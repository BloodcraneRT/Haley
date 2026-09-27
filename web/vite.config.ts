import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// vite.config runs in Node; declared here so the app tsconfig needn't pull in @types/node.
declare const process: { env: Record<string, string | undefined>; argv: string[] };

// A shell-wide NODE_ENV=development would otherwise make `vite build` ship React's dev bundle.
if (process.argv.includes("build")) process.env.NODE_ENV = "production";

const apiTarget = process.env.HALEY_API_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: apiTarget, changeOrigin: true } },
  },
  preview: {
    proxy: { "/api": { target: apiTarget, changeOrigin: true } },
  },
});
