import { createRoot } from 'react-dom/client'
import { McpSettings } from '../../../../src/features/settings/McpSettings'
import '../../../../src/styles/global.css'

const config = (window as unknown as { smokeConfig: unknown }).smokeConfig
createRoot(document.getElementById('root')!).render(
  <main className="mx-auto max-w-3xl p-6">
    <h1 className="text-heading text-gm-text">MCP 设置 · 匿名原生验收</h1>
    <p className="text-caption text-gm-text-secondary">使用生产设置组件与命令，配置和 WebView 均位于独立临时目录。原生确认由用户操作。</p>
    <pre className="my-3 whitespace-pre-wrap break-all text-caption text-gm-text">{JSON.stringify(config, null, 2)}</pre>
    <McpSettings />
  </main>,
)
