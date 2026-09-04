# Native Preview Renderer PoC 任务计划

## 当前状态

- 当前阶段：Phase 0｜等待独立实验分支准备
- 阶段状态：未开始
- 当前结论：选择 C，先做 Native Renderer PoC，不直接迁移生产实现
- 本轮结果：仅初始化本任务文档，未创建分支、worktree 或实现代码
- 当前主线快照：`main` @ `3595ad4008b66d51218c856c6921600a5a6bb150`（仅记录建档时状态，不作为未来 PoC 起点）
- 当前工作区：存在其他未提交修改；均属于既有工作，不纳入本任务
- 生产实现：PoC 全阶段继续使用现有 Renderer，默认路径不得切换
- 本阶段剩余：等待人工确认启动 PoC，并在干净工作区从当时最新主线创建实验分支
- 本阶段允许修改：仅本任务文档
- 阻塞问题：PoC 尚未获得开始实现授权；当前工作区不干净
- 下一阶段：Phase 1｜完整 HTML / Native DOM 初始渲染验证

## 项目目标与结论

当前专项调研结论为 **C：值得做 Native Renderer PoC**。本任务只验证候选架构是否值得进入逐步迁移，不预设迁移一定成功，也不在 PoC 前替换现有生产 Renderer。

候选主链路：

```text
Markdown Source
→ unified / remark / rehype
→ HAST + source metadata
→ HTML
→ Native DOM
→ React Overlay / Enhancement
```

目标形态是经过验证后收敛为**单一 Native Renderer**，普通 Markdown 使用完整 Native DOM，只有超大表格、超长代码块、大量 Mermaid 等重型节点采用局部 lazy render / virtualization。现有 Renderer 是 PoC 与迁移期的生产实现和对照基线，不应演变为永久维护的第二套 Renderer。

## 必须保持的架构边界

- 保留现有 remark/rehype 插件生态，不默认切换 markdown-it。
- 保留 `DocumentRange`、全文源码 offset、source metadata、MarkdownPreviewModel 的文档级语义；DOM 仍是派生渲染结果，不得成为搜索、批注、Selection 或 AI 上下文的 Source of Truth。
- 保留现有 raw HTML、sanitize、SVG、KaTeX 等安全清洗顺序和能力边界；PoC 不得通过放宽清洗规则换取兼容性。
- 优先只替换最终的 React Element/Fiber 正文渲染阶段；Toolbar、Popover、AI、批注弹窗、图片查看器等继续由 React Overlay/Portal 负责。
- 普通交互优先使用预览根节点事件委托；不得为每个正文节点重新创建 React 组件和监听器。
- PoC 不修改生产默认路径，不改变现有 Renderer 行为，不删除现有虚拟化与补偿逻辑。
- 不提前加入正式设置项、迁移脚本、兼容层或长期双 Renderer 抽象。

## 分支策略

- 本轮不创建实验分支，也不创建 worktree。
- 主线继续正常修复 issue、开发和发布，不等待 Native Preview PoC。
- 用户描述中的 `master` 表示产品主线；建档时仓库实际主线分支名为 `main`。真正开始时必须重新确认远端默认分支和本地分支名，不得照抄过期名称。
- 真正开始 PoC 前，先确保当前工作区干净；不得 stash、reset、覆盖或夹带届时仍存在的用户修改。工作区不干净时停止并交由人工处理。
- 从**当时最新的主线**创建并切换实验分支，分支固定命名为 `experiment/native-preview`。
- 以当前分支命名为例，人工确认主线已同步后执行：

  ```powershell
  git status --short
  git switch main
  git status --short
  git switch -c experiment/native-preview
  git branch --show-current
  git rev-parse HEAD
  ```

- 若届时主线实际名为 `master`，将上面的 `main` 替换为 `master`；不得同时假定两者存在。
- 所有 Native Preview 实验代码、fixture、benchmark 工具和报告只在 `experiment/native-preview` 开发。
- 主线继续推进后，实验分支只在预先约定节点 rebase 或 merge 当时最新主线；同步前保持工作区干净、记录基线 HEAD，并在同步后重跑受影响基准，禁止无节点地频繁追随主线。
- 未经人工确认，不得将实验代码合并、cherry-pick 或提交回主线，不得推送、打 tag 或创建 Release。
- PoC 失败时可直接删除实验分支；删除前仍需人工确认，并保留最终报告。失败不得要求主线回退或清理生产代码。

## 成功定义

PoC 必须同时回答：

