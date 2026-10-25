# Lucen npm 部署说明

## 部署结构

发布物为一个 npm `.tgz` 包，内含构建后的前端、Node 服务端和运行依赖清单。目标服务器只需 Node.js 20 或更高版本与 npm，不需要构建前端。

该部署只支持单个 Lucen 实例。所有通过共享密码登录的用户共用工作区、Prompt、画廊和本地图片存储，也拥有相同删除权限。应用默认监听 `8787`，生产部署应只监听 `127.0.0.1`，由现有 HTTPS 反向代理提供外部访问。

## 生成发布包

在开发机执行：

```bash
npm ci
# 子路径发布；根路径发布时不设置 LUCEN_BASE_PATH。
LUCEN_BASE_PATH=/generate-image npm run package
```

`prepack` 会先运行 `npm run build`，生成的 `.tgz` 位于 `release/`。发布包不包含 `node_modules`、`.env`、运行数据、测试文件或源码开发配置。

## 首次部署

以下命令以 Linux 和 Bash 为例，将应用安装到 `/opt/lucen/releases/2.0.0`，数据放在 `/var/lib/lucen`：

```bash
mkdir -p /opt/lucen/releases/2.0.0 /var/lib/lucen
cd /opt/lucen/releases/2.0.0
tar -xzf /path/to/lucen-image-workbench-2.0.0.tgz --strip-components=1
npm install --omit=dev --no-audit --no-fund
```

配置生产环境变量：

```bash
export NODE_ENV=production
export LUCEN_WORKBENCH_HOST=127.0.0.1
export LUCEN_WORKBENCH_PORT=8787
export LUCEN_DATA_DIR=/var/lib/lucen
export LUCEN_BASE_PATH=/generate-image
export LUCEN_COOKIE_SECURE=0
export LUCEN_ACCESS_PASSWORD='replace-with-a-strong-shared-password'
export LUCEN_SESSION_SECRET='replace-with-at-least-32-random-bytes'
export LUCEN_GPT_API_KEY='your-gpt-key'
export LUCEN_GEMINI_API_KEY='your-gemini-key'
```

`LUCEN_SESSION_SECRET` 应使用至少 32 字节的独立随机值。环境变量由 systemd、PM2 或其他进程管理器保存，不写入发布包。

启动并检查：

```bash
npm start --prefix /opt/lucen/releases/2.0.0
curl --fail http://127.0.0.1:8787/generate-image/__health
```

预期健康检查返回 `{ "ok": true }`。将现有反向代理的 `/generate-image/` 前缀原样转发到 `http://127.0.0.1:8787`。`LUCEN_COOKIE_SECURE=0` 仅用于明确的 HTTP 部署；HTTPS 部署应删除该覆盖或设为 `1`。若使用可信反向代理，设置 `LUCEN_TRUST_PROXY=1`；不要让未受信任的客户端直接访问应用端口。

## systemd 示例

可将环境变量保存为仅 root 可读的 `/etc/lucen/lucen.env`，使用以下服务单元作为参考。`EnvironmentFile` 使用 `KEY=VALUE` 格式，不包含 `export`。

```ini
[Unit]
Description=Lucen Image Workbench
After=network.target

[Service]
Type=simple
User=lucen
Group=lucen
WorkingDirectory=/opt/lucen/releases/2.0.0
EnvironmentFile=/etc/lucen/lucen.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

按服务器实际 Node/npm 路径调整 `ExecStart`，并确保 `lucen` 用户对版本目录有读取权限、对 `/var/lib/lucen` 有读写权限。

## 升级、停止和回退

升级：

1. 在新的版本目录安装新的 `.tgz`，不要覆盖正在运行的目录。
2. 执行验证并准备好新版环境配置。
3. 停止旧进程，使用相同的 `LUCEN_DATA_DIR` 启动新版。
4. 检查健康接口和登录、画廊功能。

回退时停止当前进程，使用相同数据目录重新启动旧版本目录。应用和数据分离后，升级或回退不会自动清空 SQLite。

停止服务但保留数据，以 systemd 为例：

```bash
systemctl stop lucen
systemctl restart lucen
journalctl -u lucen -f
```

## Provider 配置

规范环境变量为：

```text
LUCEN_GPT_API_KEY
LUCEN_GEMINI_API_KEY
```

兼容旧名称：

```text
GPT:    LUCEN-CC-GPT-IMAGE-2
        LUCEN_CC_gpt-image-2_API_KEY
        LUCEN_CC_GPT_IMAGE_2_API_KEY
        LUCEN_CC_API_KEY
Gemini: LUCEN-CC-GEMINI-3.1-FLASH-IMAGE
        LUCEN_CC_GEMINI_3_1_FLASH_IMAGE_API_KEY
```

规范名称优先。缺少某个 Key 时服务仍可启动，但对应模型显示“服务端未配置”并拒绝生成。代理会删除浏览器传入的认证头，再按 Provider 注入服务端 Key。

## 登录与安全

- 会话 Cookie 使用 HMAC-SHA256 签名、`HttpOnly`、`SameSite=Strict`，生产环境默认带 `Secure`；仅显式设置 `LUCEN_COOKIE_SECURE=0` 时用于 HTTP。Cookie Path 限定在 `LUCEN_BASE_PATH`，默认 7 天过期。HSTS 仅在 Secure Cookie 模式发送。HTTP 会以明文传输登录密码和会话 Cookie，只应短期用于可信网络；建议尽快启用 HTTPS 并将 `LUCEN_COOKIE_SECURE` 设为 `1`。
- 同一 IP 在 15 分钟内允许 5 次错误密码，第 6 次开始返回 `429`。
- `/api/local/*`、`/api/lucen/*` 和 `/legacy` 需要会话；公开健康检查只返回 `{ "ok": true }`。
- 修改 `LUCEN_SESSION_SECRET` 会立即使所有已有会话失效。
- 只有在可信反向代理后才设置 `LUCEN_TRUST_PROXY=1`，且不要把应用的 `8787` 端口直接暴露到公网。

## 图片存储、保留期限与备份

生成图以原始字节保存到 `LUCEN_DATA_DIR/images`，WebP 缩略图保存到 `LUCEN_DATA_DIR/thumbnails`。缩略图严格小于 `100000` 字节，列表只加载缩略图；展开、下载和二创才读取原图。服务端会校验 PNG/JPEG/WebP MIME、计算 SHA-256，并在删除时同时移除原图、缩略图和数据库记录。

全局保留期限默认 30 天，可登录现代版或 `/legacy` 在侧栏设置为 1–3650 天的整数。按创建时间计算；收藏图片永久豁免，二创输入图也按同一期限清理。修改设置会立即清理，启动时清理一次，此后每小时运行一次。清理文件失败时会保留数据库记录，并在下一轮重试。

SQLite、原图、缩略图和输入图均位于 `LUCEN_DATA_DIR`。图片仅通过需要登录会话的同源 `/api/local` 接口读取，不是公开图床，也不提供公开直链。备份时先停止应用，再备份完整目录；不要让多个实例同时写入该目录。容量由该目录所在磁盘和现有备份流程管理。

## 构建产物

CI 会执行类型、鉴权、本地媒体存储、Provider 浏览器和 npm 打包验证。`v*` 标签或手动触发 `Publish npm Package` 工作流时，`.tgz` 会上传为 GitHub Actions 构建产物，保留 30 天。
