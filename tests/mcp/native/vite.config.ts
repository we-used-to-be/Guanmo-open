import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url))
export default defineConfig({
  root: local('./ui/'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': local('../../../src'), 'animal-island-ui': local('../../../src/vendor/animal-island-ui/index.ts') } },
  build: { outDir: local('./web/settings'), emptyOutDir: false },
})
