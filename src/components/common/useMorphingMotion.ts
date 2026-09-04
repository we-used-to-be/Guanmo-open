import { useReducedMotion, type TargetAndTransition, type Transition } from 'motion/react'

export interface MorphingLayoutTarget {
  width: number
  height: number
  borderRadius: number
  padding: number
  left?: number
  top?: number
}

export type MorphingContentPreset = 'standard' | 'delayed'

export const MORPHING_MOTION_TOKENS = {
  surface: { type: 'spring' as const, bounce: 0.05, duration: 0.32 },
  content: { duration: 0.18, delay: 0, ease: 'easeOut' as const, enterY: 0, exitY: 0, enterScale: 0.86, exitScale: 0.96 },
  delayedContent: { duration: 0.2, delay: 0.06, ease: 'easeOut' as const, enterY: 0, exitY: 0 },
}

export interface MorphingSurfaceMotion {
  initial: TargetAndTransition
  animate: TargetAndTransition
  transition: Transition
}

export interface MorphingContentMotion {
  initial: TargetAndTransition
  animate: TargetAndTransition
  exit: TargetAndTransition
  transition: Transition
}

export interface MorphingVisibilityMotion {
  initial: TargetAndTransition
  animate: TargetAndTransition
  transition: Transition
}

function getInstantTransition(): Transition {
  return { duration: 0 }
}

export function createMorphingSurfaceMotion(
  initial: MorphingLayoutTarget,
  animate: MorphingLayoutTarget,
  reducedMotion: boolean,
): MorphingSurfaceMotion {
  return {
    initial: initial as TargetAndTransition,
    animate: animate as TargetAndTransition,
    transition: reducedMotion ? getInstantTransition() : MORPHING_MOTION_TOKENS.surface,
  }
}

export function createMorphingContentMotion(
  reducedMotion: boolean,
  preset: MorphingContentPreset = 'standard',
): MorphingContentMotion {
  const token = preset === 'delayed' ? MORPHING_MOTION_TOKENS.delayedContent : MORPHING_MOTION_TOKENS.content
  const scaleMotion = preset === 'standard'
    ? {
        initial: { scale: reducedMotion ? 1 : MORPHING_MOTION_TOKENS.content.enterScale },
        animate: { scale: 1 },
        exit: { scale: reducedMotion ? 1 : MORPHING_MOTION_TOKENS.content.exitScale },
      }
    : { initial: {}, animate: {}, exit: {} }
  return {
    initial: { opacity: 0, y: reducedMotion ? 0 : token.enterY, ...scaleMotion.initial },
    animate: { opacity: 1, y: 0, ...scaleMotion.animate },
    exit: { opacity: 0, y: reducedMotion ? 0 : token.exitY, ...scaleMotion.exit },
    transition: reducedMotion
      ? getInstantTransition()
      : { duration: token.duration, delay: token.delay, ease: token.ease },
  }
}

export function createMorphingVisibilityMotion(
  visible: boolean,
  reducedMotion: boolean,
): MorphingVisibilityMotion {
  const opacity = visible ? 1 : 0
  return {
    initial: { opacity },
    animate: { opacity },
    transition: reducedMotion ? getInstantTransition() : MORPHING_MOTION_TOKENS.surface,
  }
}

export function useMorphingMotion(
  initial: MorphingLayoutTarget,
  animate: MorphingLayoutTarget,
) {
  const reducedMotion = useReducedMotion() ?? false
  return {
    reducedMotion,
    surface: createMorphingSurfaceMotion(initial, animate, reducedMotion),
    content: (preset?: MorphingContentPreset) => createMorphingContentMotion(reducedMotion, preset),
  }
}
