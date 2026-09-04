import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('workspace UI dependency boundary', () => {
  it('routes workspace and knowledge-base operations through the workspace facade', () => {
    for (const path of [
      'src/components/file-tree/WorkspaceRoots.tsx',
      'src/components/file-tree/FileTree.tsx',
    ]) {
      const source = readSource(path)
      expect(source).toMatch(/@\/services\/workspaceIndex/)
      expect(source).not.toMatch(/@\/services\/(?:rag|database)\//)
      expect(source).not.toMatch(/import\s*{[^}]*\breadFile\b[^}]*}\s*from ['"]@\/hooks\/useTauri['"]/)
    }
  })
})
