import { aggregateBatchProgress, rememberBatchTransfer } from '../lib/transferBatch'
import { logOpenXTermError } from '../lib/errorLog'
import {
  mergeTransferProgress,
  normalizeTransferProgressPayload,
  readTransferQueueSnapshot,
  writeTransferQueueSnapshot,
} from '../lib/transferQueue'
import { requestTransferWindow } from '../lib/transferWindow'
import type { TransferProgressPayload } from '../types/domain'
import { sortTransfers } from './openXTermStoreHelpers'
import type { StoreSetter } from './openXTermStoreTypes'

let transferFlushScheduled = false
const pendingTransferPayloads = new Map<string, TransferProgressPayload>()
const loggedTransferErrors = new Map<string, string>()

export function scheduleTransferFlush(set: StoreSetter, payload: TransferProgressPayload) {
  const pendingPayload = pendingTransferPayloads.get(payload.transferId)
  pendingTransferPayloads.set(payload.transferId, mergeTransferProgress(pendingPayload, payload))

  if (transferFlushScheduled) {
    return
  }

  transferFlushScheduled = true
  window.requestAnimationFrame(() => {
    transferFlushScheduled = false
    const payloads = [...pendingTransferPayloads.values()]
    pendingTransferPayloads.clear()

    set((state) => {
      let changed = false
      const nextTransfers = {
        ...state.transferItems,
        ...readTransferQueueSnapshot(),
      }

      for (const item of payloads) {
        const mergedTransfer = mergeTransferProgress(nextTransfers[item.transferId], item)
        if (nextTransfers[item.transferId] !== mergedTransfer) {
          nextTransfers[item.transferId] = mergedTransfer
          changed = true
        }
      }

      if (!changed) {
        return state
      }

      const transferItems = sortTransfers(nextTransfers)
      writeTransferQueueSnapshot(transferItems)
      return {
        transferItems,
        transferModalDismissed: false,
      }
    })
  })
}

export function handleTransferProgress(set: StoreSetter, payload: TransferProgressPayload) {
  const normalizedPayload = normalizeTransferProgressPayload(payload)
  const aggregatePayload = aggregateBatchProgress(normalizedPayload)
  const transferPayload = aggregatePayload ?? normalizedPayload
  if (transferPayload.state === 'error') {
    const signature = `${transferPayload.message}|${transferPayload.remotePath}|${transferPayload.localPath ?? ''}`
    if (loggedTransferErrors.get(transferPayload.transferId) !== signature) {
      loggedTransferErrors.set(transferPayload.transferId, signature)
      logOpenXTermError('transfer.progress', transferPayload.message, {
        transferId: transferPayload.transferId,
        fileName: transferPayload.fileName,
        remotePath: transferPayload.remotePath,
        localPath: transferPayload.localPath,
        direction: transferPayload.direction,
        purpose: transferPayload.purpose,
      })
    }
  } else if (transferPayload.state === 'completed' || transferPayload.state === 'canceled') {
    loggedTransferErrors.delete(transferPayload.transferId)
  }
  if (aggregatePayload) {
    scheduleTransferFlush(set, normalizedPayload)
  }
  scheduleTransferFlush(set, transferPayload)
  requestTransferWindow(transferPayload)
}

export function enqueueTransferItem(set: StoreSetter, item: TransferProgressPayload) {
  rememberBatchTransfer(item)
  set((state) => {
    const mergedTransfer = mergeTransferProgress(state.transferItems[item.transferId], item)
    if (state.transferItems[item.transferId] === mergedTransfer) {
      requestTransferWindow(mergedTransfer)
      return state
    }

    const transferItems = sortTransfers({
      ...state.transferItems,
      [item.transferId]: mergedTransfer,
    })
    writeTransferQueueSnapshot(transferItems)
    requestTransferWindow(mergedTransfer)
    return {
      transferItems,
      transferModalDismissed: false,
    }
  })
}

export function clearCompletedTransferItems(set: StoreSetter) {
  set((state) => {
    const transferItems = Object.fromEntries(
      Object.entries(state.transferItems).filter(([, item]) => item.state === 'queued' || item.state === 'running'),
    )
    writeTransferQueueSnapshot(transferItems)
    return {
      transferItems,
      transferModalDismissed: false,
    }
  })
}
