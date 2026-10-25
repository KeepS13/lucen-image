/* 双 Provider 浏览器验收：所有 Lucen 请求均被拦截，不访问真实上游。 */
const { chromium } = require("playwright-core");
const { randomUUID } = require("crypto");
const sharp = require("sharp");

const BASE_URL = (process.env.WORKBENCH_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const BASE_PATH = process.env.LUCEN_BASE_PATH || "";
const GPT_MODEL_IDS = [
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
];
const GPT_MODEL = GPT_MODEL_IDS[0];
const GEMINI_MODEL = "gemini-3.1-flash-image";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cf//Z";
const WEBP_BASE64 = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==";

const results = [];
function check(name, condition, detail = "") {
  const passed = Boolean(condition);
  results.push({ name, passed, detail });
  console.log((passed ? "PASS" : "FAIL") + "  " + name + (detail ? "  " + detail : ""));
}

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

async function installMocks(page, options = {}) {
  const routePath = (pathname) => BASE_PATH && pathname.startsWith(BASE_PATH + "/") ? pathname.slice(BASE_PATH.length) : pathname;
  const state = {
    authenticated: options.authenticated !== false,
    kv: new Map(),
    gallery: [],
    files: new Map(),
    inputs: new Map(),
    prompts: [],
    providerRequests: [],
    galleryPosts: [],
    localRequests: [],
    geminiResponseIndex: 0,
    storage: { retentionDays: options.retentionDays || 30, nextCleanupAt: Date.now() + 3600000, lastCleanupAt: null, lastDeletedCount: 0, galleryCount: 0, inputCount: 0, lastError: null },
  };

  await page.route("**/api/auth/session", (route) =>
    json(route, 200, {
      authenticated: state.authenticated,
      expiresAt: state.authenticated ? Date.now() + 604800000 : null,
    }),
  );
  await page.route("**/api/auth/login", (route) => {
    const body = route.request().postDataJSON();
    if (body.password !== (options.password || "browser-password")) {
      return json(route, 401, { error: { code: "AUTH_INVALID", message: "Invalid access password." } });
    }
    state.authenticated = true;
    return json(route, 200, { authenticated: true, expiresAt: Date.now() + 604800000 });
  });
  await page.route("**/api/auth/logout", (route) => {
    state.authenticated = false;
    return json(route, 200, { ok: true });
  });
  await page.route("**/api/runtime/config", (route) =>
    json(route, 200, { authRequired: true, providers: { gpt: true, gemini: true } }),
  );

  await page.route("**/api/local/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = routePath(url.pathname);
    const method = request.method();
    state.localRequests.push({ path, method });

    if (path === "/api/local/kv" && method === "GET") {
      return json(route, 200, { value: state.kv.get(url.searchParams.get("key")) || null });
    }
    if (path === "/api/local/kv" && method === "POST") {
      const body = request.postDataJSON();
      state.kv.set(body.key, body.value);
      return json(route, 200, { ok: true });
    }
    if (path === "/api/local/gallery" && method === "GET") {
      const workspaceId = url.searchParams.get("workspaceId");
      const items = state.gallery
        .filter((item) => !workspaceId || item.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt - a.createdAt);
      return json(route, 200, {
        items,
        total: items.length,
        limit: Number(url.searchParams.get("limit") || 300),
        offset: 0,
        hasMore: false,
      });
    }
    if (path === "/api/local/gallery" && method === "POST") {
      const body = request.postDataJSON();
      const extension = body.mime === "image/jpeg" ? ".jpg" : body.mime === "image/webp" ? ".webp" : ".png";
      const filename = body.blob ? body.id + extension : null;
      const record = {
        ...body,
        filename,
        favorite: 0,
        mime: body.mime || "image/png",
        contentSha256: "mock-sha256",
        thumbnailMime: "image/webp",
        thumbnailSha256: "mock-thumb-sha256",
        thumbnailByteSize: Buffer.from(WEBP_BASE64, "base64").length,
        thumbnailReady: true,
        expiresAt: Date.now() + 30 * 86400000,
      };
      delete record.blob;
      state.gallery.unshift(record);
      state.galleryPosts.push({ ...body, filename });
      if (filename) {
        state.files.set(filename, {
          buffer: Buffer.from(body.blob, "base64"),
          mime: body.mime || "image/png",
        });
        state.files.set(body.id + ".thumb.webp", {
          buffer: Buffer.from(WEBP_BASE64, "base64"),
          mime: "image/webp",
        });
      }
      return json(route, 200, { ok: true, filename, record });
    }
    const contentMatch = path.match(/^\/api\/local\/gallery\/([^/]+)\/content$/);
    if (contentMatch && method === "GET") {
      const id = decodeURIComponent(contentMatch[1]);
      const record = state.gallery.find((item) => item.id === id);
      const file = record && state.files.get(record.filename);
      if (!file) return json(route, 404, { error: "Not found" });
      return route.fulfill({ status: 200, contentType: file.mime, body: file.buffer });
    }
    const thumbnailMatch = path.match(/^\/api\/local\/gallery\/([^/]+)\/thumbnail$/);
    if (thumbnailMatch && method === "GET") {
      const file = state.files.get(decodeURIComponent(thumbnailMatch[1]) + ".thumb.webp");
      if (!file) return json(route, 404, { error: "Not found" });
      return route.fulfill({ status: 200, contentType: "image/webp", body: file.buffer });
    }
    const galleryMatch = path.match(/^\/api\/local\/gallery\/([^/]+)$/);
    if (galleryMatch && method === "GET") {
      const record = state.gallery.find((item) => item.id === decodeURIComponent(galleryMatch[1]));
      return record ? json(route, 200, record) : json(route, 404, { error: "Not found" });
    }
    if (galleryMatch && method === "DELETE") {
      const id = decodeURIComponent(galleryMatch[1]);
      const index = state.gallery.findIndex((item) => item.id === id);
      if (index >= 0) state.gallery.splice(index, 1);
      return json(route, 200, { ok: true, deleted: index >= 0, remoteRetained: false });
    }
    if (path === "/api/local/storage" && method === "GET") {
      return json(route, 200, {
        ...state.storage,
        galleryCount: state.gallery.length,
        inputCount: state.inputs.size,
        nextCleanupAt: state.storage.nextCleanupAt || Date.now() + 3600000,
      });
    }
    if (path === "/api/local/storage" && method === "PUT") {
      const body = request.postDataJSON();
      const days = Number(body.retentionDays);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return json(route, 400, { error: { code: "INVALID_RETENTION_DAYS", message: "Retention days must be an integer between 1 and 3650." } });
      }
      state.storage.retentionDays = days;
      return json(route, 200, { ...state.storage, galleryCount: state.gallery.length, inputCount: state.inputs.size, deleted: 0, failures: [] });
    }
    if (path.startsWith("/api/local/image/") && method === "GET") {
      const filename = decodeURIComponent(path.split("/").pop());
      const file = state.files.get(filename);
      if (!file) return json(route, 404, { error: "Not found" });
      return route.fulfill({ status: 200, contentType: file.mime, body: file.buffer });
    }
    if (path === "/api/local/inputs" && method === "POST") {
      const body = request.postDataJSON();
      state.inputs.set(body.id, body);
      return json(route, 200, { ok: true });
    }
    if (path === "/api/local/inputs" && method === "GET") {
      const input = state.inputs.get(url.searchParams.get("id"));
      return input ? json(route, 200, input) : json(route, 404, { error: "Not found" });
    }
    if (path.startsWith("/api/local/inputs/") && method === "DELETE") {
      state.inputs.delete(path.split("/").pop());
      return json(route, 200, { ok: true });
    }
    if (path === "/api/local/prompts" && method === "GET") {
      const kind = url.searchParams.get("kind");
      return json(route, 200, { items: state.prompts.filter((item) => item.kind === kind) });
    }
    if (path === "/api/local/prompts" && method === "POST") {
      state.prompts.push(request.postDataJSON());
      return json(route, 200, { ok: true });
    }
    if (path === "/api/local/prompts/update" && method === "PUT") {
      return json(route, 200, { ok: true });
    }
    return json(route, 200, { ok: true });
  });

  await page.route("**/api/lucen/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = routePath(url.pathname);
    const provider = path.includes("/gemini/") ? "gemini" : "gpt";
    const entry = {
      provider,
      path,
      method: request.method(),
      authorization: request.headers().authorization || "",
      body: request.postData() || "",
    };
    state.providerRequests.push(entry);

    if (path.endsWith("/models")) {
      const models = provider === "gemini" ? [GEMINI_MODEL] : GPT_MODEL_IDS;
      return json(route, 200, { data: models.map((id) => ({ id })) });
    }
    if (provider === "gpt" && path.endsWith("/images/generations")) {
      return json(route, 200, { data: [{ b64_json: PNG_BASE64, mime_type: "image/png" }] });
    }
    if (provider === "gemini" && path.endsWith(":" + "generateContent")) {
      const variants = [
        ["image/jpeg", JPEG_BASE64],
        ["image/png", PNG_BASE64],
        ["image/webp", WEBP_BASE64],
      ];
      const [mimeType, data] = variants[state.geminiResponseIndex++ % variants.length];
      return json(route, 200, {
        candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }],
      });
    }
    return json(route, 404, { error: { message: "Unhandled mock route" } });
  });

  return state;
}

