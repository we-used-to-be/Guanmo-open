import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useEditorStore } from '@/stores/editorStore'

/** A visual copy only: no second preview instance, handlers, model or highlight registry. */
export function usePreviewSwitchSnapshot(
  containerRef: RefObject<HTMLDivElement>,
  documentKey: string | undefined,
  enabled: boolean,
  masked: boolean,
) {
  const snapshotRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const clear = () => {
      snapshotRef.current?.remove()
      snapshotRef.current = null
    }
    const unsubscribe = useEditorStore.subscribe((state, previous) => {
      if (state.viewMode !== 'preview' || !state.activeTabId) {
        clear()
        return
      }
      if (previous.viewMode !== 'preview' || state.activeTabId === previous.activeTabId) return
      // During A → B → C keep A until C is ready; B may still be masked.
      if (snapshotRef.current) return
      const source = containerRef.current
      if (!source?.parentElement || source.style.visibility === 'hidden'
        || source.hasAttribute('data-preview-masked') || !source.querySelector('.gm-markdown-preview')) return

      const snapshot = document.createElement('div')
      snapshot.dataset.previewSwitchSnapshot = ''
      snapshot.setAttribute('aria-hidden', 'true')
      snapshot.setAttribute('inert', '')
      Object.assign(snapshot.style, {
        position: 'absolute', left: `${source.offsetLeft}px`, top: `${source.offsetTop}px`,
        width: `${source.offsetWidth}px`, height: `${source.offsetHeight}px`,
        overflow: 'hidden', zIndex: '1', userSelect: 'none',
      })
      const copy = source.cloneNode(true) as HTMLDivElement
      copy.removeAttribute('data-product-tour')
      const style = getComputedStyle(source)
      Object.assign(copy.style, {
        width: '100%', height: '100%', boxSizing: 'border-box',
        padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
        pointerEvents: 'none',
      })
      // Isolate SVG definitions and heading IDs from the incoming document.
      const ids = new Map<string, string>()
      copy.querySelectorAll('[id]').forEach((element, index) => {
        const id = `gm-switch-snapshot-${index}`
        ids.set(element.id, id)
        element.id = id
      })
      const rewriteUrls = (value: string) => value.replace(/url\(\s*(['"]?)#([^\s)'" ]+)\1\s*\)/g,
        (match, _quote: string, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : match)
      copy.querySelectorAll('*').forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
          if (!attribute.value.includes('#')) continue
          const id = attribute.value.slice(1)
          const value = (attribute.localName === 'href' && attribute.value.startsWith('#') && ids.has(id))
            ? `#${ids.get(id)}` : rewriteUrls(attribute.value)
          element.setAttribute(attribute.name, value)
        }
        if (element.tagName.toLowerCase() === 'style') {
          element.textContent = rewriteUrls(element.textContent ?? '').replace(/([^{}]+)\{/g, (match, selector: string) => {
            return `${selector.replace(/#([\w:-]+)/g, (idSelector, id: string) => ids.has(id) ? `#${ids.get(id)}` : idSelector)}{`
          })
        }
      })
      snapshot.append(copy)
      source.parentElement.append(snapshot)
      copy.scrollTop = source.scrollTop
      copy.scrollLeft = source.scrollLeft
      // cloneNode does not preserve nested scroll offsets or chart canvas pixels.
      const originals = source.querySelectorAll<HTMLElement>('*')
      copy.querySelectorAll<HTMLElement>('*').forEach((element, index) => {
        const original = originals[index]
        if (original.scrollTop) element.scrollTop = original.scrollTop
        if (original.scrollLeft) element.scrollLeft = original.scrollLeft
        if (original instanceof HTMLCanvasElement && element instanceof HTMLCanvasElement
          && original.width && original.height) {
          // A lost chart context must not abort the store's switch notification.
          try { element.getContext('2d')?.drawImage(original, 0, 0) } catch { /* Incoming preview still renders normally. */ }
        }
      })
      snapshotRef.current = snapshot
    })
    return () => {
      unsubscribe()
      clear()
    }
  }, [containerRef])

  useLayoutEffect(() => {
    if (enabled && masked) return
    snapshotRef.current?.remove()
    snapshotRef.current = null
  }, [documentKey, enabled, masked])
}
