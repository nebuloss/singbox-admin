import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Vite's root is the client source, not the repository: index.html is the
// entry point of the SPA and belongs with the code it loads. Everything the
// build produces still lands in dist/ at the top, where install.sh expects it.
//
// The SPA talks to the Express API on the same origin, so in development we
// proxy /api to the server started with `npm start` (or tsx src/server/server.ts).
export default defineConfig({
  root: 'src/client',
  build: { outDir: resolve(__dirname, 'dist'), emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(__dirname, 'src/client') } },
  server: { proxy: { '/api': 'http://localhost:3000' } },
})
