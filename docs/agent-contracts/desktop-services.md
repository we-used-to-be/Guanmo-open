# 桌面服务契约

涉及系统壳、应用更新检查或开发模式性能监测时，修改前必须读取本文件。

## 桌面壳命令

- `src-tauri/permissions/main.toml` 显式列出已注册自定义 command；`build.rs` 的 AppManifest 读取该清单并启用应用 ACL。主 capability 仅匹配本地 `main` WebView，无窗口通配或 remote URL 授权；新增 command 必须同步权限清单，不能依赖默认允许。ACL 不替代 `FsAccessState`、凭据绑定、Origin 和后端参数校验，也不隔离同一主 WebView 内已经执行的恶意脚本。
- 插件只保留已使用的 dialog open/save/message/confirm、SQL、窗口操作和 shell open；`window.confirm` 由 dialog 插件转为原生 confirm，不能删除其权限。通知使用现有 Rust 命令，不开放未使用的前端通知插件命令。
- Desktop Release CSP 不开放前端供应商连接，仅保留 self/IPC；开发额外保留 localhost:1420/127.0.0.1:1420 的 HMR WebSocket。Tauri 自身给内联启动脚本注入 nonce/hash，保留现有启动时序及样式兼容。配置和 rustfmt 检查不替代新鲜桌面产物的 hash/IPC/资源实际验收。

- `reveal_file_in_folder(path: string): Result<void, string>`：校验路径已获 `FsAccessState` 授权且文件存在后，调用 Windows 资源管理器定位选中文件。

## MCP stdio 客户端边界

