/**
 * 单例 Promise 管理器 - 用于懒加载初始化
 *
 * 特性：
 * - 闲时提前加载
 * - 用户提前使用时复用同一任务
 * - 失败后允许重试
 * - 禁止重复初始化
 * - 支持优先级提升
 */

type InitFn<T> = () => Promise<T>

interface SingletonInstance<T> {
  promise: Promise<T> | null
  value: T | null
  error: unknown | null
  status: 'idle' | 'loading' | 'loaded' | 'failed'
  retryCount: number
  maxRetries: number
}

class SingletonPromiseManager {
  private instances = new Map<string, SingletonInstance<unknown>>()

  /**
   * 注册单例
   */
  register<T>(id: string, maxRetries = 2): void {
    if (!this.instances.has(id)) {
      this.instances.set(id, {
        promise: null,
        value: null,
        error: null,
        status: 'idle',
        retryCount: 0,
        maxRetries,
      })
    }
  }

  /**
   * 获取单例值（如果已加载）
   */
  get<T>(id: string): T | null {
    const instance = this.instances.get(id)
    return (instance?.value as T) ?? null
  }

  /**
   * 获取单例状态
   */
  getStatus(id: string): SingletonInstance<unknown>['status'] {
    return this.instances.get(id)?.status ?? 'idle'
  }

  /**
   * 检查是否已加载
   */
  isLoaded(id: string): boolean {
    return this.instances.get(id)?.status === 'loaded'
  }

  /**
   * 检查是否正在加载
   */
  isLoading(id: string): boolean {
    return this.instances.get(id)?.status === 'loading'
  }

  /**
   * 初始化单例（如果未初始化）
   * 如果已在加载中，复用同一 Promise
   */
  init<T>(id: string, fn: InitFn<T>): Promise<T> {
    let instance = this.instances.get(id) as SingletonInstance<T> | undefined

    if (!instance) {
      instance = {
        promise: null,
        value: null,
        error: null,
        status: 'idle',
        retryCount: 0,
        maxRetries: 2,
      }
      this.instances.set(id, instance)
    }

    // 如果已加载，直接返回
    if (instance.status === 'loaded' && instance.value !== null) {
      return Promise.resolve(instance.value)
    }

    // 如果正在加载，复用同一 Promise
    if (instance.status === 'loading' && instance.promise) {
      return instance.promise
    }

    // 如果之前失败且未超过重试次数，重试
    if (instance.status === 'failed' && instance.retryCount < instance.maxRetries) {
      console.log(`[Singleton] 重试初始化 ${id}，第 ${instance.retryCount + 1} 次`)
    }

    // 创建新的初始化任务
    instance.status = 'loading'
    instance.promise = (async () => {
      try {
        const startTime = performance.now()
        const value = await fn()
        const duration = Math.round(performance.now() - startTime)

        instance!.value = value
        instance!.status = 'loaded'
        instance!.error = null
        console.log(`[Singleton] ✓ ${id} 初始化完成: ${duration}ms`)

        return value
      } catch (error) {
        instance!.status = 'failed'
        instance!.error = error
        instance!.retryCount++
        instance!.promise = null // 允许重试
        console.warn(`[Singleton] ✗ ${id} 初始化失败 (第 ${instance!.retryCount} 次):`, error)
        throw error
      }
    })()

    return instance.promise
  }

  /**
   * 等待单例加载完成
   */
  async wait<T>(id: string): Promise<T | null> {
    const instance = this.instances.get(id) as SingletonInstance<T> | undefined
    if (!instance) return null

    if (instance.status === 'loaded') {
      return instance.value
    }

    if (instance.promise) {
      try {
        return await instance.promise
      } catch {
        return null
      }
    }

    return null
  }

  /**
   * 重置单例（允许重新初始化）
   */
  reset(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.promise = null
      instance.value = null
      instance.error = null
      instance.status = 'idle'
      instance.retryCount = 0
    }
  }

  /**
   * 获取所有单例的状态摘要
   */
  getSummary(): Record<string, { status: string; hasValue: boolean }> {
    const summary: Record<string, { status: string; hasValue: boolean }> = {}
    for (const [id, instance] of this.instances) {
      summary[id] = {
        status: instance.status,
        hasValue: instance.value !== null,
      }
    }
    return summary
  }
}

// 单例实例
export const singletonManager = new SingletonPromiseManager()

// 预定义的单例 ID
export const SINGLETON_IDS = {
  CHAT_AI: 'chat-ai',
  EMBEDDING_AI: 'embedding-ai',
  VECTOR_STORE: 'vector-store',
  MEMORIES: 'memories',
  CHAT_SESSIONS: 'chat-sessions',
  LEGACY_FILE_ACCESS: 'legacy-file-access',
  LEGACY_DATA_DETECTION: 'legacy-data-detection',
  AI_STATUS: 'ai-status',
} as const

// 注册所有单例
singletonManager.register(SINGLETON_IDS.CHAT_AI, 2)
singletonManager.register(SINGLETON_IDS.EMBEDDING_AI, 2)
singletonManager.register(SINGLETON_IDS.VECTOR_STORE, 1)
singletonManager.register(SINGLETON_IDS.MEMORIES, 1)
singletonManager.register(SINGLETON_IDS.CHAT_SESSIONS, 1)
singletonManager.register(SINGLETON_IDS.LEGACY_FILE_ACCESS, 1)
singletonManager.register(SINGLETON_IDS.LEGACY_DATA_DETECTION, 1)
singletonManager.register(SINGLETON_IDS.AI_STATUS, 1)