1. 去除正文 React Element/Fiber 与全文虚拟化后，普通 Markdown 的首次渲染、更新和内存是否得到稳定收益。
2. 完整 Native DOM 在 10 万、50 万、100 万字及高 DOM 复杂度文档上是否仍可接受。
3. morphdom 是否能在不破坏 Selection、Range、焦点、滚动锚点和增强节点状态的前提下降低编辑更新成本。
4. `DocumentRange`、source metadata、安全清洗和现有功能能否继续作为统一契约，而非重建第二套数据模型。
5. 重型节点成本能否被局部 lazy/virtualization 隔离，而无需恢复文档级虚拟化。

## Phase 1｜完整 HTML / Native DOM 初始渲染性能验证

### 目标

建立最小、独立、不可进入生产默认路径的 Native Renderer，只验证：

```text
remark/rehype → HAST → HTML → DOMParser → 完整 Native DOM
```

### 范围

- 复用现有 remark/rehype 配置、安全清洗与 source metadata，必要时抽取纯管线，但不改现有 Renderer 输出。
- 正文不生成 React Element/Fiber，不做全文虚拟化。
- 仅实现足够覆盖普通 Markdown、GFM、代码高亮、KaTeX、图片和安全 HTML 的静态输出。
- React 只提供实验容器、性能打点和必要 Overlay 边界。
- 先验证初始全量渲染，不引入 morphdom，不实现复杂交互。

### 验收

- 当前 Renderer 与 Native Renderer 能在同一匿名 fixture、同一 Release WebView2 环境中独立运行。
- 记录 parse、HAST transform、stringify、DOMParser、插入 DOM、首个真实正文可见、完整渲染、内存、DOM 节点、React/Fiber 代理指标、layout/paint。
- 样式与 sanitize 结果达到可比较状态；不得以功能缺失制造性能优势。
- 现有生产默认路径和 bundle 边界无变化。

### 暂不处理

- morphdom、编辑增量更新、Selection、搜索、批注、AI、Alt+点击、Mermaid 完整增强。

## Phase 2｜morphdom 更新验证

### 目标

验证内容变化时生成新完整 HTML，并以 morphdom patch 正文容器，是否优于现有 React reconciliation / 分块重挂载。

### 范围

- morphdom 只能 patch 独立 Native 正文根节点，React Overlay 根节点必须位于 patch 边界之外。
- 为需要保留身份的节点设计稳定 key，候选输入为节点类型、source offset、语义 ID；不得把 DOM 身份提升为业务数据源。
- 保护滚动位置、焦点、`<details open>`、原生 Selection/Range 和异步增强节点。
- 每次更新取消旧的 parse/增强任务，旧文档结果不得覆盖当前文档。
- 分别测量小范围编辑、文档头部编辑、中部编辑、尾部编辑和全量替换。

### 验收

- 输出语义与 Phase 1 全量替换一致。
- 记录 stringify、DOMParser、morph、style/layout/paint、更新到真实正文稳定的延迟。
- 快速连续编辑和快速切换文档不存在旧结果回写。
- 明确哪些节点可复用、哪些节点必须作为不透明节点保护或重建。

### 暂不处理

- 不以临时兼容补丁完成全部业务功能；复杂功能留到后续阶段。

## Phase 3｜Selection、Search、Highlight、TOC、滚动同步

### 目标

证明完整 DOM 可以简化浏览器原生交互，同时继续遵守全文模型和 `DocumentRange` 契约。

### 范围

- 全文选择、跨块拖选、Ctrl+A、Copy 优先使用原生 DOM 行为，但业务 Range 必须映射回现有源码 offset。
- 搜索结果继续基于全文模型计算；Decoration Layer 优先使用 CSS Custom Highlight API + DOM Range。
- morph 后重建失效 Range/Highlight，不得从高亮 DOM 反推匹配数据。
- TOC 跳转和编辑器 ↔ 预览滚动同步使用 source metadata；验证图片、KaTeX 等高度变化后的锚点稳定性。
- 保留当前 Renderer 同功能对照，覆盖跨全文选择、未挂载内容不再存在后的行为变化以及 Ctrl+A/Copy 语义。

### 验收

- Selection、Search、Highlight 的源码 offset 与文本提取结果精确一致。
- TOC 和双向滚动同步达到 Go 条件中的准确性阈值。
- morph、主题切换和窗口宽度变化后无残留高亮、选区错位或滚动反跳。

## Phase 4｜批注、AI Selection、Alt+点击编辑与重型增强

### 目标

补齐高价值业务功能，并验证重型节点局部治理是否足以替代文档级虚拟化。

### 范围

