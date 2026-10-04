import type { ModePerformancePolicy } from '@/services/editorSession'

export interface RagWarmupSnapshot {
  policy: ModePerformancePolicy
  documentCount: number
  availableMemoryMb?: number
  recentlyUsed: boolean
  userActive: boolean
  memoryPressure: boolean
}

export type RagWarmupDecision = 'on-demand' | 'idle-warmup' | 'cancel'

export function decideRagWarmup(snapshot: RagWarmupSnapshot): RagWarmupDecision {
  if (snapshot.memoryPressure) return 'cancel'
  if (snapshot.policy === 'memory' || snapshot.documentCount === 0) return 'on-demand'
  if (snapshot.availableMemoryMb !== undefined && snapshot.availableMemoryMb < 512) return 'on-demand'
  if (snapshot.userActive && snapshot.policy !== 'speed') return 'cancel'
  if (snapshot.policy === 'speed' || snapshot.recentlyUsed || snapshot.documentCount <= 100) return 'idle-warmup'
  return 'on-demand'
}
