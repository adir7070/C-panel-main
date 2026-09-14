import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // No hardcoded backend host — set VITE_API_URL to your backend's origin.
  // Falls back to a local dev backend placeholder so `npm run dev` doesn't
  // silently point at a dead third-party host when the var is unset.
  const apiTarget = env.VITE_API_URL || 'http://localhost:3900'
  return {
    plugins: [react(), tailwindcss()],
    // Configurable base — '/' for standalone deploy, '/cpanel/' when mounted under another app
    base: env.VITE_BASE_PATH || '/',
    build: { outDir: 'dist', emptyOutDir: true },
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: true,
        },
      },
    },
  }
})
