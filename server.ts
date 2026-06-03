import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import Database from "better-sqlite3";
import fs from "fs";
import PQueue from "p-queue";
import OpenAI from "openai";
import ytdl from "ytdl-core";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

// Import the Firebase configuration
import firebaseConfig from './firebase-applet-config.json';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Initialize Firebase Admin
admin.initializeApp({
  storageBucket: firebaseConfig.storageBucket,
});

const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
const storageBucket = admin.storage().bucket(firebaseConfig.storageBucket);

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SQLite is now only used for migration
const sqliteDb = new Database("submissions.db");

// Migration Logic: Move data from SQLite to Firestore
const migrateData = async () => {
  console.log(`Checking for data migration (Database: ${firebaseConfig.firestoreDatabaseId})...`);
  
  // Check if users collection is empty
  const usersSnapshot = await firestore.collection('users').limit(1).get();
  if (!usersSnapshot.empty) {
    console.log("Firestore already has data, skipping migration.");
    return;
  }

  console.log("Starting migration from SQLite to Firestore...");

  // Migrate Users
  const sqliteUsers = sqliteDb.prepare("SELECT * FROM users").all() as any[];
  for (const user of sqliteUsers) {
    await firestore.collection('users').doc(user.id.toString()).set({
      username: user.username,
      password: user.password,
      role: user.role,
      createdAt: user.createdAt
    });
  }
  console.log(`Migrated ${sqliteUsers.length} users.`);

  // Migrate Steps
  const sqliteSteps = sqliteDb.prepare("SELECT * FROM steps").all() as any[];
  for (const step of sqliteSteps) {
    await firestore.collection('steps').doc(step.id).set({
      title: step.title,
      correctAnswer: step.correctAnswer,
      createdAt: step.createdAt
    });
  }
  console.log(`Migrated ${sqliteSteps.length} steps.`);

  // Migrate Submissions
  const sqliteSubmissions = sqliteDb.prepare("SELECT * FROM submissions").all() as any[];
  for (const sub of sqliteSubmissions) {
    await firestore.collection('submissions').add({
      studentName: sub.studentName,
      videoUrl: sub.videoUrl,
      score: sub.score,
      result: JSON.parse(sub.result),
      createdAt: sub.createdAt
    });
  }
  console.log(`Migrated ${sqliteSubmissions.length} submissions.`);

  console.log("Migration completed.");
};

