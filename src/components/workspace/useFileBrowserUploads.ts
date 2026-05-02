import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { logOpenXTermError } from '../../lib/errorLog'
import { localPathBaseName } from '../../lib/localPath'
import { isTransferCanceledError } from '../../lib/transferQueue'
import { runBrowserFileUploads, runLocalPathUploads } from '../../lib/sftpTransfers'
import type { SessionDefinition, TransferProgressPayload } from '../../types/domain'
import { fileBrowserErrorContext } from './fileBrowserUtils'

type ResolveUploadTargets = <T extends { name: string }>(
  items: T[],
  targetPathForName: (name: string) => string,
) => Promise<Array<T & { targetName: string, conflictAction: 'overwrite' | 'error' }>>

interface UseFileBrowserUploadsOptions {
  currentPath: string
  enqueueTransfer: (item: TransferProgressPayload) => void
  loadDirectory: (path: string) => Promise<void>
  resolveUploadTargets: ResolveUploadTargets
  session: SessionDefinition
  setBusy: (busy: boolean) => void
  setMessage: (message: string) => void
}

export function useFileBrowserUploads({
  currentPath,
  enqueueTransfer,
  loadDirectory,
  resolveUploadTargets,
  session,
  setBusy,
  setMessage,
}: UseFileBrowserUploadsOptions) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const filePaneRef = useRef<HTMLDivElement | null>(null)
  const [dropActive, setDropActive] = useState(false)

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return
    }

    setBusy(true)
    try {
      const uploadItems = await resolveUploadTargets(
        files.map((file) => ({ file, name: file.name })),
        (name) => currentPath === '/' ? `/${name}` : `${currentPath}/${name}`,
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
      logOpenXTermError('file-browser.upload-file', error, {
        ...fileBrowserErrorContext(session, 'upload', currentPath),
        files: files.map((file) => ({ name: file.name, size: file.size })),
      })
      setMessage(error instanceof Error ? error.message : 'Unable to upload file.')
    } finally {
      setBusy(false)
    }
  }, [currentPath, enqueueTransfer, loadDirectory, resolveUploadTargets, session, setBusy, setMessage])

  const uploadLocalPaths = useCallback(async (droppedPaths: string[]) => {
    if (droppedPaths.length === 0) {
      return
    }

    setBusy(true)
    try {
      const uploadItems = await resolveUploadTargets(
        droppedPaths.map((localPath) => ({
          localPath,
          name: localPathBaseName(localPath),
        })),
        (name) => currentPath === '/' ? `/${name}` : `${currentPath}/${name}`,
      )
      if (uploadItems.length === 0) {
        setMessage('Upload skipped.')
        return
      }

      await runLocalPathUploads({
        currentPath,
        enqueueTransfer,
        items: uploadItems,
        session,
      })
      setMessage(`Uploaded ${uploadItems.length} item${uploadItems.length > 1 ? 's' : ''} to ${currentPath}`)
      await loadDirectory(currentPath)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setMessage('Transfer canceled.')
        return
      }
      logOpenXTermError('file-browser.drop-upload', error, {
        ...fileBrowserErrorContext(session, 'drop-upload', currentPath),
        droppedPaths,
      })
      setMessage(error instanceof Error ? error.message : 'Unable to upload dropped file.')
    } finally {
      setBusy(false)
    }
  }, [currentPath, enqueueTransfer, loadDirectory, resolveUploadTargets, session, setBusy, setMessage])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) {
      return
    }

    let disposed = false
    let unlisten: (() => void) | null = null

    void getCurrentWebview().onDragDropEvent((event) => {
      if (disposed || !filePaneRef.current) {
        return
      }

      const payload = event.payload

      if (payload.type === 'leave') {
        setDropActive(false)
        return
      }

      const bounds = filePaneRef.current.getBoundingClientRect()
      const inside =
        payload.position.x >= bounds.left
        && payload.position.x <= bounds.right
        && payload.position.y >= bounds.top
        && payload.position.y <= bounds.bottom

      if (payload.type === 'enter' || payload.type === 'over') {
        setDropActive(inside)
        return
      }

      if (payload.type !== 'drop') {
        setDropActive(false)
        return
      }

      const droppedPaths = payload.paths
      setDropActive(false)
      if (!inside || droppedPaths.length === 0) {
        return
      }

      void uploadLocalPaths(droppedPaths)
    }).then((dispose) => {
      if (disposed) {
        return
      }
      unlisten = dispose
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [uploadLocalPaths])

  async function handleUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files
    if (!fileList || fileList.length === 0) {
      return
    }

    try {
      await uploadFiles(Array.from(fileList))
    } finally {
      event.target.value = ''
    }
  }

  async function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDropActive(false)

    const droppedFiles = Array.from(event.dataTransfer.files ?? []).filter((file) => file.size >= 0)
    if (droppedFiles.length === 0) {
      return
    }

    await uploadFiles(droppedFiles)
  }

  return {
    dropActive,
    filePaneRef,
    handleFileDrop,
    handleUploadChange,
    setDropActive,
    uploadInputRef,
  }
}
