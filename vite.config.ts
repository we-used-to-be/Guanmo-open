import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    {
      name: 'guanmo-build-mode',
      transformIndexHtml(html) {
        return html.replace('<head>', `<head>\n    <meta name="guanmo-build-mode" content="${mode}" />`)
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@app-entry': path.resolve(__dirname, mode === 'web' ? './src/WebApp.tsx' : './src/App.tsx'),
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
        manualChunks: mode === 'web'
          ? undefined
          : {
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
