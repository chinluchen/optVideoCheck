import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import Database from "better-sqlite3";
import fs from "fs";

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
  )
`);

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
