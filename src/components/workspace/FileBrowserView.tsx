import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ArrowDownToLine, ArrowUp, FileText, Folder, FolderPlus, LoaderCircle, RefreshCw, Trash2, Upload } from 'lucide-react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import {
  createRemoteDirectory,
  deleteRemoteEntry,
  downloadRemoteFile,
  listRemoteDirectory,
  startNativeFileDrag,
  uploadLocalFile,
  uploadRemoteFile,
} from '../../lib/bridge'
import { logOpenXTermError } from '../../lib/errorLog'
import { createBatchChildTransferId, createBatchTransferId } from '../../lib/transferBatch'
import type { RemoteDirectorySnapshot, RemoteFileEntry, SessionDefinition } from '../../types/domain'
import { useOpenXTermStore } from '../../state/useOpenXTermStore'

interface FileBrowserViewProps {
  session: SessionDefinition
}

function parentPathOf(path: string) {
  if (!path || path === '/') {
    return '/'
  }

  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 1) {
    return '/'
  }

  return `/${parts.slice(0, -1).join('/')}`
}

function sortEntries(entries: RemoteFileEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'folder' ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })
}

function movedEnough(startX: number, startY: number, currentX: number, currentY: number) {
  return Math.hypot(currentX - startX, currentY - startY) > 5
}

function itemCountLabel(count: number) {
  return count === 1 ? '1 item' : `${count} items`
}

function fileBrowserErrorContext(session: SessionDefinition, action: string, path: string) {
  return {
    action,
    path,
    sessionId: session.id,
    sessionName: session.name,
    host: session.host,
    kind: session.kind,
    linkedSshTabId: session.linkedSshTabId,
  }
}