async function waitForWorkspace(page, selector) {
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(500);
}

async function verifyGalleryStorage() {
  const login = await fetch(BASE_URL + BASE_PATH + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "browser-password" }),
  });
  const sessionCookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const authHeaders = sessionCookie ? { Cookie: sessionCookie } : {};
  const variants = [
    ["image/jpeg", "jpg", JPEG_BASE64],
    ["image/png", "png", PNG_BASE64],
    ["image/webp", "webp", WEBP_BASE64],
  ];
  for (const [mime, extension, blob] of variants) {
    const id = "verify-provider-" + randomUUID();
    const inputBlob = mime === "image/webp"
      ? (await sharp(Buffer.from(PNG_BASE64, "base64")).webp().toBuffer()).toString("base64")
      : blob;
    try {
      const response = await fetch(BASE_URL + BASE_PATH + "/api/local/gallery", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          id,
          workspaceId: "verify-provider",
          workspaceTitle: "Provider verification",
          prompt: "mock only",
          revisedPrompt: "",
          model: GEMINI_MODEL,
          size: "1K · 1:1",
          mode: "text",
          blob: inputBlob,
          mime,
          createdAt: Date.now(),
        }),
      });
      const stored = await response.json();
      const image = await fetch(BASE_URL + BASE_PATH + "/api/local/gallery/" + id + "/content", { headers: authHeaders });
      const bytes = Buffer.from(await image.arrayBuffer());
      const thumbnail = await fetch(BASE_URL + BASE_PATH + "/api/local/gallery/" + id + "/thumbnail", { headers: authHeaders });
      const thumbnailBytes = Buffer.from(await thumbnail.arrayBuffer());
      check(
        "本地媒体接口返回真实 " + mime,
        response.ok && stored.filename === id + "." + extension && stored.record.filename === id + "." + extension && stored.record.mime === mime &&
          image.headers.get("content-type") === mime &&
          bytes.equals(Buffer.from(inputBlob, "base64")) &&
          thumbnail.ok && thumbnail.headers.get("content-type") === "image/webp" &&
          thumbnailBytes.length > 12 && thumbnailBytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          thumbnailBytes.subarray(8, 12).toString("ascii") === "WEBP",
      );
    } finally {
      await fetch(BASE_URL + BASE_PATH + "/api/local/gallery/" + id, { method: "DELETE", headers: authHeaders });
    }
  }
}

