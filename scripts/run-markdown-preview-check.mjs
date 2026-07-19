import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/markdown-preview-check.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/scripts/markdown-preview-check.cjs');",
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
