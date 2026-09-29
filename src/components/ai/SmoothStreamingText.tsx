import { useEffect, useRef, useState } from 'react'

// Presentation only: the chat store keeps the complete content for saving, tools and references.
export function SmoothStreamingText({ content }: { content: string }) {
  const [visible, setVisible] = useState(content)
  const visibleRef = useRef(content)
  const targetRef = useRef(content)
  const frameRef = useRef<number | null>(null)
  const framesRemainingRef = useRef(3)

  useEffect(() => {
    const show = (value: string) => {
      visibleRef.current = value
      setVisible(value)
    }
    const step = () => {
      frameRef.current = null
      const current = visibleRef.current
      const target = targetRef.current
      if (current === target) return
      const remaining = target.length - current.length
      let end = current.length + Math.max(1, Math.ceil(remaining / framesRemainingRef.current))
      framesRemainingRef.current = Math.max(1, framesRemainingRef.current - 1)
      if (end < target.length && /[\uD800-\uDBFF]/.test(target[end - 1])) end++
      show(target.slice(0, end))
      if (end < target.length) frameRef.current = requestAnimationFrame(step)
      else framesRemainingRef.current = 3
    }

    targetRef.current = content
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches
      || !content.startsWith(visibleRef.current)) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      framesRemainingRef.current = 3
      show(content)
    } else if (frameRef.current === null && content !== visibleRef.current) {
      frameRef.current = requestAnimationFrame(step)
    }
  }, [content])

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  return <span>{visible}</span>
}