- `src-tauri/src/mcp/` 独占 MCP 会话、工具目录和一次性调用提案；`src/services/mcp/client.ts` 仅做桌面 IPC 与不可变目录适配。模块导入不启动进程，不接入首屏、Agent registry 或旧 HTTP 代理；Web 误调用抛出 `UnsupportedCapabilityError`。
- `mcp_register_stdio({config:{serverId,executable,args,cwd}})` 保留本次运行登记的兼容入口；持久配置优先于同 ID 的会话登记。仅接受已有绝对可执行路径（Windows `.exe`）及绝对工作目录，不运行 shell 字符串、不自动安装包。登记/保存、每次启动和每次外部工具调用均须经 Rust 原生确认，前端标记不能放行。
- `mcp/config.rs` 独占独立的 `app_config_dir/mcp-servers.json`（version 1），不复用旧 API Key 文件、业务 SQLite、settingsStore 或备份。缺文件返回空列表且不创建目录/进程/轮询；损坏、未知字段或未知版本拒绝覆盖；有界读取，串行写入同目录临时文件，sync 后原子替换。保存确认绑定确认前配置快照；期间配置变化返回 `MCP_CONFIG_CHANGED`，不恢复已删除或修改的旧配置。
- `mcp_list_servers({})`→`[{config,name,enabled,envNames,connectionId,status}]`，status 为 disconnected/connecting/connected；列表只返回已配置环境变量名，绝不返回其值或密文。`config` 为旧 stdio `{serverId,executable,args,cwd}`（无 transport 字段）或 HTTP `{transport:"http",serverId,url}`；v1 兼容读取旧 stdio，保留其原形状和密文。未知字段仍拒绝覆盖，旧版程序不支持 HTTP 时安全拒读，不能清空重建。已有 ID 不允许直接切换传输类型，需另建服务，避免暗中丢弃环境变量。
- `mcp_save_server({update:{config,name,envChanges}})` 新服务默认禁用，编辑保留 enabled。stdio 的 envChanges 缺省或省略某键为保留旧密文，字符串为明确替换（包括空字符串），null 为删除；Windows 环境名按大小写不敏感处理，歧义重复拒绝，最多32项。值只短暂经 IPC 交 Rust，并通过与旧 API Key 共用的 DPAPI 函数独立加密，不进入普通日志。HTTP 不接受环境变量变更或已保存密文，仅保存规范化无凭据 URL；保存不解析 DNS、不连接网络。
- `mcp_set_server_enabled({serverId,enabled})`、`mcp_delete_server({serverId})` 只修改配置。保存/启停/删除成功时立即取消该服务的会话和提案并撤销会话登记；失败保留旧配置和运行态。保存和启用不启动进程；重启后仍须用户显式 `mcp_connect`，原生提示展示 exe/args/cwd/环境名，解密失败拒绝连接。设置页仅在 MCP 页签激活后加载和读取，不依赖 App/main 启动链。
- 第三方进程具有当前用户权限，不受 `FsAccessState` 沙箱保护。清空继承环境，仅保留 `SystemRoot/WINDIR/TEMP/TMP`，随后只注入用户显式配置的环境变量；stderr 不进入应用日志。参数不得作为凭据配置通道，禁止恢复全部继承环境或把已保存的旧值回传 WebView。
- `mcp_connect({serverId,requestId})` 与 `mcp_list_tools({connectionId})` 返回 `{serverId,connectionId,catalogRevision,protocolVersion,tools}`。Rust 聚合分页后才发布目录（最多32页、200工具、256 KiB UTF-8、深度32/节点20000）；重复名称/循环游标拒绝。刷新或服务端目录通知使旧 revision 失效；本地别名只按原快照解析，不按当前活动连接猜路由。
- `mcp_prepare_call({request:{connectionId,catalogRevision,toolName,arguments}})` 返回 `{proposalId,serverId,connectionId,catalogRevision,toolName,arguments,expiresInSeconds}`，只接受已发现的精确远端名称和最多8 KiB的JSON对象。提案最多32个、120秒有效；`mcp_confirm_call({proposalId})` 原生展示 Rust 保存的目标/参数，重新核验连接、目录和过期状态后只发送一次调用，不使用 SDK 的自动 MRTR 重试。Schema 完整传递，语义校验由服务端负责，不套用内置 primitive 参数校验。
- `mcp_cancel_connect({requestId})` 可在原生启动确认或握手期间取消连接，迟到确认不得再启动进程；`mcp_cancel_call({proposalId})` 取消未执行提案或发送中的 SDK 请求；`mcp_disconnect({connectionId})` 立即撤销本地会话/提案，异步终止进程树。已发出调用的取消、超时或断开不能承诺回滚外部副作用，错误须保留 outcome unknown 语义，禁止自动重试。
- SDK 使用新版 discovery/旧版 initialize 协商；不支持的采样、roots、elicitation、input_required/task 不自动执行。外部工具描述、annotations、content/structuredContent 均不可信，isError 不能被改为成功。Windows 使用无控制台 Job Object，初始化失败、断开与应用退出均清理进程树；单帧最多1 MiB、连接/目录/调用超时30秒，不写原始错误、正文、参数或凭据到普通日志。
- 定向验证：`MCP_TEST_NODE` 设置为已安装 Node 的绝对路径后，执行 `cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::tests --jobs 1 --locked --offline`；包含临时配置、真实 DPAPI、env 注入与禁用后进程树清理。匿名服务不读取真实用户文件或业务库。`tests/mcp/native/` 使用生产 MCP 命令/DPAPI 和可选的生产设置组件，独立临时 WebView/配置目录（Rust 管理的 ConfigPath，仅由匿名宿主注入，不是 IPC 参数）。该夹具不等于主应用完整设置导航、重启恢复、Agent 或真实第三方服务已验收。

## MCP HTTP 客户端传输与配置（阶段4A）

