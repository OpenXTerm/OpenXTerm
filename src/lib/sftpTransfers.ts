import {
  downloadRemoteEntry,
  uploadLocalFile,
  uploadRemoteFile,
} from './bridge'
import { queueBatchTransfers } from './transferBatch'
import type { RemoteFileEntry, SessionDefinition, TransferProgressPayload } from '../types/domain'

type ConflictAction = 'overwrite' | 'error'
type EnqueueTransfer = (item: TransferProgressPayload) => void

interface BrowserUploadItem {
  file: File
  targetName: string
  conflictAction: ConflictAction
}

interface LocalPathUploadItem {
  localPath: string
  targetName: string
  conflictAction: ConflictAction
}

interface DownloadEntryItem {
  entry: RemoteFileEntry
  targetName: string
  conflictAction: ConflictAction
}

interface TransferOptions {
  currentPath: string
  enqueueTransfer: EnqueueTransfer
  session: SessionDefinition
}

export function joinRemotePath(parent: string, name: string) {
  return parent === '/' ? `/${name.replace(/^\/+/, '')}` : `${parent.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`
}

export function itemCountLabel(count: number) {
  return count === 1 ? '1 item' : `${count} items`
}

export function batchLocalPathLabel(paths: string[]) {
  if (paths.length === 0) {
    return undefined
  }

  return paths.length === 1 ? paths[0] : `${paths.length} local items`
}

export async function runBrowserFileUploads({
  currentPath,
  enqueueTransfer,
  items,
  session,
}: TransferOptions & { items: BrowserUploadItem[] }) {
  const transferItems = queueBatchTransfers({
    items,
    prefix: 'upload',
    enqueueTransfer,
    parent: (uploadItems) => ({
      fileName: itemCountLabel(uploadItems.length),
      remotePath: currentPath,
      direction: 'upload',
      purpose: 'upload',
      state: 'queued',
      transferredBytes: 0,
      totalBytes: uploadItems.reduce((sum, item) => sum + item.file.size, 0),
      message: `Queued ${uploadItems.length} files for upload`,
    }),
    child: (item) => ({
      fileName: item.targetName,
      remotePath: joinRemotePath(currentPath, item.targetName),
      direction: 'upload',
      purpose: 'upload',
      state: 'queued',
      transferredBytes: 0,
      totalBytes: item.file.size,
      message: 'Queued for upload',
    }),
  })

  for (const { item, transferId } of transferItems) {
    const bytes = Array.from(new Uint8Array(await item.file.arrayBuffer()))
    await uploadRemoteFile(session, currentPath, item.targetName, bytes, transferId, item.conflictAction)
  }

  return { uploadedCount: items.length }
}

export async function runLocalPathUploads({
  currentPath,
  enqueueTransfer,
  items,
  session,
}: TransferOptions & { items: LocalPathUploadItem[] }) {
  const transferIds: string[] = []
  const transferItems = queueBatchTransfers({
    items,
    prefix: 'upload',
    enqueueTransfer,
    parent: (uploadItems) => ({
      fileName: itemCountLabel(uploadItems.length),
      remotePath: currentPath,
      direction: 'upload',
      purpose: 'upload',
      state: 'queued',
      transferredBytes: 0,
      totalBytes: undefined,
      localPath: batchLocalPathLabel(uploadItems.map((item) => item.localPath)),
      message: `Queued ${uploadItems.length} items for upload`,
    }),
    child: (item) => ({
      fileName: item.targetName,
      remotePath: joinRemotePath(currentPath, item.targetName),
      direction: 'upload',
      purpose: 'upload',
      state: 'queued',
      transferredBytes: 0,
      totalBytes: undefined,
      localPath: item.localPath,
      message: 'Queued for upload',
    }),
  })

  for (const { item, transferId } of transferItems) {
    transferIds.push(transferId)
    await uploadLocalFile(session, currentPath, item.localPath, transferId, item.targetName, item.conflictAction)
  }

  return { transferIds, uploadedCount: items.length }
}

export async function runRemoteEntryDownloads({
  currentPath,
  enqueueTransfer,
  items,
  session,
}: TransferOptions & { items: DownloadEntryItem[] }) {
  const knownTotalBytes = items.every((item) => item.entry.kind === 'file' && typeof item.entry.sizeBytes === 'number')
    ? items.reduce((sum, item) => sum + (item.entry.sizeBytes ?? 0), 0)
    : undefined
  const transferItems = queueBatchTransfers({
    items,
    prefix: 'download',
    enqueueTransfer,
    parent: (downloadItems) => ({
      fileName: itemCountLabel(downloadItems.length),
      remotePath: currentPath,
      direction: 'download',
      purpose: 'download',
      state: 'queued',
      transferredBytes: 0,
      totalBytes: knownTotalBytes,
      message: `Queued ${downloadItems.length} items for download`,
    }),
    child: (item) => ({
      fileName: item.targetName,
      remotePath: item.entry.path,
      direction: 'download',
      purpose: 'download',
      state: 'queued',
      transferredBytes: 0,
      totalBytes: item.entry.kind === 'file' ? item.entry.sizeBytes : undefined,
      message: item.entry.kind === 'folder' ? 'Queued folder download' : 'Queued for download',
    }),
  })

  let lastResult = ''
  for (const { item, transferId } of transferItems) {
    const result = await downloadRemoteEntry(
      session,
      item.entry.path,
      item.entry.kind,
      transferId,
      item.targetName,
      item.conflictAction,
    )
    lastResult = `${result.fileName} -> ${result.savedTo}`
  }

  return { downloadedCount: items.length, lastResult }
}
