import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/long-document-benchmark.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': `${process.cwd()}/src` },
  write: false,
  logLevel: 'silent',
})
const encoded = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
await import(`data:text/javascript;base64,${encoded}`)