- 设置页可新增、编辑、启停、连接检查和删除持久 HTTP 服务；`mcp_connect({serverId,requestId})` 按 Rust 配置分派 stdio/HTTP，仍先原生确认精确目标再连接并返回真实工具目录。enabled + connected 的 HTTP 服务进入既有本轮工具选择器，读取目录和工具调用沿用 connectionId/revision/一次性提案绑定。编辑 URL、启停或删除成功即撤销旧会话和提案；保存/启用与应用重启均不自动连接。完整 Windows 产品流程仍需原生验收。
- `mcp_connect_http({url,requestId})` 保留本次运行有效的独立兼容 IPC；Rust 生成服务身份、在网络请求前原生确认精确端点，再返回相同目录结构。两入口均不接受凭据、自定义头或 query，不宣称 OAuth 已实现。已有 v1 stdio 配置和普通 HTTP 代理权限保持兼容。
- 复用 `network_target.rs` 的 DNS/IP 判定：公网 HTTPS、本机/私网显式授权、永久危险范围拒绝。每次请求重新校验 DNS 并固定到首次解析集合，集合变化拒绝；连接、调用分别显示精确目标。禁用系统代理、重定向和 reqwest 自动重试，不从其他业务凭据或 Origin 授权继承权限。
- 官方 rmcp 3.7.0 的自定义 HTTP client 复用现有 reqwest 0.12；现代 request-scoped JSON/SSE 与旧 initialize/session 协商分别处理。禁用会话过期自动 reinitialize/replay、SSE resume/reconnect；旧协议仅允许一次初始 GET 流。401/403明确失败，不自动获取凭据；未知结果不重试。
- 单连接最多1000次请求/64 MiB；MCP HTTP 独立复用 `ApiUsage` 策略计数（每 Origin 每分钟120次、总240次，进程内累计10000次/512 MiB），断开与重连不重置。最多8个网络请求/响应流持有许可，响应读取结束/失败/取消释放；单请求和整个响应流各最多1 MiB，30秒超时。SSE原始总字节限制同时约束事件解析内存；长连接到限额或超时后需显式重连，不宣称无限流恢复。
- `mcp_prepare_call/confirm_call/cancel_call`、目录 revision、一次性提案和 requestId 取消边界与 stdio 共用；URL、参数和服务端原始错误不进入普通日志。资源、提示、鉴权及完整产品原生验收属于后续子阶段。

## MCP OAuth 网络基础（阶段4B1）

- `mcp/oauth_http.rs` 实现官方 SDK 的 `OAuthHttpClient`；本阶段只有受控网络基础与匿名协议验证，尚未开放授权 IPC、浏览器回调、DPAPI OAuth 凭据或设置入口，不报告完整 OAuth 已实现。现有 HTTP 连接仍无鉴权。
- 仅通过 `AuthorizationManager::new_with_oauth_http_client` 注入此适配，禁止调用 SDK 默认客户端或 `AuthorizedHttpClient`。`auth` feature 必需激活 SDK 的 reqwest 0.13，但实际网络仍由既有 reqwest 0.12 受控发送，SDK 的默认 TLS/HTTP 适配未启用。每个精确发现/注册/令牌目标在首次请求前经原生确认；一次授权最多16目标，串行请求，不继承其他 Origin 或业务凭据授权。
- 复用 MCP 的 DNS/IP 分类、固定解析集合、禁代理/重定向/重试、并发许可和进程级累计额度。每个请求含确认、DNS 与响应读取总计30秒，输入/响应最多1 MiB。只允许 GET/POST 及 Accept、Content-Type 和 SDK 发现固定使用的 `MCP-Protocol-Version: 2024-11-05`；拒绝调用方 Authorization/Cookie、自定义头和 URL 查询参数。OAuth 原始错误状态与有界响应仅交 SDK，重定向始终拒绝，不因 SDK 请求 Follow 放宽；当前仅适用于 public client。
- SDK OAuth 在 debug 级别会记录授权码/令牌；调用方必须用 `oauth_http::quiet` 包住整个 SDK 授权/刷新 future，隔离应用日志订阅者。回调、凭据持久化、撤销和产品连接接入仍由后续4B实现，不允许凭匿名协议测试宣称 Windows 产品验收完成。

## MCP OAuth 产品授权与 resources/prompts（阶段4B2/4C）

