import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import {
  createRemoteDirectory,
  deleteRemoteEntry,
  downloadRemoteEntry,
  listRemoteDirectory,
  renameRemoteEntry,
  startNativeEntriesDrag,
  uploadLocalPath,
  uploadRemoteFile,
} from '../../lib/bridge'
import { logOpenXTermError } from '../../lib/errorLog'
import type { FileConflictResolution } from '../../lib/fileConflict'
import { localPathBaseName } from '../../lib/localPath'
import {
  createBatchChildTransferId,
  createBatchTransferId,
  queueBatchTransfers,
  rememberBatchTransfer,
} from '../../lib/transferBatch'
import { isTransferCanceledError } from '../../lib/transferQueue'
import { useRemotePropertiesWindow } from '../../hooks/useRemotePropertiesWindow'
import { useSftpConflictResolver } from '../../hooks/useSftpConflictResolver'
import { useOpenXTermStore } from '../../state/useOpenXTermStore'
import { MacrosSection } from './MacrosSection'
import { SidebarFooter } from './SidebarFooter'
import { SidebarRail } from './SidebarRail'
import { SessionsSection } from './SessionsSection'
import type { SftpContextMenuState } from './SftpContextMenu'
import { SftpSection } from './SftpSection'
import { ToolsSection } from './ToolsSection'
import { useSftpFollowTerminal } from './useSftpFollowTerminal'
import { useSessionImport } from './useSessionImport'
import { useSessionTreeDrag } from './useSessionTreeDrag'
import { useSftpSelection } from './useSftpSelection'
import {
  batchLocalPathLabel,
  compareSftpEntries,
  itemCountLabel,
  joinRemotePath,
  movedEnough,
  normalizeRemotePath,
  sidebarSftpErrorContext,
} from './sftpUtils'
import { buildSessionTree } from './sessionTree'
import type {
  MacroDefinition,
  RemoteDirectorySnapshot,
  RemoteFileEntry,
  SessionDefinition,
  SessionFolderDefinition,
  SidebarSection,
  WorkspaceTab,
} from '../../types/domain'
import { useSftpTableControls } from './useSftpTableControls'

interface SidebarProps {
  activeSection: SidebarSection
  activeTab: WorkspaceTab | undefined
  sessions: SessionDefinition[]
  sessionFolders: SessionFolderDefinition[]
  sshSftpLinks: SessionDefinition[]
  terminalCwdByTabId: Record<string, string>
  macros: MacroDefinition[]
  preferredSftpSessionId?: string
  onSelectSection: (section: SidebarSection) => void
  onOpenSession: (sessionId: string) => void
  onOpenLinkedSftp: (sessionId: string, linkedSshTabId?: string) => void
  onNewSession: () => void
  onNewSessionInFolder: (folderPath: string) => void
  onNewSessionFolder: (parentPath: string | null) => void
  onEditSession: (session: SessionDefinition) => void
  onMoveSession: (session: SessionDefinition) => void
  onDropFolderToFolder: (folderId: string, folderPath: string) => void
  onDropSessionToFolder: (sessionId: string, folderPath: string) => void
  onDeleteSession: (sessionId: string) => void
  onDeleteSessionFolder: (folderId: string) => void
  onNewMacro: () => void
  onEditMacro: (macro: MacroDefinition) => void
  onDeleteMacro: (macroId: string) => void
  onRunMacro: (command: string) => void
}

