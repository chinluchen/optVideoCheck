import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  // Cloud Run uses PORT 8080 by default, but we'll support both
  const PORT = process.env.PORT || 3000;

  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", env: process.env.NODE_ENV });
  });

  // Backend Gemini Proxy (Protects API Key)
  app.post("/api/verify", async (req, res) => {
    console.log("收到驗證請求...");
    try {
      const { prompt, videoData, modelName } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        console.error("錯誤：找不到 GEMINI_API_KEY 環境變數");
        return res.status(500).json({ error: "伺服器尚未設定 GEMINI_API_KEY" });
      }

      console.log("正在呼叫 Gemini API (模型:", modelName || "gemini-3-flash-preview", ")...");
      const ai = new GoogleGenAI({ apiKey });

      const contents = videoData ? { parts: [videoData, { text: prompt }] } : prompt;
      const result = await ai.models.generateContent({
        model: modelName || "gemini-3-flash-preview",
        contents: contents,
        config: {
          responseMimeType: "application/json",
          temperature: 0
        }
      });

      console.log("Gemini 回傳成功！");
      res.json(JSON.parse(result.text || "{}"));
    } catch (error: any) {
      console.error("Gemini 後端發生錯誤:", error.message);
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
    // Production: Serve static files from dist
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    
    // SPA fallback: All other routes serve index.html
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
