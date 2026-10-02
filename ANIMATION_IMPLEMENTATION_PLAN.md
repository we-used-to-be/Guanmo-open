# 观墨交互动效分阶段实施计划

> 本文件是本次交互动效任务的唯一状态来源，按 `staged-task-handoff` 执行。根目录已有另一项任务的 `AI_IMPLEMENTATION_PLAN.md`，不得覆盖或借用其阶段状态。

## 当前状态

- 当前阶段：阶段 4｜左侧栏与 AI 面板收放
- 阶段状态：进行中
- 上次执行结果：侧边栏外壳宽度、普通 AI 面板和全屏 AI 面板增加对称收放；侧边栏展开时仅延迟 80ms 替换完整内容，收起仍即时；关闭 AI 内容立即卸载，未改变 `appStore` 状态来源、全屏位置尺寸或懒加载入口
- 验证结果：AI 面板定向 Vitest `11 passed`、Sidebar ESLint `0 errors`、`npm run typecheck` `PASS`、本次短延迟改动后的 `npm run build:desktop` 与 Desktop bundle 门禁 `PASS`、`git diff --check` `PASS`
- 本阶段剩余：真实桌面键盘/鼠标/全屏/产品引导/编辑预览模式验收、减少动态效果验收，以及新旧 Tauri Release 各 10 次冷启动对比；阶段 1、阶段 2、阶段 3 的人工验收也待补做
- 本阶段允许修改：`src/components/layout/Sidebar.tsx`、`src/components/layout/AppLayout.tsx`、`src/components/layout/layoutMotion.css`、直接相关的最小测试及本文件
- 阻塞问题：无代码阻塞；旧产物冷启动被现有调试 GuanMo 单实例阻断，新 Tauri Release 构建两次均因机器内存压力失败，因此真实桌面和性能门槛不能标记完成
- 下一阶段：阶段 5｜AI 面板内部视图交接与收口

## 项目目标与决策

让常用界面的状态变化更连贯，同时保持搜索和切换等高频操作即时响应。范围包括文件树、提示消息、搜索弹层、文档标签、左侧栏、AI 面板开关及 AI 面板内部视图交接；不重做全屏、右键菜单或既有阅读成果动效。

- 动效策略：仅在尺寸、位置或内容交接有助于理解状态时使用短动效；不得延迟点击、键盘操作、文档内容或搜索结果呈现。普通 hover、颜色变化不引入 Motion。
- 开关策略：保留 `sendMessageAnimationEnabled` 独立开关及默认关闭；本任务不新增每处动效开关，也暂不新增设置 UI。新增位移动效遵循系统 `prefers-reduced-motion`，减少动态效果时保留必要状态反馈。`AppearanceConfigV1.motionPreference` 已有 `system/full/reduced` 兼容字段，但当前没有覆盖这些 UI 的统一运行时控制；如以后确需软件内总开关，另立范围并复用该字段，不新造持久化字段。
- 动效复用：涉及尺寸/布局/状态形变时先检查 `src/components/common/useMorphingMotion.ts`；局部 opacity、颜色可沿用 CSS。不要缩放文本，不添加重型首屏静态依赖。
- 范围边界：不修改文件读写、搜索匹配、Tab/视图 Store、文档模型、SQLite、Tauri command 或 AI 请求流程。已有右键菜单动效试验曾撤回，本任务不重启该方案。
- 工作区：制定计划时 HEAD 为 `63f58b8`；仓库已有多处用户未提交修改，尤其 `src/styles/global.css`、`src/features/settings/SettingsPage.tsx`、`src/components/common/ContextMenu.tsx`、`src/components/editor/FullscreenControlBar.tsx`。各阶段开始前重新执行 `git status --short` 和涉及文件的 `git diff`，只保留并叠加本任务的精确改动。
- 交付边界：本任务不授权提交、推送、打 tag、创建 Release 或 PR；每次只实施当前阶段。2026-10-02 用户明确要求暂不验收阶段 1、直接开启阶段 2，故阶段 1 未标记完成，后续需补验收。

## 阶段计划

### 阶段 1｜文件树展开与收起

- 目标：点击左侧工作区目录时，箭头与子列表在短时间内一致地展开/收起；频繁反向点击可中断，目录内容与打开文件行为不变。
- 范围：`FileTree.tsx`、`WorkspaceRoots.tsx` 的可见性表现；不改变树数据、文件授权、拖放和选中态。
- 验收：普通目录、多级目录、大目录、快速反复点击及系统减少动态效果均无内容闪烁、卡顿或交互阻塞；收起后不可聚焦隐藏子项。
- 检查：相关组件定向测试（若现有测试无法覆盖稳定交互不变量，补最小测试）、`npm run typecheck`、相关文件 Lint、`git diff --check`；真实桌面手动观感。

