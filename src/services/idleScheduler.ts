/**
 * 统一任务调度器 - 用于启动后的闲时预热任务
 *
 * 特性：
 * - requestIdleCallback + setTimeout fallback
 * - 超时兜底，避免任务长期不执行
 * - 逐个执行，主动让出主线程
 * - 支持优先级排序
 * - 支持任务提升优先级
 */

type TaskFn = () => Promise<void>

interface ScheduledTask {
  id: string
  fn: TaskFn
  priority: number
  label: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt?: number
  completedAt?: number
  error?: unknown
}

class IdleScheduler {
  private queue: ScheduledTask[] = []
  private isRunning = false
  private startedAt = 0
  private completionCallbacks = new Map<string, () => void>()

  /**
   * 添加任务到队列
   * @param id 任务唯一标识
   * @param fn 任务函数
   * @param priority 优先级（数字越小优先级越高）
   * @param label 任务标签（用于日志）
   */
  enqueue(id: string, fn: TaskFn, priority: number, label: string): void {
    // 如果已存在相同 ID 的任务，跳过
    if (this.queue.some(t => t.id === id)) {
      return
    }

    this.queue.push({
      id,
      fn,
      priority,
      label,
      status: 'pending',
    })

    // 按优先级排序
    this.queue.sort((a, b) => a.priority - b.priority)

    // 如果调度器未运行，启动它
    if (!this.isRunning) {
      this.start()
    }
  }

  /**
   * 提升任务优先级（用户提前使用时调用）
   */
  promote(id: string): void {
    const task = this.queue.find(t => t.id === id)
    if (task && task.status === 'pending') {
      task.priority = -1 // 最高优先级
      this.queue.sort((a, b) => a.priority - b.priority)
    }
  }

  /**
   * 等待指定任务完成
   */
  waitFor(id: string): Promise<void> {
    const task = this.queue.find(t => t.id === id)
    if (!task || task.status === 'completed') {
      return Promise.resolve()
    }
    if (task.status === 'failed') {
      return Promise.reject(task.error)
    }

    return new Promise<void>((resolve, reject) => {
      const existingCallback = this.completionCallbacks.get(id)
      if (existingCallback) {
        // 如果已有回调，包装一下
        const wrapped = () => {
          existingCallback()
          const t = this.queue.find(t => t.id === id)
          if (t?.status === 'failed') {
            reject(t.error)
          } else {
            resolve()
          }
        }
        this.completionCallbacks.set(id, wrapped)
      } else {
        this.completionCallbacks.set(id, () => {
          const t = this.queue.find(t => t.id === id)
          if (t?.status === 'failed') {
            reject(t.error)
          } else {
            resolve()
          }
        })
      }
    })
  }

  /**
   * 获取任务状态
   */
  getStatus(id: string): ScheduledTask['status'] | null {
    return this.queue.find(t => t.id === id)?.status ?? null
  }

  /**
   * 启动调度器
   */
  private async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    this.startedAt = performance.now()

    console.log('[IdleScheduler] 开始执行预热任务队列')

    while (this.queue.length > 0) {
      const task = this.queue.find(t => t.status === 'pending')
      if (!task) break

      task.status = 'running'
      task.startedAt = performance.now()

      try {
        await this.executeWithYield(task.fn)
        task.status = 'completed'
        task.completedAt = performance.now()
        console.log(`[IdleScheduler] ✓ ${task.label}: ${Math.round(task.completedAt - task.startedAt!)}ms`)
      } catch (error) {
        task.status = 'failed'
        task.error = error
        task.completedAt = performance.now()
        console.warn(`[IdleScheduler] ✗ ${task.label}: ${Math.round(task.completedAt - task.startedAt!)}ms`, error)
      }

      // 触发完成回调
      const callback = this.completionCallbacks.get(task.id)
      if (callback) {
        callback()
        this.completionCallbacks.delete(task.id)
      }

      // 任务完成后让出主线程，避免连续任务堆积
      await this.yieldToMain()
    }

    this.isRunning = false
    console.log(`[IdleScheduler] 所有预热任务完成，总耗时: ${Math.round(performance.now() - this.startedAt)}ms`)
  }

  /**
   * 执行任务并主动让出主线程
   */
  private async executeWithYield(fn: TaskFn): Promise<void> {
    // 等待浏览器空闲或超时（缩短超时时间，更频繁地让出主线程）
    await this.waitForIdle(200)
    // 执行任务
    await fn()
    // 执行后再次让出主线程
    await this.yieldToMain()
  }

  /**
   * 等待浏览器空闲
   */
  private waitForIdle(timeout = 200): Promise<void> {
    return new Promise<void>((resolve) => {
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => resolve(), { timeout })
      } else {
        // Fallback: 使用 setTimeout
        setTimeout(resolve, 0)
      }
    })
  }

  /**
   * 让出主线程（使用 MessageChannel 实现更精确的让出）
   */
  private yieldToMain(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (typeof MessageChannel !== 'undefined') {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          channel.port1.close()
          resolve()
        }
        channel.port2.postMessage(undefined)
      } else {
        setTimeout(resolve, 0)
      }
    })
  }
}

// 单例实例
export const idleScheduler = new IdleScheduler()

/**
 * 便捷函数：注册闲时任务
 */
export function scheduleIdleTask(
  id: string,
  fn: TaskFn,
  priority: number,
  label: string
): void {
  idleScheduler.enqueue(id, fn, priority, label)
}

/**
 * 便捷函数：提升任务优先级
 */
export function promoteTask(id: string): void {
  idleScheduler.promote(id)
}

/**
 * 便捷函数：等待任务完成
 */
export function waitForTask(id: string): Promise<void> {
  return idleScheduler.waitFor(id)
}
