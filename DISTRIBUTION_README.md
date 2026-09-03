# Lucen Web 部署说明

## 部署结构

`compose.yaml` 启动两个服务：Caddy 对外监听 `80/443` 并自动管理 HTTPS；Lucen 仅在内部网络监听 `8787`。SQLite、输入图与上传临时文件写入 `lucen-data:/app/data`。

该部署只支持单个 Lucen 实例。所有通过共享密码登录的用户共用工作区、Prompt、画廊和上传队列，也拥有相同删除权限。

## 首次部署

1. 安装 Docker Engine 与 Compose 插件。
2. 将域名解析到 VPS，并开放 `80/tcp`、`443/tcp`、`443/udp`。
3. 根据 `.env.example` 创建 `.env`。
4. 为 `LUCEN_SESSION_SECRET` 生成至少 32 字节的独立随机值。
5. 执行 `docker compose up -d --build`。
6. 访问域名，使用 `LUCEN_ACCESS_PASSWORD` 登录。

生产环境不复制当前开发目录的 `data/`；首次启动会在空的 `lucen-data` 卷中创建 SQLite。升级时不要删除该卷。

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

- 会话 Cookie 使用 HMAC-SHA256 签名、`HttpOnly`、`SameSite=Strict`，生产环境带 `Secure`，默认 7 天过期。
- 同一 IP 在 15 分钟内允许 5 次错误密码，第 6 次开始返回 `429`。
- `/api/local/*`、`/api/lucen/*` 和 `/legacy` 需要会话；公开健康检查只返回 `{ "ok": true }`。
- 修改 `LUCEN_SESSION_SECRET` 会立即使所有已有会话失效。
- 只有在 Caddy 等可信反向代理后才设置 `LUCEN_TRUST_PROXY=1`，且不要把应用的 `8787` 端口直接暴露到公网。

## 图片存储

每张生成图片创建原图和 WebP 缩略图两个独立任务。缩略图严格小于 `100000` 字节，列表只加载缩略图；展开、下载和二创才读取原图。上传成功后会重新下载并校验 MIME、字节数和 SHA-256，然后提交 SQLite 并删除对应本地临时文件。

失败任务默认 5 分钟后重试，HTTP `429 Retry-After` 更长时按其等待。远端 Remit 图片无法通过本应用删除。

## 运维命令

```bash
docker compose ps
docker compose logs -f lucen
docker compose restart lucen
docker compose pull
docker compose up -d
```

停止服务但保留数据：

```bash
docker compose down
```

不要使用 `docker compose down -v`，它会删除 SQLite 数据卷。

## 本地发布准备

`.github/workflows/ci.yml` 会在 PR 上执行类型、鉴权、队列、Provider 浏览器和 Docker 构建检查。`publish.yml` 已配置未来在 `main`、`v*` 标签和手动触发时发布 `ghcr.io/keeps13/lucen-image` 的 `linux/amd64` 镜像。

当前阶段只准备这些文件，不执行 Git 初始化、提交、推送、Actions 或 GHCR 发布。
