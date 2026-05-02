import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import {
  createRemoteDirectory,
  uploadRemoteFile,
} from '../../lib/bridge'
import { logOpenXTermError } from '../../lib/errorLog'
import { localPathBaseName } from '../../lib/localPath'
import { queueBatchTransfers } from '../../lib/transferBatch'
import { isTransferCanceledError } from '../../lib/transferQueue'
import { runBrowserFileUploads, runLocalPathUploads } from '../../lib/sftpTransfers'
import type { SessionDefinition, SidebarSection, TransferProgressPayload } from '../../types/domain'
import {
  joinRemotePath,
  sidebarSftpErrorContext,
} from './sftpUtils'

type ResolveUploadTargets = <T extends { name: string }>(
  items: T[],
  targetPathForName: (name: string) => string,
) => Promise<Array<T & { targetName: string, conflictAction: 'overwrite' | 'error' }>>

interface UseSftpUploadsOptions {
  activeSection: SidebarSection
  currentPath: string
  enqueueTransfer: (item: TransferProgressPayload) => void
  loadDirectory: (path: string) => Promise<boolean>
  resolveUploadTargets: ResolveUploadTargets
  selectedSession: SessionDefinition | undefined
  setLoading: (loading: boolean) => void
  setMessage: (message: string) => void
}

