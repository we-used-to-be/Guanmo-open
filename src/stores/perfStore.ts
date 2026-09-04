import { create } from 'zustand'
import type { PerfData } from '@/services/perfTypes'
import type { PerfEvent } from '@/services/eventMarker'

export type SampleIntervalMs = 250 | 500 | 1000 | 5000

export interface MonitorSettings {
  sampleIntervalMs: SampleIntervalMs
  historyCapacity: number
  uiRefreshIntervalMs: number
}

export interface PerfBaseline {
  kind: 'idle' | 'document'
  setAt: number
  snapshot: PerfData
}

class RingBuffer<T> {
  private items: Array<T | undefined>
  private cursor = 0
  private length = 0
  constructor(private capacity: number) {
    this.items = new Array(capacity)
  }
  push(value: T) {
    this.items[this.cursor] = value
    this.cursor = (this.cursor + 1) % this.capacity
    this.length = Math.min(this.length + 1, this.capacity)
  }
  resize(capacity: number) {
    const current = this.toArray().slice(-capacity)
    this.capacity = capacity
    this.items = new Array(capacity)
    this.cursor = 0
    this.length = 0
    current.forEach((item) => this.push(item))
  }
  clear() {
    this.items = new Array(this.capacity)
    this.cursor = 0
    this.length = 0
  }
  toArray() {
    const result: T[] = []
    const start = (this.cursor - this.length + this.capacity) % this.capacity
    for (let index = 0; index < this.length; index += 1) {
      const item = this.items[(start + index) % this.capacity]
      if (item !== undefined) result.push(item)
    }
    return result
  }
}

const history = new RingBuffer<PerfData>(300)
let lastUiPublishAt = 0

interface PerfState {
  current: PerfData | null
  events: PerfEvent[]
  baseline: PerfBaseline | null
  testStartedAt: number | null
  testPeaks: Partial<Record<keyof PerfData, number>>
  settings: MonitorSettings
  isCollapsed: boolean
  isPaused: boolean
  addEvent: (event: PerfEvent) => void
  setBaseline: (kind: PerfBaseline['kind']) => void
  clearBaseline: () => void
  startTest: () => void
  clearHistory: () => void
  toggleCollapsed: () => void
  togglePaused: () => void
  setSampleInterval: (interval: SampleIntervalMs) => void
  publishSample: (data: PerfData | null, testPeaks: Partial<Record<keyof PerfData, number>>) => void
}

const peakKeys: Array<keyof PerfData> = [
  'appPrivateWorkingSetKb', 'webviewPrivateWorkingSetKb', 'rustPrivateWorkingSetKb',
  'cpuNormalizedPercent', 'jsHeapUsedMb', 'domNodeCount', 'detachedDomNodes', 'longTaskCount',
  'activeTimeoutCount', 'eventListenerCount', 'monacoModelCount',
]

export const usePerfStore = create<PerfState>((set, get) => ({
  current: null,
  events: [],
  baseline: null,
  testStartedAt: null,
  testPeaks: {},
  settings: { sampleIntervalMs: 5000, historyCapacity: 300, uiRefreshIntervalMs: 1000 },
  isCollapsed: true,
  isPaused: false,
  addEvent: (event) => set((state) => ({ events: [...state.events, event].slice(-500) })),
  setBaseline: (kind) => {
    const snapshot = get().current
    if (snapshot) {
      set({
        baseline: {
          kind,
          setAt: Date.now(),
          snapshot: { ...snapshot },
        },
        testStartedAt: null,
        testPeaks: {},
      })
    }
  },
  clearBaseline: () => set({ baseline: null, testStartedAt: null, testPeaks: {} }),
  startTest: () => set({ testStartedAt: Date.now(), testPeaks: {} }),
  clearHistory: () => {
    history.clear()
    set({ events: [], testPeaks: {} })
  },
  toggleCollapsed: () => set((state) => ({ isCollapsed: !state.isCollapsed })),
  togglePaused: () => set((state) => ({ isPaused: !state.isPaused })),
  setSampleInterval: (sampleIntervalMs) => set((state) => ({
    settings: { ...state.settings, sampleIntervalMs },
  })),
  publishSample: (data, testPeaks) => set((state) => ({
    ...(data ? { current: data } : {}),
    testPeaks: state.testPeaks === testPeaks ? state.testPeaks : testPeaks,
  })),
}))

export function recordPerfSample(data: PerfData) {
  const state = usePerfStore.getState()
  if (state.isPaused) return
  history.push(data)
  let testPeaks = state.testPeaks
  if (state.testStartedAt !== null) {
    testPeaks = { ...testPeaks }
    for (const key of peakKeys) {
      const value = data[key]
      if (typeof value === 'number') testPeaks[key] = Math.max(testPeaks[key] ?? value, value)
    }
  }
  const now = performance.now()
  if (state.current === null || now - lastUiPublishAt >= state.settings.uiRefreshIntervalMs) {
    lastUiPublishAt = now
    state.publishSample(data, testPeaks)
  } else if (testPeaks !== state.testPeaks) {
    state.publishSample(null, testPeaks)
  }
}

export function getPerfHistory() {
  return history.toArray()
}

export function setHistoryCapacity(capacity: number) {
  history.resize(capacity)
}
