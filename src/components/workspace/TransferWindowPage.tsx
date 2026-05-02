import { useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { cancelTransfer, listenTransferProgress, retryTransfer } from '../../lib/bridge'
import { aggregateBatchProgress, hydrateBatchTransfers } from '../../lib/transferBatch'
import {
  TRANSFER_RETRY_MESSAGE,
  mergeTransferProgress,
  normalizeTransferProgressPayload,
  readTransferQueueSnapshot,
  writeTransferQueueSnapshot,
} from '../../lib/transferQueue'
import type { TransferProgressPayload } from '../../types/domain'
import { TransferProgressModal } from './TransferProgressModal'

function sortTransfers(items: Record<string, TransferProgressPayload>) {
  return Object.values(items).sort((left, right) => left.fileName.localeCompare(right.fileName))
}

function closeCurrentTransferWindow() {
  void getCurrentWindow().close().catch(() => {
    // Missing permissions or a closing race should not surface as an unhandled rejection.
  })
}

export function TransferWindowPage() {
  const transferId = new URLSearchParams(window.location.search).get('transfer-id')
  const pendingItemsRef = useRef(new Map<string, TransferProgressPayload>())
  const flushFrameRef = useRef<number | null>(null)
  const [items, setItems] = useState<Record<string, TransferProgressPayload>>(() => {
    const snapshot = readTransferQueueSnapshot()
    hydrateBatchTransfers(snapshot)
    return snapshot
  })

  useEffect(() => {
    let disposed = false
    let unlistenTransfer: (() => void) | null = null

    function handleStorage(event: StorageEvent) {
      if (event.key === 'openxterm.transfer.queue') {
        const snapshot = readTransferQueueSnapshot()
        hydrateBatchTransfers(snapshot)
        setItems(snapshot)
      }
    }

    window.addEventListener('storage', handleStorage)

    function flushPendingItems() {
      flushFrameRef.current = null
      const pendingItems = [...pendingItemsRef.current.values()]
      pendingItemsRef.current.clear()

      if (pendingItems.length === 0 || disposed) {
        return
      }

      setItems((current) => {
        let changed = false
        const next = { ...current }

        for (const item of pendingItems) {
          const mergedTransfer = mergeTransferProgress(next[item.transferId], item)
          if (next[item.transferId] !== mergedTransfer) {
            next[item.transferId] = mergedTransfer
            changed = true
          }
        }

        if (!changed) {
          return current
        }

        writeTransferQueueSnapshot(next)
        return next
      })
    }

    void listenTransferProgress((payload) => {
      if (disposed) {
        return
      }

      const normalizedPayload = normalizeTransferProgressPayload(payload)
      const aggregatePayload = aggregateBatchProgress(normalizedPayload)
      const transferPayloads = aggregatePayload ? [normalizedPayload, aggregatePayload] : [normalizedPayload]
      for (const transferPayload of transferPayloads) {
        const pendingItem = pendingItemsRef.current.get(transferPayload.transferId)
        pendingItemsRef.current.set(transferPayload.transferId, mergeTransferProgress(pendingItem, transferPayload))
      }

      if (flushFrameRef.current === null) {
        flushFrameRef.current = window.requestAnimationFrame(flushPendingItems)
      }
    }).then((dispose) => {
      if (disposed) {
        return
      }
      unlistenTransfer = dispose
    })

    return () => {
      disposed = true
      window.removeEventListener('storage', handleStorage)
      if (flushFrameRef.current !== null) {
        window.cancelAnimationFrame(flushFrameRef.current)
      }
      unlistenTransfer?.()
    }
  }, [])

  const orderedItems = useMemo(() => {
    const sorted = sortTransfers(items)
    if (!transferId) {
      return sorted
    }

    return sorted.filter((item) => {
      if (item.transferId === transferId) {
        return true
      }

      return item.transferId.startsWith(`${transferId}::item::`) && (item.state === 'error' || item.state === 'canceled')
    })
  }, [items, transferId])
  const allItemsFinished = orderedItems.length > 0
    && orderedItems.every((item) => item.state === 'completed' || item.state === 'canceled')

  useEffect(() => {
    if (!allItemsFinished) {
      return
    }

    const closeTimer = window.setTimeout(() => {
      closeCurrentTransferWindow()
    }, 2000)

    return () => window.clearTimeout(closeTimer)
  }, [allItemsFinished])

  function handleCancelTransfer(item: TransferProgressPayload) {
    void cancelTransfer(item.transferId)
    setItems((current) => {
      const next = {
        ...current,
        [item.transferId]: mergeTransferProgress(current[item.transferId], {
          ...item,
          state: 'canceled',
          message: 'Cancel requested',
          retryable: false,
        }),
      }
      writeTransferQueueSnapshot(next)
      return next
    })
  }

  function handleRetryTransfer(item: TransferProgressPayload) {
    if (item.retryable !== true || item.state !== 'error') {
      return
    }

    setItems((current) => {
      const next = {
        ...current,
        [item.transferId]: {
          ...item,
          state: 'queued',
          transferredBytes: 0,
          message: TRANSFER_RETRY_MESSAGE,
          retryable: false,
        } satisfies TransferProgressPayload,
      }
      writeTransferQueueSnapshot(next)
      return next
    })

    void retryTransfer(item.transferId).catch((error) => {
      setItems((current) => {
        const next = {
          ...current,
          [item.transferId]: mergeTransferProgress(current[item.transferId], {
            ...item,
            state: 'error',
            transferredBytes: 0,
            message: error instanceof Error ? error.message : 'Unable to retry transfer.',
            retryable: item.retryable,
          }),
        }
        writeTransferQueueSnapshot(next)
        return next
      })
    })
  }

  return (
    <div className="transfer-window-page">
      <TransferProgressModal
        items={orderedItems}
        open
        embedded
        onCancel={handleCancelTransfer}
        onRetry={handleRetryTransfer}
        onClose={() => {
          closeCurrentTransferWindow()
        }}
      />
    </div>
  )
}
