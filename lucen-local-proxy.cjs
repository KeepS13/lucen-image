const http = require("http");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { createAuthManager } = require("./lucen-auth.cjs");
const { createRemitUploadManager } = require("./remit-upload.cjs");

const HOST = process.env.LUCEN_WORKBENCH_HOST || "0.0.0.0";
const PORT = Number(process.env.LUCEN_WORKBENCH_PORT || 8787);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const TRUST_PROXY = process.env.LUCEN_TRUST_PROXY === "1";
const LUCEN_BASE_URL =
  process.env.NODE_ENV === "test" && process.env.LUCEN_TEST_UPSTREAM_BASE_URL
    ? process.env.LUCEN_TEST_UPSTREAM_BASE_URL.replace(/\/$/, "")
    : "https://xixiapi.io";
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const HERE = __dirname;
const DATA_DIR = path.resolve(process.env.LUCEN_DATA_DIR || path.join(HERE, "data"));
const DB_PATH = path.join(DATA_DIR, "lucen.db");
const LOG_PATH = path.join(DATA_DIR, "lucen-proxy.log");

const ACCESS_PASSWORD = process.env.LUCEN_ACCESS_PASSWORD || "";
const SESSION_SECRET = process.env.LUCEN_SESSION_SECRET || "";
if (IS_PRODUCTION && (!ACCESS_PASSWORD || !SESSION_SECRET)) {
  console.error(
    "Production startup requires LUCEN_ACCESS_PASSWORD and LUCEN_SESSION_SECRET.",
  );
  process.exit(1);
}
if (IS_PRODUCTION && Buffer.byteLength(SESSION_SECRET, "utf8") < 32) {
  console.error("LUCEN_SESSION_SECRET must contain at least 32 bytes in production.");
  process.exit(1);
}

const auth = createAuthManager({
  password: ACCESS_PASSWORD,
  sessionSecret: SESSION_SECRET,
  ttlSeconds: process.env.LUCEN_SESSION_TTL_SECONDS,
  secureCookie: IS_PRODUCTION,
  trustProxy: TRUST_PROXY,
});

