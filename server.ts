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

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize SQLite Database (Stored in Cloud Run instance)
const db = new Database("submissions.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    studentName TEXT,
    videoUrl TEXT,
    score INTEGER,
    result TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transcriptions (
    id TEXT PRIMARY KEY,
    videoUrl TEXT,
    status TEXT, -- 'pending', 'processing', 'completed', 'failed'
    transcript TEXT,
    error TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

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
  const updateStatus = (status: string, transcript: string | null = null, error: string | null = null) => {
    const stmt = db.prepare("UPDATE transcriptions SET status = ?, transcript = ?, error = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?");
    stmt.run(status, transcript, error, id);
  };

  try {
    const openai = getOpenAIClient();
    updateStatus('processing');
    console.log(`[Transcription ${id}] Starting for ${videoUrl}`);

    const tempAudioPath = path.join(tmpdir(), `${id}.mp3`);
    const tempVideoPath = path.join(tmpdir(), `${id}.mp4`);

    // Download YouTube Audio
    // Note: ytdl-core can be flaky. In a real app, consider a more robust solution.
    await new Promise<void>((resolve, reject) => {
      const stream = ytdl(videoUrl, { quality: 'lowestaudio', filter: 'audioonly' });
      const writeStream = fs.createWriteStream(tempVideoPath);
      stream.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    // Convert to MP3 using ffmpeg
    await new Promise<void>((resolve, reject) => {
      ffmpeg(tempVideoPath)
        .toFormat('mp3')
        .on('end', () => resolve())
        .on('error', reject)
        .save(tempAudioPath);
    });

    // Transcribe using OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempAudioPath),
      model: "whisper-1",
    });

    updateStatus('completed', transcription.text);
    console.log(`[Transcription ${id}] Completed`);

    // Cleanup
    if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
    if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);

  } catch (error: any) {
    console.error(`[Transcription ${id}] Failed:`, error.message);
    updateStatus('failed', null, error.message);
  }
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", database: "sqlite" });
  });

  // Get all submissions
  app.get("/api/submissions", (req, res) => {
    const rows = db.prepare("SELECT * FROM submissions ORDER BY createdAt DESC").all();
    res.json(rows.map(row => ({
      ...row,
      result: JSON.parse(row.result as string)
    })));
  });

  // Transcription Endpoints
  app.post("/api/transcribe", async (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ error: "Missing videoUrl" });

    const id = randomUUID();
    const stmt = db.prepare("INSERT INTO transcriptions (id, videoUrl, status) VALUES (?, ?, ?)");
    stmt.run(id, videoUrl, 'pending');

    // Add to background queue
    transcriptionQueue.add(async () => {
      await processTranscription(id, videoUrl);
    });

    res.json({ id, status: 'pending' });
  });

  app.get("/api/transcription/:id", (req, res) => {
    const { id } = req.params;
    const row = db.prepare("SELECT * FROM transcriptions WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Transcription not found" });
    res.json(row);
  });

  // Backend Gemini Proxy
  app.post("/api/verify", async (req, res) => {
    console.log("收到驗證請求...");
    try {
      const { prompt, videoData, modelName, studentName, videoUrl } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(500).json({ error: "伺服器尚未設定 GEMINI_API_KEY" });
      }

      const ai = new GoogleGenAI({ apiKey });
      const result = await ai.models.generateContent({
        model: modelName || "gemini-3-flash-preview",
        contents: videoData ? { parts: [videoData, { text: prompt }] } : prompt,
        config: { responseMimeType: "application/json", temperature: 0 }
      });

      const analysisResult = JSON.parse(result.text || "{}");

      // Save to SQLite
      const stmt = db.prepare("INSERT INTO submissions (studentName, videoUrl, score, result) VALUES (?, ?, ?, ?)");
      stmt.run(studentName || "匿名學生", videoUrl || "本地上傳", analysisResult.score || 0, JSON.stringify(analysisResult));

      res.json(analysisResult);
    } catch (error: any) {
      console.error("Gemini Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
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
