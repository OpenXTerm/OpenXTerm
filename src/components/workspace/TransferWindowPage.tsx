import { useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { listenTransferProgress } from '../../lib/bridge'
import { aggregateBatchProgress, hydrateBatchTransfers } from '../../lib/transferBatch'
import { mergeTransferProgress, readTransferQueueSnapshot, writeTransferQueueSnapshot } from '../../lib/transferQueue'
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

      const transferPayload = aggregateBatchProgress(payload) ?? payload
      const pendingItem = pendingItemsRef.current.get(transferPayload.transferId)
      pendingItemsRef.current.set(transferPayload.transferId, mergeTransferProgress(pendingItem, transferPayload))

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

    return sorted.filter((item) => item.transferId === transferId)
  }, [items, transferId])
  const activeItem = transferId ? items[transferId] : null

  useEffect(() => {
    if (!activeItem || activeItem.state !== 'completed') {
      return
    }

    const closeTimer = window.setTimeout(() => {
      closeCurrentTransferWindow()
    }, 900)

    return () => window.clearTimeout(closeTimer)
  }, [activeItem])

  return (
    <div className="transfer-window-page">
      <TransferProgressModal
        items={orderedItems}
        open
        embedded
        onClose={() => {
          closeCurrentTransferWindow()
        }}
      />
    </div>
  )
}
