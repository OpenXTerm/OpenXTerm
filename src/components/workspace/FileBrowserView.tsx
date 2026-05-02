import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
import { ArrowDownToLine, ArrowUp, Copy, Eye, FolderPlus, Info, LoaderCircle, RefreshCw, Trash2, Upload } from 'lucide-react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import {
  createRemoteDirectory,
  deleteRemoteEntry,
  downloadRemoteFile,
  listRemoteDirectory,
  uploadLocalFile,
  uploadRemoteFile,
} from '../../lib/bridge'
import { logOpenXTermError } from '../../lib/errorLog'
import { useRemotePropertiesWindow } from '../../hooks/useRemotePropertiesWindow'
import { localPathBaseName } from '../../lib/localPath'
import { queueBatchTransfers } from '../../lib/transferBatch'
import { isTransferCanceledError } from '../../lib/transferQueue'
import { useSftpConflictResolver } from '../../hooks/useSftpConflictResolver'
import type { RemoteDirectorySnapshot, SessionDefinition } from '../../types/domain'
import { useOpenXTermStore } from '../../state/useOpenXTermStore'
import { RemoteEntryPropertiesModal } from './RemoteEntryPropertiesModal'
import { FileConflictModal } from './FileConflictModal'
import { FileTable } from './FileTable'
import { useFileBrowserSelection } from './useFileBrowserSelection'
import { useFileNativeDragOut } from './useFileNativeDragOut'
import { useFileTableControls } from './useFileTableControls'

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

function itemCountLabel(count: number) {
  return count === 1 ? '1 item' : `${count} items`
}

function normalizeRemotePath(path: string) {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }

  return `/${trimmed.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`.replace(/\/+$/, '') || '/'
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

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    const copied = document.execCommand('copy')
    if (!copied) {
      throw new Error('Clipboard copy failed.')
    }
  } finally {
    document.body.removeChild(textarea)
  }
}

