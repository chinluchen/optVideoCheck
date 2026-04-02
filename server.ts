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

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

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

  app.use(express.json({ limit: '200mb' }));
  app.use(express.urlencoded({ limit: '200mb', extended: true }));

  // Global error handler for middleware (e.g. JSON limit exceeded)
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err) {
      console.error("Server Middleware Error:", err);
      return res.status(err.status || 500).json({ error: err.message || "伺服器中介軟體錯誤" });
    }
    next();
  });

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
    let tempFilePath: string | null = null;
    try {
      const { prompt, videoData, studentName, videoUrl } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        console.error("錯誤: 缺少 GEMINI_API_KEY");
        return res.status(500).json({ error: "伺服器尚未設定 GEMINI_API_KEY，請在 Cloud Run 環境變數中設定。" });
      }

      // 使用正確的 SDK 初始化方式
      const ai = new GoogleGenAI({ apiKey });
      
      const systemInstruction = `
        你是一位專業且親切的台灣「視光系實驗課助教」。
        請根據影片內容進行評分。
        
        回覆規範：
        1. 語氣：親切、鼓勵，請用「同學你好，我是助教」作為開頭。
        2. 術語：必須使用台灣常用的視光術語（如：PD、遮蓋測試、視網膜檢影鏡）。
        3. 結構：指出優點、需要改進的地方、以及最終建議。
        4. 格式：必須嚴格遵守 JSON 格式回傳，包含 score (0-100) 與 feedback (字串) 欄位。
      `;

      let contents: any;

      if (videoData && videoData.inlineData) {
        const base64Data = videoData.inlineData.data;
        const mimeType = videoData.inlineData.mimeType;
        
        // 影片較大時的上傳處理邏輯
        if (base64Data.length > 10 * 1024 * 1024) {
          console.log(`影片較大 (${(base64Data.length / 1024 / 1024).toFixed(2)} MB)，使用 File API 上傳...`);
          const buffer = Buffer.from(base64Data, 'base64');
          const extension = mimeType.split('/')[1] || 'mp4';
          tempFilePath = path.join(tmpdir(), `gemini_upload_${randomUUID()}.${extension}`);
          fs.writeFileSync(tempFilePath, buffer);
          
          const stats = fs.statSync(tempFilePath);
          console.log(`暫存檔案已建立: ${tempFilePath}, 大小: ${stats.size} bytes`);
          
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
          
          // 根據 SDK 版本，結果可能是 { file: File } 或直接是 File
          const fileObj = uploadResult.file || uploadResult;
          if (!fileObj || !fileObj.name) {
            console.error("無法從上傳結果中取得檔案資訊:", uploadResult);
            throw new Error("Gemini 上傳失敗: 無法取得檔案資訊");
          }

          console.log("正在等待影片處理:", fileObj.name);
          let file = await (ai as any).files.get(fileObj.name);
          let pollCount = 0;
          while (file.state === 'PROCESSING' && pollCount < 60) { // 增加等待時間到 120 秒
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

      // 執行分析 - 使用正確的 ai.models.generateContent 模式
      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview", // 使用推薦的穩定版
        contents: [{ role: "user", parts: contents }],
        config: { 
          systemInstruction,
          responseMimeType: "application/json", 
          temperature: 0.1 // 調低溫度讓 AI 回覆格式更穩定
        }
      });

      if (!result.candidates || result.candidates.length === 0) {
        throw new Error("Gemini 未能生成任何結果，請稍後再試。");
      }

      let text = result.text || "{}";
      console.log("Gemini 分析完成，正在解析結果...");
      
      // 清理 Markdown 標籤的防呆機制
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();

      const analysisResult = JSON.parse(text);

      // 儲存至 SQLite
      console.log("正在儲存至資料庫...");
      const stmt = db.prepare("INSERT INTO submissions (studentName, videoUrl, score, result) VALUES (?, ?, ?, ?)");
      stmt.run(studentName || "匿名學生", videoUrl || "本地上傳", analysisResult.score || 0, JSON.stringify(analysisResult));

      console.log("驗證成功！");
      res.json(analysisResult);

    } catch (error: any) {
      console.error("Gemini Error:", error.message);
      // 如果遇到 503 錯誤，特別回傳讓前端知道
      const status = error.message.includes("503") ? 503 : 500;
      res.status(status).json({ 
        error: error.message || "分析過程中發生未知錯誤",
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

  // Catch-all for API routes to prevent HTML fallback
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
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
