# Markdown 编辑与预览契约

涉及 Markdown 渲染、大文档、预览内源码编辑、块定位、滚动同步或预览 Worker 时，修改前必须读取本文件。

- 所有文档统一使用同步 `ReactMarkdown` 渲染；不得按内容长度切换 Worker 或"正在解析预览"占位路径。
- 预览采用可视区优先渲染：全文只执行一次 `createMarkdownPreviewModel` 解析，仅挂载可视区附近顶层块（含有限 overscan），未挂载块使用高度估计作为占位。首屏 DOM 节点数不随全文规模线性增长。
- 搜索高亮、文本选区、复制、Ctrl+A 与 AI 上下文统一基于 `src/services/previewHighlight.ts` 的 `DocumentRange`（块 ID + 块内源码 offset）；DOM 只负责显示与获取交互位置。状态存活于文档模型与 ref，虚拟块卸载不丢失，重挂载时按 `previewHighlightRegistry` 自动恢复高亮。
- 预览选区由组件接管（渲染时注入 `<span data-gm-src-from/to>` 源码标注）：拖选经 rAF 节流映射为源码 offset，Ctrl+C 走 `getTextForSourceRange` 而非 DOM Selection；普通语法高亮代码块在 token 重建后依据模型 `textSegments` 恢复映射，KaTeX / Mermaid / ECharts 等无法可靠对应字符位置的子树仍降级为原生行为。禁止退回"空闲后逐渐渲染全文 DOM"或 DOM 文本长度推测源码位置。
- 跨块 reference 与 footnote 在全文模型中提取有效定义及源码引用位置，虚拟块只附加本块实际依赖的定义；脚注正文统一在文末渲染，定义源码不占正文虚拟高度。同步整篇 HTML 兼容路径仍须保留，不得为虚拟化静默降级 Markdown 语义。
- 预览顶层块统一由 `src/services/markdownBlocks.ts` 基于原始 Markdown offset 描述；预览内源码编辑必须按原始切片精确替换并在切片失效时保留草稿、提示冲突，不得使用 LaTeX 规范化后的 offset。
- “预览内源码编辑”设置默认开启；Alt+点击由预览容器事件委托处理，块编辑器只维护局部 draft，退出时才写回完整文档。
- 大文档编辑继续使用 `EditorArea` 的预览更新防抖，目录跳转、任务列表行号和滚动同步沿用现有 DOM 行号标记。
- 桌面构建不得产出 `markdownPreview.worker-*` 独立脚本，回归检查由 `npm run build:desktop` 执行。

## 不可信渲染边界

- 原始 HTML 和内联 SVG 继续经过 `markdownHtml.ts` 的统一清洗链；SVG 样式只能使用已作用域化的安全规则及本地片段引用。清洗后不得重新拼入原始 HTML。
- Mermaid 使用现有 `securityLevel: 'strict'` 和库内 SVG 清洗，不调用文档定义的回调；预览、分屏和全屏共用该入口。
- ECharts 只接收受限 JSON；tooltip 固定使用 Canvas `richText`，保留字符串模板作为文本，未配置 tooltip 时不新增可见提示。拒绝启用 HTML `toolbox.feature.dataView`，可改用安全图表或 Markdown 表格；拒绝危险协议、远程/协议相对资源、SVG data URL 和原型字段。解析/渲染失败只显示固定错误，不把原始错误或配置值拼入提示。
- 安全专项定向测试：`tests/services/echartsOption.test.ts`、`renderingSecurity.test.ts` 和 `tests/markdown-preview-prototype/{html,svg}-sanitize.test.tsx`。静态 CSP/ACL 检查不替代浏览器或原生 IPC 验收。

## ReadingMark

- 批注 anchor 必须由一次 `PreviewSelectionSnapshot` 生成，保存全文 UTF-16 offset、`DocumentRange`、可见 quote 与上下文；不得持久化 DOM 节点或 DOM Range。
- `previewHighlightRegistry` 按 kind 隔离 ReadingMark、搜索和普通选区。虚拟块卸载只清理该块 DOM Range，重挂载按完整 ReadingMark 索引恢复；不可依赖块是否当前挂载来判断批注存在。
