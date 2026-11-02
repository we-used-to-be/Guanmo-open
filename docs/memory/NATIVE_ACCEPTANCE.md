# Windows 记忆验收记录（进行中）

## 2026-11-02 Sol 独立验收补充

- 整体 **FAIL**，真实模型自然UI闭环 **BLOCKED**；本节不将下文2026-10-29旧EXE当最新结果。详细记录：[FINAL_REVIEW_2026-11-02.md](FINAL_REVIEW_2026-11-02.md)。
- 新构建 Debug：`src-tauri/target/debug/guanmo.exe`，SHA-256 `54dbd001d8928033f5ae0b0dcebf8179f904fe20d2cc91d1e438333760353716`；独立 identifier `com.guanmo.memory-eval-20261102-sol`，CDP19284。实际启动空库、无baseUrl/凭据；原生Rust＋当前Vite源码，非Release性能产物。
- PASS（SQLite/Mock）：四轮→2次Mock提案/核验→candidate；明确调用确认后active；来源ID、实际搜索ID和注入ID一致。应用进程重启后，同一记忆和来源ID继续可读、可召回。非自然UI、非真实模型。
- PASS（原生事务）：首次inserted，同操作重放及用户删除后重放均already_applied，已删除记录未重建；candidate确认后active，回执无来源正文。
- PASS（限定恢复）：拒绝记忆来源pending跨进程保留；重启后**手动调用产品scheduleWindowRecovery**，最终noop/finished/attempts=1、0条记忆。隔离配置没有AI，未证明App带真实配置的自动恢复，也没有真实模型调用。
- 原始输出与复跑包装器留在本机忽略目录 `output/memory-native/sol-*`；包装器只把既有脚本的固定评测identifier改为新identifier，原脚本的profile守卫仍执行。未访问已安装的用户观墨实例。
- 首轮尝试依靠APPDATA环境变量隔离失败，实际复用既有匿名评测identifier；已停止并排除出新空库证据。该轮脚本显式调用均Mock，启动后台调用是否为零缺少完整证据，记unknown。之后使用新编译identifier；不能用环境变量替代实际Rust路径核验。
- 首Token配对延迟、真实模型多轮决定/偏好/负例、自然UI显式卡确认/拒绝/撤销、原生真实模型完整重启召回均NOT TESTED；累计pilot预算不可核实，需新预算或可验证余额。
- FAIL（确认实现缺陷）：实际SQLite下先保存source、pending总数到512后调用Rust intake，返回memory_intake_capacity，sourceSaved=1/intakeCount=0/recoveryGroup=null；不等于聊天数据被删除，但该来源无法由pending恢复。
- FAIL（脚本未通过，根因未定）：C真实墙钟检查中不足批次来源超过观测窗仍pending；第二轮Mock调用混有旧pending恢复，不能归因该新来源。未把此异常升格为已确认新P1，也不报告C原生时效通过。待干净单例和逐请求source记录补验，详见总报告。
- 本轮独立测试进程已关闭，用户已安装观墨进程未操作；匿名容量fixture保留于独立profile，未批量删除。

日期：2026-10-29。当前分支：feature/agent-router-v2。此记录只覆盖明确执行的项目。

## 隔离与产物

- 匿名测试配置：`output/memory-native/tauri-memory.json`，identifier=`com.guanmo.app.memory-eval`，无权限/CSP 放宽。
- 原生产物：`output/memory-native/guanmo-memory-eval.exe`，来自 `tauri build --debug --no-bundle --config ...`。SHA-256：`BA4A084A8D13D62A514B2B6E3A0EF36E2CCD82D99633993EBFCA49FEC5FCFBB5`。
- 已核实 EXE 产品名称、内含测试 identifier/title；编译资产中包含最新 `!decision.shouldLookupMemory` 触发保护。
- 实际 PID 24328（启动时），路径为本仓库 output 专属 EXE；窗口 133472，标题“观墨记忆验收 - 隔离环境”。恢复后需重新枚举窗口，不复用旧索引。
- SQLite：`%APPDATA%/com.guanmo.app.memory-eval/guanmo.db`；WebView2 子进程均核实使用该隔离 profile。初次打开：0 已保存、0 候选、0 历史会话。
- Windows 启动工具最初把通用 guanmo.exe 路径解析为已安装的 `D:/观墨/guanmo.exe`（PID 12420/窗口264430）；未读取其 UI 或操作数据。随即停止该方向，复制当前编译产物为独立文件名，并通过精确路径启动。不得把该已安装窗口当作测试窗口。

## 已执行

- PASS：新鲜 Debug 桌面构建、desktop 体积预算；最终日志 `output/memory-native/build-final.log`。
- PASS：隔离空库启动、设置→记忆显示 0/0；设置→Ollama 本地，地址 `http://localhost:11434/v1`，手动改成已安装 `qwen3:0.6b-q8_0`；真实 Rust 代理“测试连接”成功，列出本机三个已有模型；没有填写/复制 Key，没有拉取新模型。
- PASS：记忆管理经 UI 添加匿名偏好“匿名验收用户偏好：技术回答先给结论，再给必要依据”，界面提示“记忆已添加”，列表显示 1 条、手动创建、全局。

## 待验证

- 关闭→重开设置、重启持久化。
- 真实模型召回、原始历史补查、普通问题无记忆预检索及自然回答。
- 自动批任务真实产生、确认、纠正替代、取消、退出恢复、删除和断网降级。
- 桌面首 token 新旧对照、P50/P95、实际 token 使用；Debug/CLI 数据不能当作 Release 性能收益。
- 原生 Rust 候选确认与真实 SQLite 的完整闭环，尚不能用 Node SQLite 或 mock 替代。

## 已知限制

- CLI 真实小模型试测：8 次分类全部在 3 秒超时；另一次 4 调用预算包含 1 次 warmup（约2.49秒完成）和3次分类，分类仍全部超时。共12次、均本地小模型。没有可用分类准确率，记录为不可用，不能用测试记录脚本的绿色退出冒充模型质量 PASS。
- CLI 适配器串行化生产消息，未走桌面 Rust 代理；其首输出时间也不是应用首 token。真实桌面生成仍须另验。
- 用户已明确非敏感稳定事实自动生效、冲突和敏感信息确认。源码已接入，本文旧 EXE 不包含最新自动策略和 Rust 版本校验；必须重建再验，不能将前述手动管理证据当自动生效通过。
- 隔离重启后曾以 SQL 核实匿名手动事实与本地模型配置持久化；测试进程现已退出，旧 PID/窗口不可复用。真实自动写入和召回仍 NOT TESTED。
