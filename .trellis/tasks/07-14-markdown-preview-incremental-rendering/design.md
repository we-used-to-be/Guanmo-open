# Markdown 大文档预览增量渲染设计

## Architecture

采用双路径：低于阈值的文档沿用单个 `ReactMarkdown`；大文档进入 `Worker parse -> stable AST blocks -> lazy block renderer`。

1. `markdownPreviewParserCore.ts` 复刻现有 ReactMarkdown 的 unified 管线，完成 Latex 分隔符归一化、remark-parse、GFM、math、remark-rehype、KaTeX 与 highlight。
2. `markdownPreview.worker.ts` 串行接收带请求 ID 的内容，返回可结构化克隆的 HAST 顶层块。
3. `markdownPreviewParser.ts` 维护共享 Worker 和请求表，避免左右预览各创建一个 Worker；组件卸载或内容更新时通过请求 ID 忽略过期结果。
4. `MarkdownPreview.tsx` 保留现有小文档渲染器；大文档把每个 HAST 块交给稳定键组件，并用 IntersectionObserver 在滚动容器附近惰性挂载。

## Data Contract

Worker 请求：`{ id: number, content: string }`。

Worker 响应：

- 成功：`{ id, result: { blocks } }`
- 失败：`{ id, error: string }`

每个块包含：

- `key`：忽略 position 后的语义内容哈希加同内容出现序号，用于跨版本复用。
- `startLine/endLine`：原文行范围，用于占位估高、滚动锚点和增量比较。
- `tree`：只含该顶层语义块的 HAST Root。

## Rendering and Virtualization

- 低于大文档阈值时不启动 Worker。
- 大文档首次展示时优先挂载前若干块；其余块以行数估高。
- IntersectionObserver 使用预览滚动容器为 root，并设置上下预加载边界；块一旦进入边界即挂载并保留，避免往返滚动反复解析和 Mermaid 重渲染。
- ResizeObserver 记录实际块高到有界内存缓存；相同稳定键再次出现时复用实测高度，减小滚动跳动。
- 块 wrapper 自带原文 `data-md-line/data-md-end-line`，因此外层现有滚动锚点查询在未挂载正文时仍可工作。

## Compatibility

- HAST 转 JSX 使用与 `react-markdown@10` 相同的 `hast-util-to-jsx-runtime` 参数：`passKeys`、`passNode`、`ignoreInvalidStyle`。
- Worker 在返回前把 raw HTML 节点转为文本，并执行与 ReactMarkdown 默认策略等价的 URL 协议过滤。
- 所有已有自定义元素 renderer 由大小文档两条路径共用；原始行号直接来自 Worker 对整篇文档生成的 position。
- 解析失败时设置该内容版本为 fallback，直接走原同步渲染器。

## Trade-offs

- 不实现编辑器式增量 parser：现有 unified 插件链没有稳定的增量解析契约。Worker 仍会解析整篇，但解析和高亮不阻塞 UI；稳定 AST 块把主线程提交限制到变更块。
- 不引入 `react-window` 等依赖：其可变高度和现有行号滚动契约需要更大范围改造。近视口惰性挂载保留完整滚动容器结构，风险更小。
- 块首次实测高度可能与估值不同；通过近视口提前挂载、实测缓存和浏览器滚动锚定降低可见跳动。

## Rollback

优化集中在新增 parser/worker 文件与 `MarkdownPreview.tsx` 的大文档分支；删除大文档分支即可恢复原同步路径，不影响 `EditorArea` 外层结构。
