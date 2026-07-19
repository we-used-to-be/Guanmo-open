import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/rag-query-benchmark.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  alias: { '@': `${process.cwd()}/src` },
})

const encoded = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
try {
  await import(`data:text/javascript;base64,${encoded}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
