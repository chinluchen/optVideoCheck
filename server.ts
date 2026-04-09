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

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'student',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    title TEXT,
    correctAnswer TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default admin and steps
const seedData = () => {
  const adminExists = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  if (!adminExists) {
    db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)").run('admin', '0322', 'admin');
  }

  const stepsCount = db.prepare("SELECT COUNT(*) as count FROM steps").get() as { count: number };
  if (stepsCount.count === 0) {
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
    const insertStep = db.prepare("INSERT INTO steps (id, title, correctAnswer) VALUES (?, ?, ?)");
    defaultSteps.forEach(s => insertStep.run(s.id, s.title, s.correctAnswer));
  }
};
seedData();

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
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password) as any;
    if (user) {
      res.json({ 
        success: true, 
        user: { 
          uid: user.id.toString(),
          displayName: user.username, 
          role: user.role 
        } 
      });
    } else {
      res.status(401).json({ error: "帳號或密碼錯誤" });
    }
  });

  // Steps Management
  app.get("/api/steps", (req, res) => {
    const steps = db.prepare("SELECT * FROM steps ORDER BY createdAt ASC").all();
    res.json(steps);
  });

  app.post("/api/steps", (req, res) => {
    const { id, title, correctAnswer } = req.body;
    const exists = db.prepare("SELECT id FROM steps WHERE id = ?").get(id);
    if (exists) {
      db.prepare("UPDATE steps SET title = ?, correctAnswer = ? WHERE id = ?").run(title, correctAnswer, id);
    } else {
      db.prepare("INSERT INTO steps (id, title, correctAnswer) VALUES (?, ?, ?)").run(id || randomUUID(), title, correctAnswer);
    }
    res.json({ success: true });
  });

  app.delete("/api/steps/:id", (req, res) => {
    db.prepare("DELETE FROM steps WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  // Students Management
  app.get("/api/students", (req, res) => {
    const students = db.prepare("SELECT id, username, password, createdAt FROM users WHERE role = 'student' ORDER BY createdAt DESC").all();
    res.json(students);
  });

  app.post("/api/students", (req, res) => {
    const { id, username, password } = req.body;
    if (id) {
      db.prepare("UPDATE users SET username = ?, password = ? WHERE id = ?").run(username, password, id);
    } else {
      try {
        db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, 'student')").run(username, password);
      } catch (e: any) {
        return res.status(400).json({ error: "帳號已存在" });
      }
    }
    res.json({ success: true });
  });

  app.delete("/api/students/:id", (req, res) => {
    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

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
        
        // 影片較大時的上傳處理邏輯
        if (base64Data.length > 10 * 1024 * 1024) {
          console.log(`影片較大 (${(base64Data.length / 1024 / 1024).toFixed(2)} MB)，使用 File API 上傳...`);
          const buffer = Buffer.from(base64Data, 'base64');
          const extension = mimeType.split('/')[1] || 'mp4';
          tempFilePath = path.join(tmpdir(), `gemini_upload_${randomUUID()}.${extension}`);
          fs.writeFileSync(tempFilePath, buffer);
          
          const stats = fs.statSync(tempFilePath);
          console.log(`暫存檔案已建立: ${tempFilePath}, 大小: ${stats.size} bytes`);

          // 偵測本地影片長度
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

      const finalPrompt = `
        ${prompt}
        ${durationSeconds ? `【影片資訊】：本影片總長度為 ${durationSeconds} 秒。請務必分析至最後一秒，並在 timeline 中紀錄最後的動作。` : ""}
      `;

      // 執行分析 - 使用正確的 ai.models.generateContent 模式
      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview", // 使用推薦的穩定版
        contents: [{ role: "user", parts: [...(Array.isArray(contents) ? contents : [contents]), { text: finalPrompt }] }],
        config: { 
          systemInstruction,
          responseMimeType: "application/json", 
          temperature: 0 // 設為 0 以追求最高精確度
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