export function useSftpUploads({
  activeSection,
  currentPath,
  enqueueTransfer,
  loadDirectory,
  resolveUploadTargets,
  selectedSession,
  setLoading,
  setMessage,
}: UseSftpUploadsOptions) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const uploadFolderInputRef = useRef<HTMLInputElement | null>(null)
  const sftpListRef = useRef<HTMLDivElement | null>(null)
  const lastNativeSftpDropAtRef = useRef(0)
  const [dropActive, setDropActive] = useState(false)

  const uploadLocalPaths = useCallback(async (localPaths: string[], source: 'drop-upload') => {
    if (localPaths.length === 0 || !selectedSession) {
      return
    }

    const uploadItems = await resolveUploadTargets(
      localPaths.map((localPath) => ({
        localPath,
        name: localPathBaseName(localPath),
      })),
      (name) => joinRemotePath(currentPath, name),
    )
    if (uploadItems.length === 0) {
      setMessage('Upload skipped.')
      return
    }

    setLoading(true)
    const transferIds: string[] = []
    try {
      const result = await runLocalPathUploads({
        currentPath,
        enqueueTransfer,
        items: uploadItems,
        session: selectedSession,
      })
      transferIds.push(...result.transferIds)
      setMessage(`Uploaded ${uploadItems.length} item${uploadItems.length > 1 ? 's' : ''} to ${currentPath}`)
      await loadDirectory(currentPath)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setMessage('Transfer canceled.')
        return
      }
      logOpenXTermError(`sidebar.sftp.${source}`, error, {
        ...sidebarSftpErrorContext(selectedSession, source, currentPath),
        droppedPaths: localPaths,
        transferIds,
      })
      setMessage(error instanceof Error ? error.message : 'Unable to upload dropped file.')
    } finally {
      setLoading(false)
    }
  }, [currentPath, enqueueTransfer, loadDirectory, resolveUploadTargets, selectedSession, setLoading, setMessage])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) {
      return
    }

    let disposed = false
    let unlisten: (() => void) | null = null

    void getCurrentWebview().onDragDropEvent((event) => {
      if (disposed || activeSection !== 'sftp' || !selectedSession || !sftpListRef.current) {
        return
      }

      const payload = event.payload
      if (payload.type === 'leave') {
        setDropActive(false)
        return
      }

      const bounds = sftpListRef.current.getBoundingClientRect()
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

      lastNativeSftpDropAtRef.current = Date.now()
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
  }, [activeSection, selectedSession, uploadLocalPaths])

  const uploadBrowserFiles = useCallback(async (files: File[], source: 'upload' | 'drop-upload') => {
    if (files.length === 0 || !selectedSession) {
      return
    }

    const uploadItems = await resolveUploadTargets(
      files.map((file) => ({ file, name: file.name })),
      (name) => joinRemotePath(currentPath, name),
    )
    if (uploadItems.length === 0) {
      setMessage('Upload skipped.')
      return
    }

    setLoading(true)
    try {
      await runBrowserFileUploads({
        currentPath,
        enqueueTransfer,
        items: uploadItems,
        session: selectedSession,
      })
      setMessage(`Uploaded ${uploadItems.length} file${uploadItems.length > 1 ? 's' : ''} to ${currentPath}`)
      await loadDirectory(currentPath)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setMessage('Transfer canceled.')
        return
      }
      logOpenXTermError(`sidebar.sftp.${source}`, error, {
        ...sidebarSftpErrorContext(selectedSession, source, currentPath),
        files: uploadItems.map((item) => ({ name: item.file.name, targetName: item.targetName, size: item.file.size })),
      })
      setMessage(error instanceof Error ? error.message : 'Unable to upload file.')
    } finally {
      setLoading(false)
    }
  }, [currentPath, enqueueTransfer, loadDirectory, resolveUploadTargets, selectedSession, setLoading, setMessage])

  const handleUploadChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files
    if (!fileList || fileList.length === 0 || !selectedSession) {
      return
    }

    try {
      await uploadBrowserFiles(Array.from(fileList), 'upload')
    } finally {
      event.target.value = ''
    }
  }, [selectedSession, uploadBrowserFiles])

  const handleBrowserDrag = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!selectedSession || !Array.from(event.dataTransfer.types).includes('Files')) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }, [selectedSession])

  const handleBrowserDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return
    }

    setDropActive(false)
  }, [])

  const handleBrowserDrop = useCallback(async (event: ReactDragEvent<HTMLDivElement>) => {
    if (!selectedSession) {
      return
    }

    event.preventDefault()
    setDropActive(false)

    if (Date.now() - lastNativeSftpDropAtRef.current < 750) {
      return
    }

    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) {
      return
    }

    await uploadBrowserFiles(files, 'drop-upload')
  }, [selectedSession, uploadBrowserFiles])

  const ensureRemoteDirectoryPath = useCallback(async (path: string) => {
    if (!selectedSession || path === '/') {
      return
    }

    let current = '/'
    for (const segment of path.split('/').filter(Boolean)) {
      try {
        await createRemoteDirectory(selectedSession, current, segment)
      } catch {
        // Existing directories are fine; the following upload/list operation will surface real path errors.
      }
      current = joinRemotePath(current, segment)
    }
  }, [selectedSession])

  const handleUploadFolderChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files
    if (!fileList || fileList.length === 0 || !selectedSession) {
      return
    }

    setLoading(true)
    try {
      const files = Array.from(fileList)
      const rootFolderName = files[0]?.webkitRelativePath?.split('/').filter(Boolean)[0] ?? 'folder'
      const rootResolution = await resolveUploadTargets(
        [{ name: rootFolderName }],
        (name) => joinRemotePath(currentPath, name),
      )
      if (rootResolution.length === 0) {
        setMessage('Folder upload skipped.')
        return
      }
      const rootTargetName = rootResolution[0].targetName
      const rootConflictAction = rootResolution[0].conflictAction
      const folderUploadItems = files.map((file) => {
        const relativePath = file.webkitRelativePath || file.name
        const parts = relativePath.split('/').filter(Boolean)
        if (parts.length > 0) {
          parts[0] = rootTargetName
        }
        const fileName = parts.at(-1) ?? file.name
        const remoteDir = parts.length > 1
          ? parts.slice(0, -1).reduce((path, segment) => joinRemotePath(path, segment), currentPath)
          : currentPath

        return { file, fileName, remoteDir }
      })
      const transferItems = queueBatchTransfers({
        items: folderUploadItems,
        prefix: 'upload',
        enqueueTransfer,
        parent: (items) => ({
          fileName: rootTargetName,
          remotePath: joinRemotePath(currentPath, rootTargetName),
          direction: 'upload',
          purpose: 'upload',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: items.reduce((sum, item) => sum + item.file.size, 0),
          message: `Queued ${items.length} folder items for upload`,
        }),
        child: (item) => ({
          fileName: item.fileName,
          remotePath: joinRemotePath(item.remoteDir, item.fileName),
          direction: 'upload',
          purpose: 'upload',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: item.file.size,
          message: 'Queued for upload',
        }),
      })

      for (const { item, transferId } of transferItems) {
        await ensureRemoteDirectoryPath(item.remoteDir)

        const bytes = Array.from(new Uint8Array(await item.file.arrayBuffer()))
        await uploadRemoteFile(selectedSession, item.remoteDir, item.fileName, bytes, transferId, rootConflictAction)
      }
      setMessage(`Uploaded folder contents to ${currentPath}`)
      await loadDirectory(currentPath)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setMessage('Transfer canceled.')
        return
      }
      logOpenXTermError('sidebar.sftp.upload-folder', error, {
        ...sidebarSftpErrorContext(selectedSession, 'upload-folder', currentPath),
        files: Array.from(fileList).map((file) => ({
          name: file.name,
          relativePath: file.webkitRelativePath,
          size: file.size,
        })),
      })
      setMessage(error instanceof Error ? error.message : 'Unable to upload folder.')
    } finally {
      setLoading(false)
      event.target.value = ''
    }
  }, [
    currentPath,
    enqueueTransfer,
    ensureRemoteDirectoryPath,
    loadDirectory,
    resolveUploadTargets,
    selectedSession,
    setLoading,
    setMessage,
  ])

  return {
    dropActive,
    handleBrowserDrag,
    handleBrowserDragLeave,
    handleBrowserDrop,
    handleUploadChange,
    handleUploadFolderChange,
    sftpListRef,
    uploadFolderInputRef,
    uploadInputRef,
  }
}