async function verifyLogin(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await installMocks(page, { authenticated: false, password: "browser-password" });
  await page.goto(BASE_URL + BASE_PATH + "/", { waitUntil: "domcontentloaded" });
  await page.getByLabel("访问密码").waitFor({ state: "visible", timeout: 5000 });
  check("未登录时现代版只显示访问密码入口", (await page.locator("[data-ws]").count()) === 0);
  await page.getByLabel("访问密码").fill("wrong");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByText("访问密码不正确", { exact: true }).waitFor({ timeout: 3000 });
  await page.getByLabel("访问密码").fill("browser-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await waitForWorkspace(page, "[data-ws]");
  check("正确共享密码进入工作台", (await page.locator("[data-ws]").count()) > 0);
  check("登录页移动端无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await context.close();
}

async function verifyModern(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem(
      "lucen2-settings",
      JSON.stringify({ persistKey: true, apiKey: "old-gpt-key", theme: "dark" }),
    );
    sessionStorage.setItem("lucen2-session-key", "old-session-gpt");
    sessionStorage.setItem("lucen2-gemini-session-key", "old-session-gemini");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await installMocks(page);

  await page.goto(BASE_URL + BASE_PATH + "/", { waitUntil: "domcontentloaded" });
  await waitForWorkspace(page, "[data-ws]");
  const workspace = page.locator("[data-ws]").first();

  const storageCard = page.getByRole("region", { name: "本地存储" });
  check("新版显示本地存储设置卡", await storageCard.isVisible() && await page.locator("#storage-retention-days").inputValue() === "30");
  check("新版不再显示 Remit 文案", (await page.getByText(/Remit|图床|上传中|等待重试/).count()) === 0);
  await page.locator("#storage-retention-days").fill("0");
  await page.waitForTimeout(100);
  check("新版输入框约束非法保留天数", await page.locator("#storage-retention-days").evaluate((input) => input.validity.rangeUnderflow));
  await page.locator("#storage-retention-days").fill("45");
  await page.waitForTimeout(100);
  await storageCard.getByRole("button", { name: "保存" }).click();
  await page.waitForFunction(() => document.querySelector("#storage-retention-days")?.value === "45");
  check("新版设置保存后刷新共享存储状态", state.storage.retentionDays === 45);
  check("新版移除 Base URL 控件", (await page.getByText(/BASE URL/i).count()) === 0);
  check(
    "新版不再展示 Provider Key 输入",
    (await page.locator('input[aria-label*="KEY" i]').count()) === 0 &&
      (await page.getByText(/保存两把 key/i).count()) === 0,
  );
  const cleared = await page.evaluate(() => ({
    settings: JSON.parse(localStorage.getItem("lucen2-settings") || "{}"),
    gpt: sessionStorage.getItem("lucen2-session-key"),
    gemini: sessionStorage.getItem("lucen2-gemini-session-key"),
  }));
  check(
    "新版启动时清除历史浏览器 Key",
    !Object.hasOwn(cleared.settings, "apiKey") &&
      !Object.hasOwn(cleared.settings, "gptApiKey") &&
      !Object.hasOwn(cleared.settings, "geminiApiKey") &&
      cleared.gpt === null && cleared.gemini === null,
  );

  await page.getByRole("button", { name: "测试 GPT" }).click();
  await page.getByText("连接成功，模型可用", { exact: true }).first().waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "测试 Gemini" }).click();
  await page.getByText("连接成功，模型可用", { exact: true }).nth(1).waitFor({ timeout: 5000 });
  check(
    "新版两种 Provider 独立测试且不发送浏览器认证头",
    state.providerRequests.filter((entry) => entry.path.endsWith("/models")).length === 2 &&
      state.providerRequests.filter((entry) => entry.path.endsWith("/models")).every((entry) => !entry.authorization),
  );

  await workspace.getByRole("button", { name: "图生图" }).click();
  await workspace.locator('input[type="file"]').setInputFiles({
    name: "kept-input.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });
  for (let attempt = 0; attempt < 60 && state.inputs.size === 0; attempt += 1) {
    await page.waitForTimeout(50);
  }
  if (state.inputs.size === 0) throw new Error("Reference image was not persisted before Gemini paste verification");
  await workspace.locator("select").first().selectOption(GEMINI_MODEL);
  check("新版选择 Gemini 后图生图禁用", await workspace.getByRole("button", { name: "图生图" }).isDisabled());
  check("新版 Gemini 参数控件显示", await workspace.getByLabel("宽高比").isVisible() && await workspace.getByLabel("分辨率").isVisible());
  check("新版 Gemini 隐藏 GPT 高级参数", (await workspace.getByRole("button", { name: /高级配置/ }).count()) === 0);
  const inputIdsBeforePaste = [...state.inputs.keys()].sort();
  await page.evaluate((pngBase64) => {
    const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "blocked-gemini-input.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  }, PNG_BASE64);
  await page.getByText("Gemini 仅支持文生图，请先切换到 GPT Image 2", { exact: true }).waitFor({ timeout: 3000 });
  await page.waitForTimeout(250);
  check(
    "新版 Gemini 拦截粘贴图片且不写入输入图",
    JSON.stringify([...state.inputs.keys()].sort()) === JSON.stringify(inputIdsBeforePaste),
  );

  await workspace.getByLabel("宽高比").selectOption("16:9");
  await workspace.getByLabel("分辨率").selectOption("2K");
  await workspace.locator("textarea").fill("mock gemini image");
  for (let index = 0; index < 3; index += 1) {
    await workspace.getByRole("button", { name: "开始生成" }).click();
    await page.waitForFunction(
      (expected) => document.body.textContent.includes("完成 " + expected + " 张"),
      1,
      { timeout: 5000 },
    );
    await page.waitForTimeout(150);
  }

  const geminiCalls = state.providerRequests.filter((entry) => entry.path.endsWith(":" + "generateContent"));
  const geminiBody = JSON.parse(geminiCalls[0].body);
  check(
    "新版 Gemini URL 与 generateContent 请求体正确",
    geminiCalls.length === 3 &&
      geminiCalls.every((entry) => entry.path.endsWith("/api/lucen/gemini/v1beta/models/" + GEMINI_MODEL + ":generateContent")) &&
      geminiCalls.every((entry) => !entry.authorization) &&
      geminiBody.generationConfig.responseModalities[0] === "IMAGE" &&
      geminiBody.generationConfig.imageConfig.aspectRatio === "16:9" &&
      geminiBody.generationConfig.imageConfig.imageSize === "2K",
  );
  const mimeFiles = state.galleryPosts.slice(-3).map((item) => item.mime + ":" + item.filename.split(".").pop());
  check(
    "Gemini JPEG、PNG、WebP 使用真实扩展名落盘",
    mimeFiles.includes("image/jpeg:jpg") && mimeFiles.includes("image/png:png") && mimeFiles.includes("image/webp:webp"),
    mimeFiles.join(", "),
  );

  await workspace.locator("select").first().selectOption(GPT_MODEL);
  await workspace.getByRole("button", { name: "图生图" }).click();
  check("新版切回 GPT 后输入图仍保留", (await workspace.locator('img[alt="kept-input.png"]').count()) === 1);
  await workspace.getByRole("button", { name: "文生图" }).click();
  await workspace.locator("textarea").fill("mock gpt image");
  await workspace.getByRole("button", { name: "开始生成" }).click();
  await page.waitForTimeout(500);
  const gptCall = state.providerRequests.find((entry) => entry.path.endsWith("/images/generations"));
  const gptBody = JSON.parse(gptCall.body);
  check(
    "新版 GPT Images URL 与请求体正确",
    gptCall.path.endsWith("/api/lucen/gpt/images/generations") &&
      !gptCall.authorization && gptBody.model === GPT_MODEL,
  );

  check(
    "新版提供全部 GPT 生图模型",
    JSON.stringify(await workspace.locator("select").first().locator("option").evaluateAll((options) => options.map((option) => option.value))) ===
      JSON.stringify([...GPT_MODEL_IDS, GEMINI_MODEL]),
  );
  await workspace.locator("select").first().selectOption("gpt-image-2.5-sunburst");
  await workspace.locator("textarea").fill("mock gpt image 2.5 sunburst");
  const gptCallCount = state.providerRequests.filter((entry) => entry.path.endsWith("/images/generations")).length;
  await workspace.getByRole("button", { name: "开始生成" }).click();
  await page.waitForFunction(
    () => document.body.textContent.includes("完成 1 张"),
    null,
    { timeout: 5000 },
  );
  const sunburstCall = state.providerRequests
    .filter((entry) => entry.path.endsWith("/images/generations"))
    .at(-1);
  check(
    "新版新模型使用 GPT 路由并传递所选模型",
    state.providerRequests.filter((entry) => entry.path.endsWith("/images/generations")).length > gptCallCount &&
      sunburstCall.path.endsWith("/api/lucen/gpt/images/generations") &&
      JSON.parse(sunburstCall.body).model === "gpt-image-2.5-sunburst",
  );
  const contentBeforeOpen = state.localRequests.filter((entry) => entry.path.endsWith("/content")).length;
  const thumbnailRequests = state.localRequests.filter((entry) => entry.path.endsWith("/thumbnail")).length;
  const resultImage = page.locator("[data-ws] .neon-border img").first();
  check("新版结果卡片只请求缩略图", thumbnailRequests > 0 && contentBeforeOpen === 0);
  await resultImage.click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 3000 });
  await page.waitForTimeout(250);
  check("新版展开后才请求原图内容", state.localRequests.filter((entry) => entry.path.endsWith("/content")).length > contentBeforeOpen);
  await page.keyboard.press("Escape");

  await page.waitForTimeout(400);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForWorkspace(page, "[data-ws]");
  check("新版刷新后画廊结果可重载", (await page.locator("[data-ws] img").count()) >= 4 && (await page.getByText(/Remit|图床|上传中|等待重试/).count()) === 0);
  const reloadedWorkspace = page.locator("[data-ws]").first();
  await reloadedWorkspace.locator("select").first().selectOption(GEMINI_MODEL);
  await page.waitForTimeout(1800);

  await page.screenshot({ path: "shot-gemini-new-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  check("新版移动端无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: "shot-gemini-new-mobile.png", fullPage: true });
  check("新版无页面脚本异常", errors.length === 0, errors.join(" | "));
  await context.close();
}

async function verifyLegacy(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem(
      "lucen-image-studio-settings",
      JSON.stringify({ persistKey: true, apiKey: "legacy-old-gpt" }),
    );
    sessionStorage.setItem("lucen-image-studio-session-key", "legacy-session-gpt");
    sessionStorage.setItem("lucen-image-studio-gemini-session-key", "legacy-session-gemini");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await installMocks(page, { retentionDays: 45 });

  if (BASE_PATH) {
    const login = await fetch(BASE_URL + BASE_PATH + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "browser-password" }),
    });
    const setCookie = login.headers.get("set-cookie") || "";
    const sessionCookie = setCookie.split(";")[0];
    await page.context().addCookies([{
      name: "lucen_session",
      value: sessionCookie.slice(sessionCookie.indexOf("=") + 1),
      url: BASE_URL + BASE_PATH + "/",
      httpOnly: true,
      sameSite: "Strict",
    }]);
  }
  await page.goto(BASE_URL + BASE_PATH + "/legacy", { waitUntil: "domcontentloaded" });
  await waitForWorkspace(page, ".workspace");
  const workspace = page.locator(".workspace").first();
  await page.waitForFunction(() => document.querySelector("#storageRetentionDays")?.value === "45");
  check("旧版显示本地存储设置卡", await page.getByRole("region", { name: "本地存储" }).isVisible() && await page.locator("#storageRetentionDays").inputValue() === "45");
  check("旧版不再显示 Remit 文案", (await page.getByText(/Remit|图床|上传中|等待重试/).count()) === 0);
  await page.locator("#storageRetentionDays").fill("0");
  await page.waitForTimeout(100);
  check("旧版输入框约束非法保留天数", await page.locator("#storageRetentionDays").evaluate((input) => input.validity.rangeUnderflow));
  check("旧版移除 Base URL 控件", (await page.getByText(/Base URL/i).count()) === 0);
  check("旧版不再展示 Provider Key 输入", (await page.locator("#gptApiKeyInput, #geminiApiKeyInput, #persistKeyInput").count()) === 0);
  const legacyCleared = await page.evaluate(() => ({
    settings: JSON.parse(localStorage.getItem("lucen-image-studio-settings") || "{}"),
    gpt: sessionStorage.getItem("lucen-image-studio-session-key"),
    gemini: sessionStorage.getItem("lucen-image-studio-gemini-session-key"),
  }));
  check("旧版启动时清除历史浏览器 Key", !Object.hasOwn(legacyCleared.settings, "apiKey") && legacyCleared.gpt === null && legacyCleared.gemini === null);

  await page.locator("#testGptBtn").click();
  await page.locator("#testGeminiBtn").click();
  await page.locator("#gptConnectionStatus.ok").waitFor({ timeout: 5000 });
  await page.locator("#geminiConnectionStatus.ok").waitFor({ timeout: 5000 });
  check("旧版 GPT 与 Gemini 独立连接测试且不发送认证头", state.providerRequests.filter((entry) => entry.path.endsWith("/models")).every((entry) => !entry.authorization));

  await workspace.locator(".model-select").selectOption(GEMINI_MODEL);
  check("旧版选择 Gemini 后图生图禁用", await workspace.locator('[data-mode="edit"]').isDisabled());
  check(
    "旧版 Gemini 参数控件显示",
    await workspace.locator(".aspect-ratio-select").isVisible() && await workspace.locator(".image-size-select").isVisible(),
  );
  check("旧版 Gemini 隐藏 GPT 尺寸控件", !(await workspace.locator(".size-select").isVisible()));
  await workspace.locator(".aspect-ratio-select").selectOption("21:9");
  await workspace.locator(".image-size-select").selectOption("4K");
  await workspace.locator(".prompt-input").fill("legacy mock gemini image");
  await workspace.locator(".run-btn").click();
  await workspace.locator(".workspace-status.ok").waitFor({ timeout: 5000 });
  const call = state.providerRequests.find((entry) => entry.path.endsWith(":" + "generateContent"));
  const body = JSON.parse(call.body);
  check(
    "旧版 Gemini 使用原生请求体且不发送浏览器认证头",
    !call.authorization &&
      body.generationConfig.imageConfig.aspectRatio === "21:9" &&
      body.generationConfig.imageConfig.imageSize === "4K",
  );
  check("旧版解析 Gemini inlineData 图片", (await workspace.locator(".result img").count()) === 1);

  check(
    "旧版提供全部 GPT 生图模型",
    JSON.stringify(await workspace.locator(".model-select option").evaluateAll((options) => options.map((option) => option.value))) ===
      JSON.stringify([...GPT_MODEL_IDS, GEMINI_MODEL]),
  );
  await workspace.locator(".model-select").selectOption("gpt-image-2.5-flare");
  await workspace.locator(".prompt-input").fill("legacy mock gpt image 2.5 flare");
  const legacyGptCallCount = state.providerRequests.filter((entry) => entry.path.endsWith("/images/generations")).length;
  await workspace.locator(".run-btn").click();
  await page.waitForFunction(
    () => document.body.textContent.includes("完成：1 张图片"),
    null,
    { timeout: 5000 },
  );
  const legacyGptCall = state.providerRequests
    .filter((entry) => entry.path.endsWith("/images/generations"))
    .at(-1);
  check(
    "旧版新模型使用 GPT 路由并传递所选模型",
    state.providerRequests.filter((entry) => entry.path.endsWith("/images/generations")).length > legacyGptCallCount &&
      legacyGptCall.path.endsWith("/api/lucen/gpt/images/generations") &&
      JSON.parse(legacyGptCall.body).model === "gpt-image-2.5-flare",
  );
  const legacyContentBeforeOpen = state.localRequests.filter((entry) => entry.path.endsWith("/content")).length;
  const legacyThumbnailRequests = state.localRequests.filter((entry) => entry.path.endsWith("/thumbnail")).length;
  check("legacy result cards only request thumbnails", legacyThumbnailRequests > 0 && legacyContentBeforeOpen === 0);
  await workspace.locator(".result img").first().click();
  await page.locator("#imageViewer.open").waitFor({ state: "visible", timeout: 3000 });
  await page.waitForTimeout(250);
  check("legacy viewer requests original content", state.localRequests.filter((entry) => entry.path.endsWith("/content")).length > legacyContentBeforeOpen);
  await page.keyboard.press("Escape");

  await page.screenshot({ path: "shot-gemini-legacy-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  check("旧版移动端无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: "shot-gemini-legacy-mobile.png", fullPage: true });
  check("旧版无页面脚本异常", errors.length === 0, errors.join(" | "));
  await context.close();
}

(async () => {
  await verifyGalleryStorage();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    await verifyLogin(browser);
    await verifyModern(browser);
    await verifyLegacy(browser);
  } finally {
    await browser.close();
  }
  const failures = results.filter((item) => !item.passed);
  console.log("\n" + (failures.length ? failures.length + " checks failed." : "All " + results.length + " checks passed."));
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error("VERIFY CRASH:", error);
  process.exit(1);
});
