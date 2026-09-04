import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('settings command boundary', () => {
  it('keeps database persistence out of SettingsPage', () => {
    const source = readSource('src/features/settings/SettingsPage.tsx')
    expect(source).not.toMatch(/@\/services\/database\/persistence/)
    expect(source).toMatch(/@\/services\/settings\/settingsCommands/)
  })

  it('keeps SettingsPage database operations inside settingsCommands', () => {
    const source = readSource('src/services/settings/settingsCommands.ts')
    expect(source).toMatch(/@\/services\/database\/persistence/)
    expect(source).toMatch(/clearSavedChatSessions/)
    expect(source).toMatch(/loadSettingsMemoryPage/)
    expect(source).toMatch(/persistSettingsMemory/)
  })
})
