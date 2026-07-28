import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.WEB_PORT ?? 5173);
  const apiBase = env.VITE_API_BASE ?? "http://localhost:8080";

  return {
    // Relative assets make the static demo portable to any GitHub Pages repository path.
    base: mode === "demo" ? "./" : "/",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        // The API's wire contract. See src/shared/index.ts's header: every response is parsed
        // through these schemas, and nothing under src/ redeclares one of those shapes by hand.
        "@shared": fileURLToPath(new URL("./src/shared/index.ts", import.meta.url)),
      },
    },
    server: {
      port,
      // This repo is the frontend alone — `/api` and `/health` are proxied to whatever backend
      // VITE_API_BASE points at, so the browser still sees a same-origin app in development.
      proxy: {
        "/api": {
          target: apiBase,
          changeOrigin: true,
        },
        "/health": {
          target: apiBase,
          changeOrigin: true,
        },
      },
    },
    preview: {
      port,
    },
  };
});
