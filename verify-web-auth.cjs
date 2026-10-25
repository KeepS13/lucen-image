const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { createAuthManager } = require("./lucen-auth.cjs");

const results = [];

function check(name, condition, detail = "") {
  const passed = Boolean(condition);
  results.push({ name, passed, detail });
  console.log((passed ? "PASS" : "FAIL") + "  " + name + (detail ? "  " + detail : ""));
}

function listen(server, port = 0, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function unusedPort() {
  const server = http.createServer();
  const address = await listen(server);
  await close(server);
  return address.port;
}

async function waitForHealth(baseUrl, child, healthUrl = baseUrl + "/__health") {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Workbench exited before becoming healthy.");
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for workbench health.");
}

function requestOptions(method, baseUrl, cookie, body) {
  const headers = { Origin: baseUrl };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
}

function proxyLogin(baseUrl, host, origin, prefix = "") {
  const payload = JSON.stringify({ password: "integration-password" });
  return new Promise((resolve, reject) => {
    const request = http.request(
      baseUrl + prefix + "/api/auth/login",
      {
        method: "POST",
        headers: {
          Host: host,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve({ status: response.statusCode, body });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function verifyAuthPrimitives() {
  let timestamp = 1_800_000_000_000;
  const options = {
    password: "shared-password",
    sessionSecret: "0123456789abcdef0123456789abcdef",
    ttlSeconds: 604800,
    secureCookie: true,
    now: () => timestamp,
  };
  const auth = createAuthManager(options);
  const ip = "203.0.113.10";

  for (let index = 0; index < 5; index += 1) {
    check("错误密码第 " + (index + 1) + " 次被拒绝", auth.authenticate("wrong", ip).code === "AUTH_INVALID");
  }
  const limited = auth.authenticate("wrong", ip);
  check("同一 IP 第 6 次失败被限流", limited.code === "AUTH_RATE_LIMITED" && limited.retryAfterSeconds > 0);

  const success = auth.authenticate("shared-password", "203.0.113.11");
  check("正确密码签发 7 天会话", success.ok && success.expiresAt === timestamp + 604800000);
  const cookie = auth.sessionCookie(success.token);
  check(
    "生产 Cookie 使用 HttpOnly、SameSite、Secure 和 7 天 Max-Age",
    /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Secure/.test(cookie) && /Max-Age=604800/.test(cookie),
  );
  const request = { headers: { cookie: cookie.split(";")[0] }, socket: {} };
  check("有效签名 Cookie 可恢复会话", auth.sessionFromRequest(request).authenticated);

  const rotated = createAuthManager({ ...options, sessionSecret: "abcdef0123456789abcdef0123456789" });
  check("轮换会话密钥会使旧 Cookie 失效", !rotated.sessionFromRequest(request).authenticated);
  timestamp += 604800001;
  check("超过 7 天的 Cookie 自动失效", !auth.sessionFromRequest(request).authenticated);

  const scopedAuth = createAuthManager({ ...options, secureCookie: false, cookiePath: "/generate-image" });
  const scopedToken = scopedAuth.authenticate("shared-password", "203.0.113.12").token;
  const scopedCookie = scopedAuth.sessionCookie(scopedToken);
  check("子路径 Cookie 使用限定 Path 且可关闭 Secure", /Path=\/generate-image(?:;|$)/.test(scopedCookie) && !/Secure/.test(scopedCookie));
}

async function verifyServerIntegration(options = {}) {
  const basePath = options.basePath || "";
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({
      url: req.url,
      authorization: req.headers.authorization || "",
      xApiKey: req.headers["x-api-key"] || "",
    });
    const model = req.url.includes("gemini") ? "gemini-3.1-flash-image" : "gpt-image-2";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: model }] }));
  });
  const upstreamAddress = await listen(upstream);
  const port = await unusedPort();
  const baseUrl = "http://127.0.0.1:" + port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucen-auth-"));
  const child = spawn(process.execPath, [path.join(__dirname, "lucen-local-proxy.cjs")], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LUCEN_WORKBENCH_HOST: "127.0.0.1",
      LUCEN_WORKBENCH_PORT: String(port),
      LUCEN_DATA_DIR: dataDir,
      LUCEN_ACCESS_PASSWORD: "integration-password",
      LUCEN_SESSION_SECRET: "integration-secret-0123456789abcdef",
      LUCEN_GPT_API_KEY: "server-gpt-key",
      LUCEN_GEMINI_API_KEY: "server-gemini-key",
      LUCEN_TRUST_PROXY: "1",
      LUCEN_BASE_PATH: basePath,
      ...(basePath ? { LUCEN_COOKIE_SECURE: "0" } : {}),
      LUCEN_TEST_UPSTREAM_BASE_URL: "http://127.0.0.1:" + upstreamAddress.port,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => (childOutput += chunk));
  child.stderr.on("data", (chunk) => (childOutput += chunk));

  try {
    const prefix = basePath;
    await waitForHealth(baseUrl, child, baseUrl + prefix + "/__health");

    if (prefix) {
      const built = spawnSync(process.execPath, [path.join(__dirname, "node_modules/vite/bin/vite.js"), "build"], {
        cwd: __dirname,
        env: { ...process.env, LUCEN_BASE_PATH: prefix },
        encoding: "utf8",
        timeout: 120000,
      });
      check("子路径生产构建成功", built.status === 0, String(built.stderr || "").trim().slice(0, 300));
      const bare = await fetch(baseUrl + prefix, { redirect: "manual" });
      check("子路径裸地址 308 跳转到带斜杠入口", bare.status === 308 && bare.headers.get("location") === prefix + "/");
      const outside = await fetch(baseUrl + "/__health");
      check("子路径模式不暴露根路径健康检查", outside.status === 404);
      const index = await fetch(baseUrl + prefix + "/");
      const indexHtml = await index.text();
      check("子路径首页引用带前缀的静态资源", index.ok && indexHtml.includes(prefix + "/assets/") && !indexHtml.includes("src=\"/assets/"));
    }

    const health = await fetch(baseUrl + prefix + "/__health");
    const healthPayload = await health.json();
    check("公开健康接口仅返回 ok", JSON.stringify(healthPayload) === JSON.stringify({ ok: true }));
    check("响应包含安全头且没有通配 CORS", health.headers.get("x-content-type-options") === "nosniff" && !health.headers.has("access-control-allow-origin"));
    check("测试模式响应不发送 HSTS", !health.headers.has("strict-transport-security"));

    const runtime = await fetch(baseUrl + prefix + "/api/runtime/config");
    const runtimePayload = await runtime.json();
    check("运行时配置只暴露 Provider 可用性", runtimePayload.authRequired === true && runtimePayload.providers.gpt === true && runtimePayload.providers.gemini === true && !JSON.stringify(runtimePayload).includes("server-gpt-key"));

    const unauthorized = await fetch(baseUrl + prefix + "/api/local/kv?key=shared");
    check("未登录访问本地 API 返回 AUTH_REQUIRED", unauthorized.status === 401 && (await unauthorized.json()).error.code === "AUTH_REQUIRED");

    const legacy = await fetch(baseUrl + prefix + "/legacy", { redirect: "manual" });
    check("未登录访问旧版跳转到现代登录页", legacy.status === 302 && String(legacy.headers.get("location") || "").includes("?returnTo=") && String(legacy.headers.get("location") || "").startsWith(prefix + "/"));

    const crossOriginLogin = await fetch(baseUrl + prefix + "/api/auth/login", {
      ...requestOptions("POST", "https://attacker.example", "", { password: "integration-password" }),
    });
    check("跨域登录请求被拒绝", crossOriginLogin.status === 403);

    const previewHost = "8787-env.monkeycode-ai.online";
    const trustedProxyLogin = await proxyLogin(baseUrl, previewHost, "https://" + previewHost, prefix);
    check(
      "可信代理未转发协议时允许同 Host 的 HTTPS 登录",
      trustedProxyLogin.status === 200 && trustedProxyLogin.body.authenticated === true,
    );

    const spoofedProxyLogin = await proxyLogin(baseUrl, previewHost, "https://attacker.example", prefix);
    check("可信代理仍拒绝不同 Host 的 Origin", spoofedProxyLogin.status === 403);

    const invalidLogin = await fetch(baseUrl + prefix + "/api/auth/login", requestOptions("POST", baseUrl, "", { password: "wrong" }));
    check("错误共享密码返回 AUTH_INVALID", invalidLogin.status === 401 && (await invalidLogin.json()).error.code === "AUTH_INVALID");

    const login = await fetch(baseUrl + prefix + "/api/auth/login", requestOptions("POST", baseUrl, "", { password: "integration-password" }));
    const loginPayload = await login.json();
    const cookieHeader = login.headers.get("set-cookie") || "";
    const cookie = cookieHeader.split(";")[0];
    check("正确密码返回签名会话 Cookie", login.ok && loginPayload.authenticated && cookie.startsWith("lucen_session="));

    const session = await fetch(baseUrl + prefix + "/api/auth/session", { headers: { Cookie: cookie } });
    check("会话接口返回登录状态和到期时间", session.ok && (await session.json()).authenticated === true);

    const secondLogin = await fetch(baseUrl + prefix + "/api/auth/login", requestOptions("POST", baseUrl, "", { password: "integration-password" }));
    const secondCookie = (secondLogin.headers.get("set-cookie") || "").split(";")[0];
    const write = await fetch(baseUrl + prefix + "/api/local/kv", requestOptions("POST", baseUrl, cookie, { key: "shared", value: "visible" }));
    const read = await fetch(baseUrl + prefix + "/api/local/kv?key=shared", { headers: { Cookie: secondCookie } });
    check("两个登录会话共享 SQLite 数据", write.ok && read.ok && (await read.json()).value === "visible");

    await fetch(baseUrl + prefix + "/api/lucen/gpt/models", {
      headers: { Cookie: cookie, Authorization: "Bearer malicious", "X-Api-Key": "malicious" },
    });
    await fetch(baseUrl + prefix + "/api/lucen/gemini/models", {
      headers: { Cookie: cookie, Authorization: "Bearer malicious-gemini" },
    });
    check(
      "代理忽略客户端凭据并按 Provider 注入服务端 Key",
      upstreamRequests.length === 2 &&
        upstreamRequests[0].authorization === "Bearer server-gpt-key" &&
        upstreamRequests[0].xApiKey === "" &&
        upstreamRequests[1].authorization === "Bearer server-gemini-key",
    );

    const forbiddenWrite = await fetch(baseUrl + prefix + "/api/local/kv", requestOptions("POST", "https://attacker.example", cookie, { key: "blocked", value: "1" }));
    check("已登录的跨域写请求仍被拒绝", forbiddenWrite.status === 403);

    const logout = await fetch(baseUrl + prefix + "/api/auth/logout", requestOptions("POST", baseUrl, cookie));
    check("退出接口清除会话 Cookie", logout.ok && /Max-Age=0/.test(logout.headers.get("set-cookie") || ""));
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    await close(upstream);
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (child.exitCode !== 0 && process.platform !== "win32") {
      check("服务响应 SIGTERM 并正常退出", false, childOutput.trim());
    } else {
      check("服务可停止且临时数据可清理", true);
    }
  }
}

