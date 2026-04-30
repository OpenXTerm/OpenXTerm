import type { TransferProgressPayload } from '../types/domain'

const BATCH_CHILD_MARKER = '::item::'

const batchParents = new Map<string, TransferProgressPayload>()
const batchChildren = new Map<string, Map<string, TransferProgressPayload>>()

type BatchTransferPrefix = TransferProgressPayload['direction'] | 'drag-export'
type TransferPayloadDraft = Omit<TransferProgressPayload, 'transferId'>

interface QueueBatchTransfersOptions<T> {
  items: readonly T[]
  prefix: BatchTransferPrefix
  enqueueTransfer: (item: TransferProgressPayload) => void
  parent: (items: readonly T[]) => TransferPayloadDraft
  child: (item: T, index: number) => TransferPayloadDraft
}

export function createBatchTransferId(prefix: TransferProgressPayload['direction'] | 'drag-export') {
  return `${prefix}-batch-${crypto.randomUUID()}`
}

export function createBatchChildTransferId(parentId: string, index: number, total: number) {
  return `${parentId}${BATCH_CHILD_MARKER}${index + 1}of${total}`
}

export function parseBatchChildTransferId(transferId: string) {
  const markerIndex = transferId.lastIndexOf(BATCH_CHILD_MARKER)
  if (markerIndex < 0) {
    return null
  }

  const parentId = transferId.slice(0, markerIndex)
  const suffix = transferId.slice(markerIndex + BATCH_CHILD_MARKER.length)
  const match = /^(\d+)of(\d+)$/.exec(suffix)
  if (!parentId || !match) {
    return null
  }

  return {
    parentId,
    index: Number(match[1]) - 1,
    total: Number(match[2]),
  }
}

export function isBatchChildTransferId(transferId: string) {
  return parseBatchChildTransferId(transferId) !== null
}

export function rememberBatchTransfer(item: TransferProgressPayload) {
  if (typeof item.itemCount === 'number' && item.itemCount > 1) {
    batchParents.set(item.transferId, item)
  }
}

export function queueBatchTransfers<T>({
  items,
  prefix,
  enqueueTransfer,
  parent,
  child,
}: QueueBatchTransfersOptions<T>) {
  const batchTransferId = items.length > 1 ? createBatchTransferId(prefix) : null

  if (batchTransferId) {
    enqueueTransfer({
      ...parent(items),
      transferId: batchTransferId,
      itemCount: items.length,
    })
  }

  return items.map((item, index) => {
    const transferId = batchTransferId
      ? createBatchChildTransferId(batchTransferId, index, items.length)
      : `${prefix}-${crypto.randomUUID()}`

    if (!batchTransferId) {
      enqueueTransfer({
        ...child(item, index),
        transferId,
      })
    }

    return {
      item,
      transferId,
      batchTransferId,
    }
  })
}

export function hydrateBatchTransfers(items: Record<string, TransferProgressPayload>) {
  for (const item of Object.values(items)) {
    rememberBatchTransfer(item)
  }
}

export function aggregateBatchProgress(payload: TransferProgressPayload) {
  const parsed = parseBatchChildTransferId(payload.transferId)
  if (!parsed) {
    return null
  }

  const childMap = batchChildren.get(parsed.parentId) ?? new Map<string, TransferProgressPayload>()
  childMap.set(payload.transferId, payload)
  batchChildren.set(parsed.parentId, childMap)

  const children = [...childMap.values()]
  const parent = batchParents.get(parsed.parentId)
  const expectedItems = parent?.itemCount ?? parsed.total
  const completedChildren = children.filter((item) => item.state === 'completed')
  const errorChild = children.find((item) => item.state === 'error')
  const allKnownChildrenReported = childMap.size >= expectedItems
  const allCompleted = allKnownChildrenReported && completedChildren.length === expectedItems
  const hasRunningChild = children.some((item) => item.state === 'running')
  const hasStartedChild = children.some((item) => item.state !== 'queued')
  const knownChildTotals = children.map((item) => item.totalBytes).filter((value): value is number => typeof value === 'number')
  const parentTotal = typeof parent?.totalBytes === 'number'
    ? parent.totalBytes
    : knownChildTotals.length > 0
      ? knownChildTotals.reduce((sum, value) => sum + value, 0)
      : undefined
  const transferredBytes = Math.min(
    parentTotal ?? Number.MAX_SAFE_INTEGER,
    children.reduce((sum, item) => {
      if (item.state === 'completed' && typeof item.totalBytes === 'number') {
        return sum + item.totalBytes
      }
      return sum + item.transferredBytes
    }, 0),
  )
  const currentChild = children.find((item) => item.state === 'running') ?? children.at(-1) ?? payload
  const itemWord = expectedItems === 1 ? 'item' : 'items'
  const state = errorChild
    ? 'error'
    : allCompleted
      ? 'completed'
      : hasRunningChild || hasStartedChild
        ? 'running'
        : 'queued'

  const message = errorChild
    ? errorChild.message
    : state === 'completed'
      ? `${expectedItems} ${itemWord} complete`
      : `${completedChildren.length}/${expectedItems} ${itemWord}; ${currentChild.message}`

  return {
    transferId: parsed.parentId,
    fileName: parent?.fileName ?? `${expectedItems} ${itemWord}`,
    remotePath: parent?.remotePath ?? currentChild.remotePath,
    direction: parent?.direction ?? currentChild.direction,
    purpose: parent?.purpose ?? currentChild.purpose,
    state,
    transferredBytes,
    totalBytes: parentTotal,
    message,
    localPath: parent?.localPath,
    itemCount: expectedItems,
  } satisfies TransferProgressPayload
}
