import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/interview/" : "/",
  build: {
    outDir: "../public/interview",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
}));
