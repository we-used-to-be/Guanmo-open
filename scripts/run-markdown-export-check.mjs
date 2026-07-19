import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/markdown-export-check.tsx'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: {
    '@': './src',
  },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/scripts/markdown-export-check.cjs');",
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
