import type { TransferProgressPayload } from '../types/domain'

const TRANSFER_QUEUE_STORAGE_KEY = 'openxterm.transfer.queue'

const transferStateRank: Record<TransferProgressPayload['state'], number> = {
  queued: 0,
  running: 1,
  completed: 2,
  canceled: 2,
  error: 2,
}

export const TRANSFER_RETRY_MESSAGE = 'Retrying transfer'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTransferProgressPayload(value: unknown): value is TransferProgressPayload {
  if (!isRecord(value)) {
    return false
  }

  return typeof value.transferId === 'string'
    && typeof value.fileName === 'string'
    && typeof value.remotePath === 'string'
    && (value.direction === 'download' || value.direction === 'upload')
    && (value.purpose === 'drag-export' || value.purpose === 'download' || value.purpose === 'upload')
    && (
      value.state === 'queued'
      || value.state === 'running'
      || value.state === 'completed'
      || value.state === 'canceled'
      || value.state === 'error'
    )
    && typeof value.transferredBytes === 'number'
    && (value.totalBytes === undefined || typeof value.totalBytes === 'number')
    && typeof value.message === 'string'
    && (value.localPath === undefined || typeof value.localPath === 'string')
    && (value.itemCount === undefined || typeof value.itemCount === 'number')
    && (value.retryable === undefined || typeof value.retryable === 'boolean')
}

function isTransferProgressRecord(value: unknown): value is Record<string, TransferProgressPayload> {
  return isRecord(value)
    && Object.entries(value).every(([key, item]) => isTransferProgressPayload(item) && key === item.transferId)
}

export function readTransferQueueSnapshot(): Record<string, TransferProgressPayload> {
  try {
    const raw = localStorage.getItem(TRANSFER_QUEUE_STORAGE_KEY)
    if (!raw) {
      return {}
    }

    const parsed: unknown = JSON.parse(raw)
    if (!isTransferProgressRecord(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([transferId, item]) => [transferId, normalizeTransferProgressPayload(item)]),
    )
  } catch {
    return {}
  }
}

export function writeTransferQueueSnapshot(items: Record<string, TransferProgressPayload>) {
  localStorage.setItem(TRANSFER_QUEUE_STORAGE_KEY, JSON.stringify(items))
}

export function normalizeTransferProgressPayload(item: TransferProgressPayload): TransferProgressPayload {
  if (item.state === 'error' && item.message === 'Transfer canceled' && item.retryable !== true) {
    return {
      ...item,
      state: 'canceled',
      message: 'Canceled',
      retryable: false,
    }
  }

  return item
}

export function isTransferCanceledError(error: unknown) {
  return error instanceof Error
    ? error.message === 'Transfer canceled'
    : String(error) === 'Transfer canceled'
}

function sameTransferProgress(left: TransferProgressPayload, right: TransferProgressPayload) {
  return left.transferId === right.transferId
    && left.fileName === right.fileName
    && left.remotePath === right.remotePath
    && left.direction === right.direction
    && left.purpose === right.purpose
    && left.state === right.state
    && left.transferredBytes === right.transferredBytes
    && left.totalBytes === right.totalBytes
    && left.message === right.message
    && left.localPath === right.localPath
    && left.itemCount === right.itemCount
    && left.retryable === right.retryable
}

export function mergeTransferProgress(
  existing: TransferProgressPayload | undefined,
  incoming: TransferProgressPayload,
) {
  incoming = normalizeTransferProgressPayload(incoming)

  if (!existing) {
    return incoming
  }

  const incomingIsOlderState = transferStateRank[incoming.state] < transferStateRank[existing.state]
  const incomingStartsRetry = incoming.state === 'queued' && incoming.message === TRANSFER_RETRY_MESSAGE
  const shouldKeepExistingState = !incomingStartsRetry && (
    incomingIsOlderState
    || (incoming.state === 'queued' && existing.state !== 'queued')
    || (existing.state === 'error' && incoming.state !== 'error')
    || (existing.state === 'canceled' && incoming.state !== 'canceled')
  )
  const totalBytes = typeof existing.totalBytes === 'number' && typeof incoming.totalBytes === 'number'
    ? Math.max(existing.totalBytes, incoming.totalBytes)
    : existing.totalBytes ?? incoming.totalBytes
  const transferredBytes = Math.max(existing.transferredBytes, incoming.transferredBytes)

  const merged = {
    ...incoming,
    state: shouldKeepExistingState ? existing.state : incoming.state,
    transferredBytes,
    totalBytes,
    message: shouldKeepExistingState ? existing.message : incoming.message,
    localPath: incoming.localPath ?? existing.localPath,
    itemCount: incoming.itemCount ?? existing.itemCount,
    retryable: incoming.retryable ?? existing.retryable,
  } satisfies TransferProgressPayload

  return sameTransferProgress(existing, merged) ? existing : merged
}
