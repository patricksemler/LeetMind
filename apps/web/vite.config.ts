import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.WEB_PORT ?? 5173);
  const apiBase = env.VITE_API_BASE ?? "http://localhost:8080";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        // CONTRACTS.md §0: web must consume @algolift/shared as TS source, never a redeclaration.
        "@algolift/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
        // shared/src/logger.ts (pulled in by the barrel export) is Node-only and dead code from
        // the browser's perspective — see shims/node-async-hooks.ts for why this is needed.
        "node:async_hooks": fileURLToPath(new URL("./shims/node-async-hooks.ts", import.meta.url)),
      },
    },
    server: {
      port,
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
