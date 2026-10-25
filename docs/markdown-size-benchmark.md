# Windows 桌面 Markdown 打开上限实测

日期：2026-10-26。本次采用 **1.5 MiB（1,572,864 字节）** 作为新的统一打开上限，比原 1 MiB 提高 50%；恰好等于上限可打开，多 1 字节拒绝。普通长文的性能专项通过，预览可用性补测为 **FAIL（11 项中 9 项通过、2 项失败）**，两项失败在原 1 MiB 对照包也复现，作为既有缺陷保留，不作为本次限额变更引入的回归。**采用新限额不代表完整预览交付验收通过**。2 MiB 能打开，但本机预览冷启动超过本次 3 秒目标。这个上限是体验预算，不是程序的绝对内存或文件容量极限。

## 方法与验收标准

- Windows 11 26200，约 16 GiB 内存；同机当前工作区构建的 Tauri Release，未使用旧安装版或 Web 结果代替桌面结果。工作区原有编辑器、预览修改在所有对照构建中保持一致。
- 匿名中英混合样本来自 `generateAnonymousMarkdown(50000, 7)`，重复完整单元后以空格补齐精确 UTF-8 字节数；包含标题、段落、公式、小表格、列表及代码。另测 128 KiB 连续单表格，防止把字节数视为唯一复杂度指标。
- 基线 1 MiB、候选 2 MiB 和最终 1.5 MiB 使用独立 exe；原始 JSON 记录 fixture 与 exe 的 SHA-256。原始结果、截图和构建日志保存在本机 `output/markdown-size/`，不提交二进制或测试 profile。
- 每轮退出原生进程，再以同一匿名会话 profile 启动，实际通过磁盘恢复内容；编辑、预览各 10 次。这里的“冷启动”指新进程，未清空 Windows 文件缓存，不等同于重启机器或首次安装。
- 测试使用专用应用标识 `com.guanmo.size-benchmark`、临时文件和独立 WebView2 profile；不能仅依赖修改 APPDATA 环境变量来保证原生目录隔离。脚本不自动删除临时目录。
- 计时批次固定关闭自动保存、自动入库，性能策略为 `memory`；另以默认 `balanced` 策略执行模式切换、滚动与搜索 Smoke。未在编译期间测量冷启动。
- 普通样本实际正文首屏最大值目标为 3 秒，输入 P95 目标为 100ms，滚动/搜索目标为 500ms；文件内容必须保持正确，原生保存结果必须与预期文本逐字一致。交互耗时包含 CDP 往返，仅代表本次样本与操作。

## 计时陷阱与修正

部分恢复启动会先挂载空预览，并提前产生一次性的 `preview-render-complete`。只等待该点位时，曾读到 0 个正文块；这批初始预览数字作废，未用于决定上限。

专项脚本改为等待磁盘恢复、目标模式及实际正文标识可见，再等待两帧。下表“实际首屏”采用该外部观测值，包含 CDP 连接、20ms 轮询及两帧的观测成本，是保守上界，不是纯 React 渲染时间。原有点位保留在 JSON 供对照，未修改产品启动/预览逻辑。`app-ready` 单独报告，不能代替正文首屏。

## 桌面结果

单位：秒；每格依次为 **中位数 / P90 / 最大值**。

| 版本与样本 | 原生启动至 WebView 时间原点 | 前端至实际正文首屏 | 进程启动至实际正文首屏 | 进程启动至 app-ready |
|---|---|---|---|---|
| 原 1 MiB 限额，1 MiB 编辑，10 次 | 0.455 / 0.478 / 0.478 | 0.509 / 0.541 / 0.567 | 0.999 / 1.068 / 1.069 | 0.961 / 0.980 / 0.984 |
| 原 1 MiB 限额，1 MiB 预览，10 次 | 0.463 / 0.469 / 0.525 | 1.820 / 1.910 / 2.006 | 2.369 / 2.463 / 2.650 | 0.849 / 0.900 / 0.985 |
| 候选 2 MiB 限额，2 MiB 预览，10 次 | 0.465 / 0.484 / 0.486 | 2.546 / 2.749 / 3.010 | 3.055 / 3.310 / 3.539 | 0.921 / 1.958 / 1.961 |
| 最终 1.5 MiB 限额，1.5 MiB 编辑，10 次 | 0.451 / 0.464 / 0.471 | 0.520 / 0.538 / 0.538 | 1.021 / 1.033 / 1.033 | 0.976 / 0.985 / 0.988 |
| 最终 1.5 MiB 限额，1.5 MiB 预览，10 次 | 0.459 / 0.464 / 0.475 | 2.142 / 2.227 / 2.238 | 2.650 / 2.740 / 2.759 | 0.849 / 0.903 / 1.673 |

不同大小代表原上限与新上限的负载对比，不是优化前后同负载提速。旧限额本来就拒绝 1.5/2 MiB，不能把拒绝时间当作渲染基线。