### 阶段 2｜提示消息退出与补位

- 目标：右上角 Toast 在自动到期、手动关闭和点击操作后短暂退出，其余提示自然补位。
- 范围：`ToastContainer.tsx`、`src/styles/toast.css`；仅当呈现层无法保持既有计时语义时才考虑 `toastStore.ts`。
- 验收：自动到期、悬停暂停、恢复、关闭、操作按钮与多个提示并发都保持原语义；退出中重复触发不会留下幽灵提示；减少动态效果时立即结束位移。
- 检查：`npm run test:toast`（若改动计时或 Store）、相关定向测试、Typecheck、相关 Lint、`git diff --check`、真实桌面观感。

### 阶段 3｜搜索与文档标签的高频反馈

- 目标：编辑区查找/替换浮层、文件/命令面板打开时立即可输入；去掉或显著缩短现有滑入。文档标签只让选中标识轻微交接，文档内容立即切换。
- 范围：`SearchOverlay.tsx`、`CommandPalette.tsx`、`TabBar.tsx` 及直接相关的最小样式；不改搜索计算、快捷键、Tab Store 或编辑器实例。
- 验收：鼠标和键盘入口、连续开关、快速切换 Tab、滚动/拖拽标签都无视觉残留；焦点与文档显示不等待动效；减少动态效果时无位移。
- 检查：搜索与 Tab 定向测试、Typecheck、相关 Lint、`git diff --check`、桌面键盘操作观感。

### 阶段 4｜左侧栏与 AI 面板收放

- 目标：左侧文件栏的完整/图标两态有连续交接；AI 面板打开和关闭反馈对称，编辑区尺寸变化不闪烁。
- 范围：`Sidebar.tsx`、`AppLayout.tsx` 和必要的局部样式；保持 `appStore` 的 `sidebarCollapsed`、`aiPanelOpen` 为唯一状态来源，不为动画增加持久化状态。
- 验收：Ctrl+B/Ctrl+J、点击按钮、窗口缩放、拖动宽度、全屏进出、产品引导恢复、快速反向切换、编辑/预览两种模式都正确；关闭后面板资源按现有时机释放；减少动态效果即时切换。
- 性能门槛：触及 `AppLayout`，实施前记录同机基线；不得引入首屏隐藏资源或重型静态 import。交付前按 `AGENTS.md` 对新鲜 Tauri Release 的编辑与预览各做至少 10 次冷启动，与旧产物比较中位数、P90、最大值；收益不稳或生命周期风险高则保留原行为并在本文件记录。
- 检查：相关布局/生命周期定向测试、Typecheck、Lint、必要 Desktop build/bundle gate、`git diff --check`、上述真实桌面与冷启动验收。

### 阶段 5｜AI 面板内部视图交接与收口

- 目标：聊天、阅读成果、提醒页面切换时，标题和内容短暂交接；不重复已有阅读成果内部 Motion，不影响发送形变、流式消息和滚动恢复。
- 范围：`AiPanel.tsx` 及直接相关最小样式/测试；保留 `sendMessageAnimationEnabled` 的独立控制与默认值。
- 验收：点击返回、快速往返、正在流式输出、历史记录、滚动位置和发送动画均无重复进入或旧内容闪现；系统减少动态效果无位移；Web/Desktop 可用能力边界不变。
- 检查：AI 面板相关定向测试、Typecheck、Lint、必要 bundle gate、`git diff --check`、真实桌面观感。完成后核对全部阶段及未测项，不自动进入提交或发布。

## 当前阶段详细任务

### 阶段 4 实施顺序

1. 检查 `git status --short`、`Sidebar.tsx`、`AppLayout.tsx`、`appStore` 的状态来源和布局/生命周期调用边界；保留已有用户改动。
2. 新增局部 `layoutMotion.css`：侧边栏只过渡外壳宽度，普通 AI 面板过渡宽度与透明度，全屏 AI 面板过渡透明度与位移；全部遵循 `prefers-reduced-motion`。
3. 保持 `sidebarCollapsed`、`aiPanelOpen` 为唯一状态来源；侧边栏展开只使用短暂的本地内容交接延迟，收起立即切换；AI 内容在关闭时按既有时机立即卸载，不改变懒加载、Resize listener、全屏位置尺寸或产品引导快照恢复。
4. 执行 AI 面板定向测试、Typecheck、目标文件 Lint、Desktop build/bundle gate、`git diff --check`；真实桌面与冷启动另作验收。
5. 更新顶部状态与阶段历史；真实桌面、冷启动和减少动态效果未验收前保持进行中。