// 确保 data 目录和子目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
["images", "inputs"].forEach((dir) => {
  const p = path.join(DATA_DIR, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// 初始化 SQLite 数据库
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS gallery (
    id TEXT PRIMARY KEY,
    workspaceId TEXT,
    workspaceTitle TEXT,
    prompt TEXT,
    revisedPrompt TEXT,
    model TEXT,
    size TEXT,
    mode TEXT,
    filename TEXT,
    url TEXT,
    sourceDataUrl TEXT,
    favorite INTEGER DEFAULT 0,
    createdAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gallery_workspace ON gallery(workspaceId);
  CREATE INDEX IF NOT EXISTS idx_gallery_created ON gallery(createdAt);
  CREATE INDEX IF NOT EXISTS idx_gallery_favorite ON gallery(favorite);

  CREATE TABLE IF NOT EXISTS inputs (
    id TEXT PRIMARY KEY,
    filename TEXT,
    name TEXT,
    type TEXT,
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    kind TEXT,
    text TEXT,
    pinned INTEGER DEFAULT 0,
    usedCount INTEGER DEFAULT 0,
    createdAt INTEGER,
    updatedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_prompts_kind ON prompts(kind);

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

const API_KEY_NAMES = {
  gpt: [
    "LUCEN_GPT_API_KEY",
    "LUCEN-CC-GPT-IMAGE-2",
    "LUCEN_CC_gpt-image-2_API_KEY",
    "LUCEN_CC_GPT_IMAGE_2_API_KEY",
    "LUCEN_CC_API_KEY",
  ],
  gemini: [
    "LUCEN_GEMINI_API_KEY",
    "LUCEN-CC-GEMINI-3.1-FLASH-IMAGE",
    "LUCEN_CC_GEMINI_3_1_FLASH_IMAGE_API_KEY",
  ],
};

function getApiKey(provider) {
  const names = API_KEY_NAMES[provider] || [];
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  if (process.platform === "win32") {
    for (const name of names) {
      const userValue = readWindowsEnvironmentValue("HKCU\\Environment", name);
      if (userValue) return userValue;
      const machineValue = readWindowsEnvironmentValue(
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        name,
      );
      if (machineValue) return machineValue;
    }
  }
  return "";
}

function readWindowsEnvironmentValue(keyPath, valueName) {
  try {
    const output = require("child_process").execFileSync(
      "reg",
      ["query", keyPath, "/v", valueName],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const line = output.split(/\r?\n/).find((item) => item.trim().startsWith(valueName + " "));
    if (!line) return "";
    const match = line.match(/\sREG_(?:SZ|EXPAND_SZ)\s+(.+)$/);
    return match ? match[1].trim() : "";
  } catch (_) {
    return "";
  }
}

function send(res, status, headers, body) {
  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  if (IS_PRODUCTION) {
    securityHeaders["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  res.writeHead(status, {
    ...securityHeaders,
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(payload));
}

function logLine(event) {
  const payload = {
    time: new Date().toISOString(),
    ...event,
  };
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(payload) + "\n", "utf8");
  } catch (_) {}
}

const remitUploads = createRemitUploadManager({
  db,
  dataDir: DATA_DIR,
  logger: logLine,
  uploadsEnabled: process.env.LUCEN_DISABLE_REMIT_UPLOAD !== "1",
});

function bodyPreview(buffer, limit = 800) {
  if (!buffer || !buffer.length) return "";
  const text = buffer.toString("utf8").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      sendJson(res, 404, { error: { message: "Not found" } });
      return;
    }
    const headers = {
      "Content-Type":
        contentType || MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    };
    if (/\/assets\//.test(filePath.replace(/\\/g, "/"))) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    send(res, 200, headers, buffer);
  });
}

function serveDist(res, pathname) {
  const distRoot = path.join(HERE, "dist");
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(distRoot, relative));
  if (!filePath.startsWith(distRoot)) {
    sendJson(res, 403, { error: { message: "Forbidden" } });
    return;
  }
  fs.stat(filePath, (error, stat) => {
    if (!error && stat.isFile()) {
      serveFile(res, filePath, MIME_TYPES[path.extname(filePath).toLowerCase()]);
    } else {
      serveFile(res, path.join(distRoot, "index.html"), MIME_TYPES[".html"]);
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function proxyHeaders(req, provider) {
  const blocked = new Set([
    "host",
    "connection",
    "content-length",
    "origin",
    "referer",
    "accept-encoding",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-dest",
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
  ]);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  const apiKey = getApiKey(provider);
  if (apiKey) headers.authorization = "Bearer " + apiKey;
  return headers;
}

function proxyRoute(reqUrl) {
  const url = new URL(reqUrl, "http://" + HOST + ":" + PORT);
  const match = url.pathname.match(/^\/api\/lucen\/(gpt|gemini)(\/.*)?$/);
  if (match) {
    return {
      provider: match[1],
      suffix: (match[2] || "/") + url.search,
    };
  }
  return {
    provider: "gpt",
    suffix: url.pathname.replace(/^\/api\/lucen\/?/, "/") + url.search,
  };
}

async function proxyLucen(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 204, {}, "");
    return;
  }

  const { provider, suffix } = proxyRoute(req.url);
  const target = LUCEN_BASE_URL + suffix;
  const headers = proxyHeaders(req, provider);

  if (!headers.authorization) {
    sendJson(res, 503, {
      error: {
        code: "PROVIDER_NOT_CONFIGURED",
        message: provider + " provider is not configured on the server.",
      },
    });
    return;
  }

  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const started = Date.now();
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
    });

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    logLine({
      kind: "upstream",
      method: req.method,
      path: req.url,
      target,
      status: upstream.status,
      ms: Date.now() - started,
      contentType: upstream.headers.get("content-type") || "",
      response: bodyPreview(responseBody),
    });
    const responseHeaders = {
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    };
    send(res, upstream.status, responseHeaders, responseBody);
  } catch (error) {
    logLine({
      kind: "proxy_error",
      method: req.method,
      path: req.url,
      target,
      message: error && error.message ? error.message : String(error),
    });
    sendJson(res, 502, {
      error: {
        message: error && error.message ? error.message : "Proxy request failed.",
      },
    });
  }
}

// 本地数据 API
async function handleLocalApi(req, res) {
  const url = new URL(req.url, "http://" + HOST + ":" + PORT);
  const pathname = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    send(res, 204, {}, "");
    return;
  }

  try {
    // KV 存储
    if (pathname === "/api/local/kv" && method === "GET") {
      const key = url.searchParams.get("key");
      const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
      sendJson(res, 200, { value: row ? row.value : null });
      return;
    }

    if (pathname === "/api/local/kv" && method === "POST") {
      const body = JSON.parse(await readBody(req));
      db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(
        body.key,
        body.value,
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    // Gallery
    if (pathname === "/api/local/gallery" && method === "GET") {
      const workspaceId = url.searchParams.get("workspaceId");
      const limit = Math.max(1, Math.min(80, parseInt(url.searchParams.get("limit") || "40", 10) || 40));
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const filter = url.searchParams.get("filter");
      const query = (url.searchParams.get("query") || "").trim();
      const clauses = [];
      const params = [];
      if (workspaceId) {
        clauses.push("workspaceId = ?");
        params.push(workspaceId);
      }
      if (filter === "fav") clauses.push("favorite = 1");
      else if (filter === "text" || filter === "edit") {
        clauses.push("mode = ?");
        params.push(filter);
      }
      if (query) {
        clauses.push("(prompt LIKE ? OR revisedPrompt LIKE ? OR workspaceTitle LIKE ?)");
        const like = "%" + query + "%";
        params.push(like, like, like);
      }
      const whereSql = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
      const total = db.prepare("SELECT COUNT(*) AS count FROM gallery" + whereSql).get(...params).count;
      const rows = db
        .prepare("SELECT * FROM gallery" + whereSql + " ORDER BY createdAt DESC LIMIT ? OFFSET ?")
        .all(...params, limit, offset);
      const items = rows.map((row) => remitUploads.getGallery(row.id) || row);
      sendJson(res, 200, { items, total, limit, offset, hasMore: offset + rows.length < total });
      return;
    }

    if (pathname === "/api/local/gallery" && method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { id, workspaceId, workspaceTitle, prompt, revisedPrompt, model, size, mode, blob, mime, url, sourceDataUrl, createdAt } = body;
      const record = await remitUploads.createGallery(
        { id, workspaceId, workspaceTitle, prompt, revisedPrompt, model, size, mode, url, sourceDataUrl, createdAt },
        blob ? Buffer.from(blob, "base64") : null,
        mime,
      );
      sendJson(res, 200, { ok: true, filename: record.filename, record });
      return;
    }

    if (pathname === "/api/local/gallery/favorite" && method === "PUT") {
      const body = JSON.parse(await readBody(req));
      db.prepare("UPDATE gallery SET favorite = ? WHERE id = ?").run(body.favorite ? 1 : 0, body.id);
      sendJson(res, 200, { ok: true });
      return;
    }

    const galleryContentMatch = pathname.match(/^\/api\/local\/gallery\/([^/]+)\/content$/);
    if (galleryContentMatch && method === "GET") {
      const content = await remitUploads.getContent(decodeURIComponent(galleryContentMatch[1]));
      if (!content) {
        sendJson(res, 404, { error: "Image content is unavailable" });
        return;
      }
      send(res, 200, {
        "Content-Type": content.mime || "application/octet-stream",
        "Cache-Control": content.source === "remote" ? "private, max-age=300" : "no-store",
      }, content.buffer);
      return;
    }

    const galleryThumbnailMatch = pathname.match(/^\/api\/local\/gallery\/([^/]+)\/thumbnail$/);
    if (galleryThumbnailMatch && method === "GET") {
      const thumbnail = await remitUploads.getThumbnail(decodeURIComponent(galleryThumbnailMatch[1]));
      if (!thumbnail) {
        sendJson(res, 404, { error: "Thumbnail is not ready" });
        return;
      }
      send(res, 200, {
        "Content-Type": "image/webp",
        "Cache-Control": thumbnail.source === "remote" ? "public, max-age=3600" : "no-store",
      }, thumbnail.buffer);
      return;
    }

    const galleryRecordMatch = pathname.match(/^\/api\/local\/gallery\/([^/]+)$/);
    if (galleryRecordMatch && method === "GET") {
      const record = remitUploads.getGallery(decodeURIComponent(galleryRecordMatch[1]));
      if (!record) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      sendJson(res, 200, record);
      return;
    }

    if (pathname === "/api/local/uploads" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "100", 10) || 100;
      sendJson(res, 200, remitUploads.listUploads(limit));
      return;
    }

    const uploadRetryMatch = pathname.match(/^\/api\/local\/uploads\/([^/]+)\/retry$/);
    if (uploadRetryMatch && method === "POST") {
      const retried = remitUploads.retry(decodeURIComponent(uploadRetryMatch[1]), url.searchParams.get("variant") || undefined);
      sendJson(res, retried ? 200 : 409, { ok: retried });
      return;
    }

    if (galleryRecordMatch && method === "DELETE") {
      const result = remitUploads.deleteGallery(decodeURIComponent(galleryRecordMatch[1]));
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // Inputs
    if (pathname === "/api/local/inputs" && method === "GET") {
      const id = url.searchParams.get("id");
      const row = db.prepare("SELECT * FROM inputs WHERE id = ?").get(id);
      if (!row) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      const filePath = path.join(DATA_DIR, "inputs", row.filename);
      if (!fs.existsSync(filePath)) {
        sendJson(res, 404, { error: "File not found" });
        return;
      }
      const buffer = fs.readFileSync(filePath);
      sendJson(res, 200, { id: row.id, name: row.name, type: row.type, blob: buffer.toString("base64") });
      return;
    }

    if (pathname === "/api/local/inputs" && method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { id, name, type, blob, createdAt } = body;
      const filename = id + path.extname(name);
      const buffer = Buffer.from(blob, "base64");
      fs.writeFileSync(path.join(DATA_DIR, "inputs", filename), buffer);
      db.prepare("INSERT INTO inputs (id, filename, name, type, createdAt) VALUES (?, ?, ?, ?, ?)").run(
        id,
        filename,
        name,
        type,
        createdAt,
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/local/inputs/") && method === "DELETE") {
      const id = pathname.split("/").pop();
      const row = db.prepare("SELECT filename FROM inputs WHERE id = ?").get(id);
      if (row) {
        try {
          fs.unlinkSync(path.join(DATA_DIR, "inputs", row.filename));
        } catch (_) {}
      }
      db.prepare("DELETE FROM inputs WHERE id = ?").run(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Prompts
    if (pathname === "/api/local/prompts" && method === "GET") {
      const kind = url.searchParams.get("kind");
      const rows = db.prepare("SELECT * FROM prompts WHERE kind = ?").all(kind);
      sendJson(res, 200, { items: rows });
      return;
    }

    if (pathname === "/api/local/prompts" && method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { id, kind, text, pinned, usedCount, createdAt, updatedAt } = body;
      db.prepare(
        "INSERT INTO prompts (id, kind, text, pinned, usedCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, kind, text, pinned || 0, usedCount || 0, createdAt, updatedAt);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/local/prompts/update" && method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const { id, pinned, usedCount, updatedAt } = body;
      const updates = [];
      const values = [];
      if (typeof pinned === "number") {
        updates.push("pinned = ?");
        values.push(pinned);
      }
      if (typeof usedCount === "number") {
        updates.push("usedCount = ?");
        values.push(usedCount);
      }
      if (typeof updatedAt === "number") {
        updates.push("updatedAt = ?");
        values.push(updatedAt);
      }
      values.push(id);
      db.prepare("UPDATE prompts SET " + updates.join(", ") + " WHERE id = ?").run(...values);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/local/prompts/") && method === "DELETE") {
      const id = pathname.split("/").pop();
      db.prepare("DELETE FROM prompts WHERE id = ?").run(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Image files
    if (pathname.startsWith("/api/local/image/")) {
      const filename = pathname.replace("/api/local/image/", "");
      const safeFilename = path.basename(filename);
      const filePath = ["images", "pending-uploads"]
        .map((directory) => path.join(DATA_DIR, directory, safeFilename))
        .find((candidate) => fs.existsSync(candidate));
      if (!filePath) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      serveFile(res, filePath);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Local API error:", error);
    sendJson(res, 500, { error: error.message });
  }
}

function isMutation(req) {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET");
}

function firstForwardedValue(value) {
  return String(value || "").split(",")[0].trim();
}

function requestOrigin(req) {
  const host = TRUST_PROXY
    ? firstForwardedValue(req.headers["x-forwarded-host"]) || req.headers.host
    : req.headers.host;
  const protocol = TRUST_PROXY
    ? firstForwardedValue(req.headers["x-forwarded-proto"]) || "http"
    : req.socket && req.socket.encrypted
      ? "https"
      : "http";
  return host ? protocol + "://" + host : "";
}

function hasValidOrigin(req) {
  if (!isMutation(req)) return true;
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") return false;
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin);
    const parsedRequestOrigin = new URL(requestOrigin(req));
    if (parsedOrigin.origin === parsedRequestOrigin.origin) return true;

    return (
      TRUST_PROXY &&
      !firstForwardedValue(req.headers["x-forwarded-proto"]) &&
      ["http:", "https:"].includes(parsedOrigin.protocol) &&
      parsedOrigin.host === parsedRequestOrigin.host
    );
  } catch (_) {
    return false;
  }
}

function requireSameOrigin(req, res) {
  if (hasValidOrigin(req)) return true;
  sendJson(res, 403, {
    error: { code: "ORIGIN_FORBIDDEN", message: "Cross-origin requests are not allowed." },
  });
  return false;
}

function requireSession(req, res) {
  const session = auth.sessionFromRequest(req);
  if (session.authenticated) return true;
  sendJson(res, 401, {
    error: { code: "AUTH_REQUIRED", message: "Authentication is required." },
  });
  return false;
}

async function handleAuthApi(req, res, pathname) {
  if (pathname === "/api/auth/session" && req.method === "GET") {
    sendJson(res, 200, auth.sessionFromRequest(req));
    return;
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    if (!requireSameOrigin(req, res)) return;
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch (_) {
      sendJson(res, 400, { error: { code: "AUTH_INVALID", message: "Invalid login request." } });
      return;
    }
    const result = auth.authenticate(body.password, auth.clientIp(req));
    if (!result.ok) {
      const status = result.code === "AUTH_RATE_LIMITED" ? 429 : 401;
      const headers = { "Cache-Control": "no-store" };
      if (result.retryAfterSeconds) headers["Retry-After"] = String(result.retryAfterSeconds);
      send(
        res,
        status,
        { ...headers, "Content-Type": "application/json; charset=utf-8" },
        JSON.stringify({
          error: {
            code: result.code,
            message:
              result.code === "AUTH_RATE_LIMITED"
                ? "Too many failed login attempts."
                : "Invalid access password.",
          },
        }),
      );
      return;
    }
    const headers = { "Cache-Control": "no-store" };
    if (auth.enabled) headers["Set-Cookie"] = auth.sessionCookie(result.token);
    send(
      res,
      200,
      { ...headers, "Content-Type": "application/json; charset=utf-8" },
      JSON.stringify({ authenticated: true, expiresAt: result.expiresAt }),
    );
    return;
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    if (!requireSameOrigin(req, res)) return;
    send(
      res,
      200,
      {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": auth.expiredCookie(),
      },
      JSON.stringify({ ok: true }),
    );
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://" + HOST + ":" + PORT).pathname;

  if (pathname === "/__health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname.startsWith("/api/auth/")) {
    await handleAuthApi(req, res, pathname);
    return;
  }

  if (pathname === "/api/runtime/config" && req.method === "GET") {
    sendJson(res, 200, {
      authRequired: auth.enabled,
      providers: {
        gpt: Boolean(getApiKey("gpt")),
        gemini: Boolean(getApiKey("gemini")),
      },
    });
    return;
  }

  if (pathname.startsWith("/legacy") && !auth.sessionFromRequest(req).authenticated) {
    send(res, 302, { Location: "/?returnTo=" + encodeURIComponent("/legacy") }, "");
    return;
  }

  if (pathname === "/legacy" || pathname === "/legacy/" || pathname === "/legacy/index.html") {
    serveFile(res, path.join(HERE, "legacy", "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (pathname.startsWith("/api/local")) {
    if (!requireSession(req, res) || !requireSameOrigin(req, res)) return;
    handleLocalApi(req, res);
    return;
  }

  if (pathname.startsWith("/api/lucen")) {
    if (!requireSession(req, res) || !requireSameOrigin(req, res)) return;
    proxyLucen(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveDist(res, pathname);
    return;
  }

  sendJson(res, 404, { error: { message: "Not found" } });
});

server.listen(PORT, HOST, () => {
  const historicalQueued = remitUploads.start();
  console.log("Lucen image workbench is running:");
  console.log("  http://" + HOST + ":" + PORT + "/");
  console.log("Proxy target:");
  console.log("  " + LUCEN_BASE_URL);
  console.log("Server provider keys:");
  console.log("  GPT: " + (getApiKey("gpt") ? "found" : "not found"));
  console.log("  Gemini: " + (getApiKey("gemini") ? "found" : "not found"));
  console.log("Local data:");
  console.log("  " + DATA_DIR);
  console.log("Remit historical queue:");
  console.log("  " + historicalQueued + " image(s) added");
  console.log("");
  console.log("Access password: " + (auth.enabled ? "required" : "disabled in local development"));
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      "Port " +
        PORT +
        " is already in use. Open http://" +
        HOST +
        ":" +
        PORT +
        "/ or set LUCEN_WORKBENCH_PORT to another port.",
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Received " + signal + ", shutting down...");
  remitUploads.stop();

  const closeServer = new Promise((resolve) => {
    server.close(() => resolve());
  });
  const deadline = Date.now() + 30000;
  while (remitUploads.getHealth().worker.running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await closeServer;
  try {
    db.close();
  } catch (_) {}
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
