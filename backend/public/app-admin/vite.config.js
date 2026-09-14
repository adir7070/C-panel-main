import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5176,
    proxy: {
      "/api": {
        target: "http://localhost:3900",
        changeOrigin: true,
      },
    },
  },
  base: "/appinfo/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
