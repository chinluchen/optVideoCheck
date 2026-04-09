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
admin.initializeApp();

const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);

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
    const openai = getOpenAIClient();
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

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempAudioPath),
      model: "whisper-1",
    });

    await updateStatus('completed', transcription.text);
    console.log(`[Transcription ${id}] Completed`);

    if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
    if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);

  } catch (error: any) {
    console.error(`[Transcription ${id}] Failed:`, error.message);
    await updateStatus('failed', null, error.message);
  }
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
    try {
      const { prompt, videoData, studentName, videoUrl } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        console.error("錯誤: 缺少 GEMINI_API_KEY");
        return res.status(500).json({ error: "伺服器尚未設定 GEMINI_API_KEY，請在 Cloud Run 環境變數中設定。" });
      }

      const ai = new GoogleGenAI({ apiKey });
      
      const systemInstruction = `
        # 角色設定
        你是一位專業且嚴謹的台灣「視光系臨床實驗課教授」。你的任務是針對學生上傳的驗光操作影片（例如：綜合檢查儀 Phoropter 操作、遮蓋測試等）進行精確的動作紀錄與評分。

        # 核心分析原則（防止幻覺）
        1. **視覺優先原則**：僅紀錄影片中「肉眼清晰可見」的動作。若畫面模糊或角度受限看不清刻度，必須標註「進行旋鈕調整，具體數值不明」，絕對禁止根據常理推測或編造未發生的動作（例如：未見撤除稜鏡動作，禁止自行補上紀錄）。
        2. **禁止過度推理**：除非學生在影片中有口頭說明（如：「現在置入稜鏡」），否則請描述「物理動作」（如：「手部轉動上方旋鈕」）而非「功能意圖」。
        3. **時間軸精確性**：
           - 每一筆紀錄必須附上精確的時間戳記 [分:秒]。
           - 你必須完整分析至影片的最後一秒。輸出的最後一筆紀錄必須對應影片結束前的最終畫面，不可在影片中途停止分析。
        4. **術語規範**：必須使用台灣視光界慣用術語（如：球面度、散光軸度、交叉圓柱鏡 JCC、遮蓋去遮蓋測試）。

        # 任務流程
        1. **客觀時間軸紀錄**：以條列式列出影片中發生的所有關鍵動作與對話。
        2. **專業評分**：根據操作規範給予 0-100 的分數。
        3. **優缺點分析**：指出 2 個優點與 2 個具體改進建議。

        # 輸出格式
        必須嚴格以 JSON 格式回傳，結構如下：
        {
          "score": number,
          "summary": "總結評價",
          "timeline": [
            {"time": "mm:ss", "action": "動作描述"}
          ],
          "strengths": ["優點1", "優點2"],
          "weaknesses": ["改進點1", "改進點2"],
          "advice": "給學生的親切溫馨提醒"
        }

        # 語氣要求
        回覆口氣要親切、專業且具備指導意義。請以「同學你好，我是助教，我已經看完你的操作影片了」作為開頭（放在 advice 或 summary 中）。
      `;

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

      let contents: any;

      if (videoData && videoData.inlineData) {
        const base64Data = videoData.inlineData.data;
        const mimeType = videoData.inlineData.mimeType;
        
        if (base64Data.length > 10 * 1024 * 1024) {
          console.log(`影片較大 (${(base64Data.length / 1024 / 1024).toFixed(2)} MB)，使用 File API 上傳...`);
          const buffer = Buffer.from(base64Data, 'base64');
          const extension = mimeType.split('/')[1] || 'mp4';
          tempFilePath = path.join(tmpdir(), `gemini_upload_${randomUUID()}.${extension}`);
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
          
          console.log("正在上傳至 Gemini File API...");
          let uploadResult;
          try {
            uploadResult = await (ai as any).files.upload(tempFilePath, {
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
          
          contents = [
            { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
            { text: prompt || "請分析這段操作影片並給予建議。" }
          ];
        } else {
          console.log("影片較小，使用 inlineData 分析...");
          contents = [videoData, { text: prompt || "請分析這段操作影片並給予建議。" }];
        }
      } else {
        contents = [{ text: prompt }];
      }

      const finalPrompt = `
        ${prompt}
        ${durationSeconds ? `【影片資訊】：本影片總長度為 ${durationSeconds} 秒。請務必分析至最後一秒，並在 timeline 中紀錄最後的動作。` : ""}
      `;

      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts: [...(Array.isArray(contents) ? contents : [contents]), { text: finalPrompt }] }],
        config: { 
          systemInstruction,
          responseMimeType: "application/json", 
          temperature: 0
        }
      });

      if (!result.candidates || result.candidates.length === 0) {
        throw new Error("Gemini 未能生成任何結果，請稍後再試。");
      }

      let text = result.text || "{}";
      console.log("Gemini 分析完成，正在解析結果...");
      
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();

      const analysisResult = JSON.parse(text);

      console.log("正在儲存至 Firestore...");
      await firestore.collection('submissions').add({
        studentName: studentName || "匿名學生",
        videoUrl: videoUrl || "本地上傳",
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
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          console.log("暫存檔案已刪除");
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
