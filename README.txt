LUCEN 光相工作台 v2 - 本地使用说明
====================================

要求：Node.js 20 或更高版本。

启动前在 PowerShell 配置：
  $env:LUCEN_ACCESS_PASSWORD="共享访问密码"
  $env:LUCEN_SESSION_SECRET="至少 32 字节的随机会话密钥"
  $env:LUCEN_GPT_API_KEY="GPT 服务端 Key"
  $env:LUCEN_GEMINI_API_KEY="Gemini 服务端 Key"

然后执行：
  npm ci
  npm run build
  npm start

现代版：http://127.0.0.1:8787/
旧版：http://127.0.0.1:8787/legacy

浏览器不再配置或保存 Provider Key。两种 Key 由服务端独立注入，不会交叉使用；旧浏览器存储中的 Key 会自动清除。上游固定为 https://xixiapi.io。

Docker VPS 使用方法：
  1. 根据 .env.example 创建 .env 并填写域名、密码、会话密钥和 Provider Key。
  2. 执行 docker compose up -d --build。
  3. Caddy 通过 80/443 提供 HTTPS，SQLite 和上传队列保存到 lucen-data 卷。

完整说明见 README.md 和 DISTRIBUTION_README.md。
