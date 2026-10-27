# MCP 原生隔离验收

该夹具只编译生产 MCP 模块，独立 App ID 和临时 WebView 数据目录，不加载观墨主入口、SQLite、用户配置或凭据。使用已安装的 Node，不安装第三方 MCP 服务。

在项目根目录使用 PowerShell：

```powershell
$env:CARGO_TARGET_DIR = (Resolve-Path src-tauri/target).Path
cargo build --manifest-path tests/mcp/native/Cargo.toml --jobs 1 --locked --offline
$env:MCP_TEST_NODE = (Get-Command node).Source
$env:MCP_TEST_FIXTURE = (Resolve-Path src-tauri/src/mcp/stdio-fixture.cjs).Path
Start-Process -FilePath "$env:CARGO_TARGET_DIR/debug/guanmo-mcp-native-smoke.exe" -WindowStyle Hidden
```

阶段3A设置页（使用生产组件，不初始化主应用或业务库）：

```powershell
npx vite build --config tests/mcp/native/vite.config.ts
$env:CARGO_TARGET_DIR = (Resolve-Path src-tauri/target).Path
cargo build --manifest-path tests/mcp/native/Cargo.toml --jobs 1 --locked --offline
$env:MCP_TEST_NODE = (Get-Command node).Source
$env:MCP_TEST_FIXTURE = (Resolve-Path src-tauri/src/mcp/stdio-fixture.cjs).Path
$env:MCP_SMOKE_SETTINGS = '1'
$env:MCP_SMOKE_CONFIG_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ('guanmo-mcp-3a-' + [guid]::NewGuid().ToString('N'))
Start-Process -FilePath "$env:CARGO_TARGET_DIR/debug/guanmo-mcp-native-smoke.exe" -WindowStyle Hidden
```

按页面顶部显示的匿名参数添加服务，环境变量仅使用虚拟值。保存、启动的 Rust 确认必须人工操作，不添加自动批准开关。新配置默认禁用，保存/启用不启动；连接并检查后显示工具数和协议。验证编辑时保留/替换/删除 env、禁用/删除后撤销连接；重启时复用同一 MCP_SMOKE_CONFIG_DIR 验证恢复配置但不自动连接。清除该环境变量后使用默认进程独立临时目录。生成的 `web/settings/` 已忽略，重建前不要删除原目录；旧窗口如仍占用可执行文件，只关闭本任务已断开的匿名窗口，不处理其他应用。

在窗口中依次登记、连接、准备提案并确认、刷新、断开。拒绝确认应返回拒绝错误且不调用工具；确认后显示匿名 echo JSON。记录协议版本、目录工具数、调用计数、父子进程 ID。断开后两进程应退出。工具调用后重复确认旧 proposalId 必须失败。取消/超时不表示外部副作用已撤销。

这里的原生确认/IPC证据不等于观墨产品设置页、Agent闭环或真实第三方服务已验收；它们属于后续阶段。不要为本夹具启动主应用或访问真实数据库。`web/index.html` 的宽松 inline CSP 仅属于这个匿名开发夹具，不得复制到产品 CSP。