最终编辑输入 P95 为 **25ms**（20 次原生输入至两帧后，包含 CDP 往返）；Ctrl+S 后 Node 读取匿名文件并逐字校验通过。最终预览首屏后整个应用进程树的私有内存快照为 **445–524 MiB**，Rust 约 14 MiB，其余主要为 WebView2；这是采样时刻快照，不是峰值或长期泄漏证明。

默认 `balanced` 策略 Smoke：编辑→分屏→预览通过；滚动约 **66.5ms**，滚动后挂载 19 个块；全文搜索约 **21.8ms** 并返回匹配结果。截图已目视检查正文显示。

**结构反例：**最终桌面包打开 128 KiB 的连续单表格，1 次进程冷启动至正文约 **8.64 秒**，前端约 8.14 秒，正文 1 块、全应用约 2.88 万 DOM 节点，私有内存快照约 561 MiB。流程执行成功，但 **3 秒性能预算 FAIL**。该问题在原 1 MiB 限制内就存在，本次未修改解析或单块渲染策略；不能承诺任意 1.5 MiB Markdown 都在 3 秒内可用。

前一轮 Edge 开发组件实验只用于分档筛选：4 MiB 普通混合文档首帧约 3.31 秒、8 MiB 单次约 9.31 秒；这些不是桌面上限结论。

## 验证与残余风险

| 项目 | 状态与证据 |
|---|---|
| 最终类型检查、桌面前端构建、bundle 预算 | PASS：`npm run build:desktop` |
| 最终新鲜原生 Release | PASS：Tauri `--no-bundle` 专用测试标识构建；未安装或发布 |
| 文件大小边界和错误文案 | PASS：`npx vitest run tests/services/markdownFileOpenPolicy.test.ts --maxWorkers=1`，3 tests |
| 修改文件的 ESLint、两个脚本语法检查 | PASS |
| 文件权限及恢复规则 | PASS：`npm run test:file-access`、`npm run test:session-restore` |
| 原生启动参数打开、持久授权和磁盘恢复 | PASS：最终两种模式各 10 次，均验证实际正文 |
| 1,572,864 字节原生打开及保存 | PASS：替换首字符保持字节数，Ctrl+S 后逐字校验 |
| 1,572,865 字节原生打开 | PASS：出现超限提示，未进入正文首屏 |
| 默认策略下切换模式、滚动、全文搜索 | PASS：`smoke-mixed-1.5-preview.json` |
| 文件选择器、系统拖放、工作区点击的各自原生交互 | NOT TESTED：共用限额链路已静态核实及权限检查，但未逐一进行原生人工操作 |
| 自动入库、持续输入、长期内存、多大文件多 Tab | NOT TESTED |
| 全局回归、完整安装器与人工舒适度验收 | NOT TESTED：本次不是发布验收 |

产品改动仅涉及共享限额及文案/契约；继续复用 `readMarkdownFileForOpen`、`readRememberedMarkdownFileForOpen` 和 Rust 受限读取。文件授权、UTF-8 校验、等于上限允许、超限拒绝、未保存草稿保留等规则不变，无存储格式迁移。

下一步应先修复下方复现的目录回首和预览内 Ctrl+S 问题，再复验 1.5 MiB。巨大单块退化和提前打点也需单独处理，之后再考虑复测 2 MiB。本次补测只修改测试脚本和报告，未修改这些产品模块。独立模型 Review 未自动调用，建议 L2：`使用 ai-code-review Skill 审查本次 Markdown 限额变更与 Windows 桌面测试；复用已有 Machine Gate，只检查本次 diff 及有证据支持的间接影响。`

## 完整预览可用性补测

在同一 Windows 桌面 Release 包上，使用精确 1.5 MiB 的匿名文档，在开头、中间、末尾各布置独立标题、文本、两行表格、TypeScript 代码、KaTeX 公式和列表。开头/中间/末尾截图已检查；目录使用 CDP 原生鼠标点击，复制使用真实 Ctrl+C 和 Windows 剪贴板读回，行内编辑使用 Alt+点击、真实输入及 Ctrl+S。测试前暂存剪贴板各格式，结束后恢复；旧剪贴板内容不写文件或报告。

最终正式补测为 `preview-usability-acceptance-1.5-preview.json`；另用原 1 MiB 限额的对照 exe、1 MiB 同结构文档运行 `preview-baseline-acceptance-1-preview.json`。二者都复现相同两项缺陷，不能把它们归因于本次提高限额。

