import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'

function TreeCollapseContent({ children, className, reducedMotion }: {
  children: ReactNode
  className?: string
  reducedMotion: boolean
}) {
  const isPresent = useIsPresent()
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.inert = !isPresent
  }, [isPresent])

  return (
    <motion.div
      ref={contentRef}
      className={className}
      initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
      animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
      exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
      transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
      aria-hidden={!isPresent}
    >
      {children}
    </motion.div>
  )
}

export function TreeCollapse({ open, children, className, reducedMotion }: {
  open: boolean
  children: ReactNode
  className?: string
  reducedMotion: boolean
}) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <TreeCollapseContent key="content" className={className} reducedMotion={reducedMotion}>
          {children}
        </TreeCollapseContent>
      )}
    </AnimatePresence>
  )
}
