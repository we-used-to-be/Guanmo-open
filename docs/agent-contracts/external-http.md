# 外部 HTTP 契约

涉及对话、Embedding、模型列表、联网搜索、更新检查、自定义 API、本地模型或 Origin 授权时，修改前必须读取本文件。

- 桌面对话、Embedding、模型列表、联网搜索和更新检查统一通过 `src/services/externalHttp.ts` 调用受限 Rust 请求代理，不得直接使用 WebView 原生 `fetch` 或 Tauri HTTP 插件。
- Web 端只有 OpenAI-compatible Chat Completions 可经 `src/web/webAiClient.ts` 使用浏览器 `fetch`；不得让桌面入口或其他共享服务回退到浏览器直连。公网 API 只允许 HTTPS，本机回环地址允许 HTTP，浏览器跨域策略仍是实际可用边界。
- Web 设置区只开放对话 API 与联网搜索 API，Embedding 保持禁用。两类 API Key 默认只保存在当前页面内存；用户可在明确风险弹窗确认后将其明文保存到 LocalStorage，或用同一个本地密码派生不可导出的 AES-GCM 密钥，将带随机 salt/IV 的双 Key 密文保存到 LocalStorage。加密模式的密码、派生密钥、明文 Key，以及所有模式的对话和文档授权不得持久化，也不得写入 SessionStorage、IndexedDB、URL、日志或错误信息；文档正文默认不发送，必须由用户逐页明确勾选。
- Web 端误调用 Embedding、更新检查、RAG 或 API Origin 持久授权时必须抛出 `UnsupportedCapabilityError`。
- Rust 代理只允许 GET/POST，并负责 URL、Origin、DNS/IP、请求头、重定向及资源限额校验；公网只允许 HTTPS，HTTP 仅允许已授权的回环或私网 Origin，危险地址永久拒绝。
- 内置供应商 Origin 自动放行；自定义 API 与本地模型按 `scheme + host + port` 进行本次或永久授权，永久授权保存在应用配置目录并可在设置中撤销。旧 Base URL、模型名和 API Key 保持兼容，首次使用时进入授权流程。
- 流式响应通过 Tauri Channel 转发并保持现有 SSE 解析接口。
- 传输层与授权边界回归使用 `npm run test:ai-http`。
