import { useCallback, type PointerEvent as ReactPointerEvent } from 'react'

import { startNativeEntriesDrag } from '../../lib/bridge'
import {
  createBatchChildTransferId,
  createBatchTransferId,
  rememberBatchTransfer,
} from '../../lib/transferBatch'
import { useDragOutTracking } from '../../hooks/useDragOutTracking'
import type { RemoteFileEntry, SessionDefinition } from '../../types/domain'
import { itemCountLabel } from './sftpUtils'

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
  const startDrag = useCallback((entry: RemoteFileEntry, _event: ReactPointerEvent<HTMLElement>, moveEvent: PointerEvent) => {
    if (!selectedSession) {
      return
    }

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
  }, [currentPath, selectedOrEntry, selectedSession, setMessage, setSelectedEntryPaths])

  return useDragOutTracking<RemoteFileEntry, HTMLElement>({
    canStart: () => Boolean(selectedSession),
    onStart: startDrag,
    shouldIgnoreTarget: (target, _entry, source) =>
      source === 'row' && Boolean(target.closest('button,input,textarea,select,a,[data-no-row-drag="true"]')),
  })
}
