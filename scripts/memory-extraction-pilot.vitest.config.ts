import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Explicit invocation only; never included in the normal test suite.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '../src') } },
  test: { environment: 'node', include: ['scripts/memory-extraction-pilot.test.ts'], maxWorkers: 1,
    fileParallelism: false, testTimeout: 600_000 },
})
