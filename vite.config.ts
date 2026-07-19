import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@app-entry': path.resolve(__dirname, './src/App.tsx'),
      'animal-island-ui': path.resolve(__dirname, './src/vendor/animal-island-ui/index.ts'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    fs: {
      allow: ['..'],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'codemirror-core': [
            '@codemirror/view',
            '@codemirror/state',
            '@codemirror/commands',
            '@codemirror/search',
            '@codemirror/autocomplete',
          ],
          'codemirror-lang': [
            '@codemirror/lang-markdown',
            '@codemirror/language-data',
          ],
        },
      },
    },
  },
}))
