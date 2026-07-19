import { create } from 'zustand'

export type ToastType = 'success' | 'info' | 'warning' | 'error'

export interface ToastAction {
  label: string
  onClick: () => void | Promise<void>
  primary?: boolean
}

export interface ToastOptions {
  id?: string
  title?: string
  message: string
  type?: ToastType
  duration?: number | null
  actions?: ToastAction[]
}

export interface ToastItem extends Required<Pick<ToastOptions, 'id' | 'message' | 'type'>> {
  title?: string
  duration: number | null
  actions: ToastAction[]
  createdAt: number
}

interface ToastTimer {
  handle: ReturnType<typeof setTimeout>
  startedAt: number
  remaining: number
}

interface ToastState {
  toasts: ToastItem[]
  timers: Map<string, ToastTimer>
  addToast: (options: ToastOptions) => string
  removeToast: (id: string) => void
  pauseToast: (id: string) => void
  resumeToast: (id: string) => void
}

const MAX_TOASTS = 3
const AUTO_DISMISS_MS = 3000
const DEDUP_WINDOW_MS = 2000

let nextId = 0

function clearToastTimer(timers: Map<string, ToastTimer>, id: string): Map<string, ToastTimer> {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer.handle)
  const next = new Map(timers)
  next.delete(id)
  return next
}

export const useToastStore = create<ToastState>((set, get) => {
  const startTimer = (id: string, duration: number) => {
    if (duration <= 0) {
      get().removeToast(id)
      return
    }
    const handle = setTimeout(() => get().removeToast(id), duration)
    set((state) => ({
      timers: new Map(state.timers).set(id, {
        handle,
        startedAt: Date.now(),
        remaining: duration,
      }),
    }))
  }

  return {
    toasts: [],
    timers: new Map(),

    addToast: (options) => {
      const state = get()
      const now = Date.now()
      const type = options.type ?? 'info'
      const explicitId = options.id
      const existing = explicitId
        ? state.toasts.find((item) => item.id === explicitId)
        : state.toasts.find(
            (item) => item.message === options.message
              && item.type === type
              && now - item.createdAt < DEDUP_WINDOW_MS,
          )
      if (existing) return existing.id

      const id = explicitId ?? `toast-${++nextId}`
      const duration = options.duration === undefined
        ? (type === 'error' ? null : AUTO_DISMISS_MS)
        : options.duration
      const item: ToastItem = {
        id,
        title: options.title,
        message: options.message,
        type,
        duration,
        actions: options.actions ?? [],
        createdAt: now,
      }

      set((current) => {
        let toasts = [...current.toasts, item]
        let timers = current.timers
        if (toasts.length > MAX_TOASTS) {
          const removed = toasts.slice(0, toasts.length - MAX_TOASTS)
          for (const toast of removed) timers = clearToastTimer(timers, toast.id)
          toasts = toasts.slice(-MAX_TOASTS)
        }
        return { toasts, timers }
      })
      if (duration !== null) startTimer(id, duration)
      return id
    },

    removeToast: (id) => {
      set((state) => ({
        toasts: state.toasts.filter((item) => item.id !== id),
        timers: clearToastTimer(state.timers, id),
      }))
    },

    pauseToast: (id) => {
      set((state) => {
        const timer = state.timers.get(id)
        if (!timer) return state
        clearTimeout(timer.handle)
        const timers = new Map(state.timers)
        timers.set(id, {
          ...timer,
          remaining: Math.max(0, timer.remaining - (Date.now() - timer.startedAt)),
        })
        return { timers }
      })
    },

    resumeToast: (id) => {
      const timer = get().timers.get(id)
      if (!timer) return
      startTimer(id, timer.remaining)
    },
  }
})
