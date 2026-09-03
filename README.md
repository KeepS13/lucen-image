# Lucen Image Workbench

Lucen 是一个支持 `gpt-image-2` 和 `gemini-3.1-flash-image` 的多人共享 Web 图片工作台。现代版与 `/legacy` 共用同一套登录会话、SQLite 画廊和 Remit 上传队列。

## 功能

- GPT 文生图、图生图与 Gemini 原生 `generateContent` 文生图。
- GPT/Gemini 密钥仅存在于服务端环境变量，浏览器不能读取或覆盖。
- 共享访问密码与 7 天 HttpOnly 会话，适合单实例、小规模可信用户。
- 原图和小于 `100000` 字节的 WebP 缩略图分别上传 Remit；列表只加载缩略图。
- SQLite 保存共享工作区、Prompt、画廊、输入图和可恢复上传任务。

## 本地运行

要求 Node.js 20 或更高版本。

```powershell
npm ci
$env:LUCEN_ACCESS_PASSWORD="replace-with-a-strong-password"
$env:LUCEN_SESSION_SECRET="replace-with-at-least-32-random-bytes"
$env:LUCEN_GPT_API_KEY="your-gpt-key"
$env:LUCEN_GEMINI_API_KEY="your-gemini-key"
npm run build
npm start
```

访问 `http://127.0.0.1:8787/`；旧版地址为 `http://127.0.0.1:8787/legacy`。

非生产模式未配置访问密码和会话密钥时，鉴权会暂时关闭，便于本地排查。`NODE_ENV=production` 下缺少其中任一配置会拒绝启动，会话密钥必须至少 32 字节。

## Docker VPS

```bash
cp .env.example .env
# 编辑 .env，配置域名、共享密码、随机会话密钥和 Provider Key
docker compose up -d --build
```

域名需要提前解析到 VPS，且主机的 `80/443` 端口可被 Caddy 使用。应用容器不公开 `8787`，持久数据保存在 `lucen-data` 命名卷中。新生产卷为空，不会包含仓库工作目录里的 `data/`。

## 环境变量

| 名称 | 用途 |
| --- | --- |
| `LUCEN_ACCESS_PASSWORD` | 所有用户共用的访问密码 |
| `LUCEN_SESSION_SECRET` | HMAC 会话签名密钥，生产环境至少 32 字节 |
| `LUCEN_SESSION_TTL_SECONDS` | 会话有效期，默认 `604800` |
| `LUCEN_GPT_API_KEY` | GPT Image 2 服务端 Key |
| `LUCEN_GEMINI_API_KEY` | Gemini 3.1 服务端 Key |
| `LUCEN_DATA_DIR` | SQLite 与临时文件目录，容器默认 `/app/data` |
| `LUCEN_TRUST_PROXY` | 位于可信反向代理后设为 `1` |

旧版 Provider 环境变量名称继续兼容，但规范名称优先。上游固定为 `https://xixiapi.io`，页面不提供 Base URL 或 Key 配置。

## 验证

```powershell
npm run typecheck
node --check lucen-auth.cjs
node --check lucen-local-proxy.cjs
node --check remit-upload.cjs
npm run verify:auth
npm run verify:uploads
npm run build
npm run verify:providers
docker build --platform linux/amd64 -t lucen-image:local .
```

自动验证使用模拟 Provider 与 Remit 响应，不会执行真实、计费生图或公开图片上传。`.github/workflows` 已准备 PR 校验和未来的 GHCR amd64 发布流程；本地改造阶段不会推送仓库或发布镜像。

## 数据与安全

- 所有登录用户共享数据，并可执行现有删除操作。
- 浏览器旧 `apiKey`、GPT Key 和 Gemini Key 存储会在页面启动时清除。
- Remit 校验成功后删除对应本地临时文件；远端图片无法通过本应用删除。
- SQLite 只支持单实例部署，不要同时运行多个应用副本写同一数据卷。
- 备份时停止应用并备份完整 `LUCEN_DATA_DIR` 或 Docker 数据卷。
