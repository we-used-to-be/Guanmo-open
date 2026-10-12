import { isTauri } from '@/hooks/useTauri'
import { idleScheduler } from './idleScheduler'

export interface SystemMemorySnapshot {
  availablePhysicalMb: number
  totalPhysicalMb: number
  availableCommitMb: number
  commitLimitMb: number
}

export type MemoryPressure = 'unknown' | 'normal' | 'pressure'
export const MEMORY_RESERVE_MB = 512
const MEMORY_RECOVERY_MB = 768
const MEMORY_POLL_MS = 5000

let pressure: MemoryPressure = 'unknown'
let latestSnapshot: SystemMemorySnapshot | null = null
let pendingSnapshot: Promise<SystemMemorySnapshot | null> | null = null
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<(value: MemoryPressure) => void>()

export function getSystemMemorySnapshot(): SystemMemorySnapshot | null { return latestSnapshot }

export function classifyMemoryPressure(snapshot: SystemMemorySnapshot | null, previous: MemoryPressure): MemoryPressure {
  if (!snapshot) return 'unknown'
  const available = Math.min(snapshot.availablePhysicalMb, snapshot.availableCommitMb)
  return available < (previous === 'pressure' ? MEMORY_RECOVERY_MB : MEMORY_RESERVE_MB) ? 'pressure' : 'normal'
}

export function canAffordWarmup(snapshot: SystemMemorySnapshot | null, budgetMb: number): boolean {
  return snapshot !== null && pressure !== 'pressure'
    && Math.min(snapshot.availablePhysicalMb, snapshot.availableCommitMb) >= MEMORY_RESERVE_MB + budgetMb
}

/** O(1) system counters, with concurrent requests coalesced; no process enumeration. */
export function readSystemMemory(): Promise<SystemMemorySnapshot | null> {
  if (!isTauri()) return Promise.resolve(null)
  if (pendingSnapshot) return pendingSnapshot
  pendingSnapshot = import('@tauri-apps/api/core').then(async ({ invoke }) => {
    const value = await invoke<unknown>('get_system_memory_snapshot')
    if (!value || typeof value !== 'object') return null
    const snapshot = value as SystemMemorySnapshot
    if (!['availablePhysicalMb', 'totalPhysicalMb', 'availableCommitMb', 'commitLimitMb']
      .every((key) => typeof snapshot[key as keyof SystemMemorySnapshot] === 'number'
        && Number.isFinite(snapshot[key as keyof SystemMemorySnapshot]) && snapshot[key as keyof SystemMemorySnapshot] >= 0)) return null
    if (snapshot.totalPhysicalMb === 0 || snapshot.commitLimitMb === 0
      || snapshot.availablePhysicalMb > snapshot.totalPhysicalMb || snapshot.availableCommitMb > snapshot.commitLimitMb) return null
    return snapshot
  }).catch(() => null).then((snapshot) => {
    latestSnapshot = snapshot
    const next = classifyMemoryPressure(snapshot, pressure)
    if (next !== pressure) {
      pressure = next
      listeners.forEach((listener) => listener(next))
    }
    return snapshot
  }).finally(() => { pendingSnapshot = null })
  return pendingSnapshot
}

/** Subscribe only after the real surface; the last subscriber owns timer cleanup. */
export function subscribeMemoryPressure(listener: (value: MemoryPressure) => void): () => void {
  if (!isTauri()) return () => undefined
  listeners.add(listener)
  listener(pressure)
  if (timer === undefined) {
    void readSystemMemory()
    timer = setInterval(() => { void readSystemMemory() }, MEMORY_POLL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** Foreground operations bypass this queue. Cancellation only suppresses unstarted work. */
export function scheduleMemoryAwareTask(
  run: () => Promise<void>,
  budget: number | (() => Promise<number>),
  eligible: () => boolean,
  priority: number,
  label: string,
): () => void {
  let cancelled = false
  const valid = () => !cancelled && eligible()
  const stop = idleScheduler.enqueueOptional(async () => {
    if (!valid()) return
    if (isTauri()) {
      // Avoid even the metadata query when the system is already under pressure.
      if (!canAffordWarmup(await readSystemMemory(), typeof budget === 'number' ? budget : 128) || !valid()) return
      const budgetMb = typeof budget === 'number' ? budget : await budget()
      if (!Number.isFinite(budgetMb) || budgetMb < 0
        || !canAffordWarmup(await readSystemMemory(), budgetMb) || !valid()) return
    }
    await run()
  }, priority, label)
  return () => { cancelled = true; stop() }
}
