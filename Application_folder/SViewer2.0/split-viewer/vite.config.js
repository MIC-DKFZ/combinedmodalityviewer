// vite.config.js / vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),     // 💡 new line
  ],
  server: {
    proxy: {
      // Proxy requests from /dcm4chee-arc to your dcm4chee server
      '/dcm4chee-arc': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
