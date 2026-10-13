# 桌面服务契约

涉及系统壳、应用更新检查或开发模式性能监测时，修改前必须读取本文件。

## 桌面壳命令

- `src-tauri/permissions/main.toml` 显式列出已注册自定义 command；`build.rs` 的 AppManifest 读取该清单并启用应用 ACL。主 capability 仅匹配本地 `main` WebView，无窗口通配或 remote URL 授权；新增 command 必须同步权限清单，不能依赖默认允许。ACL 不替代 `FsAccessState`、凭据绑定、Origin 和后端参数校验，也不隔离同一主 WebView 内已经执行的恶意脚本。
- 插件只保留已使用的 dialog open/save/message/confirm、SQL、窗口操作和 shell open；`window.confirm` 由 dialog 插件转为原生 confirm，不能删除其权限。通知使用现有 Rust 命令，不开放未使用的前端通知插件命令。
- Desktop Release CSP 不开放前端供应商连接，仅保留 self/IPC；开发额外保留 localhost:1420/127.0.0.1:1420 的 HMR WebSocket。Tauri 自身给内联启动脚本注入 nonce/hash，保留现有启动时序及样式兼容。配置和 rustfmt 检查不替代新鲜桌面产物的 hash/IPC/资源实际验收。

- `reveal_file_in_folder(path: string): Result<void, string>`：校验路径已获 `FsAccessState` 授权且文件存在后，调用 Windows 资源管理器定位选中文件。

## 应用更新检查

- 桌面版通过 GitHub Releases `latest` API 检查新版本，当前版本必须由 Tauri `getVersion()` 获取；不接入 Updater 插件或自动安装。
- 启动检查使用 24 小时本地缓存并静默失败，手动检查必须绕过缓存与忽略版本；Release 下载链接只能通过 Tauri 系统浏览器打开。
- 更新版本比较回归使用 `npm run test:update-version`，Toast 去重与暂停计时回归使用 `npm run test:toast`。

## 开发模式性能监测

- 生产资源保护使用只读 `get_system_memory_snapshot()`：返回 `availablePhysicalMb/totalPhysicalMb/availableCommitMb/commitLimitMb` 四个数值。Windows 通过 `K32GetPerformanceInfo` 获取系统提交额度与物理内存，不调用全进程性能扫描；真实首屏后才开始采样，5 秒周期由最后一个订阅者退出时清理。采样失败时可选预加载转为按需，不影响用户主动打开功能。
- `estimate_rag_index_memory()` 只读应用内部 SQLite，返回与 Rust 初始化准入共用的 MiB 预算；无前端路径参数，不读取到 WebView 的用户正文或向量，不替代开始前及构建期间的系统余量检查。
- 可选 AI 面板、隐藏模式及知识库预热共用现有闲时队列。任务开始前须满足系统余量、保留额度与任务预算；最低保留 512 MiB，压力状态在余量恢复到 768 MiB 后解除。预算是保守准入估计，不保证峰值上界。压力或采样未知时只释放无草稿的隐藏视图，不改变配置、可见视图、文档内容和阅读位置。

- 性能监测仅在 Vite 开发模式启用；生产构建不得安装 Timer、RAF、事件监听、Observer 或 Object URL 追踪包装。
- Windows 进程指标统一由 Rust `get_perf_snapshot` 返回，包含 Rust 主进程与每个 WebView2 后代进程的私有内存、CPU、线程和 Handle 明细。
- 默认每 5 秒采样；250/500/1000ms 高精度模式最多运行 60 秒。历史使用容量 300 的环形缓冲区，禁止把完整历史数组放入 React state。
- 报告 schema 当前为 v2；导出保留 v1 内存与 JS Heap 字段别名，读取旧报告时通过 `migratePerfReport` 迁移。
- 报告不得包含完整文件路径、文档/对话内容、凭据或用户名。
- 前端专项回归位于 `tests/performance/`；桌面面板构建验证使用 `npm run build:desktop`。

## 生产诊断日志

- 普通桌面 Release 将既有启动点位在首屏稳定后一次性写入诊断日志，保留进程、Tauri、WebView、真实编辑/预览表面、数据库和 `app-ready` 的独立语义；未出现的点位明确记录为缺失。
- Rust 独占写入应用日志目录，前端只上报固定事件码、受限状态、耗时、数量及白名单内的 Agent 工具名；禁止原始错误、堆栈、路径、SQL、URL、请求/响应、Markdown、Prompt、AI 回复、RAG chunk 和批注正文进入日志。
- JSONL 单文件上限 2 MiB，最多 5 份，写入和导出时清理超过 7 天的诊断文件。详细模式默认关闭，只额外采集慢路径；设置页可以导出包含 summary、environment、performance/startup 和 events 的 ZIP。清除操作只处理 `diagnostics-0.jsonl` 至 `diagnostics-4.jsonl`。
- 开发模式 `PerfMonitorPanel` 与 Agent Trace 仍按原有 DEV 开关运行；生产诊断不启用其 Timer、RAF 或 Observer 采样器。
