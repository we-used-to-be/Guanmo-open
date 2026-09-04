import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('conversation request boundary', () => {
  it('keeps context and route services out of useAiChat', () => {
    const source = readSource('src/hooks/useAiChat.ts')
    expect(source).not.toMatch(/@\/services\/(contextBuilder|agent\/routingService)/)
    expect(source).toMatch(/@\/services\/agent\/conversationRequest/)
  })

  it('keeps context and route composition inside the request boundary', () => {
    const source = readSource('src/services/agent/conversationRequest.ts')
    expect(source).toMatch(/@\/services\/contextBuilder/)
    expect(source).toMatch(/@\/services\/agent\/routingService/)
    expect(source).toMatch(/prepareConversationContext/)
    expect(source).toMatch(/prepareConversationRouting/)
  })
})
