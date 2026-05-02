import { useCallback, type PointerEvent as ReactPointerEvent } from 'react'

import { startNativeEntriesDrag } from '../../lib/bridge'
import {
  createBatchChildTransferId,
  createBatchTransferId,
  rememberBatchTransfer,
} from '../../lib/transferBatch'
import type { RemoteFileEntry, SessionDefinition } from '../../types/domain'
import { itemCountLabel, movedEnough } from './sftpUtils'

interface UseSftpNativeDragOutOptions {
  currentPath: string
  selectedSession: SessionDefinition | undefined
  selectedOrEntry: (entry: RemoteFileEntry) => RemoteFileEntry[]
  setMessage: (message: string) => void
  setSelectedEntryPaths: (paths: string[]) => void
}

export function useSftpNativeDragOut({
  currentPath,
  selectedSession,
  selectedOrEntry,
  setMessage,
  setSelectedEntryPaths,
}: UseSftpNativeDragOutOptions) {
  return useCallback((
    event: ReactPointerEvent<HTMLElement>,
    entry: RemoteFileEntry,
    source: 'row' | 'handle' = 'row',
  ) => {
    if (!selectedSession || event.button !== 0) {
      return
    }

    const target = event.target as HTMLElement
    if (source === 'row' && target.closest('button,input,textarea,select,a,[data-no-row-drag="true"]')) {
      return
    }

    if (source === 'handle') {
      event.preventDefault()
      event.stopPropagation()
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Some webview edge cases do not allow capture after the native drag starts.
    }

    const startX = event.clientX
    const startY = event.clientY
    let started = false
    const previousUserSelect = document.body.style.userSelect
    const previousWebkitUserSelect = document.body.style.webkitUserSelect
    const previousCursor = document.body.style.cursor

    document.body.style.userSelect = 'none'
    document.body.style.webkitUserSelect = 'none'
    document.body.style.cursor = 'grabbing'

    window.getSelection()?.removeAllRanges()

    const cleanupDragListeners = () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
      document.body.style.userSelect = previousUserSelect
      document.body.style.webkitUserSelect = previousWebkitUserSelect
      document.body.style.cursor = previousCursor
    }

    const startDrag = (moveEvent: PointerEvent) => {
      if (started) {
        return
      }

      started = true
      cleanupDragListeners()
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // The pointer may already be released by the webview when native drag starts.
      }
      moveEvent.preventDefault()
      moveEvent.stopPropagation()
      const dragEntries = selectedOrEntry(entry)
      setSelectedEntryPaths(dragEntries.map((item) => item.path))
      const batchTransferId = dragEntries.length > 1 ? createBatchTransferId('drag-export') : null
      if (batchTransferId) {
        const knownTotalBytes = dragEntries.every((item) => item.kind === 'file' && typeof item.sizeBytes === 'number')
          ? dragEntries.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)
          : undefined
        rememberBatchTransfer({
          transferId: batchTransferId,
          fileName: itemCountLabel(dragEntries.length),
          remotePath: currentPath,
          direction: 'download',
          purpose: 'drag-export',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: knownTotalBytes,
          itemCount: dragEntries.length,
          message: `Preparing ${dragEntries.length} items for drag copy`,
        })
      }
      void startNativeEntriesDrag(
        selectedSession,
        dragEntries.map((item, index) => ({
          remotePath: item.path,
          fileName: item.name,
          kind: item.kind,
          sizeBytes: item.sizeBytes,
          transferId: batchTransferId
            ? createBatchChildTransferId(batchTransferId, index, dragEntries.length)
            : undefined,
        })),
        moveEvent.clientX,
        moveEvent.clientY,
      )
        .then((dragStarted) => {
          if (!dragStarted) {
            setMessage('Native drag-out could not start for the selected item(s).')
          }
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : 'Native drag-out failed.')
        })
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      window.getSelection()?.removeAllRanges()
      if (started || !movedEnough(startX, startY, moveEvent.clientX, moveEvent.clientY)) {
        if (source === 'handle') {
          moveEvent.preventDefault()
          moveEvent.stopPropagation()
        }
        return
      }

      startDrag(moveEvent)
    }

    const handlePointerUp = (moveEvent: PointerEvent) => {
      if (source === 'handle') {
        moveEvent.preventDefault()
        moveEvent.stopPropagation()
      }
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // Some webview edge cases release capture before pointerup reaches this handler.
      }
      cleanupDragListeners()
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)
  }, [currentPath, selectedOrEntry, selectedSession, setMessage, setSelectedEntryPaths])
}