export function Sidebar({
  activeSection,
  activeTab,
  sessions,
  sessionFolders,
  sshSftpLinks,
  terminalCwdByTabId,
  macros,
  preferredSftpSessionId,
  onDeleteSessionFolder,
  onDeleteMacro,
  onDeleteSession,
  onEditMacro,
  onEditSession,
  onMoveSession,
  onDropFolderToFolder,
  onDropSessionToFolder,
  onNewMacro,
  onNewSessionFolder,
  onNewSession,
  onNewSessionInFolder,
  onOpenSession,
  onOpenLinkedSftp,
  onRunMacro,
  onSelectSection,
}: SidebarProps) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const uploadFolderInputRef = useRef<HTMLInputElement | null>(null)
  const sessionImportInputRef = useRef<HTMLInputElement | null>(null)
  const sftpListRef = useRef<HTMLDivElement | null>(null)
  const sessionListRef = useRef<HTMLDivElement | null>(null)
  const lastNativeSftpDropAtRef = useRef(0)
  const enqueueTransfer = useOpenXTermStore((state) => state.enqueueTransfer)
  const importMobaXtermSessions = useOpenXTermStore((state) => state.importMobaXtermSessions)
  const hasSftpLinks = sshSftpLinks.length > 0
  const [selectedSftpSessionId, setSelectedSftpSessionId] = useState<string | null>(null)
  const [snapshotsBySessionId, setSnapshotsBySessionId] = useState<Record<string, RemoteDirectorySnapshot>>({})
  const [dropActive, setDropActive] = useState(false)
  const [sftpLoading, setSftpLoading] = useState(false)
  const [sftpMessage, setSftpMessage] = useState('')
  const [newSftpFolderName, setNewSftpFolderName] = useState('')
  const [showNewSftpFolderForm, setShowNewSftpFolderForm] = useState(false)
  const [renamingSftpEntry, setRenamingSftpEntry] = useState<RemoteFileEntry | null>(null)
  const [renameSftpName, setRenameSftpName] = useState('')
  const [sftpContextMenu, setSftpContextMenu] = useState<SftpContextMenuState | null>(null)
  const [sftpPathDraft, setSftpPathDraft] = useState('/')
  const { handleSessionImportChange, sessionMessage } = useSessionImport(importMobaXtermSessions)
  const {
    handleSftpColumnResizeStart,
    handleSftpSortColumn,
    sftpSortState,
    sftpTableStyle,
  } = useSftpTableControls()
  const {
    consumeSuppressedSessionTreeClick,
    isSessionFolderExpanded,
    sessionDropTargetPath,
    sessionTreeDragState,
    startSessionTreePointerDrag,
    toggleSessionFolder,
  } = useSessionTreeDrag({
    onDropFolderToFolder,
    onDropSessionToFolder,
  })

  const selectedSftpSession =
    sshSftpLinks.find((session) => session.id === selectedSftpSessionId)
    ?? sshSftpLinks.find((session) => session.id === preferredSftpSessionId)
    ?? sshSftpLinks[0]

  const selectedSftpSnapshot = selectedSftpSession ? snapshotsBySessionId[selectedSftpSession.id] : undefined

  const loadSftpDirectory = useCallback(async (session: SessionDefinition, path: string) => {
    const normalizedPath = normalizeRemotePath(path)
    setSftpLoading(true)
    try {
      const snapshot = await listRemoteDirectory(session, normalizedPath)
      setSnapshotsBySessionId((current) => ({
        ...current,
        [session.id]: snapshot,
      }))
      setSftpPathDraft(snapshot.path)
      setSftpMessage(`Loaded ${snapshot.path}`)
      return true
    } catch (error) {
      logOpenXTermError('sidebar.sftp.load-directory', error, sidebarSftpErrorContext(session, 'load', normalizedPath))
      setSftpMessage(error instanceof Error ? error.message : 'Unable to load remote directory.')
      return false
    } finally {
      setSftpLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!sshSftpLinks.length) {
      setSelectedSftpSessionId(null)
      setSnapshotsBySessionId({})
      return
    }

    if (preferredSftpSessionId && sshSftpLinks.some((session) => session.id === preferredSftpSessionId)) {
      setSelectedSftpSessionId(preferredSftpSessionId)
      return
    }

    setSelectedSftpSessionId((current) => {
      if (current && sshSftpLinks.some((session) => session.id === current)) {
        return current
      }
      return sshSftpLinks[0]?.id ?? null
    })
  }, [preferredSftpSessionId, sshSftpLinks])

  useEffect(() => {
    if (activeSection !== 'sftp' || !selectedSftpSession) {
      return
    }

    if (selectedSftpSnapshot) {
      return
    }

    void loadSftpDirectory(selectedSftpSession, '/')
  }, [activeSection, loadSftpDirectory, selectedSftpSession, selectedSftpSnapshot])

  useEffect(() => {
    if (!sftpContextMenu) {
      return
    }

    const closeMenu = () => setSftpContextMenu(null)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu()
      }
    }

    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [sftpContextMenu])

  const currentSftpPath = selectedSftpSnapshot?.path ?? '/'
  const sftpEntries = useMemo(() => {
    if (!selectedSftpSnapshot) {
      return []
    }

    return [...selectedSftpSnapshot.entries].sort((left, right) => (
      compareSftpEntries(left, right, sftpSortState.key, sftpSortState.direction)
    ))
  }, [selectedSftpSnapshot, sftpSortState.direction, sftpSortState.key])
  const {
    selectedOrEntry,
    selectedSftpEntries,
    selectedSftpEntryPaths,
    selectSftpEntry,
    setSelectedSftpEntryPaths,
  } = useSftpSelection(sftpEntries)
  const {
    conflictRequest: sftpConflictRequest,
    hasEntryNamed: hasSftpEntryNamed,
    resolveConflict: handleSftpConflictResolve,
    resolveDownloadTarget: resolveSftpDownloadTarget,
    resolveUploadTargets: resolveSftpUploadTargets,
  } = useSftpConflictResolver(sftpEntries)
  const sessionTree = useMemo(() => buildSessionTree(sessions, sessionFolders), [sessionFolders, sessions])

  useEffect(() => {
    setSftpPathDraft(currentSftpPath)
  }, [currentSftpPath])

  function startRenameSftpEntry(entry: RemoteFileEntry) {
    setSftpContextMenu(null)
    setSelectedSftpEntryPaths(selectedOrEntry(entry).map((item) => item.path))
    setRenamingSftpEntry(entry)
    setRenameSftpName(entry.name)
  }

  const loadSelectedSftpDirectory = useCallback(async (path: string) => {
    if (!selectedSftpSession) {
      return false
    }

    const loaded = await loadSftpDirectory(selectedSftpSession, path)
    setSelectedSftpEntryPaths([])
    return loaded
  }, [loadSftpDirectory, selectedSftpSession, setSelectedSftpEntryPaths])
  const {
    canFollowRemoteTerminal,
    followedSftpPath,
    followRemoteTerminal,
    setFollowRemoteTerminal,
  } = useSftpFollowTerminal({
    currentPath: currentSftpPath,
    loadDirectory: loadSelectedSftpDirectory,
    loading: sftpLoading,
    selectedSession: selectedSftpSession,
    terminalCwdByTabId,
  })
  const {
    closeProperties: closeSftpProperties,
    handlePropertiesApplied: handleSftpPropertiesApplied,
    openProperties: openSftpProperties,
    propertiesEntry: sftpPropertiesEntry,
  } = useRemotePropertiesWindow({
    closeContextMenu: () => setSftpContextMenu(null),
    currentPath: currentSftpPath,
    errorContext: sidebarSftpErrorContext,
    errorScope: 'sidebar.sftp.properties-result',
    loadDirectory: loadSftpDirectory,
    selectedSession: selectedSftpSession,
    sessions: sshSftpLinks,
    setMessage: setSftpMessage,
    setSelectedEntryPaths: setSelectedSftpEntryPaths,
  })

  async function handleSftpPathSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await loadSelectedSftpDirectory(sftpPathDraft)
  }

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) {
      return
    }

    let disposed = false
    let unlisten: (() => void) | null = null

    void getCurrentWebview().onDragDropEvent((event) => {
      if (disposed || activeSection !== 'sftp' || !selectedSftpSession || !sftpListRef.current) {
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

      void (async () => {
        const uploadItems = await resolveSftpUploadTargets(
          droppedPaths.map((localPath) => ({
            localPath,
            name: localPathBaseName(localPath),
          })),
          (name) => joinRemotePath(currentSftpPath, name),
        )
        if (uploadItems.length === 0) {
          setSftpMessage('Upload skipped.')
          return
        }

        setSftpLoading(true)
        const transferIds: string[] = []
        try {
          const transferItems = queueBatchTransfers({
            items: uploadItems,
            prefix: 'upload',
            enqueueTransfer,
            parent: (items) => ({
              fileName: itemCountLabel(items.length),
              remotePath: currentSftpPath,
              direction: 'upload',
              purpose: 'upload',
              state: 'queued',
              transferredBytes: 0,
              totalBytes: undefined,
              localPath: batchLocalPathLabel(items.map((item) => item.localPath)),
              message: `Queued ${items.length} items for upload`,
            }),
            child: (item) => ({
              fileName: item.targetName,
              remotePath: joinRemotePath(currentSftpPath, item.targetName),
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
            await uploadLocalPath(selectedSftpSession, currentSftpPath, item.localPath, transferId, item.targetName, item.conflictAction)
          }
          setSftpMessage(`Uploaded ${uploadItems.length} item${uploadItems.length > 1 ? 's' : ''} to ${currentSftpPath}`)
          await loadSelectedSftpDirectory(currentSftpPath)
        } catch (error) {
          if (isTransferCanceledError(error)) {
            setSftpMessage('Transfer canceled.')
            return
          }
          logOpenXTermError('sidebar.sftp.drop-upload', error, {
            ...sidebarSftpErrorContext(selectedSftpSession, 'drop-upload', currentSftpPath),
            droppedPaths,
            transferIds,
          })
          setSftpMessage(error instanceof Error ? error.message : 'Unable to upload dropped file.')
        } finally {
          setSftpLoading(false)
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
  }, [activeSection, currentSftpPath, enqueueTransfer, hasSftpEntryNamed, loadSelectedSftpDirectory, resolveSftpUploadTargets, selectedSftpSession])

  async function uploadSidebarBrowserFiles(files: File[], source: 'upload' | 'drop-upload') {
    if (files.length === 0 || !selectedSftpSession) {
      return
    }

    const uploadItems = await resolveSftpUploadTargets(
      files.map((file) => ({ file, name: file.name })),
      (name) => joinRemotePath(currentSftpPath, name),
    )
    if (uploadItems.length === 0) {
      setSftpMessage('Upload skipped.')
      return
    }

    setSftpLoading(true)
    try {
      const transferItems = queueBatchTransfers({
        items: uploadItems,
        prefix: 'upload',
        enqueueTransfer,
        parent: (items) => ({
          fileName: itemCountLabel(items.length),
          remotePath: currentSftpPath,
          direction: 'upload',
          purpose: 'upload',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: items.reduce((sum, item) => sum + item.file.size, 0),
          message: `Queued ${items.length} files for upload`,
        }),
        child: (item) => ({
          fileName: item.targetName,
          remotePath: joinRemotePath(currentSftpPath, item.targetName),
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
        await uploadRemoteFile(selectedSftpSession, currentSftpPath, item.targetName, bytes, transferId, item.conflictAction)
      }
      setSftpMessage(`Uploaded ${uploadItems.length} file${uploadItems.length > 1 ? 's' : ''} to ${currentSftpPath}`)
      await loadSelectedSftpDirectory(currentSftpPath)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setSftpMessage('Transfer canceled.')
        return
      }
      logOpenXTermError(`sidebar.sftp.${source}`, error, {
        ...sidebarSftpErrorContext(selectedSftpSession, source, currentSftpPath),
        files: uploadItems.map((item) => ({ name: item.file.name, targetName: item.targetName, size: item.file.size })),
      })
      setSftpMessage(error instanceof Error ? error.message : 'Unable to upload file.')
    } finally {
      setSftpLoading(false)
    }
  }

  async function handleSidebarUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files
    if (!fileList || fileList.length === 0 || !selectedSftpSession) {
      return
    }

    try {
      await uploadSidebarBrowserFiles(Array.from(fileList), 'upload')
    } finally {
      event.target.value = ''
    }
  }

  function handleSidebarBrowserDrag(event: ReactDragEvent<HTMLDivElement>) {
    if (!selectedSftpSession || !Array.from(event.dataTransfer.types).includes('Files')) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  function handleSidebarBrowserDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return
    }

    setDropActive(false)
  }

  async function handleSidebarBrowserDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!selectedSftpSession) {
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

    await uploadSidebarBrowserFiles(files, 'drop-upload')
  }

  async function ensureRemoteDirectoryPath(path: string) {
    if (!selectedSftpSession || path === '/') {
      return
    }

    let current = '/'
    for (const segment of path.split('/').filter(Boolean)) {
      try {
        await createRemoteDirectory(selectedSftpSession, current, segment)
      } catch {
        // Existing directories are fine; the following upload/list operation will surface real path errors.
      }
      current = joinRemotePath(current, segment)
    }
  }

  async function handleSidebarUploadFolderChange(event: ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files
    if (!fileList || fileList.length === 0 || !selectedSftpSession) {
      return
    }

    setSftpLoading(true)
    try {
      const files = Array.from(fileList)
      const rootFolderName = files[0]?.webkitRelativePath?.split('/').filter(Boolean)[0] ?? 'folder'
      const rootResolution = await resolveSftpUploadTargets(
        [{ name: rootFolderName }],
        (name) => joinRemotePath(currentSftpPath, name),
      )
      if (rootResolution.length === 0) {
        setSftpMessage('Folder upload skipped.')
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
          ? parts.slice(0, -1).reduce((path, segment) => joinRemotePath(path, segment), currentSftpPath)
          : currentSftpPath

        return { file, fileName, remoteDir }
      })
      const transferItems = queueBatchTransfers({
        items: folderUploadItems,
        prefix: 'upload',
        enqueueTransfer,
        parent: (items) => ({
          fileName: rootTargetName,
          remotePath: joinRemotePath(currentSftpPath, rootTargetName),
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
        await uploadRemoteFile(selectedSftpSession, item.remoteDir, item.fileName, bytes, transferId, rootConflictAction)
      }
      setSftpMessage(`Uploaded folder contents to ${currentSftpPath}`)
      await loadSelectedSftpDirectory(currentSftpPath)
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setSftpMessage('Transfer canceled.')
        return
      }
      logOpenXTermError('sidebar.sftp.upload-folder', error, {
        ...sidebarSftpErrorContext(selectedSftpSession, 'upload-folder', currentSftpPath),
        files: Array.from(fileList).map((file) => ({
          name: file.name,
          relativePath: file.webkitRelativePath,
          size: file.size,
        })),
      })
      setSftpMessage(error instanceof Error ? error.message : 'Unable to upload folder.')
    } finally {
      setSftpLoading(false)
      event.target.value = ''
    }
  }

  async function handleCreateFolder(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!selectedSftpSession) {
      return
    }

    const name = newSftpFolderName
    if (!name || !name.trim()) {
      setSftpMessage('Enter a folder name.')
      return
    }

    setSftpLoading(true)
    try {
      await createRemoteDirectory(selectedSftpSession, currentSftpPath, name.trim())
      setSftpMessage(`Created folder ${name.trim()}`)
      setNewSftpFolderName('')
      setShowNewSftpFolderForm(false)
      await loadSelectedSftpDirectory(currentSftpPath)
    } catch (error) {
      logOpenXTermError('sidebar.sftp.create-folder', error, {
        ...sidebarSftpErrorContext(selectedSftpSession, 'create-folder', currentSftpPath),
        folderName: name.trim(),
      })
      setSftpMessage(error instanceof Error ? error.message : 'Unable to create remote folder.')
    } finally {
      setSftpLoading(false)
    }
  }

  async function handleRenameEntry(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!selectedSftpSession || !renamingSftpEntry) {
      return
    }

    const nextName = renameSftpName.trim()
    if (!nextName) {
      setSftpMessage('Enter a new name.')
      return
    }
    if (nextName.includes('/') || nextName.includes('\\')) {
      setSftpMessage('Names cannot contain path separators.')
      return
    }
    if (hasSftpEntryNamed(nextName, renamingSftpEntry.path)) {
      setSftpMessage(`${nextName} already exists in this directory.`)
      return
    }

    setSftpLoading(true)
    try {
      await renameRemoteEntry(selectedSftpSession, renamingSftpEntry.path, nextName)
      setSftpMessage(`Renamed ${renamingSftpEntry.name} to ${nextName}`)
      setRenamingSftpEntry(null)
      setRenameSftpName('')
      await loadSelectedSftpDirectory(currentSftpPath)
    } catch (error) {
      logOpenXTermError('sidebar.sftp.rename-entry', error, {
        ...sidebarSftpErrorContext(selectedSftpSession, 'rename', currentSftpPath),
        path: renamingSftpEntry.path,
        newName: nextName,
      })
      setSftpMessage(error instanceof Error ? error.message : 'Unable to rename remote entry.')
    } finally {
      setSftpLoading(false)
    }
  }

  async function handleDeleteEntry(entries = selectedSftpEntries) {
    if (!selectedSftpSession || entries.length === 0) {
      return
    }

    setSftpLoading(true)
    try {
      for (const entry of entries) {
        await deleteRemoteEntry(selectedSftpSession, entry.path, entry.kind)
      }
      setSftpMessage(entries.length === 1 ? `Deleted ${entries[0].name}` : `Deleted ${entries.length} items`)
      await loadSelectedSftpDirectory(currentSftpPath)
    } catch (error) {
      logOpenXTermError('sidebar.sftp.delete-entry', error, {
        ...sidebarSftpErrorContext(selectedSftpSession, 'delete', currentSftpPath),
        entries: entries.map((entry) => ({ path: entry.path, kind: entry.kind })),
      })
      setSftpMessage(error instanceof Error ? error.message : 'Unable to delete remote entry.')
    } finally {
      setSftpLoading(false)
    }
  }

  async function handleDownloadEntry(entries = selectedSftpEntries) {
    if (!selectedSftpSession || entries.length === 0) {
      return
    }

    setSftpLoading(true)
    try {
      let lastResult = ''
      let applyToAll: FileConflictResolution | null = null
      const downloadItems: Array<{
        entry: RemoteFileEntry
        targetName: string
        conflictAction: 'overwrite' | 'error'
      }> = []

      for (const entry of entries) {
        const target = await resolveSftpDownloadTarget(entry, entries.length > 1, applyToAll)
        applyToAll = target.resolution
        if (!target.skipped) {
          downloadItems.push({
            entry,
            targetName: target.targetName,
            conflictAction: target.conflictAction,
          })
        }
      }

      if (downloadItems.length === 0) {
        setSftpMessage('Download skipped.')
        return
      }

      const knownTotalBytes = downloadItems.every((item) => item.entry.kind === 'file' && typeof item.entry.sizeBytes === 'number')
        ? downloadItems.reduce((sum, item) => sum + (item.entry.sizeBytes ?? 0), 0)
        : undefined
      const transferItems = queueBatchTransfers({
        items: downloadItems,
        prefix: 'download',
        enqueueTransfer,
        parent: (items) => ({
          fileName: itemCountLabel(items.length),
          remotePath: currentSftpPath,
          direction: 'download',
          purpose: 'download',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: knownTotalBytes,
          message: `Queued ${items.length} items for download`,
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

      for (const { item, transferId } of transferItems) {
        const { entry } = item
        const result = await downloadRemoteEntry(selectedSftpSession, entry.path, entry.kind, transferId, item.targetName, item.conflictAction)
        lastResult = `${result.fileName} -> ${result.savedTo}`
      }
      setSftpMessage(
        downloadItems.length === 1
          ? `Downloaded ${lastResult}`
          : `Downloaded ${downloadItems.length} item${downloadItems.length > 1 ? 's' : ''}`,
      )
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setSftpMessage('Transfer canceled.')
        return
      }
      logOpenXTermError('sidebar.sftp.download-entry', error, {
        ...sidebarSftpErrorContext(selectedSftpSession, 'download', currentSftpPath),
        entries: entries.map((entry) => ({ path: entry.path, kind: entry.kind })),
      })
      setSftpMessage(error instanceof Error ? error.message : 'Unable to download remote item.')
    } finally {
      setSftpLoading(false)
    }
  }

  function handleSftpEntryOpen(entry: RemoteFileEntry) {
    if (entry.kind === 'folder') {
      void loadSelectedSftpDirectory(entry.path)
      return
    }

    const sourceSessionId = selectedSftpSession?.linkedSshSessionId ?? selectedSftpSession?.id.replace('linked-sftp-', '')
    if (sourceSessionId) {
      onOpenLinkedSftp(sourceSessionId, selectedSftpSession?.linkedSshTabId)
    }
  }

  function handleNativeDragPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    entry: RemoteFileEntry,
    source: 'row' | 'handle' = 'row',
  ) {
    if (!selectedSftpSession || event.button !== 0) {
      return
    }

    const target = event.target as HTMLElement
    if (source === 'row' && target.closest('button,input,textarea,select,a,[data-no-row-drag="true"]')) {
      return
    }

    if (source === 'handle') {
      event.preventDefault()
      event.stopPropagation()
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Some webview edge cases do not allow capture after the native drag starts.
    }

    const startX = event.clientX
    const startY = event.clientY
    let started = false
    const previousUserSelect = document.body.style.userSelect
    const previousWebkitUserSelect = document.body.style.webkitUserSelect
    const previousCursor = document.body.style.cursor

    document.body.style.userSelect = 'none'
    document.body.style.webkitUserSelect = 'none'
    document.body.style.cursor = 'grabbing'

    window.getSelection()?.removeAllRanges()

    const cleanupDragListeners = () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
      document.body.style.userSelect = previousUserSelect
      document.body.style.webkitUserSelect = previousWebkitUserSelect
      document.body.style.cursor = previousCursor
    }

    const startDrag = (moveEvent: PointerEvent) => {
      if (started) {
        return
      }

      started = true
      cleanupDragListeners()
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // The pointer may already be released by the webview when native drag starts.
      }
      moveEvent.preventDefault()
      moveEvent.stopPropagation()
      const dragEntries = selectedOrEntry(entry)
      setSelectedSftpEntryPaths(dragEntries.map((item) => item.path))
      const batchTransferId = dragEntries.length > 1 ? createBatchTransferId('drag-export') : null
      if (batchTransferId) {
        const knownTotalBytes = dragEntries.every((item) => item.kind === 'file' && typeof item.sizeBytes === 'number')
          ? dragEntries.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)
          : undefined
        rememberBatchTransfer({
          transferId: batchTransferId,
          fileName: itemCountLabel(dragEntries.length),
          remotePath: currentSftpPath,
          direction: 'download',
          purpose: 'drag-export',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: knownTotalBytes,
          itemCount: dragEntries.length,
          message: `Preparing ${dragEntries.length} items for drag copy`,
        })
      }
      void startNativeEntriesDrag(
        selectedSftpSession,
        dragEntries.map((item, index) => ({
          remotePath: item.path,
          fileName: item.name,
          kind: item.kind,
          sizeBytes: item.sizeBytes,
          transferId: batchTransferId
            ? createBatchChildTransferId(batchTransferId, index, dragEntries.length)
            : undefined,
        })),
        moveEvent.clientX,
        moveEvent.clientY,
      )
        .then((dragStarted) => {
          if (!dragStarted) {
            setSftpMessage('Native drag-out could not start for the selected item(s).')
          }
        })
        .catch((error) => {
          setSftpMessage(error instanceof Error ? error.message : 'Native drag-out failed.')
        })
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      window.getSelection()?.removeAllRanges()
      if (started || !movedEnough(startX, startY, moveEvent.clientX, moveEvent.clientY)) {
        if (source === 'handle') {
          moveEvent.preventDefault()
          moveEvent.stopPropagation()
        }
        return
      }

      startDrag(moveEvent)
    }

    const handlePointerUp = (moveEvent: PointerEvent) => {
      if (source === 'handle') {
        moveEvent.preventDefault()
        moveEvent.stopPropagation()
      }
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // Some webview edge cases release capture before pointerup reaches this handler.
      }
      cleanupDragListeners()
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)
  }

  return (
    <aside className="sidebar">
      <SidebarRail
        activeSection={activeSection}
        hasSftpLinks={hasSftpLinks}
        onSelectSection={onSelectSection}
      />

      <div className="sidebar-panel">
        {activeSection === 'sessions' && (
          <SessionsSection
            activeTab={activeTab}
            sessionDropTargetPath={sessionDropTargetPath}
            sessionImportInputRef={sessionImportInputRef}
            sessionListRef={sessionListRef}
            sessionMessage={sessionMessage}
            sessionTree={sessionTree}
            sessionTreeDragState={sessionTreeDragState}
            isSessionFolderExpanded={isSessionFolderExpanded}
            onConsumeSuppressedSessionTreeClick={consumeSuppressedSessionTreeClick}
            onDeleteSession={onDeleteSession}
            onDeleteSessionFolder={onDeleteSessionFolder}
            onEditSession={onEditSession}
            onMoveSession={onMoveSession}
            onNewSession={onNewSession}
            onNewSessionInFolder={onNewSessionInFolder}
            onNewSessionFolder={onNewSessionFolder}
            onOpenSession={onOpenSession}
            onSessionImportChange={handleSessionImportChange}
            onStartSessionTreePointerDrag={startSessionTreePointerDrag}
            onToggleSessionFolder={toggleSessionFolder}
          />
        )}

        {activeSection === 'sftp' && (
          <SftpSection
            currentSftpPath={currentSftpPath}
            dropActive={dropActive}
            entries={sftpEntries}
            listRef={sftpListRef}
            newFolderName={newSftpFolderName}
            propertiesEntry={sftpPropertiesEntry}
            renameName={renameSftpName}
            renamingEntry={renamingSftpEntry}
            selectedEntryCount={selectedSftpEntries.length}
            selectedEntryPaths={selectedSftpEntryPaths}
            selectedSession={selectedSftpSession}
            sftpConflictRequest={sftpConflictRequest}
            sftpContextMenu={sftpContextMenu}
            sftpLoading={sftpLoading}
            sftpMessage={sftpMessage}
            sftpPathDraft={sftpPathDraft}
            showNewFolderForm={showNewSftpFolderForm}
            sortState={sftpSortState}
            tableStyle={sftpTableStyle}
            uploadFolderInputRef={uploadFolderInputRef}
            uploadInputRef={uploadInputRef}
            onColumnResizeStart={handleSftpColumnResizeStart}
            onContextMenuDelete={(entry) => {
              const entries = selectedOrEntry(entry)
              setSftpContextMenu(null)
              void handleDeleteEntry(entries)
            }}
            onContextMenuDownload={(entry) => {
              setSelectedSftpEntryPaths(selectedOrEntry(entry).map((item) => item.path))
              setSftpContextMenu(null)
              void handleDownloadEntry(selectedOrEntry(entry))
            }}
            onCreateFolder={(event) => void handleCreateFolder(event)}
            onCreateFolderToggle={() => setShowNewSftpFolderForm((value) => !value)}
            onDelete={() => void handleDeleteEntry()}
            onDownload={() => void handleDownloadEntry()}
            onDragEnter={handleSidebarBrowserDrag}
            onDragLeave={handleSidebarBrowserDragLeave}
            onDragOver={handleSidebarBrowserDrag}
            onDrop={(event) => void handleSidebarBrowserDrop(event)}
            onEntryClick={selectSftpEntry}
            onEntryContextMenu={(entry, event) => {
              event.preventDefault()
              event.stopPropagation()
              setSelectedSftpEntryPaths(selectedOrEntry(entry).map((item) => item.path))
              setSftpContextMenu({ entry, x: event.clientX, y: event.clientY })
            }}
            onEntryDelete={(entry) => {
              setSelectedSftpEntryPaths(selectedOrEntry(entry).map((item) => item.path))
              void handleDeleteEntry(selectedOrEntry(entry))
            }}
            onEntryOpen={handleSftpEntryOpen}
            onEntryPointerDown={handleNativeDragPointerDown}
            onLoadDirectory={(path) => void loadSelectedSftpDirectory(path)}
            onNewFolderCancel={() => {
              setShowNewSftpFolderForm(false)
              setNewSftpFolderName('')
            }}
            onNewFolderNameChange={setNewSftpFolderName}
            onPathDraftChange={setSftpPathDraft}
            onPathSubmit={(event) => void handleSftpPathSubmit(event)}
            onPropertiesApplied={handleSftpPropertiesApplied}
            onPropertiesClose={closeSftpProperties}
            onPropertiesOpen={(entry) => void openSftpProperties(entry)}
            onRename={(event) => void handleRenameEntry(event)}
            onRenameCancel={() => {
              setRenamingSftpEntry(null)
              setRenameSftpName('')
            }}
            onRenameNameChange={setRenameSftpName}
            onRenameStart={startRenameSftpEntry}
            onSftpConflictResolve={handleSftpConflictResolve}
            onSortColumn={handleSftpSortColumn}
            onUploadChange={(event) => void handleSidebarUploadChange(event)}
            onUploadFolderChange={(event) => void handleSidebarUploadFolderChange(event)}
          />
        )}

        {activeSection === 'tools' && (
          <ToolsSection />
        )}

        {activeSection === 'macros' && (
          <MacrosSection
            macros={macros}
            onDeleteMacro={onDeleteMacro}
            onEditMacro={onEditMacro}
            onNewMacro={onNewMacro}
            onRunMacro={onRunMacro}
          />
        )}

        <SidebarFooter
          canFollowRemoteTerminal={canFollowRemoteTerminal}
          followedSftpPath={followedSftpPath}
          followRemoteTerminal={followRemoteTerminal}
          onFollowRemoteTerminalChange={setFollowRemoteTerminal}
        />
      </div>
    </aside>
  )
}
