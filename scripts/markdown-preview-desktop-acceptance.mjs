// 真实 Windows WebView2 预览验收；只写调用方提供的匿名临时文件。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'

const stages = ['START', 'MIDDLE', 'END']
const paragraph = stage => `GM_ACCEPT_${stage}_TEXT **bold_${stage}** and *italic_${stage}*.`
const checkpoint = stage => `# GM_ACCEPT_${stage}\n\n${paragraph(stage)}\n\n| Key | Value |\n| --- | --- |\n| row_${stage}_1 | value_${stage}_1 |\n| row_${stage}_2 | value_${stage}_2 |\n\n\`\`\`typescript\nconst GM_ACCEPT_${stage} = "code_${stage}";\n\`\`\`\n\n$$\nx_{${stage}}^2 + y^2 = z^2\n$$\n\n- item_${stage}_1\n- item_${stage}_2\n\n`

export function createPreviewAcceptanceFixture(bytes, unit) {
  const blocks = stages.map(checkpoint)
  const spare = bytes - Buffer.byteLength(blocks.join(''))
  const fill = size => {
    let result = unit.repeat(Math.floor(size / Buffer.byteLength(unit)))
    const short = 'Anonymous filler paragraph for preview acceptance.\n\n'
    result += short.repeat(Math.floor((size - Buffer.byteLength(result)) / Buffer.byteLength(short)))
    return result + ' '.repeat(size - Buffer.byteLength(result))
  }
  const firstGap = Math.floor(spare / 2)
  return blocks[0] + fill(firstGap) + '\n\n' + blocks[1] + fill(spare - firstGap - 4) + '\n\n' + blocks[2]
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// STA 进程保留原剪贴板各格式的数据；旧内容只留在内存，不输出、不写报告。
async function preserveClipboard() {
  const source = `
Add-Type -AssemblyName System.Windows.Forms
$saved = New-Object System.Windows.Forms.DataObject
$old = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($null -ne $old) {
  foreach ($format in $old.GetFormats($false)) {
    $value = $old.GetData($format, $false)
    if ($null -eq $value) { throw 'Cannot preserve clipboard format' }
    $saved.SetData($format, $false, $value)
  }
}
[Console]::Out.WriteLine('READY')
try {
  while ($null -ne ($command = [Console]::ReadLine())) {
    if ($command -eq 'READ') {
      $value = [System.Windows.Forms.Clipboard]::GetText()
      [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)))
    } elseif ($command -eq 'RESTORE') { break }
  }
} finally {
  if ($saved.GetFormats($false).Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() }
  else { [System.Windows.Forms.Clipboard]::SetDataObject($saved, $true, 5, 100) }
  [Console]::Out.WriteLine('RESTORED')
}
`
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const buffer = []
  let waiter
  lines.on('line', line => { if (waiter) { const accept = waiter; waiter = null; accept(line) } else buffer.push(line) })
  const next = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('clipboard helper timed out')), 10_000)
    const accept = line => { clearTimeout(timer); resolve(line) }
    if (buffer.length) accept(buffer.shift())
    else waiter = accept
  })
  child.on('error', () => child.stdin.end())
  if (await next() !== 'READY') throw Error('clipboard backup failed; copy test not started')
  return {
    async read() { const response = next(); child.stdin.write('READ\n'); return Buffer.from(await response, 'base64').toString('utf8').replace(/\r\n/g, '\n') },
    async restore() { const response = next(); child.stdin.write('RESTORE\n'); child.stdin.end(); if (await response !== 'RESTORED') throw Error('clipboard restore failed') },
  }
}