- 批注继续持久化全文 UTF-16 offset 与 `DocumentRange`，CSS Highlight 只负责显示。
- AI Selection 继续消费模型 Range，不依赖当前 DOM 文本作为长期事实。
- Alt+点击通过事件委托和 source metadata 打开 React 内联编辑 Overlay；保存仍按原始 Markdown 切片写回。
- Mermaid 使用占位节点、按需加载、取消旧任务和主题感知增强；优先研究 IntersectionObserver 与内容 hash 复用。
- KaTeX 默认继续由 rehype 阶段生成；只有指标证明必要时才研究局部延迟。
- 超大表格、超长代码块、大量 Mermaid 等仅做局部 lazy/virtualization 实验。
- 图片查看、代码复制、任务列表、链接等普通交互改为事件委托或 React Overlay。

### 验收

- 批注恢复、AI Selection、Alt+点击编辑在内容更新和 morph 后保持源码位置准确。
- Mermaid 快速切换文档/主题时旧结果不会写回，失败状态可恢复。
- 重型节点优化不改变普通 Markdown 为完整 Native DOM 的主架构。
- 形成兼容性、性能、风险和剩余补偿逻辑清单。

## Phase 5｜最终评估与迁移决策

### 目标

汇总所有 Release WebView2 基准和功能验收，只做 Go / No-Go 决策，不自动合并主线。

### 可能结论

- **Go：** Native Renderer 达标，另建经人工确认的逐步迁移计划；最终删除旧 Renderer，收敛为单一 Native Renderer。
- **Conditional Go：** 普通文档达标，但部分重型节点需先完成局部治理；继续实验分支，不进入主线默认路径。
- **No-Go：** 性能、内存、正确性或安全边界不达标；停止实验，保留报告，人工确认后删除实验分支。

## Benchmark 文档矩阵

所有 fixture 必须匿名、可生成、可重复；不得读取真实用户文档。

| 类别 | 规模或变体 | 重点风险 |
|---|---|---|
| 普通 Markdown | 10 万 / 50 万 / 100 万字 | 总文本、段落、完整 DOM |
| 大量列表 | 宽列表、深层嵌套、海量短项 | DOM 节点、列表布局 |
| 超大表格 | 多行、多列、极端 `tableCells` | 单节点 DOM、layout/paint |
| 超长代码块 | 多种语言、极端 `codeLines` | highlight、DOM 行数、复制 |
| Mermaid | 数量梯度与单图复杂度梯度 | 异步 CPU、SVG、布局、取消 |
| KaTeX | 行内/块级数量梯度 | HTML 节点、排版 |
| 图片 | 数量、不同尺寸、迟到加载 | layout shift、滚动锚点 |
| 批注 | 数量梯度、跨块、重叠 | Range/Highlight 创建与重建 |
| 混合极端文档 | 上述维度组合 | 峰值内存、长任务、交互稳定性 |

除字符数外，每份 fixture 必须记录：`chars`、`blocks`、估算/实际 DOM nodes、`listItems`、`tableCells`、`codeLines`、`mermaidCount`、`mathCount`、`imageCount`、`annotationCount`、最大单块复杂度。

## 测量方法与指标

- 环境：同一机器、同一 WebView2、同一代码基线、全新 Tauri Release；开发模式/HMR 数据不得作为结论。
- 运行：每个关键样本至少 10 次冷启动或独立加载，报告中位数、P90、最大值；异常后台负载和工具失败标记为 `NOT TESTED`。
- 阶段耗时：parse、remark/rehype transform、stringify、DOMParser、DOM insert、morph、增强任务。
- 可见性：应用壳、预览真实正文首屏、完整渲染分别打点，不得用 Skeleton 或人工延迟替代。
- 资源：JS heap、DOM node 数、React Element/Fiber 代理指标、事件监听器/Observer 数量、长任务。
- 浏览器管线：style recalculation、layout、paint、layout shift。
- 交互：稳定滚动 FPS、掉帧、搜索耗时、Highlight/Range 建立耗时、编辑更新延迟。
- 正确性：Selection/Copy 文本、source offset、搜索匹配数、批注恢复、TOC 目标、编辑器 ↔ 预览滚动同步误差、Alt+点击定位。
- 对照：当前 Renderer 与 Native Renderer 必须使用相同内容、样式、窗口尺寸、主题和功能开关。

## Go / No-Go 条件

### Go 必须全部满足