| 验收项 | 1.5 MiB 结果 | 证据 |
|---|---|---|
| 精确字节数 | PASS | 1,572,864 字节，文末校验块完整 |
| 开头渲染及目录进入 | PASS | 表格两行、代码文本和高亮、公式、粗体/斜体、列表逐项校验 |
| 中间渲染及目录进入 | PASS | 同上，独立 MIDDLE 标识 |
| 末尾渲染及目录进入 | PASS | 同上，独立 END 标识 |
| 文档最末尾可达 | PASS | 滚动到底后底部距离为 0，`item_END_2` 存在，挂载 15 块 |
| 文末返回目录首标题及重挂载 | **FAIL** | 点击 `GM_ACCEPT_START` 后目录高亮首标题，正文仍在末尾；等待 10 秒，首标题未挂载，scrollTop 仍为 491,600 |
| 真实选词复制 | PASS | 双击 `GM_ACCEPT_END_TEXT`，Ctrl+C 后 Windows 剪贴板精确读回 18 字符 |
| 虚拟化下全文复制 | PASS | Ctrl+A/C 读回 864,377 字符；三处独立标识各出现一次，16 个重复正文段全部存在，无粗体源码符号；重复测试文本 SHA-256 相同 |
| 行内编辑直接 Ctrl+S | **FAIL** | 输入的局部草稿正确且包含 EDIT 标识；15 秒后编辑器仍打开、草稿仍在，但磁盘未包含 EDIT 标识 |
| 点击块外提交后保存及模式往返 | PASS | 块外点击提交后 Ctrl+S，整个文件逐字等于唯一预期段落替换，字节数仍为 1.5 MiB；编辑→预览后修改保留 |
| 交互期间未捕获错误 | PASS | error/unhandledrejection 计数为 0；不等于功能逻辑正确 |

两次独立 1.5 MiB 复核均观察到上述失败，旧 1 MiB 对照包也复现：目录回首时 scrollTop 仍为 356,315；直接 Ctrl+S 不提交局部草稿，而块外提交后保存可以精确成功。最早一轮曾使用 DOM `.click()`，正式复核已改为原生鼠标点击，结果一致。

保存失败的静态调用链与现场一致：`AppLayout.tsx` 和 `useKeyboard.ts` 在 window 捕获阶段拦截 Ctrl+S，并走全局保存；`InlineMarkdownBlockEditor.tsx` 中用于提交局部草稿的 Ctrl+S keymap 没有完成提交。目录问题尚未定位根因，不将推测写成结论。

此补测只覆盖上述常规 Markdown 和交互；跨块拖选、Mermaid/ECharts、远程图片、跨块 HTML 与长期压力仍为 NOT TESTED。失败截图、校验点截图和匿名 JSON 均保存在 `output/markdown-size/`。剪贴板恢复 PASS；所有测试应用退出，真实用户文档未参与测试。

复跑补测（发现上述已知问题时，命令退出码为 1，并保存 FAIL 报告）：

```powershell
node scripts/markdown-size-desktop.mjs --exe=output/markdown-size/final.exe --kind=acceptance --mib=1.5 --surface=preview --runs=1 --phase=preview-usability --policy=balanced
node scripts/markdown-size-desktop.mjs --exe=output/markdown-size/baseline.exe --kind=acceptance --mib=1 --surface=preview --runs=1 --phase=preview-baseline --policy=balanced
```

## 复跑

在仓库根目录运行。先完成 `npm run build:desktop`，再使用专用测试配置构建；不得把脚本指向正式观墨可执行文件。

```powershell
New-Item -ItemType Directory -Path output/markdown-size -Force | Out-Null
Set-Content output/markdown-size/tauri-benchmark.json '{"identifier":"com.guanmo.size-benchmark","productName":"Guanmo Size Benchmark","build":{"beforeBuildCommand":""}}' -Encoding UTF8
npm run tauri build -- --no-bundle --config output/markdown-size/tauri-benchmark.json
Copy-Item src-tauri/target/release/guanmo.exe output/markdown-size/final.exe
node scripts/markdown-size-desktop.mjs --exe=output/markdown-size/final.exe --mib=1.5 --surface=edit --runs=10 --phase=final
node scripts/markdown-size-desktop.mjs --exe=output/markdown-size/final.exe --mib=1.5 --surface=preview --runs=10 --phase=final
node scripts/markdown-size-desktop.mjs --exe=output/markdown-size/final.exe --mib=1.5 --surface=preview --runs=1 --phase=smoke --policy=balanced --smoke=true
node scripts/markdown-size-desktop.mjs --exe=output/markdown-size/final.exe --mib=1.5 --overflow=1 --reject=true --surface=preview --runs=1 --phase=final
node scripts/markdown-size-desktop.mjs --exe=output/markdown-size/final.exe --kind=table --mib=0.125 --surface=preview --runs=1 --phase=structural
```

JSON 的 `status` 表示流程执行结果，`performanceBudget.status` 单独表示 3 秒预算；结构反例可同时出现流程 PASS、性能 FAIL。脚本没有把试验性能不达标伪装成崩溃，也不会因测出慢样本而跳过结果保存。
