import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:2567",
    },
    fs: { allow: [".."] },
  },
  build: { target: "es2022" },
});
