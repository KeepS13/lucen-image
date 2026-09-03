import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // 所有开发请求都经过本地 Node 服务，以执行鉴权、密钥注入和 SQLite 持久化。
      "/api": { target: "http://127.0.0.1:8787" },
      "/__health": { target: "http://127.0.0.1:8787" },
      "/legacy": { target: "http://127.0.0.1:8787" },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1200,
  },
});
