import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// The SPA talks to the Express API on the same origin, so in development we
// proxy /api to the server started with `npm start` (or tsx src/server/server.ts).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(__dirname, './src/client') } },
  server: { proxy: { '/api': 'http://localhost:3000' } },
})
