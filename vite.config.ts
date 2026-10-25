import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function normalizeBasePath(value: string | undefined): string {
  const raw = String(value || "").trim();
  if (!raw || raw === "/") return "/";
  return raw.replace(/\/+$/, "") + "/";
}

const base = normalizeBasePath(process.env.LUCEN_BASE_PATH);
const proxyBase = base === "/" ? "" : base.slice(0, -1);

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // 所有开发请求都经过本地 Node 服务，以执行鉴权、密钥注入和 SQLite 持久化。
      [proxyBase + "/api"]: { target: "http://127.0.0.1:8787" },
      [proxyBase + "/__health"]: { target: "http://127.0.0.1:8787" },
      [proxyBase + "/legacy"]: { target: "http://127.0.0.1:8787" },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1200,
  },
});
