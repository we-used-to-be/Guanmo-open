import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/chat-history-check.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})

const encoded = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
await import(`data:text/javascript;base64,${encoded}`)
