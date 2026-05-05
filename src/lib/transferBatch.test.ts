import { describe, expect, it } from 'vitest'

import type { TransferProgressPayload } from '../types/domain'
import {
  aggregateBatchProgress,
  createBatchChildTransferId,
  isBatchChildTransferId,
  parseBatchChildTransferId,
  rememberBatchTransfer,
} from './transferBatch'

function transfer(overrides: Partial<TransferProgressPayload>): TransferProgressPayload {
  return {
    transferId: 'transfer-test',
    fileName: 'file.txt',
    remotePath: '/tmp/file.txt',
    direction: 'upload',
    purpose: 'upload',
    state: 'queued',
    transferredBytes: 0,
    message: 'Queued',
    ...overrides,
  }
}

describe('transferBatch', () => {
  it('parses batch child transfer ids', () => {
    const childId = createBatchChildTransferId('upload-batch-test', 1, 3)

    expect(childId).toBe('upload-batch-test::item::2of3')
    expect(isBatchChildTransferId(childId)).toBe(true)
    expect(parseBatchChildTransferId(childId)).toEqual({
      parentId: 'upload-batch-test',
      index: 1,
      total: 3,
    })
    expect(parseBatchChildTransferId('upload-standalone')).toBeNull()
    expect(parseBatchChildTransferId('upload-batch-test::item::nope')).toBeNull()
  })

  it('aggregates child progress into a parent transfer', () => {
    const parentId = 'upload-batch-aggregate-test'
    rememberBatchTransfer(transfer({
      transferId: parentId,
      fileName: '2 files',
      remotePath: '/tmp',
      state: 'queued',
      itemCount: 2,
      totalBytes: 30,
    }))

    const running = aggregateBatchProgress(transfer({
      transferId: createBatchChildTransferId(parentId, 0, 2),
      state: 'running',
      transferredBytes: 5,
      totalBytes: 10,
      message: 'Uploading a.txt',
    }))

    expect(running?.transferId).toBe(parentId)
    expect(running?.state).toBe('running')
    expect(running?.transferredBytes).toBe(5)
    expect(running?.totalBytes).toBe(30)
    expect(running?.message).toBe('0/2 items; Uploading a.txt')

    aggregateBatchProgress(transfer({
      transferId: createBatchChildTransferId(parentId, 0, 2),
      state: 'completed',
      transferredBytes: 10,
      totalBytes: 10,
      message: 'Complete',
    }))

    const completed = aggregateBatchProgress(transfer({
      transferId: createBatchChildTransferId(parentId, 1, 2),
      state: 'completed',
      transferredBytes: 20,
      totalBytes: 20,
      message: 'Complete',
    }))

    expect(completed?.state).toBe('completed')
    expect(completed?.transferredBytes).toBe(30)
    expect(completed?.message).toBe('2 items complete')
  })
})
