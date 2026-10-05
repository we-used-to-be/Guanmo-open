import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync('src/App.tsx', 'utf8')
const singleton = readFileSync('src/services/singletonPromise.ts', 'utf8')
const appLayout = readFileSync('src/components/layout/AppLayout.tsx', 'utf8')
const aiPanel = readFileSync('src/components/ai/AiPanel.tsx', 'utf8')
const aiChat = readFileSync('src/hooks/useAiChat.ts', 'utf8')
const persistence = readFileSync('src/services/database/persistence.ts', 'utf8')
const ragStartupWarmup = readFileSync('src/services/rag/startupWarmup.ts', 'utf8')
const ragWarmupScheduler = readFileSync('src/services/rag/warmupScheduler.ts', 'utf8')

assert.doesNotMatch(app, /loadChatSessions|loadAllMemories/, 'App 不得执行结果被丢弃的查询')
assert.doesNotMatch(singleton, /CHAT_SESSIONS|MEMORIES/, '不得保留无消费者的 singleton')
assert.match(appLayout, /const AiPanel = lazy\(/, 'AI 面板必须保持懒加载')
const aiPanelMounts = [...appLayout.matchAll(/<Suspense fallback=\{<AiPanelFallback \/>\}><AiPanel\b/g)]
assert.equal(aiPanelMounts.length, 2, '普通与全屏布局都必须保留 AI 面板懒加载边界')
for (const mount of aiPanelMounts) {
  const guardStart = appLayout.lastIndexOf('{aiPanelOpen && (', mount.index)
  assert.ok(guardStart >= 0, 'AI 面板必须由打开状态控制')
  assert.doesNotMatch(appLayout.slice(guardStart, mount.index), /\)\}/, '首次打开时才挂载 AI 面板')
}
assert.match(aiPanel, /const handleLoadHistory[\s\S]*await loadMoreHistory\(\)/, '历史记录由 AI 面板真实交互按需加载')
assert.match(aiChat, /singletonManager\.init\(SINGLETON_IDS\.CHAT_AI/, '聊天客户端预热结果必须由真实消费者复用')
assert.match(persistence, /export async function loadRecentChatTurns[\s\S]*const db = getDatabase\(\)/, '重连后的历史查询必须动态获取当前数据库 adapter')
assert.doesNotMatch(app, /subscribeDatabaseRuntimeState/, '数据库 ready 事件不得触发丢弃结果的查询')
assert.match(app, /stopRagWarmup = scheduleRagWarmupAfterFirstSurface\(\)/, 'App 必须保留 RAG 预热取消句柄')
assert.match(app, /stopRagWarmup\?\.\(\)/, 'App 清理必须取消 RAG 预热')
assert.match(ragStartupWarmup, /waitForStartupPoint\('editor-first-visible'\)[\s\S]*waitForStartupPoint\('preview-first-visible'\)/, 'RAG 预热必须等待真实首屏')
assert.match(ragStartupWarmup, /surfaceReady\.then[\s\S]*if \(cancelled\) return[\s\S]*await import\('\.\/warmupScheduler'\)[\s\S]*if \(!cancelled\) stopWarmup = scheduleNativeRagWarmup\(\)/, '首屏后才加载调度器，取消后不得启动')
assert.match(ragStartupWarmup, /cancelled = true[\s\S]*stopWarmup\?\.\(\)/, '必须取消已创建的预热任务')
assert.match(ragWarmupScheduler, /decideRagWarmup\([\s\S]*modePerformancePolicy/, '调度器必须遵循性能档位')

console.log('app warmup checks passed')
