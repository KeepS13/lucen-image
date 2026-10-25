LUCEN 光相工作台 v2 - 使用说明
==============================

要求：Node.js 20 或更高版本。

启动前在 PowerShell 配置：
  $env:LUCEN_ACCESS_PASSWORD="共享访问密码"
  $env:LUCEN_SESSION_SECRET="至少 32 字节的随机会话密钥"
  $env:LUCEN_GPT_API_KEY="GPT 服务端 Key"
  $env:LUCEN_GEMINI_API_KEY="Gemini 服务端 Key"

本地运行：
  npm ci
  npm run build
  npm start

现代版：http://127.0.0.1:8787/
旧版：http://127.0.0.1:8787/legacy

npm 部署打包：
  npm ci
  npm run package

将 release 目录生成的 .tgz 上传到服务器，在独立目录安装：
  npm init -y
  npm install --omit=dev lucen-image-workbench-2.0.0.tgz
  npm start

生产环境必须先设置 NODE_ENV=production、共享密码、会话密钥和 Provider Key。
建议将 LUCEN_DATA_DIR 指向独立持久数据目录，并使用进程管理器启动。

浏览器不再配置或保存 Provider Key。两种 Key 由服务端独立注入，不会交叉使用；旧浏览器存储中的 Key 会自动清除。上游固定为 https://xixiapi.io。

生成图保存在 LUCEN_DATA_DIR/images，缩略图保存在 LUCEN_DATA_DIR/thumbnails，不依赖外部图床。
默认保留 30 天，可在现代版或 /legacy 的“本地存储”设置中修改为 1–3650 天；
收藏图片永久保留，二创输入图按同一期限清理。

完整说明见 README.md 和 DISTRIBUTION_README.md。