export function FileBrowserView({ session }: FileBrowserViewProps) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const filePaneRef = useRef<HTMLDivElement | null>(null)
  const enqueueTransfer = useOpenXTermStore((state) => state.enqueueTransfer)
  const [snapshot, setSnapshot] = useState<RemoteDirectorySnapshot | null>(null)
  const [currentPath, setCurrentPath] = useState('/')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [dropActive, setDropActive] = useState(false)
  const [pathDraft, setPathDraft] = useState('/')
  const {
    fileTableStyle,
    handleColumnResizeStart,
    handleSortColumn,
    setShowHidden,
    showHidden,
    sortState,
    visibleEntries,
  } = useFileTableControls(snapshot)
  const {
    closeContextMenu,
    contextMenu,
    openContextMenu,
    pathToCopy,
    resetSelection,
    selectEntry,
    selectedEntry,
    selectedPath,
    setSelectedEntryPaths,
    setSelectedPath,
  } = useFileBrowserSelection({
    currentPath,
    snapshot,
    visibleEntries,
  })
  const {
    conflictRequest,
    resolveConflict: handleConflictResolve,
    resolveDownloadTarget,
    resolveUploadTargets,
  } = useSftpConflictResolver(snapshot?.entries ?? [], { compareNames: 'normalized' })
  const handleNativeDragPointerDown = useFileNativeDragOut({
    session,
    setMessage,
    setSelectedPath,
  })

  const loadDirectory = useCallback(async (targetPath: string) => {
    const normalizedPath = normalizeRemotePath(targetPath)
    setBusy(true)
    try {
      const nextSnapshot = await listRemoteDirectory(session, normalizedPath)
      setSnapshot({
        path: nextSnapshot.path,
        entries: nextSnapshot.entries,
      })
      setCurrentPath(nextSnapshot.path)
      setPathDraft(nextSnapshot.path)
      resetSelection()
      setMessage(`Loaded ${nextSnapshot.path}`)
    } catch (error) {
      logOpenXTermError('file-browser.load-directory', error, fileBrowserErrorContext(session, 'load', normalizedPath))
      setMessage(error instanceof Error ? error.message : 'Unable to load remote directory.')
    } finally {
      setBusy(false)
    }
  }, [resetSelection, session])
  const {
    closeProperties,
    handlePropertiesApplied,
    openProperties,
    propertiesEntry,
  } = useRemotePropertiesWindow({
    clearSelectionOnStorageResult: false,
    closeContextMenu,
    currentPath,
    errorContext: fileBrowserErrorContext,
    errorScope: 'file-browser.properties-result',
    loadDirectory: (_session, path) => loadDirectory(path),
    selectedSession: session,
    sessions: [session],
    setMessage,
    setSelectedEntryPaths,
  })

  useEffect(() => {
    setSnapshot(null)
    setCurrentPath('/')
    setPathDraft('/')
    resetSelection()
    void loadDirectory('/')
  }, [loadDirectory, resetSelection, session.id])

  useEffect(() => {
    setPathDraft(currentPath)
  }, [currentPath])

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

          const transferItems = queueBatchTransfers({
            items: uploadItems,
            prefix: 'upload',
            enqueueTransfer,
            parent: (items) => ({
              fileName: itemCountLabel(items.length),
              remotePath: currentPath,
              direction: 'upload',
              purpose: 'upload',
              state: 'queued',
              transferredBytes: 0,
              totalBytes: undefined,
              localPath: `${items.length} local items`,
              message: `Queued ${items.length} items for upload`,
            }),
            child: (item) => ({
              fileName: item.targetName,
              remotePath: currentPath === '/' ? `/${item.targetName}` : `${currentPath}/${item.targetName}`,
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
            await uploadLocalFile(session, currentPath, item.localPath, transferId, item.targetName, item.conflictAction)
          }
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
  }, [currentPath, enqueueTransfer, loadDirectory, resolveUploadTargets, session])

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
      const target = await resolveDownloadTarget(selectedEntry, false)
      if (target.skipped) {
        setMessage('Download skipped.')
        return
      }
      enqueueTransfer({
        transferId,
        fileName: target.targetName,
        remotePath: selectedEntry.path,
        direction: 'download',
        purpose: 'download',
        state: 'queued',
        transferredBytes: 0,
        totalBytes: selectedEntry.sizeBytes,
        message: 'Queued for download',
      })
      const result = await downloadRemoteFile(session, selectedEntry.path, transferId, target.targetName, target.conflictAction)
      setMessage(`Downloaded ${result.fileName} -> ${result.savedTo}`)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setMessage('Transfer canceled.')
        return
      }
      logOpenXTermError('file-browser.download-file', error, fileBrowserErrorContext(session, 'download', selectedEntry.path))
      setMessage(error instanceof Error ? error.message : 'Unable to download remote file.')
    } finally {
      setBusy(false)
    }
  }

  async function handleCopyPath() {
    try {
      await copyTextToClipboard(pathToCopy)
      setMessage(`Copied remote path: ${pathToCopy}`)
    } catch (error) {
      logOpenXTermError('file-browser.copy-path', error, fileBrowserErrorContext(session, 'copy-path', pathToCopy))
      setMessage(error instanceof Error ? error.message : 'Unable to copy remote path.')
    }
  }

  async function handlePathSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await loadDirectory(pathDraft)
  }

  async function uploadFiles(files: File[]) {
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

      const transferItems = queueBatchTransfers({
        items: uploadItems,
        prefix: 'upload',
        enqueueTransfer,
        parent: (items) => ({
          fileName: itemCountLabel(items.length),
          remotePath: currentPath,
          direction: 'upload',
          purpose: 'upload',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: items.reduce((sum, item) => sum + item.file.size, 0),
          message: `Queued ${items.length} files for upload`,
        }),
        child: (item) => ({
          fileName: item.targetName,
          remotePath: currentPath === '/' ? `/${item.targetName}` : `${currentPath}/${item.targetName}`,
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
      setMessage(`Uploaded ${uploadItems.length} file${uploadItems.length > 1 ? 's' : ''} to ${currentPath}`)
      await loadDirectory(currentPath)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setMessage('Transfer canceled.')
        setBusy(false)
        return
      }
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
        <button type="button" onClick={() => void handleCopyPath()} disabled={busy || !pathToCopy}>
          <Copy size={14} />
          <span>Copy path</span>
        </button>
        <button type="button" onClick={() => selectedEntry && void openProperties(selectedEntry)} disabled={busy || !selectedEntry}>
          <Info size={14} />
          <span>Properties</span>
        </button>
        <button
          type="button"
          className={showHidden ? 'active' : undefined}
          onClick={() => setShowHidden((value) => !value)}
          disabled={busy}
        >
          <Eye size={14} />
          <span>{showHidden ? 'Hide hidden' : 'Show hidden'}</span>
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
        <form className="file-path-form" onSubmit={(event) => void handlePathSubmit(event)}>
          <input
            value={pathDraft}
            disabled={busy}
            aria-label="Remote path"
            spellCheck={false}
            onChange={(event) => setPathDraft(event.target.value)}
          />
          <button type="submit" disabled={busy || !pathDraft.trim()}>
            Go
          </button>
        </form>
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
          <FileTable
            entries={visibleEntries}
            rawEntryCount={snapshot?.entries.length ?? 0}
            selectedPath={selectedPath}
            showHidden={showHidden}
            sortState={sortState}
            style={fileTableStyle}
            onColumnResizeStart={handleColumnResizeStart}
            onNativeDragPointerDown={handleNativeDragPointerDown}
            onOpenContextMenu={openContextMenu}
            onOpenDirectory={(entry) => void loadDirectory(entry.path)}
            onSelectEntry={selectEntry}
            onSortColumn={handleSortColumn}
          />
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
owner: ${selectedEntry.ownerLabel ?? '-'}
group: ${selectedEntry.groupLabel ?? '-'}
access: ${selectedEntry.accessLabel ?? '-'}
drag out: ${selectedEntry.kind === 'file' ? 'native desktop drag export' : 'folders are not exported'}

double-click a folder to open it`
            : `target: ${session.username ? `${session.username}@` : ''}${session.host || session.serialPort || 'remote'}
protocol: ${session.kind.toUpperCase()}
path: ${snapshot?.path ?? currentPath}

${message || 'Drop local files here to upload or select a file to drag it back to the system.'}`}</pre>
        </div>
      </div>

      {contextMenu && (
        <div
          className="file-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => void openProperties(contextMenu.entry)}>
            <Info size={14} />
            <span>Properties</span>
          </button>
        </div>
      )}

      {propertiesEntry && (
        <RemoteEntryPropertiesModal
          session={session}
          entry={propertiesEntry}
          currentPath={currentPath}
          busy={busy}
          onClose={closeProperties}
          onApplied={handlePropertiesApplied}
        />
      )}
      <FileConflictModal request={conflictRequest} onResolve={handleConflictResolve} />
    </div>
  )
}
