import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('conversation persistence boundary', () => {
  it('keeps SQLite conversation persistence out of the UI and chat store', () => {
    for (const path of [
      'src/components/ai/AiPanel.tsx',
      'src/stores/chatStore.ts',
    ]) {
      expect(readSource(path)).not.toMatch(/@\/services\/database\/persistence/)
      expect(readSource(path)).toMatch(/@\/services\/agent\/conversationCommands/)
    }
  })

  it('keeps the database adapter inside the conversation command', () => {
    const source = readSource('src/services/agent/conversationCommands.ts')
    expect(source).toMatch(/@\/services\/database\/persistence/)
    expect(source).toMatch(/persistConversationSession/)
    expect(source).toMatch(/loadRecentConversationTurns/)
    expect(source).toMatch(/deleteConversationSession/)
  })
})
