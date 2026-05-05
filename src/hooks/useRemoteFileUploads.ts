import { useCallback } from 'react'

import { logOpenXTermError } from '../lib/errorLog'
import { localPathBaseName } from '../lib/localPath'
import { runBrowserFileUploads, runLocalPathUploads } from '../lib/sftpTransfers'
import { isTransferCanceledError } from '../lib/transferQueue'
import type { SessionDefinition, TransferProgressPayload } from '../types/domain'

export type ResolveUploadTargets = <T extends { name: string }>(
  items: T[],
  targetPathForName: (name: string) => string,
) => Promise<Array<T & { targetName: string, conflictAction: 'overwrite' | 'error' }>>

type BrowserUploadItem = {
  conflictAction: 'overwrite' | 'error'
  file: File
  targetName: string
}

interface UseRemoteFileUploadsOptions {
  browserErrorLabel: string | ((source: 'upload' | 'drop-upload') => string)
  buildErrorContext: (session: SessionDefinition, action: string, path: string) => Record<string, unknown>
  currentPath: string
  enqueueTransfer: (item: TransferProgressPayload) => void
  localPathErrorLabel: string | ((source: 'drop-upload') => string)
  loadDirectory: (path: string) => Promise<unknown>
  resolveUploadTargets: ResolveUploadTargets
  session: SessionDefinition | undefined
  setBusy: (busy: boolean) => void
  setMessage: (message: string) => void
  targetPathForName: (name: string) => string
}

export function useRemoteFileUploads({
  browserErrorLabel,
  buildErrorContext,
  currentPath,
  enqueueTransfer,
  localPathErrorLabel,
  loadDirectory,
  resolveUploadTargets,
  session,
  setBusy,
  setMessage,
  targetPathForName,
}: UseRemoteFileUploadsOptions) {
  const uploadBrowserFiles = useCallback(async (files: File[], source: 'upload' | 'drop-upload') => {
    if (files.length === 0 || !session) {
      return
    }

    setBusy(true)
    let uploadItems: BrowserUploadItem[] | null = null
    try {
      uploadItems = await resolveUploadTargets(
        files.map((file) => ({ file, name: file.name })),
        targetPathForName,
      )
      if (uploadItems.length === 0) {
        setMessage('Upload skipped.')
        return
      }

      await runBrowserFileUploads({
        currentPath,
        enqueueTransfer,
        items: uploadItems,
        session,
      })
      setMessage(`Uploaded ${uploadItems.length} file${uploadItems.length > 1 ? 's' : ''} to ${currentPath}`)
      await loadDirectory(currentPath)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setMessage('Transfer canceled.')
        return
      }
      const errorLabel = typeof browserErrorLabel === 'function' ? browserErrorLabel(source) : browserErrorLabel
      logOpenXTermError(errorLabel, error, {
        ...buildErrorContext(session, source, currentPath),
        files: uploadItems?.map((item) => ({
          name: item.file.name,
          targetName: item.targetName,
          size: item.file.size,
        })) ?? files.map((file) => ({ name: file.name, size: file.size })),
      })
      setMessage(error instanceof Error ? error.message : 'Unable to upload file.')
    } finally {
      setBusy(false)
    }
  }, [
    browserErrorLabel,
    buildErrorContext,
    currentPath,
    enqueueTransfer,
    loadDirectory,
    resolveUploadTargets,
    session,
    setBusy,
    setMessage,
    targetPathForName,
  ])

  const uploadLocalPaths = useCallback(async (localPaths: string[], source: 'drop-upload') => {
    if (localPaths.length === 0 || !session) {
      return
    }

    setBusy(true)
    const transferIds: string[] = []
    try {
      const uploadItems = await resolveUploadTargets(
        localPaths.map((localPath) => ({
          localPath,
          name: localPathBaseName(localPath),
        })),
        targetPathForName,
      )
      if (uploadItems.length === 0) {
        setMessage('Upload skipped.')
        return
      }

      const result = await runLocalPathUploads({
        currentPath,
        enqueueTransfer,
        items: uploadItems,
        session,
      })
      transferIds.push(...result.transferIds)
      setMessage(`Uploaded ${uploadItems.length} item${uploadItems.length > 1 ? 's' : ''} to ${currentPath}`)
      await loadDirectory(currentPath)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setMessage('Transfer canceled.')
        return
      }
      const errorLabel = typeof localPathErrorLabel === 'function' ? localPathErrorLabel(source) : localPathErrorLabel
      logOpenXTermError(errorLabel, error, {
        ...buildErrorContext(session, source, currentPath),
        droppedPaths: localPaths,
        transferIds,
      })
      setMessage(error instanceof Error ? error.message : 'Unable to upload dropped file.')
    } finally {
      setBusy(false)
    }
  }, [
    buildErrorContext,
    currentPath,
    enqueueTransfer,
    loadDirectory,
    localPathErrorLabel,
    resolveUploadTargets,
    session,
    setBusy,
    setMessage,
    targetPathForName,
  ])

  return {
    uploadBrowserFiles,
    uploadLocalPaths,
  }
}
