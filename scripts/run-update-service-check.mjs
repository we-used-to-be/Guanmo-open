import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/update-service-check.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  plugins: [{
    name: 'update-service-mocks',
    setup(context) {
      context.onResolve({ filter: /^@tauri-apps\/api\/app$/ }, () => ({
        path: 'tauri-app',
        namespace: 'update-mock',
      }))
      context.onResolve({ filter: /^@\/services\/externalHttp$/ }, () => ({
        path: 'external-http',
        namespace: 'update-mock',
      }))
      context.onResolve({ filter: /^@\/hooks\/useTauri$/ }, () => ({
        path: 'use-tauri',
        namespace: 'update-mock',
      }))
      context.onLoad({ filter: /.*/, namespace: 'update-mock' }, (args) => ({
        contents: args.path === 'tauri-app'
          ? "export async function getVersion() { return '1.2.1' }"
          : args.path === 'external-http'
            ? 'export const externalFetch = (...args) => globalThis.fetch(...args)'
            : 'export function isTauri() { return true }',
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
  process.exitCode = 1
}
