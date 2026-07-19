import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/file-access-check.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: {
    '@': './src',
  },
  write: false,
  logLevel: 'silent',
})

const code = result.outputFiles[0].text
const encoded = Buffer.from(code, 'utf8').toString('base64')
try {
  await import(`data:text/javascript;base64,${encoded}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