- 安全：raw HTML、sanitize、SVG、链接与脚本边界与现有 Renderer 等价；无放宽项。
- 数据契约：DocumentRange/source offset 是唯一业务坐标；Selection、Search、批注、AI Selection 的测试样本全部精确匹配，无静默猜测。
- 普通文档：10 万、50 万、100 万字样本均无崩溃、白屏或不可恢复卡死；P90 首个真实正文可见时间不得比当前 Renderer 慢超过 10%。
- 核心收益：普通文档至少满足以下两项，且任何一项不得显著恶化：P90 完整渲染降低至少 20%；P90 编辑更新延迟降低至少 20%；稳定内存降低至少 20%；正文 React/Fiber 规模不再随 Markdown 节点数线性增长。
- 滚动：稳定滚动区间 P95 帧耗时不超过 20ms；不得出现可重复的长时间主线程冻结。
- 更新：morph 后焦点、`<details>`、Selection/Range、Overlay 锚点和滚动位置保持可用；快速编辑/切文档无旧结果覆盖。
- 同步准确性：TOC 到达正确标题；编辑器 ↔ 预览稳定后误差不超过一个 source-mapped 顶层块或 16px，两者取更严格且可测的一项。
- 重型节点：至少证明超大表格、超长代码块和 Mermaid 的成本能够局部隔离，不要求恢复全文虚拟化。
- 维护性：最终迁移方案能够删除旧 Renderer，而非要求长期双实现同步维护。

### 任一项成立即 No-Go 或退回 Conditional Go

- 100 万字普通 Markdown 在目标环境稳定 OOM、崩溃、白屏或出现不可接受的持续卡死。
- Native Renderer 的 P90 首屏或稳定内存超过当前 Renderer 1.5 倍，且无法由局部重型节点治理解释或修复。
- morphdom 反复破坏 Range、Selection、焦点、滚动锚点或异步增强状态，只能依靠新的大规模补偿系统维持。
- 必须放宽 sanitize、安全 HTML 或现有 Web/Desktop 能力边界才能实现功能兼容。
- 批注、AI Selection、Alt+点击编辑无法继续使用同一 DocumentRange/source metadata 契约。
- 超大表格、代码或 Mermaid 的性能问题只能通过恢复文档级双 Renderer/双模型解决。
- 实验最终要求永久维护当前 Renderer 和 Native Renderer 两套生产实现。

## 当前阶段详细任务

### 目标

等待未来独立窗口在获得人工授权后，从干净的最新主线创建 `experiment/native-preview`，只执行 Phase 1。

### 允许修改

- 建分支动作：仅在人工确认且工作区干净后执行。
- Phase 1 文件范围：开始前根据当时实际代码和依赖重新确定，并更新本节；当前不得预授权具体源码路径。

### 验收标准

- [ ] 当前工作区完全干净。
- [ ] 已确认当时远端默认主线名称及最新 HEAD。
- [ ] 已获得人工明确授权开始 PoC。
- [ ] 已创建并切换 `experiment/native-preview`，未创建 worktree。
- [ ] 已重新读取 `AGENTS.md`、本任务全文、Markdown 契约和状态所有权文档。
- [ ] 已记录当前 Renderer 的同机 Release 基线。
- [ ] 仅执行 Phase 1，不提前实现 morphdom 或业务功能。

### 禁止事项

- 不在主线或当前脏工作区开始 PoC。
- 不 stash、reset、覆盖或删除用户已有修改。
- 不修改现有 Renderer 的生产默认行为。
- 不默认切换 markdown-it。
- 不把 DOM、Selection 或 Highlight 升级为业务 Source of Truth。
- 不提前执行后续阶段，不因 PoC 方便而放宽安全边界。
- 不自动 commit、push、merge、tag、Release 或删除实验分支。

## 后续接手 Checklist

### 启动前

- [ ] 完整读取本任务文档，确认当前阶段和状态。
- [ ] 执行 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`。
- [ ] 确认主线工作区干净，现有修改已由人工正常处理。
- [ ] 确认当时最新主线名称与 HEAD。
- [ ] 获得人工确认后创建 `experiment/native-preview`。
- [ ] 更新“当前状态”和阶段允许修改范围。

### 每阶段

- [ ] 开始前记录当前 Renderer 对照基线。
- [ ] 只执行当前阶段，不提前实现下一阶段。
- [ ] 使用匿名、可复现 fixture。
- [ ] 记录实际命令、环境、样本复杂度和 PASS/FAIL/NOT TESTED。
- [ ] 源码或依赖变化后执行对应定向 Gate；性能结论使用新鲜 Tauri Release。
- [ ] 更新当前状态、阶段结果、遗留问题和下一阶段。
- [ ] 阶段结束由人工决定继续、同步主线、暂停或终止。

### 最终决策

- [ ] 按 Go / No-Go 条件形成事实表，不用主观感受替代数据。
- [ ] 明确选择 Go、Conditional Go 或 No-Go。
- [ ] 未经人工确认不合并回主线。
- [ ] No-Go 时保留报告，人工确认后再删除实验分支。

## 阶段历史

### 任务初始化

- 状态：已完成
- 完成内容：记录调研结论、候选架构、阶段计划、分支隔离、Benchmark、指标及 Go / No-Go 条件
- 验证结果：仅文档格式与精确 diff 检查；未执行源码测试
- 遗留问题：PoC 尚未授权；等待未来在干净工作区从当时最新主线创建实验分支
