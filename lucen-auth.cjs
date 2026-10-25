const crypto = require("crypto");

const COOKIE_NAME = "lucen_session";
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function digest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest();
}

function constantTimeEqual(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (_) {
      cookies[name] = value;
    }
  }
  return cookies;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCookiePath(value) {
  const raw = String(value || "/").trim();
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#") || raw.includes(";")) {
    throw new Error("Cookie path must be an absolute path.");
  }
  if (raw === "/") return "/";
  return raw.replace(/\/+$/, "");
}

function createAuthManager(options = {}) {
  const password = String(options.password || "");
  const sessionSecret = String(options.sessionSecret || "");
  const enabled = Boolean(password && sessionSecret);
  const secureCookie = Boolean(options.secureCookie);
  const cookiePath = normalizeCookiePath(options.cookiePath);
  const trustProxy = Boolean(options.trustProxy);
  const ttlSeconds = positiveInteger(options.ttlSeconds, DEFAULT_SESSION_TTL_SECONDS);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const failuresByIp = new Map();

  function sign(payload) {
    return crypto.createHmac("sha256", sessionSecret).update(payload, "utf8").digest("base64url");
  }

  function issueToken() {
    if (!enabled) return "";
    const payload = Buffer.from(
      JSON.stringify({ version: 1, expiresAt: now() + ttlSeconds * 1000 }),
      "utf8",
    ).toString("base64url");
    return payload + "." + sign(payload);
  }

  function verifyToken(token) {
    if (!enabled || typeof token !== "string") return null;
    const separator = token.indexOf(".");
    if (separator < 1) return null;
    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!constantTimeEqual(signature, sign(payload))) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (session.version !== 1 || !Number.isFinite(session.expiresAt) || session.expiresAt <= now()) {
        return null;
      }
      return { expiresAt: session.expiresAt };
    } catch (_) {
      return null;
    }
  }

  function sessionFromRequest(req) {
    if (!enabled) return { authenticated: true, expiresAt: null };
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = verifyToken(token);
    return session
      ? { authenticated: true, expiresAt: session.expiresAt }
      : { authenticated: false, expiresAt: null };
  }

  function clientIp(req) {
    if (trustProxy) {
      const forwarded = String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
      if (forwarded) return forwarded;
    }
    return String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown");
  }

  function activeFailures(ip) {
    const cutoff = now() - LOGIN_WINDOW_MS;
    const active = (failuresByIp.get(ip) || []).filter((timestamp) => timestamp > cutoff);
    if (active.length) failuresByIp.set(ip, active);
    else failuresByIp.delete(ip);
    return active;
  }

  function authenticate(attempt, ip) {
    if (!enabled) return { ok: true, token: "", expiresAt: null };
    const failures = activeFailures(ip);
    if (failures.length >= LOGIN_MAX_FAILURES) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((failures[0] + LOGIN_WINDOW_MS - now()) / 1000),
      );
      return { ok: false, code: "AUTH_RATE_LIMITED", retryAfterSeconds };
    }
    if (!constantTimeEqual(attempt, password)) {
      failures.push(now());
      failuresByIp.set(ip, failures);
      return { ok: false, code: "AUTH_INVALID" };
    }
    failuresByIp.delete(ip);
    const token = issueToken();
    const session = verifyToken(token);
    return { ok: true, token, expiresAt: session ? session.expiresAt : null };
  }

  function sessionCookie(token) {
    const parts = [
      COOKIE_NAME + "=" + encodeURIComponent(token),
      "Path=" + cookiePath,
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=" + ttlSeconds,
    ];
    if (secureCookie) parts.push("Secure");
    return parts.join("; ");
  }

  function expiredCookie() {
    const parts = [
      COOKIE_NAME + "=",
      "Path=" + cookiePath,
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
    ];
    if (secureCookie) parts.push("Secure");
    return parts.join("; ");
  }

  return {
    enabled,
    ttlSeconds,
    authenticate,
    clientIp,
    expiredCookie,
    issueToken,
    sessionCookie,
    sessionFromRequest,
    verifyToken,
  };
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_SESSION_TTL_SECONDS,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  constantTimeEqual,
  createAuthManager,
  parseCookies,
};
