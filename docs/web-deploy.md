# 网页版部署流程

本文件是项目代理共用的 Web 能力边界、构建和部署参考。涉及推送时必须先遵守 `AGENTS.md` 与 `docs/push-safety.md` 的校验和二次确认，本文中的命令示例不构成执行授权。

## 能力与构建边界

- Web 端在支持 File System Access API 的 Chromium 浏览器中提供目录授权、工作区树、Markdown 打开/原位保存、新建与删除；其他浏览器保留相同布局并降级为单文件选择与下载保存。目录、最近文件、标签页和会话均不跨刷新恢复。
- Web 端提供 OpenAI-compatible Chat Completions 对话，设置区只开放对话 API 与联网搜索 API 配置，Embedding 配置保持禁用。只有用户明确勾选时才发送当前文档正文。
- 对话与联网搜索 API Key 共用一种存储方式：当前页面内存；经风险弹窗确认后以明文保存到 LocalStorage（只建议免费、可随时作废的 Key）；或用同一个本地密码经 PBKDF2-HMAC-SHA256 + AES-GCM 加密后，将两把 Key 的同一份密文保存到 LocalStorage。加密模式不持久化密码、派生密钥或明文 Key；所有模式禁止使用 SessionStorage 或 IndexedDB。
- Web 端不初始化 SQLite 或 IndexedDB，继续禁用 RAG、Embedding、长期记忆、聊天历史持久化和桌面服务。共享层误调用这些受限能力时必须抛出 `UnsupportedCapabilityError`。
- `npm run build` 生成 Web 版；`npm run build:desktop` 生成 Tauri 桌面前端。Tauri 配置必须调用 desktop 命令，不得混用 Web 入口。
- 两种构建分别执行模式校验与体积预算；可单独运行 `npm run check:bundle:web` 或 `npm run check:bundle:desktop`。Web 产物允许共享桌面 UI、CodeMirror 与完整 Markdown 预览，但不得包含 Tauri、SQLite 或 IndexedDB 运行时。

## 仓库说明

- **网页版源码仓库**：即当前开源仓库 `D:\React\guanmo-open`，在此处执行 `npm run build`（Vite）打包
- **网页版部署仓库**：`D:\React\guanmo-page`，用于放置打包好的网页版静态资源，通过 GitHub Pages 自动部署

## 更新网页版流程

1. 在当前开源仓库 `D:\React\guanmo-open` 执行 `npm run build`，产出在 `dist/` 目录
2. 将 `dist/` 内的打包资源复制到网页版部署仓库 `D:\React\guanmo-page`
3. 在 `D:\React\guanmo-page` 中执行 `git add -A && git commit && git push`，交由 GitHub 自动部署更新
