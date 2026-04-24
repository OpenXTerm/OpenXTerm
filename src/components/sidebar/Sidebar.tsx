import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import {
  ArrowDownToLine,
  ArrowUp,
  Bot,
  Cable,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderClosed,
  FolderPlus,
  FolderTree,
  FolderUp,
  HardDrive,
  Pencil,
  Play,
  RefreshCw,
  Server,
  Terminal,
  Trash2,
  Upload,
  Usb,
  Wrench,
} from 'lucide-react'

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
import type { SessionImportSummary } from '../../state/useOpenXTermStore'
import { splitSessionFolderPath } from '../../lib/sessionUtils'
import { createBatchChildTransferId, createBatchTransferId, rememberBatchTransfer } from '../../lib/transferBatch'
import { parseMobaXtermSessionsFile } from '../../lib/mobaxtermImport'
import { useOpenXTermStore } from '../../state/useOpenXTermStore'
import type {
  MacroDefinition,
  RemoteDirectorySnapshot,
  RemoteFileEntry,
  SessionDefinition,
  SessionFolderDefinition,
  SidebarSection,
  WorkspaceTab,
} from '../../types/domain'

interface SidebarProps {
  activeSection: SidebarSection
  activeTab: WorkspaceTab | undefined
  sessions: SessionDefinition[]
  sessionFolders: SessionFolderDefinition[]
  sshSftpLinks: SessionDefinition[]
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

const tools = [
  { name: 'Port Scanner', note: 'Reserved for the next transport pass.' },
  { name: 'Ping', note: 'Quick latency and packet-loss checks.' },
  { name: 'Network Tools', note: 'DNS, traceroute and capture helpers.' },
]

const SFTP_TABLE_COLUMN_LABELS = ['Name', 'Size (KB)', 'Last modified', 'Owner', 'Group', 'Access']
const SFTP_TABLE_DEFAULT_COLUMN_WIDTHS = [220, 82, 132, 82, 82, 104]
const SFTP_TABLE_MIN_COLUMN_WIDTHS = [140, 58, 96, 58, 58, 78]

function remoteSizeKbLabel(entry: RemoteFileEntry) {
  if (entry.kind === 'folder') {
    return ''
  }

  if (typeof entry.sizeBytes === 'number') {
    return Math.max(1, Math.ceil(entry.sizeBytes / 1024)).toLocaleString()
  }

  return entry.sizeLabel === '--' ? '' : entry.sizeLabel
}

function sidebarSftpErrorContext(session: SessionDefinition, action: string, path: string) {
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

function getSessionIcon(kind: SessionDefinition['kind']) {
  switch (kind) {
    case 'ssh':
      return <Server size={13} />
    case 'local':
      return <Terminal size={13} />
    case 'telnet':
      return <Cable size={13} />
    case 'serial':
      return <Usb size={13} />
    case 'sftp':
    case 'ftp':
      return <HardDrive size={13} />
  }
}

function movedEnough(startX: number, startY: number, currentX: number, currentY: number) {
  return Math.hypot(currentX - startX, currentY - startY) > 5
}

function joinRemotePath(parent: string, name: string) {
  return parent === '/' ? `/${name.replace(/^\/+/, '')}` : `${parent.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`
}

function itemCountLabel(count: number) {
  return count === 1 ? '1 item' : `${count} items`
}

function batchLocalPathLabel(paths: string[]) {
  if (paths.length === 0) {
    return undefined
  }

  return paths.length === 1 ? paths[0] : `${paths.length} local items`
}

interface SessionTreeFolder {
  key: string
  folderId?: string
  name: string
  path: string
  explicit: boolean
  folders: SessionTreeFolder[]
  sessions: SessionDefinition[]
}

interface SessionTreeRoot {
  folders: SessionTreeFolder[]
  sessions: SessionDefinition[]
}

function buildSessionTree(sessions: SessionDefinition[], sessionFolders: SessionFolderDefinition[]): SessionTreeRoot {
  const root: SessionTreeRoot = { folders: [], sessions: [] }
  const folderIndex = new Map<string, SessionTreeFolder>()

  const ensureFolderPath = (path: string, explicitFolder?: SessionFolderDefinition) => {
    const segments = splitSessionFolderPath(path)
    let currentFolders = root.folders
    let currentFolder: SessionTreeFolder | null = null
    let currentPath = ''

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let folder = folderIndex.get(currentPath)

      if (!folder) {
        folder = {
          key: `session-folder:${currentPath}`,
          folderId: undefined,
          name: segment,
          path: currentPath,
          explicit: false,
          folders: [],
          sessions: [],
        }
        folderIndex.set(currentPath, folder)
        currentFolders.push(folder)
      }

      if (explicitFolder && explicitFolder.path === currentPath) {
        folder.explicit = true
        folder.folderId = explicitFolder.id
      }

      currentFolder = folder
      currentFolders = folder.folders
    }
    return currentFolder
  }

  for (const folder of sessionFolders) {
    ensureFolderPath(folder.path, folder)
  }

  for (const session of sessions) {
    const normalizedFolderPath = session.folderPath
    if (!normalizedFolderPath) {
      root.sessions.push(session)
      continue
    }

    ensureFolderPath(normalizedFolderPath)?.sessions.push(session)
  }

  const sortFolder = (folder: SessionTreeFolder) => {
    folder.folders.sort((left, right) => left.name.localeCompare(right.name))
    folder.sessions.sort((left, right) => left.name.localeCompare(right.name))
    folder.folders.forEach(sortFolder)
  }

  root.folders.sort((left, right) => left.name.localeCompare(right.name))
  root.sessions.sort((left, right) => left.name.localeCompare(right.name))
  root.folders.forEach(sortFolder)

  return root
}

function countFolderSessions(folder: SessionTreeFolder): number {
  return folder.sessions.length + folder.folders.reduce((total, child) => total + countFolderSessions(child), 0)
}

function folderContainsSession(folder: SessionTreeFolder, sessionId: string | undefined): boolean {
  if (!sessionId) {
    return false
  }

  if (folder.sessions.some((session) => session.id === sessionId)) {
    return true
  }

  return folder.folders.some((child) => folderContainsSession(child, sessionId))
}

function sessionCountLabel(count: number) {
  return count === 1 ? '1 session' : `${count} sessions`
}

const SESSION_ROOT_DROP_TARGET = '__root__'

type SessionSidebarDragState =
  | { kind: 'session', session: SessionDefinition }
  | { kind: 'folder', folder: SessionTreeFolder }

interface SftpContextMenuState {
  entry: RemoteFileEntry
  x: number
  y: number
}

export function Sidebar({
  activeSection,
  activeTab,
  sessions,
  sessionFolders,
  sshSftpLinks,
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
  const sessionDropTargetPathRef = useRef<string | null>(null)
  const lastNativeSftpDropAtRef = useRef(0)
  const suppressSessionTreeClickRef = useRef(false)
  const enqueueTransfer = useOpenXTermStore((state) => state.enqueueTransfer)
  const importMobaXtermSessions = useOpenXTermStore((state) => state.importMobaXtermSessions)
  const hasSftpLinks = sshSftpLinks.length > 0
  const [selectedSftpSessionId, setSelectedSftpSessionId] = useState<string | null>(null)
  const [snapshotsBySessionId, setSnapshotsBySessionId] = useState<Record<string, RemoteDirectorySnapshot>>({})
  const [selectedSftpEntryPaths, setSelectedSftpEntryPaths] = useState<string[]>([])
  const [dropActive, setDropActive] = useState(false)
  const [sftpLoading, setSftpLoading] = useState(false)
  const [sftpMessage, setSftpMessage] = useState('')
  const [newSftpFolderName, setNewSftpFolderName] = useState('')
  const [showNewSftpFolderForm, setShowNewSftpFolderForm] = useState(false)
  const [renamingSftpEntry, setRenamingSftpEntry] = useState<RemoteFileEntry | null>(null)
  const [renameSftpName, setRenameSftpName] = useState('')
  const [sftpContextMenu, setSftpContextMenu] = useState<SftpContextMenuState | null>(null)
  const [sftpColumnWidths, setSftpColumnWidths] = useState(SFTP_TABLE_DEFAULT_COLUMN_WIDTHS)
  const [sessionMessage, setSessionMessage] = useState('')
  const [expandedSessionFolders, setExpandedSessionFolders] = useState<Record<string, boolean>>({})
  const [sessionTreeDragState, setSessionTreeDragState] = useState<SessionSidebarDragState | null>(null)
  const [sessionDropTargetPath, setSessionDropTargetPath] = useState<string | null>(null)

  const selectedSftpSession =
    sshSftpLinks.find((session) => session.id === selectedSftpSessionId)
    ?? sshSftpLinks.find((session) => session.id === preferredSftpSessionId)
    ?? sshSftpLinks[0]

  const selectedSftpSnapshot = selectedSftpSession ? snapshotsBySessionId[selectedSftpSession.id] : undefined
  const sftpTableStyle = useMemo(
    () => ({
      '--sftp-table-columns': `${sftpColumnWidths.map((width) => `${width}px`).join(' ')} 28px`,
    }) as CSSProperties,
    [sftpColumnWidths],
  )

  function handleSftpColumnResizeStart(index: number, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    const startWidth = sftpColumnWidths[index]

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const minWidth = SFTP_TABLE_MIN_COLUMN_WIDTHS[index] ?? 58
      const nextWidth = Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX))
      setSftpColumnWidths((current) => current.map((width, columnIndex) => (
        columnIndex === index ? nextWidth : width
      )))
    }

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  const loadSftpDirectory = useCallback(async (session: SessionDefinition, path: string) => {
    setSftpLoading(true)
    try {
      const snapshot = await listRemoteDirectory(session, path)
      setSnapshotsBySessionId((current) => ({
        ...current,
        [session.id]: snapshot,
      }))
      setSftpMessage(`Loaded ${snapshot.path}`)
    } catch (error) {
      logOpenXTermError('sidebar.sftp.load-directory', error, sidebarSftpErrorContext(session, 'load', path))
      setSftpMessage(error instanceof Error ? error.message : 'Unable to load remote directory.')
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
  const selectedSftpEntries = selectedSftpSnapshot
    ? selectedSftpEntryPaths
      .map((path) => selectedSftpSnapshot.entries.find((entry) => entry.path === path))
      .filter((entry): entry is RemoteFileEntry => Boolean(entry))
    : []
  const sftpEntries = useMemo(() => {
    if (!selectedSftpSnapshot) {
      return []
    }

    return [...selectedSftpSnapshot.entries].sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'folder' ? -1 : 1
      }

      return left.name.localeCompare(right.name)
    })
  }, [selectedSftpSnapshot])
  const sessionTree = useMemo(() => buildSessionTree(sessions, sessionFolders), [sessionFolders, sessions])

