import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    {
      name: 'guanmo-build-mode',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html
            .replace('<head>', `<head>\n    <meta name="guanmo-build-mode" content="${mode}" />`)
            .replace('/src/main.tsx', mode === 'web' ? '/src/webMain.tsx' : '/src/main.tsx')
        },
      },
    },
  ],
  resolve: {
    alias: {
      '@/services/externalHttp': path.resolve(__dirname, mode === 'web' ? './src/web/externalHttp.ts' : './src/services/externalHttp.ts'),
      '@/services/rag/indexer': path.resolve(__dirname, mode === 'web' ? './src/web/ragIndexer.ts' : './src/services/rag/indexer.ts'),
      '@/services/workspaceIndex': path.resolve(__dirname, mode === 'web' ? './src/web/workspaceIndex.ts' : './src/services/workspaceIndex.ts'),
      ...(mode === 'web' ? {
        '@tauri-apps/api/core': path.resolve(__dirname, './src/web/tauriCoreShim.ts'),
        '@tauri-apps/api/window': path.resolve(__dirname, './src/web/tauriWindowShim.ts'),
        '@tauri-apps/api/webviewWindow': path.resolve(__dirname, './src/web/tauriWindowShim.ts'),
        '@tauri-apps/api/event': path.resolve(__dirname, './src/web/tauriEventShim.ts'),
        '@tauri-apps/api/path': path.resolve(__dirname, './src/web/tauriPathShim.ts'),
        '@tauri-apps/api/app': path.resolve(__dirname, './src/web/tauriAppShim.ts'),
        '@tauri-apps/plugin-dialog': path.resolve(__dirname, './src/web/tauriDialogShim.ts'),
        '@tauri-apps/plugin-shell': path.resolve(__dirname, './src/web/tauriShellShim.ts'),
        '@tauri-apps/plugin-sql': path.resolve(__dirname, './src/web/tauriSqlShim.ts'),
        '@/services/database/persistence': path.resolve(__dirname, './src/web/databasePersistence.ts'),
        '@/services/database/db': path.resolve(__dirname, './src/web/databaseDb.ts'),
        '@/services/agent/conversationCommands': path.resolve(__dirname, './src/web/conversationCommands.ts'),
        '@/services/agent/artifactCommands': path.resolve(__dirname, './src/web/artifactCommands.ts'),
        '@/services/readingReminders': path.resolve(__dirname, './src/web/readingReminders.ts'),
        '@/stores/readingArtifactsStore': path.resolve(__dirname, './src/web/readingArtifactsStore.ts'),
        '@/components/reading-artifacts/ReadingArtifactCenter': path.resolve(__dirname, './src/web/ReadingArtifactCenter.tsx'),
        '@/services/settings/settingsCommands': path.resolve(__dirname, './src/web/settingsCommands.ts'),
        '@/services/rag/pipeline': path.resolve(__dirname, './src/web/ragPipeline.ts'),
        '@/services/rag/knowledgeBase': path.resolve(__dirname, './src/web/knowledgeBase.ts'),
        '@/services/dataBackup': path.resolve(__dirname, './src/web/dataBackup.ts'),
        '@/services/secureStorage': path.resolve(__dirname, './src/web/secureStorage.ts'),
        '@/services/updateService': path.resolve(__dirname, './src/web/updateService.ts'),
        '@/services/updateNotifications': path.resolve(__dirname, './src/web/updateNotifications.ts'),
        '@/features/settings/UsageActivity': path.resolve(__dirname, './src/web/usageActivity.tsx'),
        '@/features/settings/KnowledgeBaseManager': path.resolve(__dirname, './src/web/knowledgeBaseManager.tsx'),
        '@/components/legacy/LegacyMigrationEntry': path.resolve(__dirname, './src/web/legacyMigrationEntry.tsx'),
      } : {}),
      '@': path.resolve(__dirname, './src'),
      '@settings-entry': path.resolve(__dirname, mode === 'web' ? './src/web/WebSettingsPage.tsx' : './src/features/settings/SettingsPage.tsx'),
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
              'react-core': [
                'react',
                'react-dom',
              ],
            },
      },
    },
  },
}))