async function verifyProductionHttpHeaders() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucen-prod-http-"));
  const port = await unusedPort();
  const baseUrl = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, [path.join(__dirname, "lucen-local-proxy.cjs")], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: "production",
      LUCEN_WORKBENCH_HOST: "127.0.0.1",
      LUCEN_WORKBENCH_PORT: String(port),
      LUCEN_DATA_DIR: dataDir,
      LUCEN_ACCESS_PASSWORD: "integration-password",
      LUCEN_SESSION_SECRET: "integration-secret-0123456789abcdef",
      LUCEN_BASE_PATH: "/generate-image",
      LUCEN_COOKIE_SECURE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForHealth(baseUrl, child, baseUrl + "/generate-image/__health");
    const health = await fetch(baseUrl + "/generate-image/__health");
    check("HTTP production with non-Secure Cookie omits HSTS", !health.headers.has("strict-transport-security"));
    const payload = JSON.stringify({ password: "integration-password" });
    const login = await fetch(baseUrl + "/generate-image/api/auth/login", {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: payload,
    });
    const cookie = login.headers.get("set-cookie") || "";
    check("HTTP production Cookie omits Secure and scopes Path", login.ok && /Path=\/generate-image(?:;|$)/.test(cookie) && !/; Secure(?:;|$)/.test(cookie));
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
function verifyProductionGuard() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucen-prod-guard-"));
  const env = { ...process.env, NODE_ENV: "production", LUCEN_DATA_DIR: dataDir };
  delete env.LUCEN_ACCESS_PASSWORD;
  delete env.LUCEN_SESSION_SECRET;
  const result = spawnSync(process.execPath, [path.join(__dirname, "lucen-local-proxy.cjs")], {
    cwd: __dirname,
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
  check("生产模式缺少鉴权 Secret 时拒绝启动", result.status !== 0 && /requires LUCEN_ACCESS_PASSWORD/.test(result.stderr));
}

(async () => {
  verifyAuthPrimitives();
  verifyProductionGuard();
  await verifyProductionHttpHeaders();
  await verifyServerIntegration();
  await verifyServerIntegration({ basePath: "/generate-image" });
  const failures = results.filter((item) => !item.passed);
  console.log("\n" + (failures.length ? failures.length + " checks failed." : "All " + results.length + " checks passed."));
  assert.equal(failures.length, 0);
})().catch((error) => {
  console.error("VERIFY CRASH:", error);
  process.exit(1);
});
