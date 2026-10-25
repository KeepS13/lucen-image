const RAW_BASE = String(import.meta.env.BASE_URL || "/").trim();
const BASE_PATH = RAW_BASE === "/" ? "" : RAW_BASE.replace(/\/+$/, "");

export function appPath(pathname: string): string {
  if (!pathname.startsWith("/")) throw new Error("appPath requires an absolute path");
  return BASE_PATH + pathname;
}

export function legacyPath(): string {
  return appPath("/legacy");
}

export function loginPath(returnTo?: string): string {
  const query = returnTo ? "?returnTo=" + encodeURIComponent(returnTo) : "";
  return appPath("/") + query;
}

export function basePath(): string {
  return BASE_PATH;
}
