# 使用 Node.js 官方映像檔
FROM node:20-slim

# 安裝編譯 better-sqlite3 所需的工具 (如果您的專案有用到)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# 設定工作目錄
WORKDIR /app

# 複製 package.json 並安裝套件
COPY package*.json ./
RUN npm install

# 複製所有程式碼
COPY . .

# 打包前端網頁 (產生 dist 資料夾)
RUN npm run build

# 設定環境變數為生產模式
ENV NODE_ENV=production

# Cloud Run 預設使用 8080 埠
ENV PORT=8080
EXPOSE 8080

# 啟動伺服器
CMD ["npm", "start"]
