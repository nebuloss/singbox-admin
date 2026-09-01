import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Vite's root is the client source, not the repository: index.html is the entry
// point of the SPA and belongs with the code it loads.
//
// The build lands next to the server because the server embeds it: what ships
// is one binary with the interface inside, not a binary that has to find its
// assets on disk.
//
// The SPA talks to the API on the same origin, so in development we proxy /api
// to the server started with `go run ./src/server`.
export default defineConfig({
  root: 'src/client',
  build: { outDir: resolve(__dirname, 'src/server/dist'), emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(__dirname, 'src/client') } },
  server: { proxy: { '/api': 'http://localhost:3000' } },
})
