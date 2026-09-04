import { describe, expect, it } from 'vitest'
import { createMorphingContentMotion, createMorphingSurfaceMotion, createMorphingVisibilityMotion } from '@/components/common/useMorphingMotion'

const initial = { width: 30, height: 30, borderRadius: 10, padding: 0, left: 120, top: 80 }
const expanded = { width: 280, height: 140, borderRadius: 12, padding: 0, left: 220, top: 40 }

describe('useMorphingMotion helpers', () => {
  it('keeps layout properties explicit and uses the shared spring transition', () => {
    const motion = createMorphingSurfaceMotion(initial, expanded, false)

    expect(motion.initial).toEqual(initial)
    expect(motion.animate).toEqual(expanded)
    expect(motion.transition).toEqual({ type: 'spring', bounce: 0.05, duration: 0.32 })
  })

  it('animates content with opacity while keeping text content anchored', () => {
    const motion = createMorphingContentMotion(false, 'delayed')

    expect(motion.initial).toEqual({ opacity: 0, y: 0 })
    expect(motion.animate).toEqual({ opacity: 1, y: 0 })
    expect(motion.exit).toEqual({ opacity: 0, y: 0 })
    expect(motion.transition).toEqual({ duration: 0.2, delay: 0.06, ease: 'easeOut' })
    expect(motion.initial).not.toHaveProperty('scale')
    expect(motion.animate).not.toHaveProperty('scale')
    expect(motion.exit).not.toHaveProperty('scale')
  })

  it('scales the standard entry in place without shifting its anchor', () => {
    const motion = createMorphingContentMotion(false, 'standard')

    expect(motion.initial).toEqual({ opacity: 0, y: 0, scale: 0.86 })
    expect(motion.animate).toEqual({ opacity: 1, y: 0, scale: 1 })
    expect(motion.exit).toEqual({ opacity: 0, y: 0, scale: 0.96 })
  })

  it('uses the same shared transition when visibility toggles in either direction', () => {
    const entering = createMorphingVisibilityMotion(true, false)
    const leaving = createMorphingVisibilityMotion(false, false)

    expect(entering.transition).toEqual(leaving.transition)
    expect(entering.transition).toEqual({ type: 'spring', bounce: 0.05, duration: 0.32 })
    expect(entering.animate).toEqual({ opacity: 1 })
    expect(leaving.animate).toEqual({ opacity: 0 })
  })

  it('disables movement and timing when reduced motion is requested', () => {
    const surface = createMorphingSurfaceMotion(initial, expanded, true)
    const content = createMorphingContentMotion(true, 'delayed')
    const visibility = createMorphingVisibilityMotion(true, true)

    expect(surface.transition).toEqual({ duration: 0 })
    expect(content.initial).toEqual({ opacity: 0, y: 0 })
    expect(content.animate).toEqual({ opacity: 1, y: 0 })
    expect(content.exit).toEqual({ opacity: 0, y: 0 })
    expect(content.transition).toEqual({ duration: 0 })
    expect(visibility.transition).toEqual({ duration: 0 })
  })
})
