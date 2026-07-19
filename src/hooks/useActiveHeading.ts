import { useEffect, useRef, useState } from 'react'

/**
 * 使用 IntersectionObserver 监听标题元素可见性
 * 返回当前在视口中"活跃"的标题 ID
 *
 * @param containerRef - 滚动容器的 ref
 * @param headingSelector - 标题元素的选择器
 * @param trigger - 额外的触发依赖，当容器可能变化时传入（如 viewMode）
 */
export function useActiveHeading(
  containerRef: React.RefObject<HTMLElement | null>,
  headingSelector: string = '[data-heading-id]',
  trigger?: unknown,
  enabled: boolean = true
): string | null {
  const [activeId, setActiveId] = useState<string | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const headingPositionsRef = useRef<Map<string, number>>(new Map())
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    // 清理旧的 observer
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    setActiveId(null)

    const headingPositions = headingPositionsRef.current
    headingPositions.clear()

    if (!enabled) return

    // 使用 rAF 循环检测容器是否已挂载
    let disposed = false

    const tryObserve = () => {
      if (disposed) return

      const container = containerRef.current
      if (!container) {
        // 容器还没挂载，下一帧再试
        rafRef.current = requestAnimationFrame(tryObserve)
        return
      }

      // 创建 IntersectionObserver
      observerRef.current = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const id = entry.target.getAttribute('data-heading-id')
            if (!id) return

            if (entry.isIntersecting) {
              headingPositions.set(id, entry.boundingClientRect.top)
            } else {
              headingPositions.delete(id)
            }
          })

          // 选择最靠近视口顶部的标题
          if (headingPositions.size > 0) {
            let closestId: string | null = null
            let closestTop = -Infinity

            headingPositions.forEach((top, id) => {
              if (top >= 0 && (closestId === null || top < closestTop)) {
                closestTop = top
                closestId = id
              }
            })

            if (closestId === null) {
              let minDistance = Infinity
              headingPositions.forEach((top, id) => {
                const distance = Math.abs(top)
                if (distance < minDistance) {
                  minDistance = distance
                  closestId = id
                }
              })
            }

            setActiveId(closestId)
          }
        },
        {
          root: container,
          // 触发区域：顶部 0% 到底部 50%
          rootMargin: '0px 0px -50% 0px',
          threshold: 0,
        }
      )

      // 观察所有标题元素
      const headings = container.querySelectorAll(headingSelector)
      headings.forEach((heading) => {
        observerRef.current?.observe(heading)
      })
    }

    tryObserve()

    return () => {
      disposed = true
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }
      headingPositions.clear()
    }
  }, [containerRef, headingSelector, trigger, enabled])

  return activeId
}
