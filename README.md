# Lucen Image Workbench

Lucen 是一个支持 `gpt-image-2` 和 `gemini-3.1-flash-image` 的多人共享 Web 图片工作台。现代版与 `/legacy` 共用同一套登录会话、SQLite 画廊和本地图片存储。

## 功能

- GPT 文生图、图生图与 Gemini 原生 `generateContent` 文生图。
- GPT/Gemini 密钥仅存在于服务端环境变量，浏览器不能读取或覆盖。
- 共享访问密码与 7 天 HttpOnly 会话，适合单实例、小规模可信用户。
- 生成图以原始字节保存在服务器的 `LUCEN_DATA_DIR/images`，并生成小于 `100000` 字节的 WebP 缩略图；列表只加载缩略图。
- SQLite 保存共享工作区、Prompt、画廊和输入图。图片读取接口仅对已登录会话有效，不提供公开外链。
- 全局保留期限默认 30 天，可在现代版或 `/legacy` 设置为 1–3650 天。收藏图片永久保留；二创输入图按同一期限清理。启动时清理一次，此后每小时清理。

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

## npm 打包与部署

项目统一使用 npm 构建和分发，发布物是包含前端静态文件、Node 服务端和依赖清单的 `.tgz` 包；服务器无需安装前端开发依赖或再次构建。

开发机生成发布包：

```powershell
npm ci
npm run package
```

产物位于 `release/lucen-image-workbench-2.0.0.tgz`。`prepack` 会自动执行 `npm run build`，因此无需单独构建。

将发布包上传到服务器后，使用独立版本目录安装（以下为 Bash 示例）：

```bash
mkdir -p /opt/lucen/releases/2.0.0 /var/lib/lucen
cd /opt/lucen/releases/2.0.0
npm init -y
npm install --omit=dev /path/to/lucen-image-workbench-2.0.0.tgz
```

设置生产环境变量后启动：

```bash
export NODE_ENV=production
export LUCEN_WORKBENCH_HOST=127.0.0.1
export LUCEN_WORKBENCH_PORT=8787
export LUCEN_DATA_DIR=/var/lib/lucen
export LUCEN_ACCESS_PASSWORD='replace-with-a-strong-shared-password'
export LUCEN_SESSION_SECRET='replace-with-at-least-32-random-bytes'
export LUCEN_GPT_API_KEY='your-gpt-key'
export LUCEN_GEMINI_API_KEY='your-gemini-key'
npm start --prefix /opt/lucen/releases/2.0.0
```

应用监听 `127.0.0.1:8787`，健康检查为 `http://127.0.0.1:8787/__health`。生产环境应由现有 HTTPS 反向代理连接该地址；仅当代理与应用位于同一可信网络时设置 `LUCEN_TRUST_PROXY=1`。建议使用 systemd、PM2 等进程管理器保存环境变量并管理进程，避免依赖交互式终端。

升级时在新目录安装新版 `.tgz`，停止旧进程，沿用相同的 `LUCEN_DATA_DIR` 启动新版即可。回退时重新启动旧版本目录。不要并发运行多个实例写入同一数据目录。

完整部署、安全及运维说明见 [DISTRIBUTION_README.md](DISTRIBUTION_README.md)。

## 环境变量

| 名称 | 用途 |
| --- | --- |
| `NODE_ENV` | 生产部署设为 `production` |
| `LUCEN_WORKBENCH_HOST` | 监听地址，建议默认仅监听 `127.0.0.1` |
| `LUCEN_WORKBENCH_PORT` | 监听端口，默认 `8787` |
| `LUCEN_ACCESS_PASSWORD` | 所有用户共用的访问密码 |
| `LUCEN_SESSION_SECRET` | HMAC 会话签名密钥，生产环境至少 32 字节 |
| `LUCEN_SESSION_TTL_SECONDS` | 会话有效期，默认 `604800` |
| `LUCEN_GPT_API_KEY` | GPT Image 2 服务端 Key |
| `LUCEN_GEMINI_API_KEY` | Gemini 3.1 服务端 Key |
| `LUCEN_DATA_DIR` | SQLite、原图、缩略图和输入图目录，默认应用目录下的 `data` |
| `LUCEN_TRUST_PROXY` | 位于可信反向代理后设为 `1` |

旧版 Provider 环境变量名称继续兼容，但规范名称优先。上游固定为 `https://xixiapi.io`，页面不提供 Base URL 或 Key 配置。

## 验证

```powershell
npm run typecheck
node --check lucen-auth.cjs
node --check lucen-local-proxy.cjs
node --check local-media.cjs
npm run verify:auth
npm run verify:storage
npm run verify:providers
npm run package
```

自动验证使用模拟 Provider 响应和临时本地数据目录，不会执行真实、计费生图。CI 执行类型、鉴权、本地存储、Provider 浏览器和 npm 打包验证；`v*` 标签或手动触发发布工作流时，会将 `.tgz` 保存为 Actions 构建产物。

## 数据与安全

- 所有登录用户共享数据，并可执行现有删除操作。
- 浏览器旧 `apiKey`、GPT Key 和 Gemini Key 存储会在页面启动时清除。
- 删除图片会同时删除原图、缩略图和 SQLite 记录；过期清理失败时保留记录，并在下一轮重试。
- SQLite 只支持单实例部署，不要同时运行多个应用副本写同一数据目录。
- 备份时停止应用并备份完整 `LUCEN_DATA_DIR`。磁盘容量和备份策略由部署方负责。