### 本阶段禁止事项

- 不修改 `AI_IMPLEMENTATION_PLAN.md`、设置、全局样式、全局 Store、文件授权或其他阶段文件；局部布局样式仅限 `layoutMotion.css`。
- 不覆盖任何预存未提交修改；不新增依赖，不进行全仓测试或全量 E2E。
- 不提交、推送、打 tag、创建 Release 或 PR。

### Blast Radius（阶段 1）

- 直接影响：目录节点及工作区 Root 的展开容器、同目录共用的折叠呈现组件。
- 间接依赖：子级 `FileTreeNode` 挂载/卸载、重命名输入焦点、Root 搜索视图切换。
- 高风险点：退出动画期间子项仍短暂挂载；必须立刻移出可交互/可聚焦树，快速反向切换可中断，卸载不保留旧内容。
- 禁止影响：树数据、文件授权、文件打开/拖放/重命名、工作区管理和持久化状态。

### Blast Radius（阶段 2）

- 直接影响：`ToastContainer.tsx` 的挂载、退出和布局呈现。
- 间接依赖：`App.tsx`、`WebApp.tsx` 调用 Toast 容器，`toastStore.ts` 持有计时、暂停、去重及最多三条提示的唯一状态。
- 高风险点：Store 移除后视图延迟卸载，退出期间必须立刻 inert/aria-hidden，避免重复点击；容器需持续挂载到退出结束。
- 禁止影响：Store 计时与去重、Toast 操作回调的执行次数、更新提醒和消息内容。

### Blast Radius（阶段 3）

- 直接影响：`SearchOverlay.tsx`、`CommandPalette.tsx` 的进入呈现与输入焦点；`TabBar.tsx` 的选中指示条。
- 间接依赖：`EditorArea`、`AppLayout` 的挂载/卸载；`editorStore` 的标签和文档切换状态；现有搜索/拖放事件处理。
- 高风险点：两个浮层都有挂载后的焦点副作用；标签指示条不能改变标签尺寸、焦点顺序或拖拽命中区域。
- 禁止影响：搜索匹配/替换、快捷键、文档内容切换、Tab Store、编辑器实例、预存 `global.css` 修改。

### Blast Radius（阶段 4）

- 直接影响：`Sidebar.tsx` 的可见外壳宽度；`AppLayout.tsx` 的普通/全屏 AI 面板外壳、开合呈现和内容挂载。
- 状态来源：继续使用 `appStore.sidebarCollapsed`、`appStore.aiPanelOpen`、现有侧栏/AI 宽度及全屏位置尺寸；不新增动画状态或持久化字段。
- 间接依赖：主编辑区的 flex 可用宽度、`AiPanel` 懒加载与卸载、侧栏宽度拖动、全屏外部点击关闭、产品引导快照/恢复。
- 高风险点：快速反向切换时的宽度/透明度竞态；关闭期间不能继续接收焦点或指针；全屏进出不能遗留隐藏面板或覆盖恢复后的状态；减少动态效果必须即时切换。
- 禁止影响：`appStore` 持久化语义、AI 请求与内部视图、启动首屏/动态 import、Resize listener 清理、全屏位置尺寸计算、预存 `global.css` 及其他阶段改动。

## 阶段历史

### 阶段 1｜文件树展开与收起（代码与自动检查）

- 状态：进行中；用户要求跳过真实桌面验收并先实施阶段 2。
- 完成内容：新增 `TreeCollapse.tsx` 供目录和工作区 Root 共用；只在退出动画期间暂留子树并设 inert/aria-hidden，完成后卸载；箭头遵循减少动态效果；目录按钮补充 `aria-expanded`；保留树数据与文件操作。
- 验证结果：`npx vitest run tests/workspace/fileTreeCollapse.test.tsx tests/workspace/workspaceRootsUi.test.tsx --maxWorkers=1` 为 `6 passed`；`npm run typecheck` 为 `PASS`；五个目标文件 ESLint 为 `0 errors / 1 既有 warning`；`git diff --check` 为 `PASS`。真实 Tauri 和大目录性能 `NOT TESTED`。
- 遗留问题：需完成真实桌面观感验收。实际修改为本文件、`FileTree.tsx`、`WorkspaceRoots.tsx`、新增 `TreeCollapse.tsx` 和 `fileTreeCollapse.test.tsx`、`workspaceRootsUi.test.tsx`；所有既有脏工作区文件保留，未提交或推送。

