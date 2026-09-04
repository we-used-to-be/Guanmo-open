interface HeadingScrollOptions {
  container: HTMLElement
  fadeElement?: HTMLElement | null
  getTargetTop: () => number | undefined
  forceDirect?: boolean
  onBeforeReveal?: () => void
  onSettled?: () => void
}

const HEADING_SCROLL_SETTLE_MS = 180
const HEADING_SCROLL_FALLBACK_MS = 1000
const HEADING_JUMP_FADE_OUT_MS = 100
const HEADING_JUMP_FADE_IN_MS = 160
const HEADING_JUMP_MIN_DISTANCE = 1200
const HEADING_JUMP_VIEWPORTS = 7
const HEADING_JUMP_CORRECTION_FRAMES = 2

export function startHeadingScroll({
  container,
  fadeElement,
  getTargetTop,
  forceDirect = false,
  onBeforeReveal,
  onSettled,
}: HeadingScrollOptions): (() => void) | null {
  const initialTarget = getTargetTop()
  if (typeof initialTarget !== 'number') return null

  const clampTarget = (top: number) => {
    const normalized = Math.max(0, top)
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
    return maxTop > 0 ? Math.min(normalized, maxTop) : normalized
  }
  const targetTop = clampTarget(initialTarget)
  if (Math.abs(targetTop - container.scrollTop) < 1) {
    onBeforeReveal?.()
    onSettled?.()
    return null
  }

  let terminalFrame: number | null = null
  let phaseTimer: number | null = null
  let nativeSettled = false
  let terminalStartedAt: number | null = null
  let terminalStartTop = container.scrollTop
  let active = true
  const originalFadeStyles = fadeElement ? {
    opacity: fadeElement.style.opacity,
    transition: fadeElement.style.transition,
  } : null

  const cleanup = () => {
    if (!active) return
    active = false
    if (terminalFrame !== null) window.cancelAnimationFrame(terminalFrame)
    if (phaseTimer !== null) window.clearTimeout(phaseTimer)
    terminalFrame = null
    phaseTimer = null
    container.removeEventListener('scrollend', startTerminalSettle)
    container.removeEventListener('wheel', cleanup)
    container.removeEventListener('pointerdown', cleanup)
    container.removeEventListener('touchstart', cleanup)
    if (fadeElement && originalFadeStyles) {
      fadeElement.style.opacity = originalFadeStyles.opacity
      fadeElement.style.transition = originalFadeStyles.transition
    }
  }
  const finish = () => {
    cleanup()
    onSettled?.()
  }
  const runTerminalSettle = (time: number) => {
    terminalFrame = null
    if (!active) return
    const latestTarget = getTargetTop()
    if (typeof latestTarget !== 'number') {
      cleanup()
      return
    }
    if (terminalStartedAt === null) {
      terminalStartedAt = time
      terminalStartTop = container.scrollTop
    }
    const completion = Math.min(1, (time - terminalStartedAt) / HEADING_SCROLL_SETTLE_MS)
    const easedCompletion = 1 - Math.pow(1 - completion, 3)
    container.scrollTop = terminalStartTop + (clampTarget(latestTarget) - terminalStartTop) * easedCompletion
    if (completion < 1) {
      terminalFrame = window.requestAnimationFrame(runTerminalSettle)
      return
    }
    cleanup()
    onBeforeReveal?.()
    onSettled?.()
  }
  function startTerminalSettle() {
    if (!active || nativeSettled) return
    nativeSettled = true
    container.removeEventListener('scrollend', startTerminalSettle)
    if (phaseTimer !== null) window.clearTimeout(phaseTimer)
    phaseTimer = null
    terminalFrame = window.requestAnimationFrame(runTerminalSettle)
  }

  container.addEventListener('wheel', cleanup, { passive: true })
  container.addEventListener('pointerdown', cleanup)
  container.addEventListener('touchstart', cleanup, { passive: true })

  const distance = Math.abs(targetTop - container.scrollTop)
  const longJumpThreshold = Math.max(HEADING_JUMP_MIN_DISTANCE, container.clientHeight * HEADING_JUMP_VIEWPORTS)
  const reduceMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (fadeElement && (forceDirect || distance > longJumpThreshold) && !reduceMotion) {
    fadeElement.style.transition = `opacity ${HEADING_JUMP_FADE_OUT_MS}ms ease-out`
    fadeElement.style.opacity = '0'
    phaseTimer = window.setTimeout(() => {
      phaseTimer = null
      if (!active) return
      container.scrollTop = targetTop
      let correctionFrames = 0
      const correctAndReveal = () => {
        terminalFrame = null
        if (!active) return
        const latestTarget = getTargetTop()
        if (typeof latestTarget !== 'number') {
          cleanup()
          return
        }
        container.scrollTop = clampTarget(latestTarget)
        correctionFrames += 1
        if (correctionFrames < HEADING_JUMP_CORRECTION_FRAMES) {
          terminalFrame = window.requestAnimationFrame(correctAndReveal)
          return
        }
        onBeforeReveal?.()
        fadeElement.style.transition = `opacity ${HEADING_JUMP_FADE_IN_MS}ms ease-in`
        fadeElement.style.opacity = '1'
        phaseTimer = window.setTimeout(finish, HEADING_JUMP_FADE_IN_MS)
      }
      terminalFrame = window.requestAnimationFrame(correctAndReveal)
    }, HEADING_JUMP_FADE_OUT_MS)
    return cleanup
  }

  if (reduceMotion && distance > longJumpThreshold) {
    container.scrollTop = targetTop
    onBeforeReveal?.()
    finish()
    return null
  }

  container.addEventListener('scrollend', startTerminalSettle)
  phaseTimer = window.setTimeout(startTerminalSettle, HEADING_SCROLL_FALLBACK_MS)
  container.scrollTo({ top: targetTop, behavior: 'smooth' })
  return cleanup
}
