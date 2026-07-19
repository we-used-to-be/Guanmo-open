import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/agent-tool-parser-check.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})

const code = result.outputFiles[0].text
const encoded = Buffer.from(code, 'utf8').toString('base64')
globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
globalThis.document = {
  addEventListener: () => {},
  visibilityState: 'visible',
  documentElement: { dataset: {} },
}
try {
  await import(`data:text/javascript;base64,${encoded}`)
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
