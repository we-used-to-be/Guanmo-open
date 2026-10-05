/* eslint no-undef: off -- Node 脚本依赖 Node/运行时全局（console/process/fetch/WebSocket），项目 flat config 未覆盖 scripts 目录 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultExecutable = join(repoRoot, 'src-tauri', 'target', 'release', 'guanmo.exe')
const themeIds = ['warm', 'light', 'dark', 'paper', 'github-light']
const expectedCanvasColors = {
  warm: 'rgb(248, 244, 232)',
  light: 'rgb(255, 255, 255)',
  dark: 'rgb(21, 19, 15)',
  paper: 'rgb(241, 234, 220)',
  'github-light': 'rgb(245, 247, 249)',
}
const startupMarkNames = [
  'html-start',
  'startup-shell-dom-ready',
  'html-parsed',
  'main-module-requested',
  'app-module-ready',
  'main-module-evaluated',
  'frontend-bootstrap',
  'create-root-start',
  'react-render-start',
  'react-mounted',
  'startup-shell-removed',
  'first-animation-frame',
  'first-react-render',
  'app-shell-first-visible',
  'app-shell-interactive',
  'database-ready',
  'active-tab-disk-read-complete',
  'startup-session-restore-complete',
  'active-document-first-visible',
  'editor-first-visible',
  'preview-first-visible',
  'preview-render-complete',
  'app-ready',
]
const requiredMarkers = {
  edit: [
    'html-start',
    'startup-shell-dom-ready',
    'html-parsed',
    'main-module-requested',
    'app-module-ready',
    'main-module-evaluated',
    'create-root-start',
    'react-render-start',
    'react-mounted',
    'startup-shell-removed',
    'first-animation-frame',
    'active-tab-disk-read-complete',
    'startup-session-restore-complete',
    'active-document-first-visible',
    'editor-first-visible',
    'app-ready',
  ],
  preview: [
    'html-start',
    'startup-shell-dom-ready',
    'html-parsed',
    'main-module-requested',
    'app-module-ready',
    'main-module-evaluated',
    'create-root-start',
    'react-render-start',
    'react-mounted',
    'startup-shell-removed',
    'first-animation-frame',
    'active-tab-disk-read-complete',
    'startup-session-restore-complete',
    'active-document-first-visible',
    'preview-render-complete',
    'app-ready',
  ],
}
const timeoutMs = 20_000

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function parseArgs(argv) {
  const options = { executable: defaultExecutable, runs: 3, surface: 'edit', theme: 'warm', keep: false }
  for (const arg of argv) {
    if (arg === '--keep') {
      options.keep = true
    } else if (arg.startsWith('--exe=')) {
      options.executable = resolve(arg.slice('--exe='.length))
    } else if (arg.startsWith('--runs=')) {
      options.runs = Number(arg.slice('--runs='.length))
    } else if (arg.startsWith('--surface=')) {
      options.surface = arg.slice('--surface='.length)
    } else if (arg.startsWith('--theme=')) {
      options.theme = arg.slice('--theme='.length)
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/measure-cold-start.mjs [--runs=3] [--surface=edit|preview] [--theme=warm|light|dark|paper|github-light] [--exe=path] [--keep]')
      process.exit(0)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
    throw new Error('--runs 必须是 1 到 10 之间的整数')
  }
  if (!(options.surface in requiredMarkers)) {
    throw new Error('--surface 只能是 edit 或 preview')
  }
  if (!themeIds.includes(options.theme)) {
    throw new Error(`--theme 只能是 ${themeIds.join('、')}`)
  }
  return options
}

function getFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolvePromise(port))
    })
  })
}

async function getPageTarget(port, deadline) {
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        // 只连接应用主文档；WebView2 初始化期还会短暂暴露无 localStorage 权限的内部 page target。
        const page = targets.find((target) => {
          if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false
          try {
            const url = new URL(target.url)
            return url.protocol === 'tauri:'
              || url.hostname === 'tauri.localhost'
              || url.hostname === 'localhost'
              || url.hostname === '127.0.0.1'
          } catch {
            return false
          }
        })
        if (page) return page
      }
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw new Error(`等待 WebView2 DevTools 页面超时${lastError ? `：${lastError.message}` : ''}`)
}

async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  let closed = false

  const opened = new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', () => reject(new Error('WebView2 DevTools WebSocket 连接失败')), { once: true })
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (typeof message.id !== 'number') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) {
      request.reject(new Error(message.error.message || 'CDP 请求失败'))
    } else {
      request.resolve(message.result)
    }
  })

  socket.addEventListener('close', () => {
    closed = true
    for (const request of pending.values()) request.reject(new Error('WebView2 DevTools 连接已关闭'))
    pending.clear()
  })

  await opened

  const call = (method, params = {}) => {
    if (closed) return Promise.reject(new Error('WebView2 DevTools 连接已关闭'))
    const id = nextId++
    return new Promise((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? '页面脚本执行失败'
      throw new Error(String(detail).split('\n').at(0) ?? detail)
    }
    return result?.result?.value
  }

  return {
    evaluate,
    call,
    close() {
      if (!closed) socket.close()
    },
  }
}

async function connectPage(port, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试进程提前退出，exit code=${child.exitCode}`)
    try {
      const target = await getPageTarget(port, Math.min(deadline, Date.now() + 1_000))
      const cdp = await connectCdp(target.webSocketDebuggerUrl)
      while (Date.now() < deadline) {
        try {
          const ready = await cdp.evaluate(`(() => {
            try {
              localStorage.getItem('__guanmo_startup_probe__')
              return document.readyState !== 'loading'
            } catch {
              return false
            }
          })()`)
          if (ready) return cdp
        } catch {
          // 初始导航切换 execution context 时短暂失败，继续等待当前 page target。
        }
        await sleep(50)
      }
      cdp.close()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await sleep(100)
    }
  }
  throw new Error('连接测试页面超时')
}

function readStartupMarks(cdp) {
  const names = JSON.stringify(startupMarkNames)
  return cdp.evaluate(`(() => {
    if (!document.documentElement || !document.body) {
      return { timeOrigin: performance.timeOrigin, readyState: document.readyState, marks: [] }
    }
    const wanted = new Set(${names})
    const marks = performance.getEntriesByType('mark')
      .filter((entry) => entry.name.startsWith('guanmo:startup:'))
      .filter((entry) => wanted.has(entry.name.slice('guanmo:startup:'.length)))
      .map((entry) => ({ name: entry.name.slice('guanmo:startup:'.length), startTime: entry.startTime }))
    return {
      timeOrigin: performance.timeOrigin,
      readyState: document.readyState,
      themeId: document.documentElement.dataset.themeId,
      colorScheme: document.documentElement.style.colorScheme,
      canvasColor: getComputedStyle(document.body).backgroundColor,
      marks,
    }
  })()`)
}

async function waitForMarkers(cdp, names, child) {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试进程提前退出，exit code=${child.exitCode}`)
    lastSnapshot = await readStartupMarks(cdp)
    const available = new Set(lastSnapshot.marks.map((mark) => mark.name))
    if (names.every((name) => available.has(name))) return lastSnapshot
    await sleep(100)
  }
  const available = lastSnapshot?.marks.map((mark) => mark.name).join(', ') || '无'
  throw new Error(`等待启动标记超时，需要 ${names.join(', ')}；当前已有：${available}`)
}

function makePersistedEditorState(surface) {
  const content = '# 启动基线文档\n\n用于测量真实文本首帧，不包含用户数据。'
  const tab = {
    id: 'cold-start-probe',
    title: '启动基线.md',
    filePath: null,
    content,
    savedContent: content,
    originalContent: content,
    modified: false,
  }
  return {
    state: {
      recentFiles: [],
      favorites: [],
      tabs: [tab],
      activeTabId: tab.id,
      previewVisible: true,
      viewMode: surface,
      rightPaneTabId: null,
      rightPaneUserSelected: false,
      viewModeUsage: {},
      readingPositions: {},
      pendingReveal: null,
    },
    version: 0,
  }
}

function makeSeedSource(surface, theme) {
  const storageValue = JSON.stringify(makePersistedEditorState(surface))
  const encoded = JSON.stringify(storageValue)
  const settingsValue = JSON.stringify({
    state: {
      appearance: {
        customCursorEnabled: false,
        aiMascotAvatarEnabled: false,
        themeId: theme,
        lastLightThemeId: theme === 'dark' ? 'warm' : theme,
      },
    },
    version: 0,
  })
  const encodedSettings = JSON.stringify(settingsValue)
  return `(() => {
    localStorage.setItem('guanmo-editor', ${encoded})
    localStorage.setItem('guanmo-settings', ${encodedSettings})
    localStorage.removeItem('guanmo-boot-snapshot')
  })()`
}

async function seedEditorState(cdp, surface, theme, child) {
  const source = makeSeedSource(surface, theme)
  await cdp.evaluate(source)
  // 旧文档 beforeunload 会 flush 延迟持久化队列，可能用应用内存态覆写直写的 seed；
  // 注册新文档前置脚本，在任何应用脚本执行前重写 seed，保证 reload 后必定携带目标状态
  await cdp.call('Page.enable')
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source })
  await cdp.call('Page.reload')
  await waitForMarkers(cdp, requiredMarkers[surface], child)
}

function createEnvironment(runRoot, port) {
  const appData = join(runRoot, 'appdata')
  const localAppData = join(runRoot, 'localappdata')
  const temp = join(runRoot, 'temp')
  const webviewData = join(runRoot, 'webview2')
  for (const directory of [appData, localAppData, temp, webviewData]) mkdirSync(directory, { recursive: true })
  const existingBrowserArguments = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS?.trim()
  return {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    WEBVIEW2_USER_DATA_FOLDER: webviewData,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [existingBrowserArguments, `--remote-debugging-port=${port}`]
      .filter(Boolean)
      .join(' '),
  }
}

function launch(executable, environment) {
  const launchStartedAt = Date.now()
  const child = spawn(executable, [], {
    env: environment,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  return { child, launchStartedAt }
}

function waitForExit(child, timeout = 3_000) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const timer = setTimeout(() => finish(false), timeout)
    child.once('exit', () => finish(true))
  })
}

async function stopApp(app, cdp) {
  if (!app) return
  cdp?.close()
  if (app.child.exitCode !== null) return
  app.child.kill()
  if (await waitForExit(app.child)) return
  if (process.platform === 'win32' && app.child.pid) {
    const taskkill = spawn('taskkill.exe', ['/PID', String(app.child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await waitForExit(taskkill, 5_000)
  }
}

async function safeRemoveRunRoot(runRoot) {
  const tempRoot = resolve(tmpdir())
  const resolved = resolve(runRoot)
  const prefix = join(tempRoot, 'guanmo-cold-start-')
  if (!resolved.startsWith(prefix) || resolved === tempRoot) {
    throw new Error(`拒绝清理非测试目录：${resolved}`)
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      rmSync(resolved, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 5 || !['EBUSY', 'EPERM'].includes(error.code)) throw error
      await sleep(attempt * 200)
    }
  }
}

function metric(snapshot, name, launchStartedAt) {
  const mark = snapshot.marks.find((item) => item.name === name)
  if (!mark) return null
  const frontend = snapshot.marks.find((item) => item.name === 'frontend-bootstrap')
  return {
    launchToMarkMs: Math.round(snapshot.timeOrigin + mark.startTime - launchStartedAt),
    frontendToMarkMs: frontend ? Math.round(mark.startTime - frontend.startTime) : null,
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measureSample(executable, surface, theme, index, keep) {
  const runRoot = mkdtempSync(join(tmpdir(), 'guanmo-cold-start-'))
  const copiedExecutable = join(runRoot, 'guanmo-cold-start.exe')
  copyFileSync(executable, copiedExecutable)
  let setupApp
  let setupCdp
  let measuredApp
  let measuredCdp
  try {
    const setupPort = await getFreePort()
    setupApp = launch(copiedExecutable, createEnvironment(runRoot, setupPort))
    setupCdp = await connectPage(setupPort, setupApp.child)
    await seedEditorState(setupCdp, surface, theme, setupApp.child)
    await stopApp(setupApp, setupCdp)
    setupCdp = null
    await sleep(500)

    const measuredPort = await getFreePort()
    measuredApp = launch(copiedExecutable, createEnvironment(runRoot, measuredPort))
    measuredCdp = await connectPage(measuredPort, measuredApp.child)
    const snapshot = await waitForMarkers(measuredCdp, requiredMarkers[surface], measuredApp.child)
    if (
      snapshot.themeId !== theme
      || snapshot.canvasColor !== expectedCanvasColors[theme]
      || snapshot.colorScheme !== (theme === 'dark' ? 'dark' : 'light')
    ) {
      throw new Error(
        `启动主题不匹配：期望 ${theme}/${expectedCanvasColors[theme]}，实际 ${snapshot.themeId}/${snapshot.canvasColor}/${snapshot.colorScheme}`,
      )
    }
    const result = {
      run: index,
      surface,
      theme,
      canvasColor: snapshot.canvasColor,
      launchToTimeOriginMs: Math.round(snapshot.timeOrigin - measuredApp.launchStartedAt),
      launchToHtmlStartMs: metric(snapshot, 'html-start', measuredApp.launchStartedAt)?.launchToMarkMs,
      launchToShellDomReadyMs: metric(snapshot, 'startup-shell-dom-ready', measuredApp.launchStartedAt)?.launchToMarkMs,
      launchToHtmlParsedMs: metric(snapshot, 'html-parsed', measuredApp.launchStartedAt)?.launchToMarkMs,
      launchToAppModuleReadyMs: metric(snapshot, 'app-module-ready', measuredApp.launchStartedAt)?.launchToMarkMs,
      launchToReactMountedMs: metric(snapshot, 'react-mounted', measuredApp.launchStartedAt)?.launchToMarkMs,
      launchToFirstFrameMs: metric(snapshot, 'first-animation-frame', measuredApp.launchStartedAt)?.launchToMarkMs,
      launchToSessionRestoreMs: metric(snapshot, 'startup-session-restore-complete', measuredApp.launchStartedAt)?.launchToMarkMs,
      launchToTextMs: metric(snapshot, 'active-document-first-visible', measuredApp.launchStartedAt)?.launchToMarkMs,
      launchToSurfaceMs: metric(snapshot, surface === 'edit' ? 'editor-first-visible' : 'preview-render-complete', measuredApp.launchStartedAt)?.launchToMarkMs,
      launchToAppReadyMs: metric(snapshot, 'app-ready', measuredApp.launchStartedAt)?.launchToMarkMs,
      frontendToTextMs: metric(snapshot, 'active-document-first-visible', measuredApp.launchStartedAt)?.frontendToMarkMs,
      frontendToSurfaceMs: metric(snapshot, surface === 'edit' ? 'editor-first-visible' : 'preview-render-complete', measuredApp.launchStartedAt)?.frontendToMarkMs,
      frontendToAppReadyMs: metric(snapshot, 'app-ready', measuredApp.launchStartedAt)?.frontendToMarkMs,
      marks: snapshot.marks.map((mark) => ({ name: mark.name, startTime: Math.round(mark.startTime) })),
    }
    console.log(JSON.stringify(result))
    return result
  } catch (error) {
    error.message = `第 ${index} 次冷启动失败：${error.message}`
    throw error
  } finally {
    await stopApp(measuredApp, measuredCdp)
    await stopApp(setupApp, setupCdp)
    if (!keep) {
      try {
        await safeRemoveRunRoot(runRoot)
      } catch (cleanupError) {
        console.warn(`[cold-start] 清理临时目录失败：${cleanupError.message}`)
      }
    } else {
      console.warn(`[cold-start] 保留临时目录：${runRoot}`)
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (process.platform !== 'win32') throw new Error('当前测量脚本依赖 Windows WebView2，仅支持 Windows')
  if (!existsSync(options.executable)) throw new Error(`找不到可执行文件：${options.executable}`)

  const results = []
  for (let index = 1; index <= options.runs; index += 1) {
    results.push(await measureSample(options.executable, options.surface, options.theme, index, options.keep))
  }

  const summary = {
    test: 'cold-start',
    surface: options.surface,
    theme: options.theme,
    runs: results.length,
    metrics: {
      launchToHtmlStartMedianMs: median(results.map((result) => result.launchToHtmlStartMs)),
      launchToShellDomReadyMedianMs: median(results.map((result) => result.launchToShellDomReadyMs)),
      launchToHtmlParsedMedianMs: median(results.map((result) => result.launchToHtmlParsedMs)),
      launchToAppModuleReadyMedianMs: median(results.map((result) => result.launchToAppModuleReadyMs)),
      launchToReactMountedMedianMs: median(results.map((result) => result.launchToReactMountedMs)),
      launchToFirstFrameMedianMs: median(results.map((result) => result.launchToFirstFrameMs)),
      launchToSessionRestoreMedianMs: median(results.map((result) => result.launchToSessionRestoreMs)),
      launchToTextMedianMs: median(results.map((result) => result.launchToTextMs)),
      launchToSurfaceMedianMs: median(results.map((result) => result.launchToSurfaceMs)),
      launchToAppReadyMedianMs: median(results.map((result) => result.launchToAppReadyMs)),
      frontendToTextMedianMs: median(results.map((result) => result.frontendToTextMs)),
      frontendToSurfaceMedianMs: median(results.map((result) => result.frontendToSurfaceMs)),
      frontendToAppReadyMedianMs: median(results.map((result) => result.frontendToAppReadyMs)),
    },
    samples: results,
  }
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(`[cold-start] ${error.message}`)
  process.exitCode = 1
})
