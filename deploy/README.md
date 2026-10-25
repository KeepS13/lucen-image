# 香港服务器部署

部署主机为 `root@lyj-yecao-207-xianggang`，公网入口为 `http://207.57.127.105/generate-image/`，旧版入口为 `/generate-image/legacy`。

## 文件与运行方式

- 应用：`/opt/lucen/releases/2.0.0`。依赖是该目录中的真实 `node_modules`，不要创建指向自身的符号链接。
- 发布包与锁文件：`/opt/lucen/packages`。文件由本地 SSH/SCP 上传，服务器不从 GitHub 拉取代码。
- 数据：`/var/lib/lucen`。本次使用全新画廊，不迁移青岛或本地数据。
- 环境：`/etc/lucen/lucen.env`，root 所有，权限 600；沿用本地共享密码和 Provider Key，不放进发布包。
- 服务：`/etc/systemd/system/lucen.service`，模板见本目录的 `lucen.service`。
- Nginx：`/etc/nginx/conf.d/99-lucen-image.conf`，模板见 `lucen-image-subpath.nginx.conf`。

复用服务器已有 Node 22.23.3 和 Nginx 1.30.6。应用只监听 `127.0.0.1:8787`；独立 IP 虚拟主机保留 `/var/www/html` 根站行为，其他命名站点不修改。

## 构建与传输

PowerShell 中使用 `$env:LUCEN_BASE_PATH='/generate-image'` 后执行 `npm run package`；根路径构建时移除该变量。除发布包外，将本地 `package-lock.json` 和本目录的配置模板通过 SCP 上传。

在版本目录解包（`tar --strip-components=1`），放入锁文件后执行 `npm ci --omit=dev --no-audit --no-fund`。本部署通过 `npm_config_build_from_source=true npm_config_nodedir=/usr PYTHON=/usr/bin/python3` 使用本机 Node 头文件构建 SQLite，避免依赖 GitHub 或 nodejs.org 下载。完成安装后将应用目录设为 root:lucen，赋予 lucen 读取和目录遍历权限；数据目录由 lucen 写入。

首次启用前备份 `/etc/nginx` 到 `/opt/lucen/backups`。安装并启动 systemd 单元，确认内部健康检查后再安装 Nginx 片段；先 `nginx -t` 成功，再 `systemctl reload nginx`。失败时恢复该片段的备份并重新测试配置，不覆盖其他站点。

## 运维与回退

健康检查：`curl --fail http://127.0.0.1:8787/generate-image/__health`，应返回 `{ "ok": true }`。

查看状态：`systemctl status lucen`。查看日志：`journalctl -u lucen -n 60 --no-pager`，Nginx 日志为 `/var/log/nginx/lucen-image.access.log` 和 `lucen-image.error.log`。

升级时在新目录准备完整依赖，不改名正在运行的依赖目录。更新单元里的版本路径并执行 `systemctl daemon-reload`、`systemctl restart lucen`，随后以健康接口为准检查就绪。失败时将单元切回完整的旧版本并重启；只看到 systemd active 不能替代健康检查。

新 IP 入口回退时删除本次新增的 `99-lucen-image.conf`，通过 `nginx -t` 后 reload，并停止 Lucen 服务。现有默认站点仍保留。

## 验收边界

真实 GPT/Gemini 请求仅查询模型列表，检查凭据与网络链路；生图请求通过本地模拟 Provider 测试，不执行计费生成。HTTP 部署显式设置 `LUCEN_COOKIE_SECURE=0`，Cookie 仍有 HttpOnly、SameSite=Strict、7 天有效期及子路径 Path。后续启用 HTTPS 时将该变量恢复为 1。

## 本次发布结果（2026-10-25）

发布包 SHA-256：`cce8abb051d41a7878ed7723cebf8937205749aebbb7cc6910ce405a92f0404b`。Nginx 原配置备份：`/opt/lucen/backups/initial-20261025-180659`。23 项公网 HTTP 检查通过；桌面、移动端现代版和旧版页面、登录刷新会话均通过；两种 Provider 经真实代理查询模型列表都返回 200，没有执行计费生图。

