import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('reading artifact command boundary', () => {
  it('keeps database persistence out of AiPanel', () => {
    const source = readSource('src/components/ai/AiPanel.tsx')
    expect(source).not.toMatch(/@\/services\/database\//)
    expect(source).toMatch(/@\/services\/agent\/artifactCommands/)
    expect(source).toMatch(/@\/services\/readingReminders/)
  })

  it('keeps database persistence out of the reading artifact store', () => {
    const source = readSource('src/stores/readingArtifactsStore.ts')
    expect(source).not.toMatch(/@\/services\/database\/(?:readingArtifacts|persistence)/)
    expect(source).toMatch(/@\/services\/agent\/artifactCommands/)
  })

  it('keeps repository imports inside the artifact command', () => {
    const source = readSource('src/services/agent/artifactCommands.ts')
    expect(source).toMatch(/@\/services\/database\/readingArtifacts/)
    expect(source).toMatch(/@\/services\/database\/persistence/)
    expect(source).toMatch(/persistReadingArtifactCommand/)
    expect(source).toMatch(/loadReadingArtifactsPageCommand/)
    expect(source).toMatch(/checkReadingArtifactSourceCommand/)
  })
})