  function selectSftpEntry(entry: RemoteFileEntry, event?: ReactMouseEvent) {
    setSelectedSftpEntryPaths((current) => {
      if (event?.shiftKey && current.length > 0) {
        const anchorPath = current[current.length - 1]
        const anchorIndex = sftpEntries.findIndex((item) => item.path === anchorPath)
        const targetIndex = sftpEntries.findIndex((item) => item.path === entry.path)
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const start = Math.min(anchorIndex, targetIndex)
          const end = Math.max(anchorIndex, targetIndex)
          return sftpEntries.slice(start, end + 1).map((item) => item.path)
        }
      }

      if (event?.metaKey || event?.ctrlKey) {
        return current.includes(entry.path)
          ? current.filter((path) => path !== entry.path)
          : [...current, entry.path]
      }

      return [entry.path]
    })
  }

  function selectedOrEntry(entry: RemoteFileEntry) {
    if (selectedSftpEntryPaths.includes(entry.path)) {
      return selectedSftpEntries
    }

    return [entry]
  }

  const hasSftpEntryNamed = useCallback((name: string, ignoredPath?: string) => {
    return sftpEntries.some((entry) => entry.name === name && entry.path !== ignoredPath)
  }, [sftpEntries])

  function startRenameSftpEntry(entry: RemoteFileEntry) {
    setSftpContextMenu(null)
    setSelectedSftpEntryPaths(selectedOrEntry(entry).map((item) => item.path))
    setRenamingSftpEntry(entry)
    setRenameSftpName(entry.name)
  }

  const loadSelectedSftpDirectory = useCallback(async (path: string) => {
    if (!selectedSftpSession) {
      return
    }

    await loadSftpDirectory(selectedSftpSession, path)
    setSelectedSftpEntryPaths([])
  }, [loadSftpDirectory, selectedSftpSession])

  function isSessionFolderExpanded(path: string) {
    return expandedSessionFolders[path] ?? true
  }

  function toggleSessionFolder(path: string) {
    setExpandedSessionFolders((current) => ({
      ...current,
      [path]: !(current[path] ?? true),
    }))
  }

  function clearSessionDragState() {
    setSessionTreeDragState(null)
    setSessionDropTargetPath(null)
    sessionDropTargetPathRef.current = null
  }

  function consumeSuppressedSessionTreeClick() {
    if (!suppressSessionTreeClickRef.current) {
      return false
    }

    suppressSessionTreeClickRef.current = false
    return true
  }

  function canDropSessionOnTarget(session: SessionDefinition, targetPath: string) {
    const currentFolderPath = session.folderPath ?? ''
    if (targetPath === SESSION_ROOT_DROP_TARGET) {
      return currentFolderPath !== ''
    }

    return currentFolderPath !== targetPath
  }

  function canDropFolderOnTarget(folder: SessionTreeFolder, targetPath: string) {
    if (targetPath === SESSION_ROOT_DROP_TARGET) {
      return folder.path.includes('/')
    }

    if (targetPath === folder.path) {
      return false
    }

    if (targetPath.startsWith(`${folder.path}/`)) {
      return false
    }

    const folderName = folder.name
    const currentParentPath = folder.path.includes('/') ? folder.path.split('/').slice(0, -1).join('/') : ''
    const nextPath = targetPath ? `${targetPath}/${folderName}` : folderName

    if (nextPath === folder.path || currentParentPath === targetPath) {
      return false
    }

    return true
  }

  function updateSessionDropTarget(clientX: number, clientY: number, dragState: SessionSidebarDragState) {
    const targetElement = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-session-drop-target]')
    const targetPath = targetElement?.dataset.sessionDropTarget ?? null

    if (!targetPath) {
      setSessionDropTargetPath(null)
      sessionDropTargetPathRef.current = null
      return
    }

    const canDrop = dragState.kind === 'session'
      ? canDropSessionOnTarget(dragState.session, targetPath)
      : canDropFolderOnTarget(dragState.folder, targetPath)

    const nextTargetPath = canDrop ? targetPath : null
    setSessionDropTargetPath(nextTargetPath)
    sessionDropTargetPathRef.current = nextTargetPath
  }

  function startSessionTreePointerDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    dragState: SessionSidebarDragState,
  ) {
    if (event.button !== 0) {
      return
    }

    const target = event.target as HTMLElement
    if (target.closest('button,input,textarea,select,a,[data-no-row-drag="true"]')) {
      return
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Ignore capture failures from the embedded webview.
    }

    const startX = event.clientX
    const startY = event.clientY
    let started = false
    const previousUserSelect = document.body.style.userSelect
    const previousWebkitUserSelect = document.body.style.webkitUserSelect
    const previousCursor = document.body.style.cursor

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
      document.body.style.userSelect = previousUserSelect
      document.body.style.webkitUserSelect = previousWebkitUserSelect
      document.body.style.cursor = previousCursor
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!started && !movedEnough(startX, startY, moveEvent.clientX, moveEvent.clientY)) {
        return
      }

      if (!started) {
        started = true
        suppressSessionTreeClickRef.current = true
        document.body.style.userSelect = 'none'
        document.body.style.webkitUserSelect = 'none'
        document.body.style.cursor = 'grabbing'
        setSessionTreeDragState(dragState)
      }

      updateSessionDropTarget(moveEvent.clientX, moveEvent.clientY, dragState)
    }

    const handlePointerUp = () => {
      cleanup()

      if (!started) {
        return
      }

      const dropTargetPath = sessionDropTargetPathRef.current

      if (dropTargetPath) {
        if (dragState.kind === 'session') {
          onDropSessionToFolder(dragState.session.id, dropTargetPath === SESSION_ROOT_DROP_TARGET ? '' : dropTargetPath)
        } else if (dragState.folder.folderId) {
          onDropFolderToFolder(dragState.folder.folderId, dropTargetPath === SESSION_ROOT_DROP_TARGET ? '' : dropTargetPath)
        }
      }

      clearSessionDragState()
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)
  }

  function renderSessionRow(session: SessionDefinition, depth: number) {
    return (
      <div
        key={session.id}
        className={`sidebar-row sidebar-tree-row ${activeTab?.sessionId === session.id ? 'active' : ''} ${
          sessionTreeDragState?.kind === 'session' && sessionTreeDragState.session.id === session.id ? 'dragging' : ''
        }`}
        role="button"
        tabIndex={0}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        onPointerDown={(event) => startSessionTreePointerDrag(event, { kind: 'session', session })}
        onDoubleClick={() => {
          if (consumeSuppressedSessionTreeClick()) {
            return
          }
          onOpenSession(session.id)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onOpenSession(session.id)
          }
        }}
      >
        <div className="sidebar-row-main">
          <span className="sidebar-tree-spacer" aria-hidden="true" />
          <span className="sidebar-row-icon">{getSessionIcon(session.kind)}</span>
          <div className="sidebar-row-copy">
            <strong>{session.name}</strong>
            <span>{session.kind.toUpperCase()}</span>
          </div>
        </div>
        <div className="sidebar-row-actions">
          <button
            type="button"
            title="Move session"
            onClick={(event) => {
              event.stopPropagation()
              onMoveSession(session)
            }}
          >
            <FolderTree size={12} />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onEditSession(session)
            }}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onDeleteSession(session.id)
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    )
  }

  function buildSessionImportMessage(summary: SessionImportSummary) {
    const parts: string[] = []

    if (summary.importedSessions > 0) {
      parts.push(`imported ${summary.importedSessions} session${summary.importedSessions === 1 ? '' : 's'}`)
    }
    if (summary.importedFolders > 0) {
      parts.push(`created ${summary.importedFolders} folder${summary.importedFolders === 1 ? '' : 's'}`)
    }
    if (summary.skippedExistingSessions > 0) {
      parts.push(`skipped ${summary.skippedExistingSessions} existing session${summary.skippedExistingSessions === 1 ? '' : 's'}`)
    }
    if (summary.skippedExistingFolders > 0) {
      parts.push(`skipped ${summary.skippedExistingFolders} existing folder${summary.skippedExistingFolders === 1 ? '' : 's'}`)
    }
    if (summary.skippedUnsupported > 0) {
      parts.push(`ignored ${summary.skippedUnsupported} unsupported item${summary.skippedUnsupported === 1 ? '' : 's'}`)
    }

    return parts.length > 0 ? `MobaXterm import: ${parts.join(', ')}.` : 'MobaXterm import: nothing new to add.'
  }

  async function handleSessionImportChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const content = await file.text()
      const preview = parseMobaXtermSessionsFile(content)
      if (preview.sessions.length === 0 && preview.folders.length === 0 && preview.skipped.length > 0) {
        setSessionMessage(`MobaXterm import: no supported sessions found. Ignored ${preview.skipped.length} unsupported item${preview.skipped.length === 1 ? '' : 's'}.`)
        return
      }

      const summary = await importMobaXtermSessions(content)
      setSessionMessage(buildSessionImportMessage(summary))
    } catch (error) {
      setSessionMessage(error instanceof Error ? error.message : 'Unable to import MobaXterm sessions.')
    } finally {
      event.target.value = ''
    }
  }

  function renderSessionFolder(folder: SessionTreeFolder, depth: number): ReactNode {
    const expanded = isSessionFolderExpanded(folder.path)
    const canDeleteFolder = folder.explicit && folder.folders.length === 0 && folder.sessions.length === 0
    const isDropTarget = sessionDropTargetPath === folder.path

    return (
      <div key={folder.key}>
        <div
          className={`sidebar-row sidebar-tree-row sidebar-folder-row ${
            folderContainsSession(folder, activeTab?.sessionId) ? 'active' : ''
          } ${isDropTarget ? 'drop-target' : ''} ${
            sessionTreeDragState?.kind === 'folder' && sessionTreeDragState.folder.path === folder.path ? 'dragging' : ''
          }`}
          role="button"
          tabIndex={0}
          data-session-drop-target={folder.path}
          style={{ paddingLeft: `${10 + depth * 14}px` }}
          onPointerDown={(event) => {
            if (folder.explicit) {
              startSessionTreePointerDrag(event, { kind: 'folder', folder })
            }
          }}
          onClick={() => {
            if (consumeSuppressedSessionTreeClick()) {
              return
            }
            toggleSessionFolder(folder.path)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleSessionFolder(folder.path)
            }
          }}
        >
          <div className="sidebar-row-main">
            <span className="sidebar-tree-toggle" aria-hidden="true">
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
            <span className="sidebar-row-icon">
              <FolderClosed size={13} />
            </span>
            <div className="sidebar-row-copy">
              <strong>{folder.name}</strong>
              <span>{sessionCountLabel(countFolderSessions(folder))}</span>
            </div>
          </div>
          <div className="sidebar-row-actions">
            <button
              type="button"
              title="New session in folder"
              onClick={(event) => {
                event.stopPropagation()
                onNewSessionInFolder(folder.path)
              }}
            >
              <Terminal size={12} />
            </button>
            <button
              type="button"
              title="New subfolder"
              onClick={(event) => {
                event.stopPropagation()
                onNewSessionFolder(folder.path)
              }}
            >
              <FolderPlus size={12} />
            </button>
            {folder.explicit && (
              <button
                type="button"
                title={canDeleteFolder ? 'Delete folder' : 'Folder is not empty'}
                disabled={!canDeleteFolder}
                onClick={(event) => {
                  event.stopPropagation()
                  if (canDeleteFolder && folder.folderId) {
                    onDeleteSessionFolder(folder.folderId)
                  }
                }}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>
        {expanded && (
          <>
            {folder.folders.map((child) => renderSessionFolder(child, depth + 1))}
            {folder.sessions.map((session) => renderSessionRow(session, depth + 1))}
          </>
        )}
      </div>
    )
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
        const uploadPaths = droppedPaths.filter((localPath) => {
          const fileName = localPath.split('/').filter(Boolean).at(-1) ?? 'upload.bin'
          return !hasSftpEntryNamed(fileName)
        })
        const skippedCount = droppedPaths.length - uploadPaths.length
        if (skippedCount > 0) {
          setSftpMessage(
            skippedCount === 1
              ? 'A dropped item already exists. Rename or delete it before uploading.'
              : `${skippedCount} dropped items already exist. Rename or delete them before uploading.`,
          )
        }
        if (uploadPaths.length === 0) {
          return
        }

        setSftpLoading(true)
        const transferIds: string[] = []
        try {
          const batchTransferId = uploadPaths.length > 1 ? createBatchTransferId('upload') : null
          if (batchTransferId) {
            enqueueTransfer({
              transferId: batchTransferId,
              fileName: itemCountLabel(uploadPaths.length),
              remotePath: currentSftpPath,
              direction: 'upload',
              purpose: 'upload',
              state: 'queued',
              transferredBytes: 0,
              totalBytes: undefined,
              localPath: batchLocalPathLabel(uploadPaths),
              itemCount: uploadPaths.length,
              message: `Queued ${uploadPaths.length} items for upload`,
            })
          }

          for (const [index, localPath] of uploadPaths.entries()) {
            const fileName = localPath.split('/').filter(Boolean).at(-1) ?? 'upload.bin'
            const transferId = batchTransferId
              ? createBatchChildTransferId(batchTransferId, index, uploadPaths.length)
              : `upload-${crypto.randomUUID()}`
            transferIds.push(transferId)
            if (!batchTransferId) {
              enqueueTransfer({
                transferId,
                fileName,
                remotePath: currentSftpPath === '/' ? `/${fileName}` : `${currentSftpPath}/${fileName}`,
                direction: 'upload',
                purpose: 'upload',
                state: 'queued',
                transferredBytes: 0,
                totalBytes: undefined,
                localPath,
                message: 'Queued for upload',
              })
            }
            await uploadLocalPath(selectedSftpSession, currentSftpPath, localPath, transferId)
          }
          setSftpMessage(`Uploaded ${uploadPaths.length} file${uploadPaths.length > 1 ? 's' : ''} to ${currentSftpPath}`)
          await loadSelectedSftpDirectory(currentSftpPath)
        } catch (error) {
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
  }, [activeSection, currentSftpPath, enqueueTransfer, hasSftpEntryNamed, loadSelectedSftpDirectory, selectedSftpSession])

  async function uploadSidebarBrowserFiles(files: File[], source: 'upload' | 'drop-upload') {
    if (files.length === 0 || !selectedSftpSession) {
      return
    }

    const skippedFiles = files.filter((file) => hasSftpEntryNamed(file.name))
    const uploadFiles = files.filter((file) => !hasSftpEntryNamed(file.name))
    if (skippedFiles.length > 0) {
      setSftpMessage(
        skippedFiles.length === 1
          ? `${skippedFiles[0].name} already exists. Rename or delete it before uploading.`
          : `${skippedFiles.length} files already exist. Rename or delete them before uploading.`,
      )
    }
    if (uploadFiles.length === 0) {
      return
    }

    setSftpLoading(true)
    try {
      const batchTransferId = uploadFiles.length > 1 ? createBatchTransferId('upload') : null
      if (batchTransferId) {
        enqueueTransfer({
          transferId: batchTransferId,
          fileName: itemCountLabel(uploadFiles.length),
          remotePath: currentSftpPath,
          direction: 'upload',
          purpose: 'upload',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: uploadFiles.reduce((sum, file) => sum + file.size, 0),
          itemCount: uploadFiles.length,
          message: `Queued ${uploadFiles.length} files for upload`,
        })
      }

      for (const [index, file] of uploadFiles.entries()) {
        const transferId = batchTransferId
          ? createBatchChildTransferId(batchTransferId, index, uploadFiles.length)
          : `upload-${crypto.randomUUID()}`
        if (!batchTransferId) {
          enqueueTransfer({
            transferId,
            fileName: file.name,
            remotePath: currentSftpPath === '/' ? `/${file.name}` : `${currentSftpPath}/${file.name}`,
            direction: 'upload',
            purpose: 'upload',
            state: 'queued',
            transferredBytes: 0,
            totalBytes: file.size,
            message: 'Queued for upload',
          })
        }
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
        await uploadRemoteFile(selectedSftpSession, currentSftpPath, file.name, bytes, transferId)
      }
      setSftpMessage(`Uploaded ${uploadFiles.length} file${uploadFiles.length > 1 ? 's' : ''} to ${currentSftpPath}`)
      await loadSelectedSftpDirectory(currentSftpPath)
    } catch (error) {
      logOpenXTermError(`sidebar.sftp.${source}`, error, {
        ...sidebarSftpErrorContext(selectedSftpSession, source, currentSftpPath),
        files: uploadFiles.map((file) => ({ name: file.name, size: file.size })),
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
      const batchTransferId = files.length > 1 ? createBatchTransferId('upload') : null
      if (batchTransferId) {
        enqueueTransfer({
          transferId: batchTransferId,
          fileName: rootFolderName,
          remotePath: joinRemotePath(currentSftpPath, rootFolderName),
          direction: 'upload',
          purpose: 'upload',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: files.reduce((sum, file) => sum + file.size, 0),
          itemCount: files.length,
          message: `Queued ${files.length} folder items for upload`,
        })
      }

      for (const [index, file] of files.entries()) {
        const relativePath = file.webkitRelativePath || file.name
        const parts = relativePath.split('/').filter(Boolean)
        const fileName = parts.at(-1) ?? file.name
        const remoteDir = parts.length > 1
          ? parts.slice(0, -1).reduce((path, segment) => joinRemotePath(path, segment), currentSftpPath)
          : currentSftpPath

        await ensureRemoteDirectoryPath(remoteDir)

        const transferId = batchTransferId
          ? createBatchChildTransferId(batchTransferId, index, files.length)
          : `upload-${crypto.randomUUID()}`
        if (!batchTransferId) {
          enqueueTransfer({
            transferId,
            fileName,
            remotePath: joinRemotePath(remoteDir, fileName),
            direction: 'upload',
            purpose: 'upload',
            state: 'queued',
            transferredBytes: 0,
            totalBytes: file.size,
            message: 'Queued for upload',
          })
        }
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
        await uploadRemoteFile(selectedSftpSession, remoteDir, fileName, bytes, transferId)
      }
      setSftpMessage(`Uploaded folder contents to ${currentSftpPath}`)
      await loadSelectedSftpDirectory(currentSftpPath)
    } catch (error) {
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
      const batchTransferId = entries.length > 1 ? createBatchTransferId('download') : null
      const knownTotalBytes = entries.every((entry) => entry.kind === 'file' && typeof entry.sizeBytes === 'number')
        ? entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0)
        : undefined
      if (batchTransferId) {
        enqueueTransfer({
          transferId: batchTransferId,
          fileName: itemCountLabel(entries.length),
          remotePath: currentSftpPath,
          direction: 'download',
          purpose: 'download',
          state: 'queued',
          transferredBytes: 0,
          totalBytes: knownTotalBytes,
          itemCount: entries.length,
          message: `Queued ${entries.length} items for download`,
        })
      }

      for (const [index, entry] of entries.entries()) {
        const transferId = batchTransferId
          ? createBatchChildTransferId(batchTransferId, index, entries.length)
          : `download-${crypto.randomUUID()}`
        if (!batchTransferId) {
          enqueueTransfer({
            transferId,
            fileName: entry.name,
            remotePath: entry.path,
            direction: 'download',
            purpose: 'download',
            state: 'queued',
            transferredBytes: 0,
            totalBytes: entry.kind === 'file' ? entry.sizeBytes : undefined,
            message: entry.kind === 'folder' ? 'Queued folder download' : 'Queued for download',
          })
        }
        const result = await downloadRemoteEntry(selectedSftpSession, entry.path, entry.kind, transferId)
        lastResult = `${result.fileName} -> ${result.savedTo}`
      }
      setSftpMessage(
        entries.length === 1
          ? `Downloaded ${lastResult}`
          : `Downloaded ${entries.length} item${entries.length > 1 ? 's' : ''}`,
      )
    } catch (error) {
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
          transferId: batchTransferId
            ? createBatchChildTransferId(batchTransferId, index, dragEntries.length)
            : undefined,
        })),
        moveEvent.clientX,
        moveEvent.clientY,
      )
        .then((dragStarted) => {
          if (!dragStarted) {
            setSftpMessage('Native macOS drag-out could not start for the selected item(s).')
          }
        })
        .catch((error) => {
          setSftpMessage(error instanceof Error ? error.message : 'Native macOS drag-out failed.')
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
      cleanupDragListeners()
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-rail">
        <RailButton
          active={activeSection === 'sessions'}
          icon={<FolderTree size={14} />}
          label="Sessions"
          onClick={() => onSelectSection('sessions')}
        />
        {hasSftpLinks && (
          <RailButton
            active={activeSection === 'sftp'}
            icon={<HardDrive size={14} />}
            label="SFTP"
            onClick={() => onSelectSection('sftp')}
          />
        )}
        <RailButton
          active={activeSection === 'tools'}
          icon={<Wrench size={14} />}
          label="Tools"
          onClick={() => onSelectSection('tools')}
        />
        <RailButton
          active={activeSection === 'macros'}
          icon={<Bot size={14} />}
          label="Macros"
          onClick={() => onSelectSection('macros')}
        />
      </div>

      <div className="sidebar-panel">
        {activeSection === 'sessions' && (
          <>
            <div className="sidebar-header">
              <span>Sessions</span>
              <div className="sidebar-header-actions">
                <input
                  ref={sessionImportInputRef}
                  type="file"
                  accept=".mxtsessions,.ini,text/plain"
                  hidden
                  onChange={handleSessionImportChange}
                />
                <SidebarIconButton
                  accent="transfer"
                  icon={<Upload size={14} />}
                  label="Import MobaXterm sessions"
                  onClick={() => sessionImportInputRef.current?.click()}
                />
                <SidebarIconButton
                  accent="folder"
                  icon={<FolderPlus size={14} />}
                  label="New folder"
                  onClick={() => onNewSessionFolder(null)}
                />
                <SidebarIconButton
                  accent="success"
                  icon={<Terminal size={14} />}
                  label="New session"
                  onClick={onNewSession}
                />
              </div>
            </div>
            {sessionMessage && (
              <div className="sidebar-session-note">{sessionMessage}</div>
            )}
            <div ref={sessionListRef} className="sidebar-list">
              {sessionTreeDragState && (
                <div
                  className={`sidebar-row sidebar-root-drop-target ${
                    sessionDropTargetPath === SESSION_ROOT_DROP_TARGET ? 'drop-target' : ''
                  }`}
                  data-session-drop-target={SESSION_ROOT_DROP_TARGET}
                >
                  <div className="sidebar-row-main">
                    <span className="sidebar-tree-spacer" aria-hidden="true" />
                    <span className="sidebar-row-icon">
                      <FolderTree size={13} />
                    </span>
                    <div className="sidebar-row-copy">
                      <strong>Move To Root</strong>
                      <span>
                        {sessionTreeDragState.kind === 'folder'
                          ? 'Drop folder here to move it to root'
                          : 'Drop session here to remove folder'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {sessionTree.folders.map((folder) => renderSessionFolder(folder, 0))}
              {sessionTree.sessions.map((session) => renderSessionRow(session, 0))}
            </div>
          </>
        )}

        {activeSection === 'sftp' && (
          <>
            <div className="sidebar-header">
              <span>SFTP</span>
              <span className="sidebar-caption">{selectedSftpSession?.host ?? 'SSH-linked'}</span>
            </div>
            {sshSftpLinks.length > 1 && (
              <div className="sidebar-sftp-switcher">
                {sshSftpLinks.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={`sidebar-sftp-chip ${selectedSftpSession?.id === session.id ? 'active' : ''}`}
                    onClick={() => setSelectedSftpSessionId(session.id)}
                  >
                    {session.name}
                  </button>
                ))}
              </div>
            )}
            <div className="sidebar-sftp-toolbar">
              <SidebarIconButton
                accent="folder"
                icon={<ArrowUp size={14} />}
                label="Up"
                disabled={sftpLoading || currentSftpPath === '/' || !selectedSftpSession}
                onClick={() => {
                  if (!selectedSftpSession) {
                    return
                  }

                  const parentSegments = currentSftpPath.split('/').filter(Boolean).slice(0, -1)
                  const parent = parentSegments.length > 0 ? `/${parentSegments.join('/')}` : '/'
                  void loadSelectedSftpDirectory(parent)
                }}
              />
              <SidebarIconButton
                accent="transfer"
                icon={<ArrowDownToLine size={14} />}
                label="Download"
                disabled={sftpLoading || selectedSftpEntries.length === 0}
                onClick={() => void handleDownloadEntry()}
              />
              <SidebarIconButton
                accent="transfer"
                icon={<Upload size={14} />}
                label="Upload"
                disabled={sftpLoading || !selectedSftpSession}
                onClick={() => uploadInputRef.current?.click()}
              />
              <SidebarIconButton
                accent="transfer"
                icon={<FolderUp size={14} />}
                label="Upload folder"
                disabled={sftpLoading || !selectedSftpSession}
                onClick={() => uploadFolderInputRef.current?.click()}
              />
              <SidebarIconButton
                accent="success"
                icon={<RefreshCw size={14} className={sftpLoading ? 'spinning' : undefined} />}
                label="Refresh"
                disabled={sftpLoading || !selectedSftpSession}
                onClick={() => {
                  if (selectedSftpSession) {
                    void loadSelectedSftpDirectory(currentSftpPath)
                  }
                }}
              />
              <SidebarIconButton
                accent="folder"
                icon={<FolderPlus size={14} />}
                label="New folder"
                disabled={sftpLoading || !selectedSftpSession}
                onClick={() => setShowNewSftpFolderForm((value) => !value)}
              />
              <SidebarIconButton
                accent="danger"
                icon={<Trash2 size={14} />}
                label="Delete"
                disabled={sftpLoading || selectedSftpEntries.length === 0}
                onClick={() => void handleDeleteEntry()}
              />
            </div>
            <input
              ref={uploadInputRef}
              className="sr-only-input"
              type="file"
              multiple
              onChange={(event) => void handleSidebarUploadChange(event)}
            />
            <input
              ref={uploadFolderInputRef}
              className="sr-only-input"
              type="file"
              multiple
              // React's DOM types do not include Chromium's folder-picker attributes yet.
              {...{ webkitdirectory: '', directory: '' }}
              onChange={(event) => void handleSidebarUploadFolderChange(event)}
            />
            {showNewSftpFolderForm && selectedSftpSession && (
              <form className="sidebar-sftp-create-form" onSubmit={(event) => void handleCreateFolder(event)}>
                <input
                  autoFocus
                  value={newSftpFolderName}
                  placeholder="Folder name"
                  disabled={sftpLoading}
                  onChange={(event) => setNewSftpFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setShowNewSftpFolderForm(false)
                      setNewSftpFolderName('')
                    }
                  }}
                />
                <button type="submit" disabled={sftpLoading || !newSftpFolderName.trim()}>
                  Create
                </button>
              </form>
            )}
            {renamingSftpEntry && selectedSftpSession && (
              <form className="sidebar-sftp-create-form" onSubmit={(event) => void handleRenameEntry(event)}>
                <input
                  autoFocus
                  value={renameSftpName}
                  placeholder="New name"
                  disabled={sftpLoading}
                  onChange={(event) => setRenameSftpName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setRenamingSftpEntry(null)
                      setRenameSftpName('')
                    }
                  }}
                />
                <button type="submit" disabled={sftpLoading || !renameSftpName.trim()}>
                  Rename
                </button>
              </form>
            )}
            <div className="sidebar-sftp-path">
              <span>{currentSftpPath}</span>
              {selectedSftpEntries.length > 0 && (
                <strong>{selectedSftpEntries.length} selected</strong>
              )}
            </div>
            <div
              ref={sftpListRef}
              className={`sidebar-list ${dropActive ? 'sidebar-drop-active' : ''}`}
              onDragEnter={handleSidebarBrowserDrag}
              onDragOver={handleSidebarBrowserDrag}
              onDragLeave={handleSidebarBrowserDragLeave}
              onDrop={(event) => void handleSidebarBrowserDrop(event)}
            >
              {selectedSftpSession && sftpEntries.length > 0 && (
                <div
                  className="sidebar-sftp-table"
                  role="table"
                  aria-label="Remote SFTP directory"
                  style={sftpTableStyle}
                >
                  <div className="sidebar-sftp-table-header" role="row">
                    {SFTP_TABLE_COLUMN_LABELS.map((label, index) => (
                      <span key={label} className="file-table-header-cell">
                        {label}
                        <button
                          className="file-table-column-resizer"
                          type="button"
                          aria-label={`Resize ${label} column`}
                          onPointerDown={(event) => handleSftpColumnResizeStart(index, event)}
                        />
                      </span>
                    ))}
                    <span aria-hidden="true" />
                  </div>
                  {sftpEntries.map((entry) => {
                    const selected = selectedSftpEntryPaths.includes(entry.path)
                    return (
                      <div
                        key={entry.path}
                        className={`sidebar-sftp-table-row ${selected ? 'active' : ''}`}
                        role="row"
                        tabIndex={0}
                        title="Drag to Finder"
                        onPointerDown={(event) => handleNativeDragPointerDown(event, entry, 'row')}
                        onClick={(event) => selectSftpEntry(entry, event)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setSelectedSftpEntryPaths(selectedOrEntry(entry).map((item) => item.path))
                          setSftpContextMenu({ entry, x: event.clientX, y: event.clientY })
                        }}
                        onDoubleClick={() => {
                          handleSftpEntryOpen(entry)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            handleSftpEntryOpen(entry)
                          }
                          if (event.key === 'Delete' || event.key === 'Backspace') {
                            event.preventDefault()
                            setSelectedSftpEntryPaths(selectedOrEntry(entry).map((item) => item.path))
                            void handleDeleteEntry(selectedOrEntry(entry))
                          }
                        }}
                      >
                        <span className="sidebar-sftp-name-cell" title={entry.name}>
                          {entry.kind === 'folder' ? <FolderClosed size={13} /> : <FileText size={13} />}
                          <span>{entry.name}</span>
                        </span>
                        <span>{remoteSizeKbLabel(entry)}</span>
                        <span title={entry.modifiedLabel}>{entry.modifiedLabel}</span>
                        <span>{entry.ownerLabel ?? ''}</span>
                        <span>{entry.groupLabel ?? ''}</span>
                        <span className="sidebar-sftp-access-cell">{entry.accessLabel ?? ''}</span>
                        <button
                          className="sidebar-sftp-table-drag"
                          data-no-row-drag="true"
                          type="button"
                          title="Drag selected item(s) to Finder"
                          aria-label={`Drag ${entry.name} to Finder`}
                          onPointerDown={(event) => handleNativeDragPointerDown(event, entry, 'handle')}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            setSelectedSftpEntryPaths(selectedOrEntry(entry).map((item) => item.path))
                          }}
                        >
                          <ArrowDownToLine size={12} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              {selectedSftpSession && !sftpEntries.length && (
                <div className="sidebar-empty-copy">
                  {sftpLoading ? 'Loading remote directory...' : sftpMessage || 'This directory is empty.'}
                </div>
              )}
              {!selectedSftpSession && (
                <div className="sidebar-empty-copy">No live SSH-linked SFTP session yet.</div>
              )}
              {dropActive && (
                <div className="sidebar-drop-overlay">
                  <strong>Drop files to upload</strong>
                  <span>{currentSftpPath}</span>
                </div>
              )}
            </div>
            {sftpContextMenu && (
              <div
                className="sidebar-context-menu"
                style={{ left: sftpContextMenu.x, top: sftpContextMenu.y }}
                role="menu"
                onPointerDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
              >
                <button type="button" role="menuitem" onClick={() => startRenameSftpEntry(sftpContextMenu.entry)}>
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const entries = selectedOrEntry(sftpContextMenu.entry)
                    setSftpContextMenu(null)
                    void handleDeleteEntry(entries)
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSelectedSftpEntryPaths(selectedOrEntry(sftpContextMenu.entry).map((item) => item.path))
                    setSftpContextMenu(null)
                    void handleDownloadEntry(selectedOrEntry(sftpContextMenu.entry))
                  }}
                >
                  Download
                </button>
              </div>
            )}
          </>
        )}

        {activeSection === 'tools' && (
          <>
            <div className="sidebar-header">
              <span>Tools</span>
              <span className="sidebar-caption">Placeholders</span>
            </div>
            <div className="sidebar-list">
              {tools.map((tool) => (
                <div key={tool.name} className="tool-row">
                  <div className="tool-row-icon">
                    <Wrench size={14} />
                  </div>
                  <div className="tool-row-copy">
                    <strong>{tool.name}</strong>
                    <span>{tool.note}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {activeSection === 'macros' && (
          <>
            <div className="sidebar-header">
              <span>Macros</span>
              <button className="sidebar-header-button" type="button" onClick={onNewMacro}>
                New
              </button>
            </div>
            <div className="sidebar-list">
              {macros.map((macro) => (
                <div key={macro.id} className="sidebar-row">
                  <div className="sidebar-row-main">
                    <span className="sidebar-row-icon">
                      <Terminal size={13} />
                    </span>
                    <div className="sidebar-row-copy">
                      <strong>{macro.name}</strong>
                      <span>{macro.command}</span>
                    </div>
                  </div>
                  <div className="sidebar-row-actions">
                    <button type="button" onClick={() => onRunMacro(macro.command)}>
                      <Play size={12} />
                    </button>
                    <button type="button" onClick={() => onEditMacro(macro)}>
                      <Pencil size={12} />
                    </button>
                    <button type="button" onClick={() => onDeleteMacro(macro.id)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="sidebar-footer">
          <label className="sidebar-follow-toggle">
            <input type="checkbox" disabled />
            <span>follow remote terminal</span>
          </label>
        </div>
      </div>
    </aside>
  )
}

interface SidebarIconButtonProps {
  accent: 'danger' | 'folder' | 'success' | 'transfer'
  disabled?: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}

function SidebarIconButton({ accent, disabled, icon, label, onClick }: SidebarIconButtonProps) {
  return (
    <button
      className={`sidebar-icon-button ${accent}`}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

interface RailButtonProps {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}

function RailButton({ active, icon, label, onClick }: RailButtonProps) {
  return (
    <button className={`rail-button ${active ? 'active' : ''}`} type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  )
}
