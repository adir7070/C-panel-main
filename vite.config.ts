import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // `npm run dev` runs the backend (backend/server.js) on PORT from .env —
  // every server path the SPA touches is proxied to it, sockets included.
  const apiTarget = `http://localhost:${env.PORT || 3910}`
  const toBackend = { target: apiTarget, changeOrigin: true }
  return {
    plugins: [react(), tailwindcss()],
    build: { outDir: 'dist', emptyOutDir: true },
    server: {
      proxy: {
        '/api': toBackend,
        '/socket.io': { ...toBackend, ws: true },
        '/generated': toBackend,
        '/auth/facebook': toBackend,
        '/pdf-pages': toBackend,
        '/lp-preview': toBackend,
        '/wow-ads-preview': toBackend,
        '/wow-organic-preview': toBackend,
      },
    },
  }
})
