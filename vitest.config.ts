import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@settings-entry': path.resolve(__dirname, './src/web/WebSettingsPage.tsx'),
      '@scripts': path.resolve(__dirname, './scripts'),
      'animal-island-ui': path.resolve(__dirname, './src/vendor/animal-island-ui/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
    // 多个设置/预览测试依赖共享的 jsdom 与模块重置；并发 worker 会造成间歇性超时。
    maxWorkers: 1,
  },
})
