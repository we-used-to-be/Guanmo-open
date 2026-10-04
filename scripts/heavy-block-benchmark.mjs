import { build } from 'esbuild'

const result = await build({
  entryPoints: ['scripts/heavy-block-benchmark.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': `${process.cwd()}/src` },
  write: false,
  logLevel: 'silent',
})
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