// Seed default data if Firestore is empty (and migration didn't happen or was empty)
const seedFirestore = async () => {
  const stepsSnapshot = await firestore.collection('steps').limit(1).get();
  if (stepsSnapshot.empty) {
    const defaultSteps = [
      { id: "1", title: "消毒雙手與儀器 (Sanitization)", correctAnswer: "操作者應使用 75% 酒精徹底消毒雙手，並擦拭驗光儀器之額托與下巴托。" },
      { id: "2", title: "調整受檢者坐姿與下巴托 (Patient Positioning)", correctAnswer: "受檢者應坐穩，下巴靠在托架上，額頭緊貼額托，調整高度使受檢者眼睛對準儀器刻度。" },
      { id: "3", title: "電腦驗光 (Auto-Refraction)", correctAnswer: "操作者應指示受檢者注視儀器內的熱氣球或目標，並在對焦準確後進行至少三次測量。" },
      { id: "4", title: "自覺式驗光 - 霧視法 (Subjective Refraction - Fogging)", correctAnswer: "在進行自覺式驗光前，應先加入正度數鏡片使視力模糊（霧視），以放鬆調節力。" },
      { id: "5", title: "紅綠測試 (Red-Green Test)", correctAnswer: "受檢者應比較紅綠背景下的視標清晰度，若綠色較清楚則減少負度數，若紅色較清楚則增加負度數。" },
      { id: "6", title: "散光軸度與度數調整 (Cross Cylinder Adjustment)", correctAnswer: "使用交叉圓柱鏡 (JCC) 進行精確的散光軸度與度數調整，根據受檢者反應旋轉軸度。" },
      { id: "7", title: "雙眼平衡 (Binocular Balance)", correctAnswer: "使用稜鏡分離法或霧視法，確保雙眼在看遠時的調節狀態一致且平衡。" },
      { id: "8", title: "試戴與最終處方確認 (Final Prescription Confirmation)", correctAnswer: "讓受檢者戴上試鏡架行走，確認是否有晃動感、頭暈或不適，並進行最終度數微調。" }
    ];
    for (const s of defaultSteps) {
      await firestore.collection('steps').doc(s.id).set({
        title: s.title,
        correctAnswer: s.correctAnswer,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }

  const adminSnapshot = await firestore.collection('users').where('username', '==', 'admin').limit(1).get();
  if (adminSnapshot.empty) {
    await firestore.collection('users').add({
      username: 'admin',
      password: '0322',
      role: 'admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
};

const transcriptionQueue = new PQueue({ concurrency: 2 });
let openaiClient: OpenAI | null = null;

function getOpenAIClient() {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required for transcription");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function toMMSS(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const mm = String(Math.floor(safe / 60)).padStart(2, "0");
  const ss = String(safe % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function buildTimestampedTranscript(transcription: any): string {
  const segments = Array.isArray(transcription?.segments) ? transcription.segments : [];
  const rows = segments
    .map((segment: any, index: number) => {
      const startNum = Number(segment?.start);
      const start = Number.isFinite(startNum) ? startNum : index;
      const text = typeof segment?.text === "string" ? segment.text.trim() : "";
      if (!text) return null;
      return `[${toMMSS(start)}] ${text}`;
    })
    .filter(Boolean) as string[];

  if (rows.length > 0) return rows.join("\n");

  const fallbackText = typeof transcription?.text === "string" ? transcription.text.trim() : "";
  if (!fallbackText) return "";
  return `[00:00] ${fallbackText}`;
}

async function transcribeAudioFileWithWhisper(audioPath: string) {
  const openai = getOpenAIClient();
  const transcription: any = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  return buildTimestampedTranscript(transcription);
}

async function processTranscription(id: string, videoUrl: string) {
  const updateStatus = async (status: string, transcript: string | null = null, error: string | null = null) => {
    await firestore.collection('transcriptions').doc(id).update({
      status,
      transcript,
      error,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  };

  try {
    await updateStatus('processing');
    console.log(`[Transcription ${id}] Starting for ${videoUrl}`);

    const tempAudioPath = path.join(tmpdir(), `${id}.mp3`);
    const tempVideoPath = path.join(tmpdir(), `${id}.mp4`);

    await new Promise<void>((resolve, reject) => {
      const stream = ytdl(videoUrl, { quality: 'lowestaudio', filter: 'audioonly' });
      const writeStream = fs.createWriteStream(tempVideoPath);
      stream.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    await new Promise<void>((resolve, reject) => {
      ffmpeg(tempVideoPath)
        .toFormat('mp3')
        .on('end', () => resolve())
        .on('error', reject)
        .save(tempAudioPath);
    });

    const transcriptText = await transcribeAudioFileWithWhisper(tempAudioPath);
    await updateStatus('completed', transcriptText);
    console.log(`[Transcription ${id}] Completed`);

    if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
    if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);

  } catch (error: any) {
    console.error(`[Transcription ${id}] Failed:`, error.message);
    await updateStatus('failed', null, error.message);
  }
}

async function transcribeLocalVideoWithWhisper(localVideoPath: string) {
  const tempAudioPath = path.join(tmpdir(), `verify_stt_${randomUUID()}.mp3`);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(localVideoPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .audioBitrate("64k")
        .toFormat("mp3")
        .on("end", () => resolve())
        .on("error", reject)
        .save(tempAudioPath);
    });

    return await transcribeAudioFileWithWhisper(tempAudioPath);
  } finally {
    if (fs.existsSync(tempAudioPath)) {
      try {
        fs.unlinkSync(tempAudioPath);
      } catch (e) {
        console.warn("無法刪除 STT 暫存音訊檔:", e);
      }
    }
  }
}

const STANDARD_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const STANDARD_MAX_DURATION_SECONDS = 30 * 60;
const STANDARD_KEYFRAME_INTERVAL_SECONDS = 8;
const STANDARD_MAX_KEYFRAMES = 10;

function formatSecondsAsMMSS(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const mm = String(Math.floor(safe / 60)).padStart(2, "0");
  const ss = String(safe % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function getVideoDurationSeconds(videoPath: string): Promise<number | null> {
  try {
    const metadata: any = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
    const duration = Number(metadata?.format?.duration);
    return Number.isFinite(duration) ? Math.round(duration) : null;
  } catch (error) {
    console.warn("偵測影片長度失敗:", error);
    return null;
  }
}

async function compressVideoForAnalysis(inputPath: string, outputPath: string) {
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .audioChannels(1)
      .audioBitrate("128k")
      .outputOptions([
        "-vf",
        "scale=-2:720:force_original_aspect_ratio=decrease,fps=15",
        "-preset",
        "veryfast",
        "-movflags",
        "+faststart",
        "-b:v",
        "1200k",
        "-maxrate",
        "1500k",
        "-bufsize",
        "3000k",
      ])
      .on("end", () => resolve())
      .on("error", reject)
      .save(outputPath);
  });
}

async function extractAudioForStt(inputPath: string, outputPath: string) {
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("end", () => resolve())
      .on("error", reject)
      .save(outputPath);
  });
}

async function extractKeyframesForAnalysis(
  videoPath: string,
  durationSeconds: number | null,
  outputDir: string
) {
  fs.mkdirSync(outputDir, { recursive: true });
  const interval = durationSeconds
    ? Math.max(5, Math.min(10, Math.round(durationSeconds / 8) || STANDARD_KEYFRAME_INTERVAL_SECONDS))
    : STANDARD_KEYFRAME_INTERVAL_SECONDS;
  const maxDuration = durationSeconds ?? interval;
  const timestamps: number[] = [];

  for (let current = 0; current <= maxDuration; current += interval) {
    timestamps.push(current);
    if (timestamps.length >= STANDARD_MAX_KEYFRAMES) break;
  }

  if (timestamps.length === 0) timestamps.push(0);

  const keyframes: Array<{ path: string; timestamp: string }> = [];
  for (let index = 0; index < timestamps.length; index++) {
    const timestamp = timestamps[index];
    const filename = `frame_${String(index + 1).padStart(2, "0")}_${formatSecondsAsMMSS(timestamp).replace(":", "-")}.jpg`;
    const outputPath = path.join(outputDir, filename);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .outputOptions(["-q:v", "3"])
        .on("end", () => resolve())
        .on("error", reject)
        .save(outputPath);
    });

    keyframes.push({ path: outputPath, timestamp: formatSecondsAsMMSS(timestamp) });
  }

  return keyframes;
}

async function parseVerifyRequest(req: express.Request) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("multipart/form-data")) {
    return {
      fields: (req.body || {}) as Record<string, any>,
      uploadedVideoPath: null as string | null,
      uploadedVideoMimeType: null as string | null,
      uploadedVideoName: null as string | null,
      cleanupPaths: [] as string[],
    };
  }

  const busboyModule: any = await import("@fastify/busboy");
  const Busboy = busboyModule.default || busboyModule;

  return await new Promise<{
    fields: Record<string, any>;
    uploadedVideoPath: string | null;
    uploadedVideoMimeType: string | null;
    uploadedVideoName: string | null;
    cleanupPaths: string[];
  }>((resolve, reject) => {
    const fields: Record<string, any> = {};
    const cleanupPaths: string[] = [];
    let uploadedVideoPath: string | null = null;
    let uploadedVideoMimeType: string | null = null;
    let uploadedVideoName: string | null = null;
    let sawVideoFile = false;
    let resolved = false;
    let rejected = false;

    const finishResolve = () => {
      if (resolved || rejected) return;
      resolved = true;
      resolve({ fields, uploadedVideoPath, uploadedVideoMimeType, uploadedVideoName, cleanupPaths });
    };

    const fail = (error: any) => {
      if (resolved || rejected) return;
      rejected = true;
      reject(error);
    };

    const busboy = new Busboy({
      headers: req.headers,
      limits: {
        fileSize: STANDARD_MAX_UPLOAD_BYTES,
        files: 1
      }
    });

    busboy.on("field", (name: string, value: string) => {
      fields[name] = value;
    });

    busboy.on("file", (name: string, file: NodeJS.ReadableStream, info: any) => {
      if (name !== "video") {
        file.resume();
        return;
      }

      const fileStream: any = file;
      sawVideoFile = true;
      uploadedVideoMimeType = info?.mimeType || "video/mp4";
      uploadedVideoName = info?.filename || "upload.mp4";
      const extension = path.extname(uploadedVideoName) || `.${(uploadedVideoMimeType.split("/")[1] || "mp4")}`;
      uploadedVideoPath = path.join(tmpdir(), `standard_upload_${randomUUID()}${extension}`);
      cleanupPaths.push(uploadedVideoPath);

      const writeStream = fs.createWriteStream(uploadedVideoPath);

      file.on("limit", () => {
        fail(new Error("檔案太大，請上傳小於 100MB 的影片"));
        fileStream.destroy?.();
        writeStream.destroy();
      });

      file.on("error", fail);
      writeStream.on("error", fail);
      writeStream.on("finish", () => finishResolve());
      file.pipe(writeStream);
    });

    busboy.on("error", fail);
    busboy.on("finish", () => {
      if (!sawVideoFile) finishResolve();
    });
    req.pipe(busboy);
  });
}

function buildStandardAnalysisPrompt(options: {
  checklistText: string;
  transcriptText: string;
  keyframes: Array<{ path: string; timestamp: string }>;
  durationSeconds: number | null;
  sourceName?: string;
}) {
  const { checklistText, transcriptText, keyframes, durationSeconds, sourceName } = options;
  const keyframeIndex = keyframes
    .map((frame, index) => `- 第 ${index + 1} 張 [${frame.timestamp}] ${path.basename(frame.path)}`)
    .join("\n");

  return `
你是台灣視光實驗課的檢核助教。你只能根據「逐字稿」、「關鍵畫面」與「固定流程檢核表」判斷，禁止自由補完未出現的流程。

嚴格規則：
1. 若沒有明確證據或時間點，status 必須是「無法判斷」。
2. 不得推論學生已完成未明確出現的步驟。
3. 若回傳「明確完成」但缺少 evidence 或 timestamp，後端會降級為「無法判斷」。
4. 只能使用固定流程檢核表，不可輸出自由總評。
5. 關鍵畫面是輔助證據，不可取代逐字稿。

【來源資訊】${sourceName || "上傳影片"}
${durationSeconds ? `【影片總長】約 ${durationSeconds} 秒` : ""}

【固定流程檢核表】
${checklistText}

【STT逐字稿】
${transcriptText || "無可用逐字稿"}

【關鍵畫面索引】
${keyframeIndex || "無可用關鍵畫面"}

請輸出 step_checks 陣列，且每個步驟都必須包含 step_id, step_name, status, confidence, evidence, timestamp, feedback。
      `.trim();
}

async function startServer() {
  try {
    await migrateData();
    await seedFirestore();
  } catch (err) {
    console.error("Firestore Initialization Error (Migration/Seeding):", err);
    console.log("Server will continue to start, but Firestore operations may fail.");
  }

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json({ limit: '200mb' }));
  app.use(express.urlencoded({ limit: '200mb', extended: true }));

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err) {
      console.error("Server Middleware Error:", err);
      return res.status(err.status || 500).json({ error: err.message || "伺服器中介軟體錯誤" });
    }
    next();
  });

  // API Routes
  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const snapshot = await firestore.collection('users')
      .where('username', '==', username)
      .where('password', '==', password)
      .limit(1)
      .get();
    
    if (!snapshot.empty) {
      const userDoc = snapshot.docs[0];
      const userData = userDoc.data();
      res.json({ 
        success: true, 
        user: { 
          uid: userDoc.id,
          displayName: userData.username, 
          role: userData.role 
        } 
      });
    } else {
      res.status(401).json({ error: "帳號或密碼錯誤" });
    }
  });

  // Steps Management
  app.get("/api/steps", async (req, res) => {
    const snapshot = await firestore.collection('steps').orderBy('createdAt', 'asc').get();
    const steps = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(steps);
  });

  app.post("/api/steps", async (req, res) => {
    const { id, title, correctAnswer } = req.body;
    const stepId = id || randomUUID();
    await firestore.collection('steps').doc(stepId).set({
      title,
      correctAnswer,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true });
  });

  app.delete("/api/steps/:id", async (req, res) => {
    await firestore.collection('steps').doc(req.params.id).delete();
    res.json({ success: true });
  });

  // Students Management
  app.get("/api/students", async (req, res) => {
    const snapshot = await firestore.collection('users')
      .where('role', '==', 'student')
      .orderBy('createdAt', 'desc')
      .get();
    const students = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(students);
  });

  app.post("/api/students", async (req, res) => {
    const { id, username, password } = req.body;
    if (id) {
      await firestore.collection('users').doc(id).update({ username, password });
    } else {
      const exists = await firestore.collection('users').where('username', '==', username).limit(1).get();
      if (!exists.empty) {
        return res.status(400).json({ error: "帳號已存在" });
      }
      await firestore.collection('users').add({
        username,
        password,
        role: 'student',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    res.json({ success: true });
  });

  app.delete("/api/students/:id", async (req, res) => {
    await firestore.collection('users').doc(req.params.id).delete();
    res.json({ success: true });
  });

  app.post("/api/students/bulk", async (req, res) => {
    const { students } = req.body;
    if (!Array.isArray(students)) {
      return res.status(400).json({ error: "Invalid data format" });
    }

    const batch = firestore.batch();
    const results = { success: 0, skipped: 0, errors: [] as string[] };

    for (const student of students) {
      const { username, password } = student;
      if (!username || !password) {
        results.errors.push(`Missing data for student: ${JSON.stringify(student)}`);
        continue;
      }

      const exists = await firestore.collection('users').where('username', '==', username).limit(1).get();
      if (!exists.empty) {
        results.skipped++;
        continue;
      }

      const newDocRef = firestore.collection('users').doc();
      batch.set(newDocRef, {
        username,
        password,
        role: 'student',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      results.success++;
    }

    if (results.success > 0) {
      await batch.commit();
    }

    res.json(results);
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", database: "firestore" });
  });

  app.get("/api/submissions", async (req, res) => {
    const snapshot = await firestore.collection('submissions').orderBy('createdAt', 'desc').get();
    const submissions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(submissions);
  });

  app.post("/api/transcribe", async (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ error: "Missing videoUrl" });

    const id = randomUUID();
    await firestore.collection('transcriptions').doc(id).set({
      videoUrl,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    transcriptionQueue.add(async () => {
      await processTranscription(id, videoUrl);
    });

    res.json({ id, status: 'pending' });
  });

  app.get("/api/transcription/:id", async (req, res) => {
    const { id } = req.params;
    const doc = await firestore.collection('transcriptions').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: "Transcription not found" });
    res.json({ id: doc.id, ...doc.data() });
  });

  app.post("/api/verify", async (req, res) => {
    console.log("收到驗證請求...");
    let tempFilePath: string | null = null;
    let sttSourceVideoPath: string | null = null;
    let transcriptText = "";
    const cleanupPaths: string[] = [];
    try {
      const requestPayload = await parseVerifyRequest(req);
      const body = requestPayload.fields || {};
      const prompt = body.prompt;
      const checklist = body.checklist;
      const videoData = body.videoData;
      const studentName = body.studentName;
      const videoUrl = body.videoUrl;
      const storagePath = body.storagePath;
      const videoMimeType = body.videoMimeType;
      const analysisMode = String(body.analysisMode || "legacy");
      if (requestPayload.uploadedVideoPath) {
        sttSourceVideoPath = requestPayload.uploadedVideoPath;
        tempFilePath = requestPayload.uploadedVideoPath;
        cleanupPaths.push(...requestPayload.cleanupPaths);
      }
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        console.error("錯誤: 缺少 GEMINI_API_KEY");
        return res.status(500).json({ error: "伺服器尚未設定 GEMINI_API_KEY，請在 Cloud Run 環境變數中設定。" });
      }

      const ai = new GoogleGenAI({ apiKey });
      const allowedStatuses = ["明確完成", "可能完成", "無法判斷", "明確未完成"] as const;
      type StepStatus = typeof allowedStatuses[number];
      type ChecklistStep = { step_id: string; step_name: string; criteria: string };
      type StepCheck = {
        step_id: string;
        step_name: string;
        status: StepStatus;
        confidence: number;
        evidence: string;
        timestamp: string;
        feedback: string;
      };

      const statusWeight: Record<StepStatus, number> = {
        明確完成: 1,
        可能完成: 0.6,
        無法判斷: 0.2,
        明確未完成: 0
      };

      const normalizeChecklist = (rawChecklist: any[]): ChecklistStep[] => {
        return rawChecklist
          .map((item, index) => {
            const stepId = String(item?.step_id ?? item?.id ?? `${index + 1}`).trim();
            const stepName = String(item?.step_name ?? item?.title ?? "").trim();
            const criteria = String(item?.criteria ?? item?.correctAnswer ?? "無特定要求").trim();
            if (!stepName) return null;
            return {
              step_id: stepId || `${index + 1}`,
              step_name: stepName,
              criteria: criteria || "無特定要求"
            };
          })
          .filter(Boolean) as ChecklistStep[];
      };

      const checklistSource = Array.isArray(checklist)
        ? checklist
        : typeof checklist === "string"
          ? (() => {
              try {
                const parsed = JSON.parse(checklist);
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            })()
          : [];

      let checklistItems = normalizeChecklist(checklistSource);
      if (checklistItems.length === 0) {
        const fallbackSteps = await firestore.collection('steps').orderBy('createdAt', 'asc').get();
        checklistItems = fallbackSteps.docs
          .map((doc, index) => {
            const data = doc.data() as any;
            const stepName = typeof data?.title === "string" ? data.title.trim() : "";
            if (!stepName) return null;
            return {
              step_id: doc.id || `${index + 1}`,
              step_name: stepName,
              criteria: typeof data?.correctAnswer === "string" && data.correctAnswer.trim() ? data.correctAnswer.trim() : "無特定要求"
            };
          })
          .filter(Boolean) as ChecklistStep[];
      }

      if (checklistItems.length === 0) {
        return res.status(400).json({ error: "找不到可用的檢核步驟，請先設定步驟後再分析。" });
      }

      const checklistText = checklistItems
        .map((step, index) => `步驟 ${index + 1}\nstep_id: ${step.step_id}\nstep_name: ${step.step_name}\ncriteria: ${step.criteria}`)
        .join("\n\n");

      const systemInstruction = `
你是台灣視光實驗課的檢核助教。你的唯一任務是依固定檢核表逐項判斷，禁止自由總評或自由打分。

嚴格規則（務必遵守）：
1. 每一個步驟都必須輸出：step_id, step_name, status, confidence, evidence, timestamp, feedback。
2. status 只能是：明確完成、可能完成、無法判斷、明確未完成。
3. 若影片/逐字稿沒有明確證據，status 必須是「無法判斷」，不得推論成已完成。
4. 若無法提供 timestamp 或 evidence，不得將 status 設為「明確完成」。
5. 只允許描述看得到/聽得到的事實，不可補全未發生動作。
6. confidence 必須為 0~1。
7. timestamp 格式請使用 mm:ss；若沒有明確時間，填 "N/A"。
8. 回傳格式必須是 JSON，頂層僅輸出 step_checks 陣列。
      `;

      const responseSchema = {
        type: "object",
        properties: {
          step_checks: {
            type: "array",
            minItems: checklistItems.length,
            items: {
              type: "object",
              properties: {
                step_id: { type: "string" },
                step_name: { type: "string" },
                status: { type: "string", enum: [...allowedStatuses] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                evidence: { type: "string" },
                timestamp: { type: "string" },
                feedback: { type: "string" }
              },
              required: ["step_id", "step_name", "status", "confidence", "evidence", "timestamp", "feedback"]
            }
          }
        },
        required: ["step_checks"]
      };

      const toSeconds = (timeLike: string): number | null => {
        if (!timeLike || typeof timeLike !== "string") return null;
        const parts = timeLike.trim().split(":");
        if (parts.length !== 2) return null;
        const mm = Number(parts[0]);
        const ss = Number(parts[1]);
        if (!Number.isFinite(mm) || !Number.isFinite(ss) || mm < 0 || ss < 0 || ss > 59) return null;
        return mm * 60 + ss;
      };

      const toMMSS = (totalSeconds: number): string => {
        const safe = Math.max(0, Math.floor(totalSeconds));
        const mm = String(Math.floor(safe / 60)).padStart(2, "0");
        const ss = String(safe % 60).padStart(2, "0");
        return `${mm}:${ss}`;
      };

      const normalizeStatus = (rawStatus: any): StepStatus => {
        const value = typeof rawStatus === "string" ? rawStatus.trim() : "";
        if ((allowedStatuses as readonly string[]).includes(value)) return value as StepStatus;
        if (value.includes("完成") && !value.includes("未")) return "可能完成";
        if (value.includes("未完成")) return "明確未完成";
        if (value.includes("無法") || value.includes("不確定") || value.includes("不明")) return "無法判斷";
        return "無法判斷";
      };

      const normalizeTimestamp = (timeLike: any, duration: number | null): string => {
        if (typeof timeLike !== "string") return "N/A";
        let seconds = toSeconds(timeLike.trim());
        if (seconds === null) {
          const match = timeLike.match(/(\d{1,2}):(\d{2})/);
          if (match) {
            seconds = toSeconds(`${match[1]}:${match[2]}`);
          }
        }
        if (seconds === null) return "N/A";
        if (duration !== null) seconds = Math.min(seconds, Math.max(0, duration));
        return toMMSS(seconds);
      };

      const genericEvidenceTokens = new Set([
        "操作", "動作", "步驟", "流程", "檢查", "測試", "儀器", "學生", "同學", "影片", "畫面",
        "進行", "完成", "可能", "應該", "看見", "看到", "聽到", "調整", "使用", "鏡片", "驗光"
      ]);

      const extractKeywords = (text: string) => {
        const raw = (text || "").match(/[\u4e00-\u9fffA-Za-z0-9]+/g) || [];
        return raw
          .map((token) => token.trim().toLowerCase())
          .filter((token) => {
            if (!token) return false;
            if (token.length <= 1) return false;
            if (genericEvidenceTokens.has(token)) return false;
            return true;
          });
      };

      const hasStepKeywordSupport = (evidence: string, checklistStep: ChecklistStep) => {
        const evidenceTokens = new Set(extractKeywords(evidence));
        const stepTokens = new Set([
          ...extractKeywords(checklistStep.step_name),
          ...extractKeywords(checklistStep.criteria)
        ]);

        if (stepTokens.size === 0 || evidenceTokens.size === 0) return false;

        let hitCount = 0;
        for (const token of stepTokens) {
          if (evidenceTokens.has(token)) hitCount++;
        }
        return hitCount >= 1;
      };

      const defaultFeedbackByStatus: Record<StepStatus, string> = {
        明確完成: "此步驟有明確證據且時間點清楚，請維持目前操作。",
        可能完成: "有部分跡象，但證據仍不足，建議補充更清晰畫面或口述。",
        無法判斷: "目前缺乏明確證據或時間點，無法判定是否完成。",
        明確未完成: "可明確看出此步驟未完成，請依標準流程補強。"
      };

      const sanitizeSingleStep = (source: any, checklistStep: ChecklistStep, duration: number | null): StepCheck => {
        let status = normalizeStatus(source?.status);
        let downgradedByEvidenceGate = false;
        const confidenceNum = Number(source?.confidence);
        let confidence = Number.isFinite(confidenceNum) ? Math.max(0, Math.min(1, confidenceNum)) : 0;
        const evidenceRaw = typeof source?.evidence === "string" ? source.evidence.trim() : "";
        const evidence = evidenceRaw || "未提供明確證據";
        const timestamp = normalizeTimestamp(source?.timestamp, duration);
        const hasTimestamp = timestamp !== "N/A";
        const hasEvidence = evidence !== "未提供明確證據";
        const evidenceSignalsUnclear = /(無法判斷|看不清|不清楚|不確定|畫面不足|未提供|unclear|insufficient)/i.test(evidence);

        if (!hasEvidence || evidenceSignalsUnclear) {
          status = "無法判斷";
        }
        if (status === "明確完成" && (!hasTimestamp || !hasEvidence || confidence < 0.75)) {
          status = hasEvidence && hasTimestamp ? "可能完成" : "無法判斷";
        }
        if ((status === "明確完成" || status === "可能完成") && !hasStepKeywordSupport(evidence, checklistStep)) {
          status = "無法判斷";
          confidence = Math.min(confidence, 0.49);
          downgradedByEvidenceGate = true;
        }

        const feedbackRaw = typeof source?.feedback === "string" ? source.feedback.trim() : "";
        const fallbackFeedback = defaultFeedbackByStatus[status];
        const feedback = feedbackRaw && !downgradedByEvidenceGate ? feedbackRaw : fallbackFeedback;

        return {
          step_id: checklistStep.step_id,
          step_name: checklistStep.step_name,
          status,
          confidence,
          evidence,
          timestamp,
          feedback
        };
      };

      const validateRawShape = (raw: any) => {
        if (!raw || typeof raw !== "object") return false;
        if (!Array.isArray(raw.step_checks)) return false;
        if (raw.step_checks.length === 0) return false;
        return raw.step_checks.every((item: any) =>
          item &&
          typeof item === "object" &&
          "step_id" in item &&
          "step_name" in item &&
          "status" in item &&
          "confidence" in item &&
          "evidence" in item &&
          "timestamp" in item &&
          "feedback" in item
        );
      };

      const buildFinalResult = (raw: any, duration: number | null, transcript: string = "") => {
        const sourceSteps = Array.isArray(raw?.step_checks) ? raw.step_checks : [];
        const sourceById = new Map<string, any>();
        const sourceByName = new Map<string, any>();

        for (const item of sourceSteps) {
          if (!item || typeof item !== "object") continue;
          const idKey = typeof item.step_id === "string" ? item.step_id.trim() : "";
          const nameKey = typeof item.step_name === "string" ? item.step_name.trim().toLowerCase() : "";
          if (idKey && !sourceById.has(idKey)) sourceById.set(idKey, item);
          if (nameKey && !sourceByName.has(nameKey)) sourceByName.set(nameKey, item);
        }

        const step_checks = checklistItems.map((step) => {
          const source = sourceById.get(step.step_id) || sourceByName.get(step.step_name.toLowerCase()) || null;
          return sanitizeSingleStep(source, step, duration);
        });

        const statusCounts: Record<StepStatus, number> = {
          明確完成: 0,
          可能完成: 0,
          無法判斷: 0,
          明確未完成: 0
        };

        let weighted = 0;
        for (const step of step_checks) {
          statusCounts[step.status] += 1;
          weighted += statusWeight[step.status] * step.confidence;
        }

        const totalSteps = Math.max(step_checks.length, 1);
        const score = Math.max(0, Math.min(100, Math.round((weighted / totalSteps) * 100)));
        const completionRate = Math.round((statusCounts["明確完成"] / totalSteps) * 100);

        const strengths = step_checks
          .filter((step) => step.status === "明確完成" || step.status === "可能完成")
          .slice(0, 4)
          .map((step) => `${step.step_name}：${step.feedback}`);

        const weaknesses = step_checks
          .filter((step) => step.status === "無法判斷" || step.status === "明確未完成")
          .slice(0, 4)
          .map((step) => `${step.step_name}：${step.feedback}`);

        const summary = `本次依固定流程檢核 ${step_checks.length} 步：明確完成 ${statusCounts["明確完成"]} 步、可能完成 ${statusCounts["可能完成"]} 步、無法判斷 ${statusCounts["無法判斷"]} 步、明確未完成 ${statusCounts["明確未完成"]} 步。`;

        const adviceParts = [
          "同學你好，我是助教，我已經看完你的操作影片了。",
          `本次明確完成率為 ${completionRate}%。`,
          statusCounts["無法判斷"] > 0
            ? "有部分步驟缺少可驗證證據，建議補強拍攝角度、光線與口述。"
            : "大多數步驟已有可驗證證據，請持續保持。",
          statusCounts["明確未完成"] > 0
            ? "請優先針對「明確未完成」的步驟再次練習並重新上傳。"
            : "目前未發現明確未完成步驟。"
        ];

        const timeline = step_checks.map((step) => ({
          time: step.timestamp === "N/A" ? "00:00" : step.timestamp,
          action: `${step.step_name}｜${step.status}｜證據：${step.evidence}`
        }));

        return {
          score,
          summary,
          transcript,
          timeline,
          strengths: strengths.length > 0 ? strengths : ["目前沒有足夠證據可判定為明確完成步驟。"],
          weaknesses: weaknesses.length > 0 ? weaknesses : ["目前沒有明確未完成步驟，但仍建議持續提升畫面可判讀性。"],
          advice: adviceParts.join(" "),
          step_checks,
          statusCounts,
          checklistVersion: "fixed-v1"
        };
      };

      const buildUnableToJudgeResult = (reason: string, duration: number | null, transcript: string = "") => {
        const raw = {
          step_checks: checklistItems.map((step) => ({
            step_id: step.step_id,
            step_name: step.step_name,
            status: "無法判斷",
            confidence: 0,
            evidence: reason,
            timestamp: "N/A",
            feedback: "來源資料不足，系統依規則不得推論完成。"
          }))
        };
        return buildFinalResult(raw, duration, transcript);
      };

      const downloadYoutubeToTempFile = async (targetUrl: string) => {
        const ytTempPath = path.join(tmpdir(), `yt_${randomUUID()}.mp4`);
        await new Promise<void>((resolve, reject) => {
          const stream = ytdl(targetUrl, { quality: "18" });
          const writer = fs.createWriteStream(ytTempPath);
          stream.on("error", reject);
          writer.on("error", reject);
          writer.on("finish", () => resolve());
          stream.pipe(writer);
        });
        return ytTempPath;
      };

      const uploadFileToGeminiAndBuildPart = async (localFilePath: string, mimeType: string) => {
        console.log("正在上傳至 Gemini File API...");
        let uploadResult;
        try {
          uploadResult = await (ai as any).files.upload(localFilePath, {
            mimeType,
            displayName: "Student Upload",
          });
          console.log("Gemini File API 上傳成功:", JSON.stringify(uploadResult));
        } catch (uploadError: any) {
          console.error("Gemini File API 上傳失敗:", uploadError);
          throw new Error(`Gemini 檔案上傳失敗: ${uploadError.message}`);
        }

        const fileObj = uploadResult.file || uploadResult;
        if (!fileObj || !fileObj.name) {
          console.error("無法從上傳結果中取得檔案資訊:", uploadResult);
          throw new Error("Gemini 上傳失敗: 無法取得檔案資訊");
        }

        console.log("正在等待影片處理:", fileObj.name);
        let file = await (ai as any).files.get(fileObj.name);
        let pollCount = 0;
        while (file.state === 'PROCESSING' && pollCount < 60) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          file = await (ai as any).files.get(fileObj.name);
          pollCount++;
        }

        if (file.state === 'FAILED') throw new Error("Gemini 影片處理失敗");
        if (file.state === 'PROCESSING') throw new Error("影片處理超時");

        return { fileData: { fileUri: file.uri, mimeType: file.mimeType } };
      };

      let durationSeconds: number | null = null;
      if (videoUrl && (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be'))) {
        try {
          const info = await ytdl.getBasicInfo(videoUrl);
          durationSeconds = parseInt(info.videoDetails.lengthSeconds);
          console.log(`偵測到 YouTube 影片長度: ${durationSeconds} 秒`);
        } catch (e) {
          console.warn("YouTube 影片長度偵測失敗:", e);
        }
      }

      if (analysisMode === "standard" && sttSourceVideoPath) {
        console.log("開始一般分析模式流程...");
        const sourceDuration = await getVideoDurationSeconds(sttSourceVideoPath);
        if (sourceDuration !== null) {
          durationSeconds = sourceDuration;
          if (sourceDuration > STANDARD_MAX_DURATION_SECONDS) {
            throw new Error(`影片太長，請縮短至 ${Math.floor(STANDARD_MAX_DURATION_SECONDS / 60)} 分鐘內`);
          }
        }

        const compressedPath = path.join(tmpdir(), `standard_compressed_${randomUUID()}.mp4`);
        const audioPath = path.join(tmpdir(), `standard_audio_${randomUUID()}.wav`);
        const keyframeDir = path.join(tmpdir(), `standard_keyframes_${randomUUID()}`);
        cleanupPaths.push(compressedPath, audioPath, keyframeDir);

        try {
          await compressVideoForAnalysis(sttSourceVideoPath, compressedPath);
        } catch (error: any) {
          throw new Error(`ffmpeg壓縮失敗：${error?.message || error}`);
        }

        try {
          await extractAudioForStt(compressedPath, audioPath);
        } catch (error: any) {
          throw new Error(`音訊抽取失敗：${error?.message || error}`);
        }

        try {
          transcriptText = await transcribeAudioFileWithWhisper(audioPath);
        } catch (error: any) {
          throw new Error(`STT失敗：${error?.message || error}`);
        }

        if (!transcriptText) {
          throw new Error("STT失敗：未取得逐字稿");
        }

        let keyframes: Array<{ path: string; timestamp: string }> = [];
        try {
          keyframes = await extractKeyframesForAnalysis(compressedPath, durationSeconds, keyframeDir);
        } catch (error: any) {
          throw new Error(`關鍵畫面擷取失敗：${error?.message || error}`);
        }

        if (keyframes.length === 0) {
          throw new Error("關鍵畫面擷取失敗：未產生任何關鍵畫面");
        }

        const standardPrompt = buildStandardAnalysisPrompt({
          checklistText,
          transcriptText,
          keyframes,
          durationSeconds,
          sourceName: "一般分析模式"
        });

        const standardParts: any[] = [
          { text: standardPrompt },
          ...keyframes.map((frame) => ({
            inlineData: {
              data: fs.readFileSync(frame.path).toString("base64"),
              mimeType: "image/jpeg"
            }
          }))
        ];

        const runStandardModelWithRetry = async () => {
          let lastError = "";
          for (let attempt = 1; attempt <= 2; attempt++) {
            const retryInstruction = attempt === 1
              ? ""
              : "你上一版輸出不符合 JSON schema。請只輸出合法 JSON，且每一項都含 step_id, step_name, status, confidence, evidence, timestamp, feedback。";

            const result = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: [{
                role: "user",
                parts: [...standardParts, ...(retryInstruction ? [{ text: retryInstruction }] : [])]
              }],
              config: {
                systemInstruction,
                responseMimeType: "application/json",
                responseSchema,
                temperature: 0
              }
            });

            if (!result.candidates || result.candidates.length === 0) {
              lastError = "Gemini 未能生成任何結果";
              continue;
            }

            let text = (result.text || "{}").replace(/```json/g, "").replace(/```/g, "").trim();
            if (!text) text = "{}";

            try {
              const raw = JSON.parse(text);
              if (!validateRawShape(raw)) {
                lastError = "schema 驗證失敗";
                continue;
              }
              return raw;
            } catch (parseError: any) {
              lastError = parseError?.message || "JSON 解析失敗";
            }
          }
          throw new Error(`AI 回傳格式不符合 schema，請稍後再試。${lastError ? ` (${lastError})` : ""}`);
        };

        const rawAnalysisResult = await runStandardModelWithRetry();
        const analysisResult = buildFinalResult(rawAnalysisResult, durationSeconds, transcriptText);

        await firestore.collection('submissions').add({
          studentName: studentName || "匿名學生",
          videoUrl: storagePath || videoUrl || "本地上傳",
          score: analysisResult.score || 0,
          result: {
            ...analysisResult,
            analysisMode: "standard"
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log("一般分析模式驗證成功！");
        return res.json(analysisResult);
      }

      let contents: any[] = [];

      if (storagePath) {
        const extension = path.extname(storagePath) || '.mp4';
        tempFilePath = path.join(tmpdir(), `storage_upload_${randomUUID()}${extension}`);
        sttSourceVideoPath = tempFilePath;
        const bucketFile = storageBucket.file(storagePath);

        console.log(`從 Cloud Storage 下載影片: ${storagePath}`);
        await bucketFile.download({ destination: tempFilePath });
        const [metadata] = await bucketFile.getMetadata();
        const effectiveMimeType = videoMimeType || metadata.contentType || "video/mp4";

        try {
          const probeResult: any = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(tempFilePath!, (err, data) => {
              if (err) reject(err);
              else resolve(data);
            });
          });
          durationSeconds = Math.round(probeResult.format.duration);
          console.log(`偵測到雲端影片長度: ${durationSeconds} 秒`);
        } catch (e) {
          console.warn("雲端影片長度偵測失敗:", e);
        }

        contents = [await uploadFileToGeminiAndBuildPart(tempFilePath, effectiveMimeType)];
      } else if (videoData && videoData.inlineData) {
        const base64Data = videoData.inlineData.data;
        const mimeType = videoData.inlineData.mimeType;
        
        if (base64Data.length > 10 * 1024 * 1024) {
          console.log(`影片較大 (${(base64Data.length / 1024 / 1024).toFixed(2)} MB)，使用 File API 上傳...`);
          const buffer = Buffer.from(base64Data, 'base64');
          const extension = mimeType.split('/')[1] || 'mp4';
          tempFilePath = path.join(tmpdir(), `gemini_upload_${randomUUID()}.${extension}`);
          sttSourceVideoPath = tempFilePath;
          fs.writeFileSync(tempFilePath, buffer);
          
          const stats = fs.statSync(tempFilePath);
          console.log(`暫存檔案已建立: ${tempFilePath}, 大小: ${stats.size} bytes`);

          try {
            const metadata: any = await new Promise((resolve, reject) => {
              ffmpeg.ffprobe(tempFilePath!, (err, data) => {
                if (err) reject(err);
                else resolve(data);
              });
            });
            durationSeconds = Math.round(metadata.format.duration);
            console.log(`偵測到本地影片長度: ${durationSeconds} 秒`);
          } catch (e) {
            console.warn("本地影片長度偵測失敗:", e);
          }

          contents = [await uploadFileToGeminiAndBuildPart(tempFilePath, mimeType)];
        } else {
          console.log("影片較小，使用 inlineData 分析...");
          const extension = mimeType.split('/')[1] || 'mp4';
          tempFilePath = path.join(tmpdir(), `inline_upload_${randomUUID()}.${extension}`);
          sttSourceVideoPath = tempFilePath;
          fs.writeFileSync(tempFilePath, Buffer.from(base64Data, 'base64'));
          contents = [videoData];
        }
      } else if (videoUrl && (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be'))) {
        try {
          console.log("YouTube 驗證：嘗試先下載影片再送 AI 分析...");
          tempFilePath = await downloadYoutubeToTempFile(videoUrl);
          sttSourceVideoPath = tempFilePath;
          try {
            const metadata: any = await new Promise((resolve, reject) => {
              ffmpeg.ffprobe(tempFilePath!, (err, data) => {
                if (err) reject(err);
                else resolve(data);
              });
            });
            durationSeconds = Math.round(metadata.format.duration);
            console.log(`偵測到 YouTube 下載影片長度: ${durationSeconds} 秒`);
          } catch (e) {
            console.warn("YouTube 下載影片長度偵測失敗:", e);
          }

          contents = [await uploadFileToGeminiAndBuildPart(tempFilePath, "video/mp4")];
        } catch (ytError: any) {
          console.warn("YouTube 下載失敗，改為保守輸出無法判斷:", ytError?.message || ytError);
          const fallbackResult = buildUnableToJudgeResult(
            "無法取得 YouTube 影片畫面（可能為權限或平台限制），系統不得推論步驟完成。",
            durationSeconds,
            transcriptText
          );
          await firestore.collection('submissions').add({
            studentName: studentName || "匿名學生",
            videoUrl: videoUrl || "YouTube 連結",
            score: fallbackResult.score || 0,
            result: fallbackResult,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          return res.json(fallbackResult);
        }
      } else {
        contents = [];
      }

      if (contents.length === 0) {
        const fallbackResult = buildUnableToJudgeResult(
          "未取得可驗證影片內容，系統依規則只能標示為無法判斷。",
          durationSeconds,
          transcriptText
        );
        await firestore.collection('submissions').add({
          studentName: studentName || "匿名學生",
          videoUrl: storagePath || videoUrl || "未提供影片",
          score: fallbackResult.score || 0,
          result: fallbackResult,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.json(fallbackResult);
      }

      if (sttSourceVideoPath) {
        try {
          console.log(`開始 STT 逐字稿辨識: ${sttSourceVideoPath}`);
          transcriptText = await transcribeLocalVideoWithWhisper(sttSourceVideoPath);
          console.log(`STT 完成，逐字稿長度: ${transcriptText.length}`);
        } catch (sttError: any) {
          console.warn("STT 逐字稿辨識失敗:", sttError?.message || sttError);
          transcriptText = "";
        }
      }

      const finalPrompt = `
【固定流程檢核表】：
${checklistText}

${durationSeconds ? `【影片資訊】影片總長度約 ${durationSeconds} 秒。請分析至最後一秒。` : ""}
${videoUrl ? `【來源資訊】${videoUrl}` : ""}
${transcriptText ? `【語音逐字稿（STT）】\n${transcriptText}\n` : ""}
${prompt ? `【使用者補充】${prompt}` : ""}

請你逐項輸出 step_checks，不要輸出總評、不要輸出分數。
若無法提供證據或時間戳，該步驟 status 必須是「無法判斷」。
只回傳合法 JSON。
      `;

      const runModelWithRetry = async () => {
        let lastError = "";
        for (let attempt = 1; attempt <= 2; attempt++) {
          const retryInstruction = attempt === 1
            ? ""
            : "你上一版輸出不符合 JSON schema。請只輸出合法 JSON，且每一項都含 step_id, step_name, status, confidence, evidence, timestamp, feedback。";

          const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: "user", parts: [...contents, { text: `${finalPrompt}\n${retryInstruction}`.trim() }] }],
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseSchema,
              temperature: 0
            }
          });

          if (!result.candidates || result.candidates.length === 0) {
            lastError = "Gemini 未能生成任何結果";
            continue;
          }

          let text = (result.text || "{}").replace(/```json/g, "").replace(/```/g, "").trim();
          if (!text) text = "{}";

          try {
            const raw = JSON.parse(text);
            if (!validateRawShape(raw)) {
              lastError = "schema 驗證失敗";
              continue;
            }
            return raw;
          } catch (parseError: any) {
            lastError = parseError?.message || "JSON 解析失敗";
          }
        }
        throw new Error(`AI 回傳格式不符合 schema，請稍後再試。${lastError ? ` (${lastError})` : ""}`);
      };

      const rawAnalysisResult = await runModelWithRetry();
      console.log("Gemini 分析完成，正在解析結果...");
      const analysisResult = buildFinalResult(rawAnalysisResult, durationSeconds, transcriptText);

      console.log("正在儲存至 Firestore...");
      await firestore.collection('submissions').add({
        studentName: studentName || "匿名學生",
        videoUrl: storagePath || videoUrl || "本地上傳",
        score: analysisResult.score || 0,
        result: analysisResult,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log("驗證成功！");
      res.json(analysisResult);

    } catch (error: any) {
      console.error("Gemini Error:", error.message);
      const status = error.message.includes("503") ? 503 : 500;
      const displayMessage = status === 503 ? "伺服器忙線中，稍後再試" : (error.message || "分析過程中發生未知錯誤");
      res.status(status).json({ 
        error: displayMessage,
        isQuotaError: error.message.includes("high demand")
      });
    } finally {
      const filesToCleanup = Array.from(new Set([tempFilePath, ...cleanupPaths].filter((p): p is string => Boolean(p))));
      for (const filePath of filesToCleanup) {
        if (!fs.existsSync(filePath)) continue;
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
          console.log("暫存檔案已刪除:", filePath);
        } catch (e) {
          console.error("刪除暫存檔案失敗:", e);
        }
      }
    }
  });

  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
