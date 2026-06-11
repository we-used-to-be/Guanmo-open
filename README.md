<p align="center">
  <img src="src-tauri/icons/icon.png" alt="观墨 Logo" width="128" />
</p>

<h1 align="center">观墨 · GuanMo</h1>

<p align="center">
  <strong>AI 驱动的 Markdown 知识管理桌面应用</strong><br/>
  <sub>An AI-powered Markdown knowledge management desktop application</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri_2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/React_18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 18" />
  <img src="https://img.shields.io/badge/TypeScript_5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/CodeMirror_6-D30707?style=flat-square&logo=codemirror&logoColor=white" alt="CodeMirror 6" />
  <img src="https://img.shields.io/badge/Vite_6-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite 6" />
</p>

---

<p align="center">
  <a href="#-功能特性-features">功能特性</a> ·
  <a href="#-快速开始-quick-start">快速开始</a> ·
  <a href="#%EF%B8%8F-技术栈-tech-stack">技术栈</a> ·
  <a href="#-项目结构-project-structure">项目结构</a> ·
  <a href="#-快捷键-shortcuts">快捷键</a> ·
  <a href="#-许可证-license">许可证</a>
</p>

---

## 📖 简介 · Introduction

**观墨**（GuanMo）是一款面向知识工作者的 **AI Markdown 编辑器**，基于 [Tauri 2](https://v2.tauri.app/) 构建为轻量桌面应用。它将专业的 Markdown 编辑能力、本地 RAG 知识库、长期记忆系统和 Agent 工具调用整合为一体，让你在写作的同时拥有一个真正「理解」你文档上下文的 AI 助手。

**GuanMo** is an **AI-powered Markdown editor** for knowledge workers, built as a lightweight desktop app with [Tauri 2](https://v2.tauri.app/). It combines a professional Markdown editor, local RAG knowledge base, long-term memory system, and Agent tool-calling into one seamless experience — giving you an AI assistant that truly understands the context of your documents.

---

## 🔐 安全提醒 · Security Notes

- Tauri FS 权限默认不开放全盘访问；文件读写仅限用户通过对话框显式选择的工作区目录或单个文件。
- Rust 兜底文件命令会校验绝对路径、文本文件扩展名，并拒绝访问未授权 workspace 之外的路径。
- 本开源副本不内置任何 API Key。API Key 通过应用设置填写，并由 Windows DPAPI 加密后保存在本机。
- `.env` 只用于配置本机密钥存储中的标识名，不应写入真实 API Key。请从 `.env.example` 创建本地 `.env`，并且不要提交 `.env`、数据库文件或历史记录。

示例环境变量：

```bash
VITE_GUANMO_AI_API_KEY_SECRET=guanmo.ai.api-key
VITE_GUANMO_EMBEDDING_API_KEY_SECRET=guanmo.embedding.api-key
VITE_GUANMO_WEB_SEARCH_API_KEY_SECRET=guanmo.web-search.api-key
```

---

## ✨ 功能特性 · Features

### 📝 Markdown 编辑器 · Editor

| 功能 | 说明 |
|------|------|
| **多视图模式** | 编辑 / 预览 / 并排 / 双文档 / Diff 对比 |
| **语法高亮** | CodeMirror 6 驱动，支持 Markdown、代码块语法高亮 |
| **数学公式** | KaTeX 渲染行内 & 块级 LaTeX 公式 |
| **Mermaid 图表** | 流程图、时序图、甘特图等直接渲染 |
| **任务列表** | 预览模式下可交互勾选 `- [ ]` 任务项 |
| **目录导航** | 自动提取标题生成侧边目录 TOC |
| **搜索替换** | `Ctrl+F` 正则搜索与批量替换 |
| **多标签页** | 同时打开多个文件，标签栏切换 |
| **自动保存** | 可配置延迟的自动保存机制 |
| **HTML 导出** | `Ctrl+Shift+E` 一键导出为 HTML |

### 🤖 AI 助手 · AI Assistant

| 功能 | 说明 |
|------|------|
| **Agent 工具调用** | 基于意图打分的智能工具选择，支持多工具并行执行 |
| **上下文标签** | 为对话添加文件、文件夹、选区、记忆、网络搜索作为上下文 |
| **本地 RAG 知识库** | 文档分块 → 向量嵌入 → 余弦相似度检索，作用域由上下文标签控制 |
| **长期记忆** | 自动提取 + 手动保存，支持分类、锁定、搜索 |
| **联网搜索** | 支持 DuckDuckGo / Brave Search / 自定义搜索引擎 |
| **选区编辑确认** | AI 修改文本需用户确认，精确范围锚定避免误改 |
| **流式渲染** | AI 回答实时流式输出为 Markdown |
| **Agent 时间线** | 可视化展示 Agent 执行链：本地搜索 → 联网搜索 → 生成 → 完成 |

### 🗂 文件管理 · File Management

- 文件树侧边栏，支持工作区文件夹
- 最近文件、收藏夹、重命名、另存为
- 工作区文档批量索引 / 清理 / 重建

### ⚙️ 设置 · Settings

- **AI 模型配置**：预设 OpenAI、DeepSeek、MiMo、SiliconFlow、智谱 GLM、Ollama
- **独立 Embedding 模型配置**
- **编辑器设置**：字体、字号、Tab 宽度、自动换行、行号
- **记忆管理**：查看、锁定、删除、确认候选记忆
- **数据备份**：一键导出 / 导入全部数据

### 🖥 本地优先 · Local-First

观墨无需后端服务，安装后即可在本地运行。

- 文档编辑、预览与管理均在本地完成
- 知识库索引保存在本机
- 不强制上传用户文档
- AI 功能需用户自行配置模型接口

### 📂 文件关联 · File Association


- 双击 Markdown 文件直接打开
- 支持拖放打开文件
- 自动注册系统关联

---

## 🛠️ 技术栈 · Tech Stack

| 层级 | 技术 |
|------|------|
| **桌面壳** | Tauri 2 (Rust) |
| **前端框架** | React 18 + TypeScript 5.7 |
| **构建工具** | Vite 6 |
| **编辑器** | CodeMirror 6 |
| **状态管理** | Zustand 5（4 个持久化 Store） |
| **样式** | Tailwind CSS 3.4 + 自定义设计令牌 |
| **UI 组件库** | Animal Island UI |
| **数据库** | SQLite（Tauri SQL 插件） |
| **Markdown 渲染** | react-markdown + remark-gfm + rehype-katex + rehype-highlight |
| **图表** | Mermaid |
| **数学公式** | KaTeX |
| **安全** | Windows DPAPI 加密存储 API Key |

---

## 🚀 快速开始 · Quick Start

### 环境要求 · Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/) (stable)
- [Tauri 2 CLI](https://v2.tauri.app/start/prerequisites/) 依赖

### 安装 · Installation

```bash
# 克隆仓库 · Clone the repo
git clone https://github.com/we-used-to-be/Guanmo-open.git
cd Guanmo-open

# 安装前端依赖 · Install frontend dependencies
npm ci

# 创建本机配置文件，文件中仅包含密钥标识名，不包含真实 API Key
# Create local config with secret identifiers only, never real API keys
cp .env.example .env
```

### 开发 · Development

```bash
# 推荐：Tauri 开发模式（直接在 WebView 中运行，资源路径问题立即暴露）
# Recommended: Tauri dev mode (runs in WebView, path issues surface immediately)
npm run tauri dev

# 仅前端 Vite 开发服务器 · Frontend-only Vite dev server
npm run dev
```

### 构建 · Build

```bash
# TypeScript 检查 + Vite 构建 · TypeScript check + Vite build
npm run build

# 完整 Tauri 构建（生成 .exe）· Full Tauri build (produces .exe)
npm run tauri build
```

### 测试 · Testing

```bash
# Agent 解析器测试 · Agent parser tests
npm run test:agent-parser

# 资源路径检查 · Resource path check
npm run check:paths
```

---

## 📁 项目结构 · Project Structure

```
guanmo/
├── src/
│   ├── components/
│   │   ├── ai/                 # AI 聊天面板、提示词编辑器
│   │   │                     # AI chat panel, prompt composer
│   │   ├── editor/             # CodeMirror 编辑器、预览、Diff、标签栏
│   │   │                     # CodeMirror editor, preview, diff, tab bar
│   │   ├── file-tree/          # 文件树组件
│   │   │                     # File tree component
│   │   ├── layout/             # 应用布局：标题栏、侧边栏、状态栏
│   │   │                     # App layout: title bar, sidebar, status bar
│   │   └── common/             # 通用组件：命令面板、右键菜单、Toast
│   │                         # Common: command palette, context menu, toast
│   ├── services/
│   │   ├── agent/              # Agent 系统：意图检测、工具选择、执行器
│   │   │                     # Agent: intent detection, tool selection, executor
│   │   ├── ai/                 # AI 客户端、流式处理、模型预设
│   │   │                     # AI client, streaming, model presets
│   │   ├── rag/                # RAG 管道：分块、嵌入、向量存储、检索
│   │   │                     # RAG pipeline: chunking, embedding, vector store
│   │   ├── memory/             # 长期记忆服务
│   │   │                     # Long-term memory service
│   │   └── database/           # SQLite 初始化、Schema、CRUD
│   │                         # SQLite init, schema, persistence
│   ├── stores/                 # Zustand 状态管理（app / editor / chat / settings）
│   │                         # Zustand stores (app / editor / chat / settings)
│   ├── hooks/                  # 自定义 Hooks：AI 聊天、文件操作、快捷键
│   │                         # Custom hooks: AI chat, file ops, keyboard
│   ├── features/               # 功能模块：设置页面
│   │                         # Feature modules: settings page
│   ├── styles/                 # 全局样式 + 主题令牌（亮色 / 暗色 / 动物暗色）
│   │                         # Global styles + theme tokens (light / dark / animal-dark)
│   └── vendor/                 # 内置 UI 组件库：Animal Island UI
│                             # Vendored UI library: Animal Island UI
├── src-tauri/
│   ├── src/lib.rs              # Rust 后端：DPAPI 加密、文件操作命令
│   │                         # Rust backend: DPAPI encryption, file commands
│   ├── Cargo.toml
│   └── tauri.conf.json         # Tauri 配置
│                             # Tauri configuration
├── scripts/                    # 工具脚本（路径检查、Agent 解析器测试）
│                             # Utility scripts (path check, agent parser test)
└── docs/                       # 项目文档
                              # Project documentation
```

---

## ⌨️ 快捷键 · Shortcuts

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + N` | 新建文件 |
| `Ctrl + O` | 打开文件 |
| `Ctrl + S` | 保存 |
| `Ctrl + Shift + S` | 另存为 |
| `Ctrl + F` | 搜索替换 |
| `Ctrl + J` | 切换 AI 助手面板 |
| `Ctrl + B` | 切换侧边栏 |
| `Ctrl + P` | 命令面板（文件） |
| `Ctrl + Shift + P` | 命令面板（命令） |
| `Ctrl + Shift + E` | 导出为 HTML |
| `Ctrl + 滚轮` | 调整编辑器字号 |
| `Ctrl + Tab` | 切换标签页 |

---

## 🤝 贡献 · Contributing

欢迎提交 Issue 和 Pull Request！

Contributions are welcome! Feel free to open issues and submit pull requests.

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 📦 发布 · Release

推送 `v*` 格式的 tag 会触发 GitHub Actions，在 Windows 上构建 Tauri 应用、创建 GitHub Release，并上传 NSIS `.exe` 与 WiX `.msi` 安装包。安装包不会提交到 Git 仓库。

```bash
git tag v1.0.0
git push origin v1.0.0
```

发布 tag 应与 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中的版本号保持一致。

---

## 🧩 第三方组件与品牌说明 · Third-party Notices

- 本项目 vendored 了 [animal-island-ui](https://github.com/guokaigdg/animal-island-ui) 的组件快照，并保留其 MIT 许可证。
- animal-island-ui 上游 README 同时包含非商业使用说明，该说明与 MIT LICENSE 的授权范围存在表述差异；计划商业分发前请自行核对上游条款。
- 观墨不是 Nintendo 官方产品，与 Nintendo Co., Ltd. 无关联、授权或合作关系。
- 完整归属与许可说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

## Disclaimer

Guanmo is provided as a Markdown editing and AI assistance tool on an "AS IS" basis. Users are responsible for backing up important data and reviewing AI-generated content before use. For details, see [DISCLAIMER.md](DISCLAIMER.md).

---

## 📄 许可证 · License

观墨项目原创代码基于 MIT 许可证开源。第三方代码与资源仍受各自许可证和条款约束。

Guanmo's original code is licensed under the MIT License. Third-party code and assets remain subject to their respective licenses and terms.

---

<p align="center">
  <sub>用 ❤️ 和 ☕ 打造 · Built with ❤️ and ☕</sub>
</p>
