import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { useRemoteFileUploads, type ResolveUploadTargets } from '../../hooks/useRemoteFileUploads'
import type { SessionDefinition, TransferProgressPayload } from '../../types/domain'
import { fileBrowserErrorContext } from './fileBrowserUtils'

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
  const targetPathForName = useCallback((name: string) => currentPath === '/' ? `/${name}` : `${currentPath}/${name}`, [currentPath])

  const { uploadBrowserFiles, uploadLocalPaths } = useRemoteFileUploads({
    browserErrorLabel: 'file-browser.upload-file',
    buildErrorContext: fileBrowserErrorContext,
    currentPath,
    enqueueTransfer,
    localPathErrorLabel: 'file-browser.drop-upload',
    loadDirectory,
    resolveUploadTargets,
    session,
    setBusy,
    setMessage,
    targetPathForName,
  })

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

      void uploadLocalPaths(droppedPaths, 'drop-upload')
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
      await uploadBrowserFiles(Array.from(fileList), 'upload')
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

    await uploadBrowserFiles(droppedFiles, 'drop-upload')
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
