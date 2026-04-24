import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import { isBatchChildTransferId } from './transferBatch'
import type { TransferProgressPayload } from '../types/domain'

const pendingTransferWindowRequests = new Map<string, Promise<void>>()
const requestedTransferWindows = new Set<string>()

function isTauriRuntime() {
  return '__TAURI_INTERNALS__' in window
}

function transferWindowLabel(transferId: string) {
  return `transfer-${transferId.replace(/[^A-Za-z0-9:_-]/g, '-')}`
}

function transferWindowUrl(transferId: string) {
  return `/?transfer-window=1&transfer-id=${encodeURIComponent(transferId)}`
}

export function requestTransferWindow(item: TransferProgressPayload) {
  if (!isTauriRuntime()) {
    return
  }

  if (item.state === 'completed' || item.state === 'error') {
    return
  }

  if (item.purpose === 'drag-export') {
    return
  }

  if (isBatchChildTransferId(item.transferId)) {
    return
  }

  const label = transferWindowLabel(item.transferId)
  if (requestedTransferWindows.has(label)) {
    return
  }

  if (pendingTransferWindowRequests.has(label)) {
    return
  }

  requestedTransferWindows.add(label)
  const request = WebviewWindow.getByLabel(label)
    .then((existing) => {
      if (existing) {
        void existing.show()
        void existing.setFocus()
        return
      }

      const win = new WebviewWindow(label, {
        url: transferWindowUrl(item.transferId),
        title: `OpenXTerm Transfer - ${item.fileName}`,
        width: 540,
        height: 265,
        minWidth: 420,
        minHeight: 240,
        resizable: true,
        center: true,
        visible: true,
        focus: true,
        alwaysOnTop: true,
      })

      void win.once('tauri://created', () => {
        void win.show()
        void win.setFocus()
      })

      void win.once('tauri://error', () => {
        // The Rust side also tries to open this window, so a duplicate-label race is harmless.
      })
    })
    .catch(() => {
      requestedTransferWindows.delete(label)
      // Browser preview and permission failures should not break transfer execution.
    })
    .finally(() => {
      pendingTransferWindowRequests.delete(label)
    })

  pendingTransferWindowRequests.set(label, request)
}
