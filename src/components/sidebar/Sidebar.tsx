import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  listRemoteDirectory,
} from '../../lib/bridge'
import { logOpenXTermError } from '../../lib/errorLog'
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
import { useSftpEntryOperations } from './useSftpEntryOperations'
import { useSftpFollowTerminal } from './useSftpFollowTerminal'
import { useSftpNativeDragOut } from './useSftpNativeDragOut'
import { useSftpUploads } from './useSftpUploads'
import { useSessionImport } from './useSessionImport'
import { useSessionTreeDrag } from './useSessionTreeDrag'
import { useSftpSelection } from './useSftpSelection'
import {
  compareSftpEntries,
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
  const sessionImportInputRef = useRef<HTMLInputElement | null>(null)
  const sessionListRef = useRef<HTMLDivElement | null>(null)
  const enqueueTransfer = useOpenXTermStore((state) => state.enqueueTransfer)
  const importMobaXtermSessions = useOpenXTermStore((state) => state.importMobaXtermSessions)
  const hasSftpLinks = sshSftpLinks.length > 0
  const [selectedSftpSessionId, setSelectedSftpSessionId] = useState<string | null>(null)
  const [snapshotsBySessionId, setSnapshotsBySessionId] = useState<Record<string, RemoteDirectorySnapshot>>({})
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
  const handleNativeDragPointerDown = useSftpNativeDragOut({
    currentPath: currentSftpPath,
    selectedSession: selectedSftpSession,
    selectedOrEntry,
    setMessage: setSftpMessage,
    setSelectedEntryPaths: setSelectedSftpEntryPaths,
  })
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

  const loadSelectedSftpDirectory = useCallback(async (path: string) => {
    if (!selectedSftpSession) {
      return false
    }

    const loaded = await loadSftpDirectory(selectedSftpSession, path)
    setSelectedSftpEntryPaths([])
    return loaded
  }, [loadSftpDirectory, selectedSftpSession, setSelectedSftpEntryPaths])
  const {
    handleCreateFolder,
    handleDeleteEntry,
    handleDownloadEntry,
    handlePathSubmit,
    handleRenameEntry,
    startRenameEntry,
  } = useSftpEntryOperations({
    currentPath: currentSftpPath,
    enqueueTransfer,
    hasEntryNamed: hasSftpEntryNamed,
    loadDirectory: loadSelectedSftpDirectory,
    newFolderName: newSftpFolderName,
    renameName: renameSftpName,
    renamingEntry: renamingSftpEntry,
    resolveDownloadTarget: resolveSftpDownloadTarget,
    selectedEntries: selectedSftpEntries,
    selectedOrEntry,
    selectedSession: selectedSftpSession,
    setLoading: setSftpLoading,
    setMessage: setSftpMessage,
    setNewFolderName: setNewSftpFolderName,
    setRenameName: setRenameSftpName,
    setRenamingEntry: setRenamingSftpEntry,
    setSelectedEntryPaths: setSelectedSftpEntryPaths,
    setShowNewFolderForm: setShowNewSftpFolderForm,
  })
  const {
    canFollowRemoteTerminal,
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
  const {
    dropActive,
    handleBrowserDrag,
    handleBrowserDragLeave,
    handleBrowserDrop,
    handleUploadChange,
    handleUploadFolderChange,
    sftpListRef,
    uploadFolderInputRef,
    uploadInputRef,
  } = useSftpUploads({
    activeSection,
    currentPath: currentSftpPath,
    enqueueTransfer,
    loadDirectory: loadSelectedSftpDirectory,
    resolveUploadTargets: resolveSftpUploadTargets,
    selectedSession: selectedSftpSession,
    setLoading: setSftpLoading,
    setMessage: setSftpMessage,
  })

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
            onDragEnter={handleBrowserDrag}
            onDragLeave={handleBrowserDragLeave}
            onDragOver={handleBrowserDrag}
            onDrop={(event) => void handleBrowserDrop(event)}
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
            onPathSubmit={(event) => void handlePathSubmit(event, sftpPathDraft)}
            onPropertiesApplied={handleSftpPropertiesApplied}
            onPropertiesClose={closeSftpProperties}
            onPropertiesOpen={(entry) => void openSftpProperties(entry)}
            onRename={(event) => void handleRenameEntry(event)}
            onRenameCancel={() => {
              setRenamingSftpEntry(null)
              setRenameSftpName('')
            }}
            onRenameNameChange={setRenameSftpName}
            onRenameStart={(entry) => {
              setSftpContextMenu(null)
              startRenameEntry(entry)
            }}
            onSftpConflictResolve={handleSftpConflictResolve}
            onSortColumn={handleSftpSortColumn}
            onUploadChange={(event) => void handleUploadChange(event)}
            onUploadFolderChange={(event) => void handleUploadFolderChange(event)}
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
          followRemoteTerminal={followRemoteTerminal}
          onFollowRemoteTerminalChange={setFollowRemoteTerminal}
        />
      </div>
    </aside>
  )
}
