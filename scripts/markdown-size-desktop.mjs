// Windows Release 专项：只操作匿名 fixture，保留隔离目录供复核，不清理用户文件。
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { getFreePort, connectPage, createEnvironment, stopApp, readStartupMarks } from './measure-cold-start.mjs'
import { createPreviewAcceptanceFixture, runPreviewAcceptance } from './markdown-preview-desktop-acceptance.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')))
const exe = resolve(args.exe || 'output/markdown-size/baseline.exe')
const mib = Number(args.mib || 1)
const runs = Number(args.runs || 10)
const surface = args.surface || 'preview'
const kind = args.kind || 'mixed'
const policy = args.policy || 'memory'
if (!['memory', 'balanced'].includes(policy)) throw Error('invalid policy')
if (![1, 1.5, 2, 4, 8].includes(mib) && kind === 'mixed') throw Error('mixed: --mib=1|1.5|2|4|8')
if (!['edit', 'preview'].includes(surface) || !Number.isInteger(runs) || runs < 1 || runs > 10) throw Error('invalid surface/runs')

const artifactDir = resolve('output/markdown-size')
mkdirSync(artifactDir, { recursive: true })
const runRoot = mkdtempSync(join(tmpdir(), 'guanmo-size-bench-'))
const copiedExe = join(runRoot, 'size-benchmark.exe')
copyFileSync(exe, copiedExe)
const fixture = join(runRoot, 'anonymous.md')
let unit
let prefix = ''
let suffix = ''
if (kind === 'mixed' || kind === 'acceptance') {
  const bundled = await build({ entryPoints: ['scripts/markdown-preview-prototype/generateBenchmarkDoc.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { generateAnonymousMarkdown } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
  unit = generateAnonymousMarkdown(50_000, 7).markdown + '\n\n'
} else if (kind === 'table') {
  prefix = '| A | B | C |\n|---|---|---|\n'
  unit = '| sample | benchmark | result |\n'
} else if (kind === 'code') {
  prefix = '```typescript\n'
  suffix = '\n```'
  unit = 'const sample = 1; // benchmark\n'
} else throw Error('invalid kind')
const bytes = Math.round(mib * 1048576) + Number(args.overflow || 0)
const copies = Math.floor((bytes - Buffer.byteLength(prefix + suffix)) / Buffer.byteLength(unit))
let content = kind === 'acceptance' ? createPreviewAcceptanceFixture(bytes, unit) : prefix + unit.repeat(copies)
if (kind !== 'acceptance') content += ' '.repeat(bytes - Buffer.byteLength(content + suffix)) + suffix
writeFileSync(fixture, content, 'utf8')
const hash = text => createHash('sha256').update(text).digest('hex')
const pause = ms => new Promise(r => setTimeout(r, ms))
const launch = async (fileArgs = []) => {
  const port = await getFreePort()
  const start = Date.now()
  const child = spawn(copiedExe, fileArgs, { env: createEnvironment(runRoot, port), stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  const app = { child, launchStartedAt: start }
  try { return { app, cdp: await connectPage(port, child) } }
  catch (error) { await stopApp(app); throw error }
}
const waitSurface = async cdp => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await readStartupMarks(cdp)
    const names = new Set(snapshot.marks.map(mark => mark.name))
    if (names.has('app-ready') && names.has(surface === 'edit' ? 'editor-first-visible' : 'preview-render-complete')) {
      const probe = await cdp.evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(surface === 'edit' ? '.cm-content' : '[data-md-render-mode]')})
        return !!root && root.getClientRects().length > 0 && root.textContent.includes(${JSON.stringify(kind === 'acceptance' ? 'GM_ACCEPT_START' : kind === 'mixed' ? 'Anonymous Benchmark' : 'benchmark')})
      })()`)
      if (probe) {
        snapshot.observedSurfaceAt = await cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(performance.now()))))')
        return snapshot
      }
    }
    await pause(20)
  }
  throw Error('real surface not ready within 30s')
}

const report = { phase: args.phase || 'baseline', kind, mib, bytes, surface, runs, fixtureSha256: hash(content), executableSha256: hash(readFileSync(exe)), settings: { autoSave: false, autoIndexEnabled: false, modePerformancePolicy: policy }, samples: [], nativeOpen: 'NOT TESTED', nativeSave: 'NOT TESTED' }
const output = join(artifactDir, `${report.phase}-${kind}-${mib}-${surface}${args.reject === 'true' ? '-reject' : ''}.json`)
const saveReport = () => writeFileSync(output, JSON.stringify(report, null, 2))
let active
try {
  // 此 exe 必须由专用 identifier=com.guanmo.size-benchmark 构建，避免正式配置/SQLite。
  active = await launch([fixture])
  const configDir = await active.cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory',{directory:13})`)
  if (!configDir.endsWith('com.guanmo.size-benchmark')) throw Error('refusing non-benchmark application identifier')
  let opened = false
  for (let i = 0; i < 300; i++) {
    opened = await active.cdp.evaluate(args.reject === 'true'
      ? `document.body.innerText.includes('文件过大') && performance.getEntriesByName('guanmo:startup:active-document-first-visible').length === 0`
      : `document.body.innerText.includes('anonymous.md') && performance.getEntriesByName('guanmo:startup:active-document-first-visible').length > 0`)
    if (opened) break
    await pause(100)
  }
  if (!opened) throw Error('native file-association open failed')
  report.nativeOpen = 'PASS'
  if (args.reject === 'true') {
    report.expectedRejection = true
    report.status = 'PASS'
    console.log(JSON.stringify({ nativeOversizeRejection: 'PASS', bytes }))
  } else {
    const state = { state: { recentFiles: [], favorites: [], tabs: [{ id: 'size-benchmark', title: 'anonymous.md', filePath: fixture, content: '', savedContent: '', originalContent: '', modified: false }], activeTabId: 'size-benchmark', viewMode: surface, previewVisible: true, rightPaneTabId: null, rightPaneUserSelected: false, viewModeUsage: {}, readingPositions: {}, pendingReveal: null }, version: 0 }
    const settings = { state: { editor: { autoSave: false, defaultOpenMode: surface, modePerformancePolicy: policy }, knowledge: { autoIndexEnabled: false }, appearance: { customCursorEnabled: false, themeId: 'warm' } }, version: 0 }
    const seed = `localStorage.setItem('guanmo-editor',${JSON.stringify(JSON.stringify(state))});localStorage.setItem('guanmo-settings',${JSON.stringify(JSON.stringify(settings))});localStorage.removeItem('guanmo-boot-snapshot');`
    await active.cdp.call('Page.enable')
    await active.cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: seed })
    await active.cdp.call('Page.reload')
    await waitSurface(active.cdp)
    await stopApp(active.app, active.cdp)
    active = null
    for (let run = 1; run <= runs; run++) {
      await pause(500)
      active = await launch()
      const snapshot = await waitSurface(active.cdp)
      const marks = Object.fromEntries(snapshot.marks.map(mark => [mark.name, mark.startTime]))
      const surfaceMark = snapshot.observedSurfaceAt
      const render = await active.cdp.evaluate(`({nodes:document.querySelectorAll('*').length,blocks:document.querySelectorAll('[data-md-block-index]').length,heapMb:performance.memory?.usedJSHeapSize/1048576,renderMode:document.querySelector('[data-md-render-mode]')?.dataset.mdRenderMode})`)
      const memory = await active.cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('get_perf_snapshot').then(s=>({nativeMemory:'PASS',appPrivateMb:s.appPrivateBytesKb/1024,rustPrivateMb:s.rustPrivateBytesKb/1024,webviewPrivateMb:s.webviewPrivateBytesKb/1024})).catch(()=>({nativeMemory:'NOT TESTED'}))`)
      const sample = { run, launchToWebviewMs: snapshot.timeOrigin - active.app.launchStartedAt, frontendToSurfaceMs: surfaceMark - marks['frontend-bootstrap'], launchToSurfaceMs: snapshot.timeOrigin + surfaceMark - active.app.launchStartedAt, frontendToAppReadyMs: marks['app-ready'] - marks['frontend-bootstrap'], launchToAppReadyMs: snapshot.timeOrigin + marks['app-ready'] - active.app.launchStartedAt, originalSurfaceMarkMs: marks[surface === 'edit' ? 'editor-first-visible' : 'preview-render-complete'], observedSurfaceAtMs: surfaceMark, ...render, ...memory }
      report.samples.push(sample)
      console.log(JSON.stringify(sample))
      if (surface === 'edit' && run === runs) {
        const key = async (key, code, modifiers = 0) => {
          await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers })
          await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
        }
        await active.cdp.evaluate(`document.querySelector('.cm-content').focus()`)
        const times = []
        for (let i = 0; i < 20; i++) {
          await key('Home', 'Home', 2)
          await key('ArrowRight', 'ArrowRight', 8)
          const start = Date.now()
          await active.cdp.call('Input.insertText', { text: i % 2 ? 'y' : 'x' })
          await active.cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
          times.push(Date.now() - start)
        }
        times.sort((a, b) => a - b)
        report.inputP95Ms = times[18]
        await pause(500)
        await key('s', 'KeyS', 2)
        const expected = 'y' + content.slice(1)
        for (let i = 0; i < 40 && readFileSync(fixture, 'utf8') !== expected; i++) await pause(100)
        report.nativeSave = readFileSync(fixture, 'utf8') === expected ? 'PASS' : 'FAIL'
        if (report.nativeSave !== 'PASS') throw Error('native Ctrl+S roundtrip mismatch')
      }
      if (run === runs) {
        if (kind === 'acceptance') {
          report.previewAcceptance = await runPreviewAcceptance({ cdp: active.cdp, content, fixture, output, bytes })
          if (report.previewAcceptance.status !== 'PASS') throw Error('preview usability acceptance failed')
        }
        if (args.smoke === 'true') {
          for (const [title, selector] of [['编辑模式', '.cm-content'], ['编辑+预览', '[data-md-render-mode]'], ['预览模式', '[data-md-render-mode]']]) {
            await active.cdp.evaluate(`document.querySelector('button[title="${title}"]').click()`)
            let ready = false
            for (let i = 0; i < 300; i++) {
              ready = await active.cdp.evaluate(`Array.from(document.querySelectorAll('${selector}')).some(el=>el.getClientRects().length && el.textContent.includes('Anonymous Benchmark'))`)
              if (ready) break
              await pause(50)
            }
            if (!ready) throw Error('mode switch surface missing')
          }
          report.modeSwitch = 'PASS'
          report.scroll = await active.cdp.evaluate(`(async()=>{
            let el=document.querySelector('[data-md-render-mode]');
            while(el && !['auto','scroll'].includes(getComputedStyle(el).overflowY))el=el.parentElement;
            if(!el)return {status:'FAIL'};
            const start=performance.now();el.scrollTop=el.scrollHeight*.8;
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            return {status:el.scrollTop>0?'PASS':'FAIL',ms:performance.now()-start,blocks:document.querySelectorAll('[data-md-block-index]').length};
          })()`)
          await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', modifiers: 2 })
          await active.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: 2 })
          await pause(100)
          await active.cdp.evaluate(`document.querySelector('input[placeholder="搜索..."]').focus()`)
          const searchStarted = await active.cdp.evaluate('performance.now()')
          await active.cdp.call('Input.insertText', { text: 'benchmark' })
          report.search = 'FAIL'
          for (let i = 0; i < 100; i++) {
            const countText = await active.cdp.evaluate(`document.querySelector('[data-editor-search-overlay]').innerText`)
            if (/\d+\/[1-9]\d*/.test(countText)) { report.search = 'PASS'; break }
            await pause(20)
          }
          report.searchMs = (await active.cdp.evaluate('performance.now()')) - searchStarted
          if (report.scroll.status !== 'PASS' || report.scroll.ms > 500 || report.search !== 'PASS' || report.searchMs > 500) throw Error('native scroll/search smoke failed')
        }
        const shot = await active.cdp.call('Page.captureScreenshot', { format: 'png' })
        writeFileSync(output.replace(/\.json$/, '.png'), Buffer.from(shot.data, 'base64'))
      }
      await stopApp(active.app, active.cdp)
      active = null
      saveReport()
    }
    const summarize = field => {
      const values = report.samples.map(sample => sample[field]).sort((a, b) => a - b)
      return { median: values[Math.floor(values.length / 2)], p90: values[Math.ceil(values.length * .9) - 1], max: values.at(-1) }
    }
    report.summary = Object.fromEntries(['launchToWebviewMs', 'frontendToSurfaceMs', 'launchToSurfaceMs', 'frontendToAppReadyMs', 'launchToAppReadyMs'].map(field => [field, summarize(field)]))
    report.performanceBudget = { limitMs: 3000, criterion: 'max launch-to-observed-surface', status: report.summary.launchToSurfaceMs.max <= 3000 ? 'PASS' : 'FAIL' }
    report.status = 'PASS'
  }
} catch (error) {
  report.status = 'FAIL'
  report.error = error.message
  process.exitCode = 1
} finally {
  if (active) await stopApp(active.app, active.cdp)
  saveReport()
  console.log(JSON.stringify({ status: report.status, summary: report.summary, nativeOpen: report.nativeOpen, nativeSave: report.nativeSave, error: report.error, output }))
}