### 阶段 2｜提示消息退出与补位（代码与自动检查）

- 状态：进行中。
- 完成内容：`ToastContainer.tsx` 使用已有 Motion 依赖完成短时进出场和位置补位，系统减少动态效果时不位移；退出中即时 inert/aria-hidden；Store、操作回调和消息内容不变。新增 `tests/toast/toastContainer.test.tsx` 检查操作按钮退出及并发提示。
- 验证结果：组件定向 Vitest `2 passed`；`npm run test:toast`、`npm run typecheck`、目标文件 ESLint、`git diff --check` 均 `PASS`。真实 Tauri 观感与减少动态效果 `NOT TESTED`。
- 遗留问题：需补做真实桌面验收；本阶段只改组件、新增定向测试和本文件，未提交或推送。既有 `toast.css` 动画类暂未移除，以免改动预存脏工作区的 `global.css` 引用链。

### 阶段 3｜搜索与文档标签的高频反馈（代码与自动检查）

- 状态：进行中。
- 完成内容：`SearchOverlay` 与 `CommandPalette` 去除滑入位移；命令面板打开后立即聚焦；`TabBar` 选中态使用不改变布局的透明度指示条；增加搜索聚焦/无滑入与标签指示条定向断言。
- 验证结果：`npx vitest run tests/editor/SearchOverlay.preview.test.tsx tests/editor/SearchOverlay.nearestMatch.test.ts tests/editor/TabBar.newDocument.test.tsx --maxWorkers=1` 为 `11 passed`；`npm run typecheck`、目标文件 ESLint（`0 errors`）和 `git diff --check` 通过。真实桌面键盘与观感 `NOT TESTED`。
- 遗留问题：待在真实桌面验证鼠标/键盘入口、连续开关、快速切换 Tab、滚动/拖拽标签及减少动态效果；阶段 1、阶段 2 的人工验收仍未补做。未提交或推送。

### 阶段 4｜左侧栏与 AI 面板收放（代码与自动检查）

- 状态：进行中。
- 完成内容：侧边栏完整/图标态共用连续宽度外壳，展开时增加 80ms 内容交接延迟、收起立即切换；普通 AI 面板改为宽度/透明度对称过渡，全屏 AI 面板改为透明度/位移对称过渡；关闭时立即卸载 AI 内容，拖动期间禁用过渡保证跟手，保留 Store、懒加载、Resize 和全屏状态边界；新增局部减少动态效果规则。
- 验证结果：`npx vitest run tests/agent/aiPanelInteractions.test.tsx --maxWorkers=1` 为 `11 passed`；`npm run typecheck`、`npx eslint src/components/layout/Sidebar.tsx`、本次短延迟改动后的 `npm run build:desktop` 与 Desktop bundle 门禁、`git diff --check` 通过。
- 未完成门槛：旧产物 `node scripts/measure-cold-start.mjs --runs=10 --surface=edit --theme=warm` 第 1 次即因现有调试 GuanMo 单实例提前退出，未取得有效基线；新鲜 `npm run tauri -- build --no-bundle` 首次在 Rust 链接阶段内存分配失败，串行 Cargo 重试在 Vite/esbuild 阶段再次因系统内存不足失败。真实桌面、减少动态效果和新旧 Release 各 10 次冷启动均 `NOT TESTED`。
- 遗留问题：待关闭现有调试实例且机器资源稳定后，重新生成新旧 Release 冷启动数据并补做人工验收；阶段 1、阶段 2、阶段 3 的人工验收仍未补做。未提交或推送。

### 计划初始化｜2026-10-02

- 状态：已完成计划，阶段 1 未开始。
- 内容：基于当前代码、契约及 `63f58b8` 确定五阶段范围；另建计划以保留原 `AI_IMPLEMENTATION_PLAN.md`。
- 验证：文档尾随空白检查 `PASS`，`git diff --check` 退出码 0，已核对工作区状态；功能、性能及真实桌面均 `NOT TESTED`。
- 风险：阶段 4 涉及布局/生命周期和首屏门槛；所有阶段须保护现有用户未提交修改。
