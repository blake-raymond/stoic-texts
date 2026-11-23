import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/chat/",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../public/chat", import.meta.url)),
    emptyOutDir: true,
  },
});
