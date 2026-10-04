# 长文档专项基准

样本由 `long-document-cases.ts` 固定生成，只包含匿名结构化文本。基准直接调用预览模型，不经过正式文件打开入口，因此不会改变 1 MiB 产品限制。

## Node：读取、解析、模型与几何

在仓库根目录运行 `node --expose-gc scripts/long-document-benchmark.mjs`。可在命令末尾附加样本名，例如 `giant-table-100000`。默认每项重复 3 次并报告中位数；`GM_LONG_BENCH_REPEATS` 可覆盖次数。文件读取使用临时 `.md`，每项完成后删除其自建临时文件。`parseMs` 是同配置 remark 解析的独立计时；`modelMs` 是完整 `createMarkdownPreviewModel` 计时，二者不能相减当作精确的“模型额外成本”。

## Edge：生产预览组件、DOM 与交互

先运行 `npx vite --mode web --host 127.0.0.1 --port 4179`，再以 Playwright CLI 打开 `http://127.0.0.1:4179/scripts/long-document-browser.html`，浏览器选择 `msedge`。在页面执行 `await window.runLongDocumentCase('ordinary-100000')`；可用样本名见 `window.longDocumentCases`。重复测量时先刷新页面。此入口渲染正式 `MarkdownPreview`，但跳过文件对话框、Tauri IPC 和应用启动链路。

浏览器指标中的 `firstVisibleMs` 是组件回调时间，`firstFrameMs` 是再经过两次动画帧后的时间。`performance.memory` 只表示 Chromium JS Heap 快照；它不是 WebView2 私有内存，也不是可靠峰值。正式 WebView2 内存与整应用冷启动须另外使用隔离数据目录和新鲜 Tauri Release 测量。

## 巨大单块隔离实验

`node scripts/heavy-block-benchmark.mjs` 对固定表格、列表、代码块分别计时同配置 GFM parse、无 GFM parse、完整预览模型及一次线性预检扫描。设置 `GM_HEAVY_SWEEP_ONLY=1` 可只跑 5k～30k 表格、50k～200k 列表和代码的阈值样本；命令末尾可指定单个样本名。扫描器是成本实验，不提供正式 Markdown 语义判定。

在同一 Vite 服务中打开 `http://127.0.0.1:4179/scripts/heavy-block-browser.html`，执行 `await window.runHeavyBlockCase('giant-code-300000', 'highlight-annotated')`。支持 `parse`、`production`、`highlight`、`plain`、`highlight-annotated`、`plain-annotated`、`code-plain-pre`、`list-batch` 变体。`parse` 在浏览器内分别计时 GFM parse、无 GFM parse 和全文模型；后四个 `ReactMarkdown` 变体用于单独识别高亮和源码标注成本；`list-batch` 只挂前 100 项，是首屏节点数的下界原型，尚未解决嵌套/跨项语义及完整选区。`modelBuildMs` 在 `firstFrameMs` 之外单独计时。除 `production` 外，原型不包含生产预览全部交互包装，不能将其首帧当作正式产品改造后的准确收益。

浏览器需要使用同一设备、同一浏览器、刷新后重复运行。CDP `Performance.getMetrics` 的 `ScriptDuration`、`LayoutDuration`、`RecalcStyleDuration` 可区分脚本与布局；`HeapProfiler.collectGarbage` 前后 JS Heap 差值只表示保留量，不代表进程峰值或 WebView2 内存。Windows 剪贴板读回会把 LF 变成 CRLF，比较时须先规范化换行。
