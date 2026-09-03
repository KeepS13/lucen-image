import type { ImageProvider } from "./types";

export interface SessionInfo {
  authenticated: boolean;
  expiresAt: number | null;
}

export interface RuntimeConfig {
  authRequired: boolean;
  providers: Record<ImageProvider, boolean>;
}

export const UNAUTHORIZED_EVENT = "lucen:unauthorized";

function errorMessage(payload: any, fallback: string): string {
  return String(payload?.error?.message || payload?.message || fallback);
}

async function readJson(response: Response): Promise<any> {
  return response.json().catch(() => ({}));
}

export function notifyUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export async function getSession(): Promise<SessionInfo> {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(errorMessage(payload, "无法读取登录状态"));
  return {
    authenticated: Boolean(payload.authenticated),
    expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : null,
  };
}

export async function login(password: string): Promise<SessionInfo> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = new Error(errorMessage(payload, "登录失败")) as Error & {
      code?: string;
      retryAfter?: number;
    };
    error.code = payload?.error?.code;
    error.retryAfter = Number(response.headers.get("Retry-After") || 0) || undefined;
    throw error;
  }
  return {
    authenticated: Boolean(payload.authenticated),
    expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : null,
  };
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const response = await fetch("/api/runtime/config", { cache: "no-store" });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(errorMessage(payload, "无法读取服务配置"));
  return {
    authRequired: Boolean(payload.authRequired),
    providers: {
      gpt: Boolean(payload.providers?.gpt),
      gemini: Boolean(payload.providers?.gemini),
    },
  };
}