export async function runPreviewAcceptance({ cdp, content, fixture, output, bytes }) {
  const result = { status: 'FAIL', checks: [], clipboardRestore: 'NOT TESTED' }
  let clipboard
  const check = async (name, fn) => {
    try { const evidence = await fn(); result.checks.push({ name, status: 'PASS', ...evidence }); return true }
    catch (error) {
      result.checks.push({ name, status: 'FAIL', error: error.message })
      await screenshot(`failure-${name}`)
      return false
    }
  }
  const wait = async (expression, description, timeout = 10_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { const value = await cdp.evaluate(expression); if (value) return value; await pause(50) }
    throw Error(description)
  }
  const key = async (key, code, modifiers = 0) => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
  }
  const mouse = async (x, y, modifiers = 0, clickCount = 1) => {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, modifiers })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, modifiers })
  }
  const navigate = async stage => {
    const point = await cdp.evaluate(`(() => {
      const button=Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(`GM_ACCEPT_${stage}`)});
      if(!button)throw Error('checkpoint TOC button missing');button.scrollIntoView({block:'nearest'});
      const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`)
    await mouse(point.x, point.y)
    try { await wait(`(() => {
      const heading=Array.from(document.querySelectorAll('[data-md-render-mode] h1')).find(el=>el.textContent.trim()===${JSON.stringify(`GM_ACCEPT_${stage}`)});
      if(!heading)return false; let clip=heading.parentElement;
      while(clip&&!['auto','scroll'].includes(getComputedStyle(clip).overflowY))clip=clip.parentElement;
      const r=heading.getBoundingClientRect(),c=clip.getBoundingClientRect();return r.top>=c.top-2 && r.bottom<=c.bottom;
    })()`, `${stage} heading did not enter viewport`) }
    catch {
      const probe = await cdp.evaluate(`(() => {
        const h=Array.from(document.querySelectorAll('[data-md-render-mode] h1')).find(el=>el.textContent.trim()===${JSON.stringify(`GM_ACCEPT_${stage}`)});
        let el=document.querySelector('[data-md-render-mode]');while(el&&!['auto','scroll'].includes(getComputedStyle(el).overflowY))el=el.parentElement;
        return {headingMounted:!!h,headingRect:h?.getBoundingClientRect().toJSON(),scrollTop:el?.scrollTop,scrollHeight:el?.scrollHeight,clip:el?.getBoundingClientRect().toJSON()};
      })()`)
      throw Error(`${stage} TOC target not visible: ${JSON.stringify(probe)}`)
    }
    await pause(300)
  }
  const screenshot = async label => {
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(output.replace(/\.json$/, `-${label}.png`), Buffer.from(shot.data, 'base64'))
  }
  const positionOfMarker = async marker => cdp.evaluate(`(() => {
    const root=document.querySelector('[data-md-render-mode]');
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
    while(node=walker.nextNode()){const start=node.textContent.indexOf(${JSON.stringify(marker)});if(start<0)continue;
      const range=document.createRange();range.setStart(node,start+2);range.setEnd(node,start+3);const r=range.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}
    throw Error('visible text marker missing');
  })()`)
  try {
    await cdp.evaluate(`window.__previewAcceptanceErrors=[];window.addEventListener('error',()=>window.__previewAcceptanceErrors.push('error'));window.addEventListener('unhandledrejection',()=>window.__previewAcceptanceErrors.push('unhandledrejection'))`)
    await check('exact-byte-fixture', async () => {
      if (Buffer.byteLength(content) !== bytes || !content.endsWith(checkpoint('END'))) throw Error('fixture size or tail mismatch')
      return { bytes: Buffer.byteLength(content) }
    })
    for (const stage of stages) {
      await check(`toc-and-render-${stage.toLowerCase()}`, async () => {
        await navigate(stage)
        const evidence = await wait(`(() => {
          const root=document.querySelector('[data-md-render-mode]');
          const text=root.textContent;
          const table=Array.from(root.querySelectorAll('table')).find(el=>el.textContent.includes('row_${stage}_1'));
          const code=Array.from(root.querySelectorAll('pre code')).find(el=>el.textContent.includes('GM_ACCEPT_${stage}'));
          const math=Array.from(root.querySelectorAll('.katex annotation')).find(el=>el.textContent==='x_{${stage}}^2 + y^2 = z^2');
          const bold=Array.from(root.querySelectorAll('strong')).some(el=>el.textContent==='bold_${stage}');
          const italic=Array.from(root.querySelectorAll('em')).some(el=>el.textContent==='italic_${stage}');
          if(!table || table.querySelectorAll('tbody tr').length!==2 || !table.textContent.includes('value_${stage}_2') || !code || code.textContent.trim()!=='const GM_ACCEPT_${stage} = "code_${stage}";' || !math || !bold || !italic || !text.includes('item_${stage}_2') || root.querySelector('.katex-error'))return false;
          return {tableRows:2,codeHighlighted:code.querySelectorAll('span').length>0,formula:true,bold,italic,blocks:root.querySelectorAll('[data-md-block-index]').length};
        })()`, `${stage} rendered semantics mismatch`)
        if (!evidence.codeHighlighted) throw Error('code highlighting missing')
        await screenshot(stage.toLowerCase())
        return evidence
      })
    }
    await check('bottom-reachable', async () => {
      const probe = await cdp.evaluate(`(async()=>{
        let root=document.querySelector('[data-md-render-mode]'),el=root;
        while(el&&!['auto','scroll'].includes(getComputedStyle(el).overflowY))el=el.parentElement;
        if(!el)throw Error('scroll container missing');el.scrollTop=el.scrollHeight;
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        return {tail:root.textContent.includes('item_END_2'),distanceToBottom:el.scrollHeight-el.scrollTop-el.clientHeight,blocks:root.querySelectorAll('[data-md-block-index]').length};
      })()`)
      if (!probe.tail || probe.distanceToBottom > 10) throw Error('last block not reachable')
      return probe
    })
    await check('toc-return-start-remount', async () => {
      await navigate('START'); await navigate('END')
      return { remount: true }
    })
    clipboard = await preserveClipboard()
    await check('native-word-selection-copy', async () => {
      await navigate('END')
      const point = await positionOfMarker('GM_ACCEPT_END_TEXT')
      await mouse(point.x, point.y, 0, 2)
      await key('c', 'KeyC', 2)
      let copied = ''
      for (let i = 0; i < 30; i++) { copied = await clipboard.read(); if (copied === 'GM_ACCEPT_END_TEXT') break; await pause(50) }
      if (copied !== 'GM_ACCEPT_END_TEXT') throw Error('native selected word clipboard mismatch')
      return { chars: copied.length }
    })
    await check('native-whole-document-copy', async () => {
      await key('a', 'KeyA', 2); await key('c', 'KeyC', 2)
      let copied = ''
      for (let i = 0; i < 40; i++) { copied = await clipboard.read(); if (copied.includes('GM_ACCEPT_START_TEXT') && copied.includes('GM_ACCEPT_MIDDLE_TEXT') && copied.includes('GM_ACCEPT_END_TEXT')) break; await pause(50) }
      const expectedUnits = content.split('title: Anonymous Benchmark').length - 1
      if (copied.length < 300_000 || copied.split('title: Anonymous Benchmark').length - 1 !== expectedUnits || stages.some(stage=>copied.split(`GM_ACCEPT_${stage}_TEXT`).length!==2) || copied.includes('**bold_END**')) throw Error('logical full copy missing source checkpoints or repeated sections')
      await key('Escape', 'Escape')
      return { chars: copied.length, repeatedSections: expectedUnits, sha256: createHash('sha256').update(copied).digest('hex') }
    })
    await check('inline-edit-exact-source-and-save', async () => {
      await navigate('END')
      const point = await positionOfMarker('GM_ACCEPT_END_TEXT')
      await mouse(point.x, point.y, 1)
      await wait(`!!document.querySelector('.gm-inline-markdown-editor .cm-content')`, 'inline editor did not open')
      await cdp.evaluate(`document.querySelector('.gm-inline-markdown-editor .cm-content').focus()`)
      await key('a', 'KeyA', 2)
      const draft = paragraph('END').replace('_TEXT', '_EDIT')
      await cdp.call('Input.insertText', { text: draft })
      const draftProbe = await cdp.evaluate(`document.querySelector('.gm-inline-markdown-editor .cm-content').textContent`)
      if (draftProbe !== draft) throw Error('inline input did not match requested draft')
      await key('s', 'KeyS', 2)
      const expected = content.replace(paragraph('END'), draft)
      for (let i = 0; i < 150 && readFileSync(fixture, 'utf8') !== expected; i++) await pause(100)
      if (readFileSync(fixture, 'utf8') !== expected) {
        const probe = await cdp.evaluate(`({inlineStillOpen:!!document.querySelector('.gm-inline-markdown-editor .cm-content'),draftHasEdit:document.querySelector('.gm-inline-markdown-editor .cm-content')?.textContent.includes('GM_ACCEPT_END_EDIT'),previewHasEdit:document.querySelector('[data-md-render-mode]').textContent.includes('GM_ACCEPT_END_EDIT')})`)
        throw Error(`inline Ctrl+S mismatch: ${JSON.stringify({...probe,fileHasEdit:readFileSync(fixture,'utf8').includes('GM_ACCEPT_END_EDIT')})}`)
      }
      await wait(`document.querySelector('[data-md-render-mode]').textContent.includes('GM_ACCEPT_END_EDIT')`, 'edited preview not displayed')
      await cdp.evaluate(`document.querySelector('button[title="编辑模式"]').click()`)
      await wait(`!!document.querySelector('.cm-content')`, 'edit mode did not mount after commit')
      await cdp.evaluate(`document.querySelector('button[title="预览模式"]').click()`)
      await wait(`!!document.querySelector('[data-md-render-mode]')`, 'preview did not remount after commit')
      await navigate('END')
      await wait(`document.querySelector('[data-md-render-mode]').textContent.includes('GM_ACCEPT_END_EDIT')`, 'inline edit lost across modes')
      await screenshot('edited')
      return { bytes: Buffer.byteLength(expected), exactFileMatch: true, modeRoundtrip: true }
    })
    await check('inline-outside-click-commit-and-save', async () => {
      const draft = paragraph('END').replace('_TEXT', '_EDIT')
      const expected = content.replace(paragraph('END'), draft)
      const stillEditing = await cdp.evaluate(`!!document.querySelector('.gm-inline-markdown-editor .cm-content')`)
      if (stillEditing) {
        const point = await positionOfMarker('GM_ACCEPT_END')
        await mouse(point.x, point.y)
        await wait(`!document.querySelector('.gm-inline-markdown-editor .cm-content')`, 'outside click did not commit draft')
        await key('s', 'KeyS', 2)
      }
      for (let i = 0; i < 100 && readFileSync(fixture, 'utf8') !== expected; i++) await pause(100)
      if (readFileSync(fixture, 'utf8') !== expected) throw Error('outside-click commit/save did not preserve exact source')
      await cdp.evaluate(`document.querySelector('button[title="编辑模式"]').click()`)
      await wait(`!!document.querySelector('.cm-content')`, 'edit surface missing after outside commit')
      await cdp.evaluate(`document.querySelector('button[title="预览模式"]').click()`)
      await wait(`!!document.querySelector('[data-md-render-mode]')`, 'preview missing after outside commit')
      await navigate('END')
      await wait(`document.querySelector('[data-md-render-mode]').textContent.includes('GM_ACCEPT_END_EDIT')`, 'edit lost after mode switch')
      await screenshot('outside-commit')
      return { exactFileMatch: true, bytes: Buffer.byteLength(expected), modeRoundtrip: true, exercisedOutsideClick: stillEditing }
    })
    await check('runtime-errors', async () => {
      const errors = await cdp.evaluate('window.__previewAcceptanceErrors')
      if (errors.length) throw Error('runtime errors during acceptance')
      return { count: 0 }
    })
  } catch (error) {
    result.checks.push({ name: 'acceptance-harness', status: 'FAIL', error: error.message })
  } finally {
    if (clipboard) {
      try { await clipboard.restore(); result.clipboardRestore = 'PASS' }
      catch { result.clipboardRestore = 'FAIL' }
    }
  }
  result.status = result.checks.length === 11 && result.checks.every(item=>item.status==='PASS') && result.clipboardRestore === 'PASS' ? 'PASS' : 'FAIL'
  return result
}