旧服务器 `root@fsb-aly-qingdao-01` 的 Lucen 已停止并删除，服务单元、专用用户、环境密钥、`/opt/lucen`、`/var/lib/lucen`、`/etc/lucen` 及本次发布备份和临时包已清理；原 IP 根站恢复且内容哈希未变，8787 不再监听。

本地验收记录和截图位于 `output/deployment-hk-20261025/`（已被 Git 忽略）。

## 生成结果传输修复（2026-10-25）

用户两次文生图的供应商响应均为 200，耗时约 14 秒和 20 秒；浏览器在接收约 2 MB、3.6 MB Base64 JSON 时出现 `ERR_INCOMPLETE_CHUNKED_ENCODING`，尚未回传画廊 API，因此图片没有保存。无法仅凭现有证据判断是哪一段网络或中间设备截断连接。

新版文生图先在服务器落盘原图和缩略图，再返回小体积画廊记录；客户端传输中断后可刷新找回已保存结果。生成结果不确定时不自动重发计费请求。响应显式设置 Content-Length，Nginx 仅压缩静态脚本和样式，保留 JSON 长度头。

本地 `npm run verify:generation` 使用模拟 Provider 验证大响应、原始字节哈希、客户端断开、刷新恢复、无重复上传及无自动重试，不调用真实生图接口。原来失败的两次结果没有落盘，日志不包含完整图片，无法从当前服务器恢复。

修复已于 2026-10-25 19:08（Asia/Shanghai）部署。新发布包 SHA-256：`435d236e508b4586c77355329605793232905cb5f2143aeade75bbeafef9b658`；回退备份：`/opt/lucen/backups/fix-generation-20261025-190828`，包含原应用（不含复用的 node_modules）、Nginx 片段及服务单元。鉴权 53 项、存储 22 项、Provider 浏览器 47 项、生成链路回归 24 项通过；公网 17 项验收通过。3,152,409 字节模拟 PNG 原图下载字节一致，耗时 626 ms，临时画廊记录已删除。真实浏览器已加载新脚本，保留原提示词，两个 Provider 连接测试成功；未重新执行计费生图。报告和截图位于 `output/generation-fix/`。

## 图生图遗漏修复（2026-10-25）

19:08 发布只覆盖了文生图，未覆盖 GPT `/images/edits`。用户 20:52 和 20:58 的图生图响应在 25.555 秒和 29.533 秒内已完整到达 Node（3,085,664 和 3,161,708 字节），但浏览器传输出现 `ERR_CONTENT_LENGTH_MISMATCH`，旧分支又自动重试，结果仍未入库。不能把供应商完成时间当成浏览器收到图片的时间，也不能把模拟公网下载通过当成所有真实生图分支均已修复。

本修复将单/多图编辑、现代/旧版页面统一接入服务器先保存；原始 multipart 图片字节和上游路径不变，正确保留 edit 模式、提示词、模型、尺寸和对比输入。图生图输入仅通过鉴权 `/api/local/gallery/:id/source` 按需下载，画廊 JSON 不嵌入它的 Base64。图生图传输中断和不确定 5xx 不再自动重复请求。日志增加请求 ID，以及响应头、响应体和保存阶段耗时。验证仍不调用计费生图接口。

本次补全于 2026-10-25 21:19（Asia/Shanghai）部署。发布包 SHA-256：`84983552fede83e85f159083a90b5326ddba58f36b8cbb4d167d431a71adc4aa`；回退备份：`/opt/lucen/backups/fix-edits-20261025-211913`。生成专项浏览器 43 项、服务器 Node 22 隔离 HTTP 28 项、原 Provider 浏览器 47 项、鉴权 53 项、存储 22 项和公网 21 项通过。Nginx 所有配置及根站均未改变；原画廊和输入图记录一致。当前用户页面已加载 `index-CS5eH3QW.js`，输入图、提示词和既有结果都保留。未重新执行真实计费生图，不能将这些模拟验收视为修改后真实供应商计费请求的成功证明。报告和截图位于 `output/edit-fix/`。

## 用户验收确认（2026-10-25）

用户已在线完成验收并确认没有问题，随后要求将本地改造及修复代码推送到 GitHub。此处记录用户的线上验收反馈；代理在自动回归和发布过程中未额外发起真实计费生图请求。
