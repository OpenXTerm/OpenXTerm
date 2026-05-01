import type { ChangeEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import {
  Cable,
  ChevronDown,
  ChevronRight,
  FolderClosed,
  FolderPlus,
  FolderTree,
  HardDrive,
  Pencil,
  Server,
  Terminal,
  Trash2,
  Upload,
  Usb,
} from 'lucide-react'

import type { SessionDefinition, WorkspaceTab } from '../../types/domain'
import { SidebarIconButton } from './SidebarIconButton'
import {
  SESSION_ROOT_DROP_TARGET,
  countFolderSessions,
  folderContainsSession,
  sessionCountLabel,
  type SessionSidebarDragState,
  type SessionTreeFolder,
  type SessionTreeRoot,
} from './sessionTree'

interface SessionsSectionProps {
  activeTab: WorkspaceTab | undefined
  sessionImportInputRef: RefObject<HTMLInputElement | null>
  sessionListRef: RefObject<HTMLDivElement | null>
  sessionMessage: string
  sessionTree: SessionTreeRoot
  sessionTreeDragState: SessionSidebarDragState | null
  sessionDropTargetPath: string | null
  isSessionFolderExpanded: (path: string) => boolean
  onConsumeSuppressedSessionTreeClick: () => boolean
  onDeleteSession: (sessionId: string) => void
  onDeleteSessionFolder: (folderId: string) => void
  onEditSession: (session: SessionDefinition) => void
  onMoveSession: (session: SessionDefinition) => void
  onNewSession: () => void
  onNewSessionInFolder: (folderPath: string) => void
  onNewSessionFolder: (parentPath: string | null) => void
  onOpenSession: (sessionId: string) => void
  onSessionImportChange: (event: ChangeEvent<HTMLInputElement>) => void
  onStartSessionTreePointerDrag: (
    event: ReactPointerEvent<HTMLDivElement>,
    dragState: SessionSidebarDragState,
  ) => void
  onToggleSessionFolder: (path: string) => void
}

export function SessionsSection({
  activeTab,
  sessionImportInputRef,
  sessionListRef,
  sessionMessage,
  sessionTree,
  sessionTreeDragState,
  sessionDropTargetPath,
  isSessionFolderExpanded,
  onConsumeSuppressedSessionTreeClick,
  onDeleteSession,
  onDeleteSessionFolder,
  onEditSession,
  onMoveSession,
  onNewSession,
  onNewSessionInFolder,
  onNewSessionFolder,
  onOpenSession,
  onSessionImportChange,
  onStartSessionTreePointerDrag,
  onToggleSessionFolder,
}: SessionsSectionProps) {
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
        onPointerDown={(event) => onStartSessionTreePointerDrag(event, { kind: 'session', session })}
        onDoubleClick={() => {
          if (onConsumeSuppressedSessionTreeClick()) {
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

  function renderSessionFolder(folder: SessionTreeFolder, depth: number) {
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
              onStartSessionTreePointerDrag(event, { kind: 'folder', folder })
            }
          }}
          onClick={() => {
            if (onConsumeSuppressedSessionTreeClick()) {
              return
            }
            onToggleSessionFolder(folder.path)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onToggleSessionFolder(folder.path)
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

  return (
    <>
      <div className="sidebar-header">
        <span>Sessions</span>
        <div className="sidebar-header-actions">
          <input
            ref={sessionImportInputRef}
            type="file"
            accept=".mxtsessions,.ini,text/plain"
            hidden
            onChange={onSessionImportChange}
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
  )
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