- `mcp_authorize({serverId,requestId})` 在 Rust 启动受限 OAuth 流程并立即返回；浏览器授权码、state、PKCE verifier 和 access/refresh token 不回到 WebView。回调只绑定随机端口上的 `127.0.0.1`、随机路径、精确 Host 与 GET；限制请求大小、数量和时限，拒绝重复参数，并在成功及错误回调都校验 state/issuer。SDK 授权、token 获取和刷新 future 均包 `oauth_http::quiet`。
- HTTP 服务的 OAuth bundle 作为可选 `SavedServer.oauth` DPAPI 密文保存，仅包含绑定的 serverId、精确资源 URL、已验证 issuer、SDK metadata 与凭据。stdio 不接受 OAuth。旧 stdio/无鉴权 HTTP 配置保持原序列化形状；缺少字段仍可读，未知字段和版本继续拒绝覆盖。刷新凭据须在 access token 使用前持久化；禁用、修改 URL、删除和撤销会取消授权并清除凭据、会话和提案；失败不替换旧配置。
- HTTP MCP 的每次请求由 Rust AuthorizationManager 获取绑定 token，仍走阶段4B1受控网络；连接时重新受控发现 metadata 并核对 issuer 与端点。401/403 返回固定授权错误，不自动打开浏览器、重放请求或执行工具。设置只显示固定授权状态/错误码，不显示 OAuth URL、code、state 或 token。
- `mcp_list_resources` / `mcp_list_prompts` 建立连接级、有界目录快照；对应 `list_changed` 通知使旧快照失效。`mcp_read_resource` / `mcp_get_prompt` 仅接受当前快照中的精确 URI/name，并在 Rust 原生确认后向同一 MCP 服务读取。分页、条目、JSON 深度/节点与 1 MiB 返回值均有上限；超时/断线不自动重试，未实现的交互式结果明确失败。
- resources/prompts 结果只在 MCP 设置页以转义文本展示并标为外部不可信，不持久化、不访问观墨本地文件，也不注入 Agent/system prompt。匿名 fixture 和 Web 检查不能替代 Windows OAuth、浏览器回调、原生确认及真实服务验收；未完成部分必须标为 `NOT TESTED`。

## 本机 MCP 服务端（阶段5，只读）

- `src-tauri/src/mcp_server/` 独占入站 HTTP、运行态授权与请求关联，独立于出站客户端、Agent 和业务存储。默认关闭，重启不恢复监听、token 或授权；无显式启用不建立 HTTP listener 或业务桥。
- `mcp_server_options({offset?})` 分页列出既有 `FsAccessState` 文件/工作区授权（每页50项），不扩权。`mcp_server_start({config:{paths,artifactKeys,readDocuments,searchKnowledge,readArtifacts},requestId})` 先登记唯一请求，再通过共用 Rust 原生确认展示范围；最多32个文件范围、100个成果key。`mcp_server_status({})` 仅返回 running/starting/generation/endpoint/config，不带 token；`mcp_server_stop({generation?})` 可精确取消旧 generation 或由用户显式关闭当前服务。设置卸载取消未完成启动并清理迟到成功，不关闭已建立的服务。
- listener 只绑定 `127.0.0.1` 随机端口，精确校验 Host、拒绝所有携带 Origin 的浏览器请求，只接受 `/mcp` 无 query 的 POST。每次启动生成独立随机 Bearer；`mcp_server_connection_info({})` 仅供用户主动查看/复制，不自动写外部客户端配置。认证完成后从传入 SDK 的 headers 去除 Authorization/Cookie，token 不进入日志或持久化。
- 官方 rmcp 的 Streamable HTTP 服务处理新旧协议，采用无会话的有界 JSON 请求/响应；不开放 GET 订阅、会话恢复、服务端采样或文件 roots。最多8个连接、4个操作；请求/响应各1MiB、30秒上限；独立复用 ApiUsage 的进程累计/速率策略，停止或重启不退还额度。关闭取消正在等待的查询并释放监听。
- `read_document` 只读 Markdown，逐次核验独立 scope 与当前 FSA 的交集，规范化路径后拒绝越界/路径穿越；字节上限与 Markdown 打开策略一致为1.5MiB，返回按 Unicode 字符 offset/maxChars 分页。`search_knowledge` 明确为关键词检索，路径过滤先于 SQL 分页，不加载 Embedding 或全库向量。
- `list_reading_artifacts` / `read_reading_artifact` 仅访问用户显式勾选的 `mark:<id>` / `ai:<id>`；阅读成果独立授权全文，包括成果内的结构化引用和历史选区，不从工作区授权隐式继承。成果key过滤先于分页，返回内容始终是不可信资料。
- 业务查询通过按需安装的单一 `guanmo:mcp-server-query` 主 WebView 监听器执行固定只读 SQL；前后均检查 `isDatabaseReady` 和 runtime status=ready，维护/关闭时拒绝。事件绑定 requestId/generation/固定工具/原参数/已授权scope；`mcp_server_reply` 仅完成仍挂起的精确请求，Rust再次核对结果路径或成果key。查询20秒超时、最多8个挂起记录、结果256KiB；关闭/取消/迟到回复不能恢复旧请求。停止后保留单个被动 UI 事件监听器，不轮询、不发起网络或数据库工作。
- 阶段5不提供写入能力；不能用只读 SQL/文件测试、匿名网络请求或界面截图代替真实 Windows 授权链及外部客户端验收。阶段6的修改提案必须另经用户核对和现有保存队列，不得直接复用当前文件写入接口绕过确认。

