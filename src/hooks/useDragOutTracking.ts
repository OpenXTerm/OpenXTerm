import { useCallback, type PointerEvent as ReactPointerEvent } from 'react'

type DragSource = 'row' | 'handle'

interface UseDragOutTrackingOptions<TItem, TElement extends HTMLElement> {
  canStart?: (item: TItem, event: ReactPointerEvent<TElement>, source: DragSource) => boolean
  minDistance?: number
  onStart: (
    item: TItem,
    event: ReactPointerEvent<TElement>,
    moveEvent: PointerEvent,
    source: DragSource,
  ) => void
  shouldIgnoreTarget?: (target: HTMLElement, item: TItem, source: DragSource) => boolean
}

function movedEnough(startX: number, startY: number, currentX: number, currentY: number, minDistance: number) {
  return Math.hypot(currentX - startX, currentY - startY) > minDistance
}

export function useDragOutTracking<TItem, TElement extends HTMLElement = HTMLElement>({
  canStart,
  minDistance = 5,
  onStart,
  shouldIgnoreTarget,
}: UseDragOutTrackingOptions<TItem, TElement>) {
  return useCallback((
    event: ReactPointerEvent<TElement>,
    item: TItem,
    source: DragSource = 'row',
  ) => {
    if (event.button !== 0 || canStart?.(item, event, source) === false) {
      return
    }

    const target = event.target as HTMLElement
    if (shouldIgnoreTarget?.(target, item, source)) {
      return
    }

    if (source === 'handle') {
      event.preventDefault()
      event.stopPropagation()
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Some webview edge cases do not allow capture after native drag starts.
    }

    const startX = event.clientX
    const startY = event.clientY
    const dragTarget = event.currentTarget
    const pointerId = event.pointerId
    let started = false
    const previousUserSelect = document.body.style.userSelect
    const previousWebkitUserSelect = document.body.style.webkitUserSelect

    document.body.style.userSelect = 'none'
    document.body.style.webkitUserSelect = 'none'
    window.getSelection()?.removeAllRanges()

    const cleanupDragListeners = () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
      document.body.style.userSelect = previousUserSelect
      document.body.style.webkitUserSelect = previousWebkitUserSelect
    }

    const releasePointerCapture = () => {
      try {
        dragTarget.releasePointerCapture(pointerId)
      } catch {
        // The pointer may already be released by the webview when native drag starts.
      }
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      window.getSelection()?.removeAllRanges()
      if (started || !movedEnough(startX, startY, moveEvent.clientX, moveEvent.clientY, minDistance)) {
        if (source === 'handle') {
          moveEvent.preventDefault()
          moveEvent.stopPropagation()
        }
        return
      }

      started = true
      cleanupDragListeners()
      releasePointerCapture()
      moveEvent.preventDefault()
      moveEvent.stopPropagation()
      onStart(item, event, moveEvent, source)
    }

    const handlePointerUp = (moveEvent: PointerEvent) => {
      if (source === 'handle') {
        moveEvent.preventDefault()
        moveEvent.stopPropagation()
      }
      releasePointerCapture()
      cleanupDragListeners()
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)
  }, [canStart, minDistance, onStart, shouldIgnoreTarget])
}
