import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/ai-http-transport-check.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  plugins: [{
    name: 'ai-http-transport-mocks',
    setup(context) {
      context.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
        path: 'tauri-core',
        namespace: 'transport-mock',
      }))
      context.onResolve({ filter: /^@\/hooks\/useTauri$/ }, () => ({
        path: 'use-tauri',
        namespace: 'transport-mock',
      }))
      context.onLoad({ filter: /.*/, namespace: 'transport-mock' }, (args) => ({
        contents: args.path === 'tauri-core'
          ? `export class Channel { onmessage };
             export const invoke = (...args) => globalThis.__TAURI_INVOKE__(...args)`
          : 'export function isTauri() { return globalThis.__TEST_TAURI__ === true }',
        loader: 'js',
      }))
    },
  }],
})

const code = result.outputFiles[0].text
const encoded = Buffer.from(code, 'utf8').toString('base64')
try {
  await import(`data:text/javascript;base64,${encoded}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const cargo = spawnSync('cargo', [
  'test', '--manifest-path', 'src-tauri/Cargo.toml', 'api_http', '--lib', '--quiet',
], { stdio: 'inherit', shell: process.platform === 'win32' })
if (cargo.status !== 0) process.exit(cargo.status ?? 1)