export function FileBrowserView({ session }: FileBrowserViewProps) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const filePaneRef = useRef<HTMLDivElement | null>(null)
  const enqueueTransfer = useOpenXTermStore((state) => state.enqueueTransfer)
  const [snapshot, setSnapshot] = useState<RemoteDirectorySnapshot | null>(null)
  const [currentPath, setCurrentPath] = useState('/')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [dropActive, setDropActive] = useState(false)

  const selectedEntry = useMemo(
    () => snapshot?.entries.find((entry) => entry.path === selectedPath) ?? null,
    [selectedPath, snapshot],
  )

  const loadDirectory = useCallback(async (targetPath: string) => {
    setBusy(true)
    try {
      const nextSnapshot = await listRemoteDirectory(session, targetPath)
      setSnapshot({
        path: nextSnapshot.path,
        entries: sortEntries(nextSnapshot.entries),
      })
      setCurrentPath(nextSnapshot.path)
      setSelectedPath(null)
      setMessage(`Loaded ${nextSnapshot.path}`)
    } catch (error) {
      logOpenXTermError('file-browser.load-directory', error, fileBrowserErrorContext(session, 'load', targetPath))
      setMessage(error instanceof Error ? error.message : 'Unable to load remote directory.')
    } finally {
      setBusy(false)
    }
  }, [session])

  useEffect(() => {
    setSnapshot(null)
    setCurrentPath('/')
    setSelectedPath(null)
    void loadDirectory('/')
  }, [loadDirectory, session.id])

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

      void (async () => {
        setBusy(true)
        try {
          const batchTransferId = droppedPaths.length > 1 ? createBatchTransferId('upload') : null
          if (batchTransferId) {
            enqueueTransfer({
              transferId: batchTransferId,
              fileName: itemCountLabel(droppedPaths.length),
              remotePath: currentPath,
              direction: 'upload',
              purpose: 'upload',
              state: 'queued',
              transferredBytes: 0,
              totalBytes: undefined,
              localPath: `${droppedPaths.length} local items`,
              itemCount: droppedPaths.length,
              message: `Queued ${droppedPaths.length} items for upload`,
            })
          }

          for (const [index, localPath] of droppedPaths.entries()) {
            const fileName = localPath.split('/').filter(Boolean).at(-1) ?? 'upload.bin'
            const transferId = batchTransferId
              ? createBatchChildTransferId(batchTransferId, index, droppedPaths.length)
              : `upload-${crypto.randomUUID()}`
            if (!batchTransferId) {
              enqueueTransfer({
                transferId,
                fileName,
                remotePath: currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`,
                direction: 'upload',
                purpose: 'upload',
                state: 'queued',
                transferredBytes: 0,
                totalBytes: undefined,
                localPath,
                message: 'Queued for upload',
              })
            }
            await uploadLocalFile(session, currentPath, localPath, transferId)
          }
          setMessage(`Uploaded ${droppedPaths.length} file${droppedPaths.length > 1 ? 's' : ''} to ${currentPath}`)
          await loadDirectory(currentPath)
        } catch (error) {
          logOpenXTermError('file-browser.drop-upload', error, {
            ...fileBrowserErrorContext(session, 'drop-upload', currentPath),
            droppedPaths,
          })
          setMessage(error instanceof Error ? error.message : 'Unable to upload dropped file.')
        } finally {
          setBusy(false)
        }
      })()
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
  }, [currentPath, enqueueTransfer, loadDirectory, session])

  async function handleCreateFolder() {
    const name = window.prompt('Folder name')
    if (!name || !name.trim()) {
      return
    }

    setBusy(true)
    try {
      await createRemoteDirectory(session, currentPath, name.trim())
      setMessage(`Created folder ${name.trim()}`)
      await loadDirectory(currentPath)
    } catch (error) {
      logOpenXTermError('file-browser.create-folder', error, {
        ...fileBrowserErrorContext(session, 'create-folder', currentPath),
        folderName: name.trim(),
      })
      setMessage(error instanceof Error ? error.message : 'Unable to create remote folder.')
      setBusy(false)
    }
  }

  async function handleDeleteSelected() {
    if (!selectedEntry) {
      return
    }

    const confirmed = window.confirm(`Delete ${selectedEntry.name}?`)
    if (!confirmed) {
      return
    }

    setBusy(true)
    try {
      await deleteRemoteEntry(session, selectedEntry.path, selectedEntry.kind)
      setMessage(`Deleted ${selectedEntry.name}`)
      await loadDirectory(currentPath)
    } catch (error) {
      logOpenXTermError('file-browser.delete-entry', error, {
        ...fileBrowserErrorContext(session, 'delete', selectedEntry.path),
        entryKind: selectedEntry.kind,
      })
      setMessage(error instanceof Error ? error.message : 'Unable to delete remote entry.')
      setBusy(false)
    }
  }

  async function handleDownloadSelected() {
    if (!selectedEntry || selectedEntry.kind !== 'file') {
      return
    }

    setBusy(true)
    try {
      const transferId = `download-${crypto.randomUUID()}`
      enqueueTransfer({
        transferId,
        fileName: selectedEntry.name,
        remotePath: selectedEntry.path,
        direction: 'download',
        purpose: 'download',
        state: 'queued',
        transferredBytes: 0,
        totalBytes: selectedEntry.sizeBytes,
        message: 'Queued for download',
      })
      const result = await downloadRemoteFile(session, selectedEntry.path, transferId)
      setMessage(`Downloaded ${result.fileName} -> ${result.savedTo}`)
    } catch (error) {
      logOpenXTermError('file-browser.download-file', error, fileBrowserErrorContext(session, 'download', selectedEntry.path))
      setMessage(error instanceof Error ? error.message : 'Unable to download remote file.')
    } finally {
      setBusy(false)
    }
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) {
      return
    }

    setBusy(true)
    try {
      const batchTransferId = files.length > 1 ? createBatchTransferId('upload') : null
      if (batchTransferId) {
        enqueueTransfer({
          transferId: batchTransferId,
          fileName: itemCountLabel(files.length),
          remotePath: currentPath,
          direction: 'upload',
          purpose: 'upload',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: files.reduce((sum, file) => sum + file.size, 0),
          itemCount: files.length,
          message: `Queued ${files.length} files for upload`,
        })
      }

      for (const [index, file] of files.entries()) {
        const transferId = batchTransferId
          ? createBatchChildTransferId(batchTransferId, index, files.length)
          : `upload-${crypto.randomUUID()}`
        if (!batchTransferId) {
          enqueueTransfer({
            transferId,
            fileName: file.name,
            remotePath: currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`,
            direction: 'upload',
            purpose: 'upload',
            state: 'queued',
            transferredBytes: 0,
            totalBytes: file.size,
            message: 'Queued for upload',
          })
        }
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
        await uploadRemoteFile(session, currentPath, file.name, bytes, transferId)
      }
      setMessage(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''} to ${currentPath}`)
      await loadDirectory(currentPath)
    } catch (error) {
      logOpenXTermError('file-browser.upload-file', error, {
        ...fileBrowserErrorContext(session, 'upload', currentPath),
        files: files.map((file) => ({ name: file.name, size: file.size })),
      })
      setMessage(error instanceof Error ? error.message : 'Unable to upload file.')
      setBusy(false)
    }
  }

  async function handleUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files
    if (!fileList || fileList.length === 0) {
      return
    }

    try {
      await uploadFiles(Array.from(fileList))
    } finally {
      event.target.value = ''
      setBusy(false)
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
    setBusy(false)
  }

  function handleNativeDragPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    entry: RemoteFileEntry,
  ) {
    if (entry.kind !== 'file' || event.button !== 0) {
      return
    }

    setSelectedPath(entry.path)
    const startX = event.clientX
    const startY = event.clientY
    let started = false

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (started || !movedEnough(startX, startY, moveEvent.clientX, moveEvent.clientY)) {
        return
      }

      started = true
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      void startNativeFileDrag(session, entry.path, entry.name, moveEvent.clientX, moveEvent.clientY)
        .then((dragStarted) => {
          if (!dragStarted) {
            setMessage('Native macOS drag-out could not start for this file.')
          }
        })
        .catch((error) => {
          logOpenXTermError('file-browser.native-drag', error, fileBrowserErrorContext(session, 'native-drag', entry.path))
          setMessage(error instanceof Error ? error.message : 'Native macOS drag-out failed.')
        })
    }

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  return (
    <div className="file-browser">
      <div className="file-toolbar">
        <button type="button" onClick={() => void loadDirectory(parentPathOf(currentPath))} disabled={busy || currentPath === '/'}>
          <ArrowUp size={14} />
          <span>Up</span>
        </button>
        <button type="button" onClick={() => uploadInputRef.current?.click()} disabled={busy}>
          <Upload size={14} />
          <span>Upload</span>
        </button>
        <button type="button" onClick={() => void handleDownloadSelected()} disabled={busy || selectedEntry?.kind !== 'file'}>
          <ArrowDownToLine size={14} />
          <span>Download</span>
        </button>
        <button type="button" onClick={() => void loadDirectory(currentPath)} disabled={busy}>
          <RefreshCw size={14} className={busy ? 'spinning' : undefined} />
          <span>Refresh</span>
        </button>
        <button type="button" onClick={() => void handleDeleteSelected()} disabled={busy || !selectedEntry}>
          <Trash2 size={14} />
          <span>Delete</span>
        </button>
        <button type="button" onClick={() => void handleCreateFolder()} disabled={busy}>
          <FolderPlus size={14} />
          <span>Create folder</span>
        </button>
        <input ref={uploadInputRef} className="sr-only-input" type="file" multiple onChange={(event) => void handleUploadChange(event)} />
      </div>

      <div className="file-grid">
        <div
          ref={filePaneRef}
          className={`file-pane ${dropActive ? 'drop-active' : ''}`}
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              setDropActive(true)
            }
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setDropActive(true)
            }
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
              return
            }
            setDropActive(false)
          }}
          onDrop={(event) => void handleFileDrop(event)}
        >
          <div className="file-pane-header">
            <span>{session.kind.toUpperCase()} {snapshot?.path ?? currentPath}</span>
            {busy && <LoaderCircle size={14} className="spinning" />}
          </div>
          <div className="file-list">
            {snapshot?.entries.length ? (
              snapshot.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`file-row ${selectedPath === entry.path ? 'selected' : ''} ${entry.kind === 'file' ? 'draggable' : ''}`}
                    onPointerDown={(event) => handleNativeDragPointerDown(event, entry)}
                    onClick={() => setSelectedPath(entry.path)}
                    onDoubleClick={() => {
                      if (entry.kind === 'folder') {
                        void loadDirectory(entry.path)
                      }
                    }}
                  >
                    <div className="file-row-name">
                      {entry.kind === 'folder' ? <Folder size={14} /> : <FileText size={14} />}
                      <span>{entry.name}</span>
                    </div>
                    <span>{entry.sizeLabel}</span>
                    <span>{entry.modifiedLabel}</span>
                  </button>
              ))
            ) : (
              <div className="file-empty">This directory is empty.</div>
            )}
          </div>
          {dropActive && (
            <div className="file-drop-overlay">
              <strong>Drop files to upload</strong>
              <span>{currentPath}</span>
            </div>
          )}
        </div>

        <div className="file-preview">
          <div className="file-pane-header">Transfer details</div>
          <pre>{selectedEntry
            ? `name: ${selectedEntry.name}
path: ${selectedEntry.path}
type: ${selectedEntry.kind}
size: ${selectedEntry.sizeLabel}
modified: ${selectedEntry.modifiedLabel}
drag out: ${selectedEntry.kind === 'file' ? 'native macOS file promise' : 'folders are not exported'}

double-click a folder to open it`
            : `target: ${session.username ? `${session.username}@` : ''}${session.host || session.serialPort || 'remote'}
protocol: ${session.kind.toUpperCase()}
path: ${snapshot?.path ?? currentPath}

${message || 'Drop local files here to upload or select a file to drag it back to the system.'}`}</pre>
        </div>
      </div>
    </div>
  )
}
