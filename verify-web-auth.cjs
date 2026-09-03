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

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Workbench exited before becoming healthy.");
    try {
      const response = await fetch(baseUrl + "/__health");
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
}

async function verifyServerIntegration() {
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
      LUCEN_TEST_UPSTREAM_BASE_URL: "http://127.0.0.1:" + upstreamAddress.port,
      LUCEN_DISABLE_REMIT_UPLOAD: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => (childOutput += chunk));
  child.stderr.on("data", (chunk) => (childOutput += chunk));

  try {
    await waitForHealth(baseUrl, child);

    const health = await fetch(baseUrl + "/__health");
    const healthPayload = await health.json();
    check("公开健康接口仅返回 ok", JSON.stringify(healthPayload) === JSON.stringify({ ok: true }));
    check("响应包含安全头且没有通配 CORS", health.headers.get("x-content-type-options") === "nosniff" && !health.headers.has("access-control-allow-origin"));

    const runtime = await fetch(baseUrl + "/api/runtime/config");
    const runtimePayload = await runtime.json();
    check("运行时配置只暴露 Provider 可用性", runtimePayload.authRequired === true && runtimePayload.providers.gpt === true && runtimePayload.providers.gemini === true && !JSON.stringify(runtimePayload).includes("server-gpt-key"));

    const unauthorized = await fetch(baseUrl + "/api/local/kv?key=shared");
    check("未登录访问本地 API 返回 AUTH_REQUIRED", unauthorized.status === 401 && (await unauthorized.json()).error.code === "AUTH_REQUIRED");

    const legacy = await fetch(baseUrl + "/legacy", { redirect: "manual" });
    check("未登录访问旧版跳转到现代登录页", legacy.status === 302 && /^\/?\?returnTo=/.test(legacy.headers.get("location") || ""));

    const crossOriginLogin = await fetch(baseUrl + "/api/auth/login", {
      ...requestOptions("POST", "https://attacker.example", "", { password: "integration-password" }),
    });
    check("跨域登录请求被拒绝", crossOriginLogin.status === 403);

    const invalidLogin = await fetch(baseUrl + "/api/auth/login", requestOptions("POST", baseUrl, "", { password: "wrong" }));
    check("错误共享密码返回 AUTH_INVALID", invalidLogin.status === 401 && (await invalidLogin.json()).error.code === "AUTH_INVALID");

    const login = await fetch(baseUrl + "/api/auth/login", requestOptions("POST", baseUrl, "", { password: "integration-password" }));
    const loginPayload = await login.json();
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    check("正确密码返回签名会话 Cookie", login.ok && loginPayload.authenticated && cookie.startsWith("lucen_session="));

    const session = await fetch(baseUrl + "/api/auth/session", { headers: { Cookie: cookie } });
    check("会话接口返回登录状态和到期时间", session.ok && (await session.json()).authenticated === true);

    const secondLogin = await fetch(baseUrl + "/api/auth/login", requestOptions("POST", baseUrl, "", { password: "integration-password" }));
    const secondCookie = (secondLogin.headers.get("set-cookie") || "").split(";")[0];
    const write = await fetch(baseUrl + "/api/local/kv", requestOptions("POST", baseUrl, cookie, { key: "shared", value: "visible" }));
    const read = await fetch(baseUrl + "/api/local/kv?key=shared", { headers: { Cookie: secondCookie } });
    check("两个登录会话共享 SQLite 数据", write.ok && read.ok && (await read.json()).value === "visible");

    await fetch(baseUrl + "/api/lucen/gpt/models", {
      headers: { Cookie: cookie, Authorization: "Bearer malicious", "X-Api-Key": "malicious" },
    });
    await fetch(baseUrl + "/api/lucen/gemini/models", {
      headers: { Cookie: cookie, Authorization: "Bearer malicious-gemini" },
    });
    check(
      "代理忽略客户端凭据并按 Provider 注入服务端 Key",
      upstreamRequests.length === 2 &&
        upstreamRequests[0].authorization === "Bearer server-gpt-key" &&
        upstreamRequests[0].xApiKey === "" &&
        upstreamRequests[1].authorization === "Bearer server-gemini-key",
    );

    const forbiddenWrite = await fetch(baseUrl + "/api/local/kv", requestOptions("POST", "https://attacker.example", cookie, { key: "blocked", value: "1" }));
    check("已登录的跨域写请求仍被拒绝", forbiddenWrite.status === 403);

    const logout = await fetch(baseUrl + "/api/auth/logout", requestOptions("POST", baseUrl, cookie));
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
  await verifyServerIntegration();
  const failures = results.filter((item) => !item.passed);
  console.log("\n" + (failures.length ? failures.length + " checks failed." : "All " + results.length + " checks passed."));
  assert.equal(failures.length, 0);
})().catch((error) => {
  console.error("VERIFY CRASH:", error);
  process.exit(1);
});