### MCP 服务端受确认文档修改

- 运行配置仅新增可选 `writeDocuments`，Rust 缺省为 false；旧配置仍为只读，不持久化新授权。只有明确开启时才公布 `propose_document_edit`、`get_document_edit` 和 `cancel_document_edit`；外部不提供批准或提交工具。
- `read_document` 的 `contentHash` 为完整文件 UTF-8 文本的 SHA-256，所有分页共用同一全文 hash。提案要求 `path/expectedHash/oldText/newText`，旧片段非空且在原文中唯一，两个片段分别最多32KiB、完整前后文件1.5MiB。独立 scope 与当前 FSA 必须同时允许 Markdown 读写，不扩权、不接收任意 SQL/命令。最多8个有界快照，待确认5分钟；超时记录随后最多保留5分钟供查询解释。
- Rust 保存提案 ID、generation、规范化路径、完整前后快照、差异、期限与一次性状态。前端通过固定 `capture_document_edit` 业务事件先记录 Tab 身份/路径/正文/保存基线（已有草稿拒绝），再返回外部 `pending`；该结果不表示写入。用户在设置页显式核对以纯文本显示的差异，`mcp_server_approve_edit({proposalId})` 仍经 Rust 原生确认展示已保存路径/hash/差异；前端 `approved` 无权放行。
- `mcp_server_commit_edit({proposalId})` 只能经 `useTauri.ts` 从 documentSave 同路径互斥事务调用，不接收前端 path/content。队列开始前再次检查 Tab 快照，Rust 消费一次批准前复验期限、generation、写权限与原文；Windows 读句柄在替换前阻止并发写入，ReplaceFileW 保留原文件属性/ACL，单独保留原文副本至成功。操作系统替换失败记 `unknown`，保留恢复文件路径供用户核实，不自动重试或声称回滚。成功才记 `written` 并更新保存基线/派生索引；I/O期间的新草稿保留，旧 Tab 不复活。失败不先将提案正文写入 Tab，防止后续自动保存泄漏被拒绝的内容。
- 提案列表/详情/取消仅访问 Rust 持有记录。`mcp_server_revert_edit({proposalId})` 只为仍在当前运行授权内、已写入且原文未再变更的记录创建独立反向提案；仍须重新核对、原生确认和同路径队列，不是静默回滚。停止/撤销、迟到确认、过期、重复提交均不能恢复旧授权；已提交/未知操作不能被取消接口误报为已撤销。无 MCP 模式的手动/自动保存与原有合并/重试策略不变。

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
