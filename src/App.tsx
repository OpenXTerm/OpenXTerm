import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { MacroEditorModal } from './components/forms/MacroEditorModal'
import { MoveSessionModal } from './components/forms/MoveSessionModal'
import { SessionFolderModal } from './components/forms/SessionFolderModal'
import { SessionEditorModal } from './components/forms/SessionEditorModal'
import { AppSettingsModal } from './components/forms/AppSettingsModal'
import { AppLockOverlay } from './components/forms/AppLockOverlay'
import { TopBar } from './components/layout/TopBar'
import { getSystemAuthSupport, listenMenuAction, requestSystemUnlock } from './lib/bridge'
import { StatusBar } from './components/status/StatusBar'
import { Sidebar } from './components/sidebar/Sidebar'
import { Workspace } from './components/workspace/Workspace'
import { useOpenXTermStore } from './state/useOpenXTermStore'
import type { MacroDefinition, MenuAction, SessionDefinition, SystemAuthSupport } from './types/domain'

export function App() {
  const isMacOS = navigator.userAgent.includes('Mac')
  const lastAutoSftpSessionIdRef = useRef<string | null>(null)
  const sidebarWidthRef = useRef(252)
  const {
    activeTabId,
    createSessionFolder,
    initialize,
    initialized,
    macros,
    moveSessionFolder,
    moveSessionToFolder,
    openLinkedSftp,
    sendInputToTab,
    openSession,
    preferences,
    removeMacro,
    removeSession,
    removeSessionFolder,
    restartTab,
    resizeTab,
    runMacro,
    selectTab,
    sessionCpuHistoryByTabId,
    sessionFolders,
    setSidebarWidth,
    sessionStatusByTabId,
    sessions,
    setSidebar,
    tabs,
    terminalCwdByTabId,
    terminalFeeds,
    terminalStoppedByTabId,
    updatePreferences,
    upsertMacro,
    upsertSession,
    closeTab,
  } = useOpenXTermStore()

  const [editingSession, setEditingSession] = useState<SessionDefinition | null>(null)
  const [sessionDraftFolderPath, setSessionDraftFolderPath] = useState('')
  const [editingMacro, setEditingMacro] = useState<MacroDefinition | null>(null)
  const [movingSession, setMovingSession] = useState<SessionDefinition | null>(null)
  const [newSessionFolderParentPath, setNewSessionFolderParentPath] = useState<string | null>(null)
  const [sessionModalOpen, setSessionModalOpen] = useState(false)
  const [macroModalOpen, setMacroModalOpen] = useState(false)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [moveSessionModalOpen, setMoveSessionModalOpen] = useState(false)
  const [sessionFolderModalOpen, setSessionFolderModalOpen] = useState(false)
  const [sidebarWidthDraft, setSidebarWidthDraft] = useState<number | null>(null)
  const [lockSupport, setLockSupport] = useState<SystemAuthSupport>({
    available: false,
    methodLabel: 'System authentication',
    detail: 'Checking platform support...',
  })
  const [appLocked, setAppLocked] = useState(false)
  const [unlockBusy, setUnlockBusy] = useState(false)
  const [unlockError, setUnlockError] = useState('')
  const [terminalCommandRequest, setTerminalCommandRequest] = useState<{ action: 'clear' | 'reset' | 'search'; nonce: number; tabId: string } | null>(null)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    if (!initialized) {
      return
    }

    let disposed = false

    void getSystemAuthSupport()
      .then((support) => {
        if (!disposed) {
          setLockSupport(support)
        }
      })
      .catch((error) => {
        if (disposed) {
          return
        }

        setLockSupport({
          available: false,
          methodLabel: 'System authentication',
          detail: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      disposed = true
    }
  }, [initialized])

  const handleLockApp = useCallback(() => {
    if (!lockSupport.available || appLocked) {
      return
    }

    setUnlockBusy(false)
    setUnlockError('')
    setAppLocked(true)
  }, [appLocked, lockSupport.available])

  const handleUnlockApp = useCallback(async () => {
    if (!lockSupport.available || unlockBusy) {
      return
    }

    setUnlockBusy(true)
    setUnlockError('')

    try {
      const unlocked = await requestSystemUnlock('Unlock OpenXTerm')
      if (unlocked) {
        setAppLocked(false)
        return
      }

      setUnlockError('Unlock canceled.')
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : String(error))
    } finally {
      setUnlockBusy(false)
    }
  }, [lockSupport.available, unlockBusy])

  const handleMenuAction = useCallback((action: MenuAction) => {
    switch (action) {
      case 'open-settings':
        setSettingsModalOpen(true)
        break
      case 'new-session':
        setEditingSession(null)
        setSessionModalOpen(true)
        break
      case 'new-macro':
        setEditingMacro(null)
        setMacroModalOpen(true)
        break
      case 'show-sessions':
        void setSidebar('sessions')
        break
      case 'show-sftp':
        void setSidebar('sftp')
        break
      case 'show-tools':
        void setSidebar('tools')
        break
      case 'show-macros':
        void setSidebar('macros')
        break
      case 'lock-app':
        handleLockApp()
        break
      case 'search-terminal':
      case 'clear-terminal':
      case 'reset-terminal':
        if (activeTab?.kind !== 'terminal') {
          break
        }
        setTerminalCommandRequest({
          action:
            action === 'search-terminal'
              ? 'search'
              : action === 'clear-terminal'
                ? 'clear'
                : 'reset',
          nonce: Date.now(),
          tabId: activeTab.id,
        })
        break
      default:
        break
    }
  }, [activeTab?.id, activeTab?.kind, handleLockApp, setSidebar])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null

    void listenMenuAction((payload) => {
      if (disposed) {
        return
      }

      handleMenuAction(payload.action)
    }).then((disposeListener) => {
      if (disposed) {
        void disposeListener()
        return
      }

      unlisten = disposeListener
    }).catch(() => {
      if (disposed) {
        return
      }
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [handleMenuAction])

  const terminalTabsForSftp = activeTab ? [activeTab, ...tabs.filter((tab) => tab.id !== activeTab.id)] : tabs
  const liveLinkedSftpSessions = Array.from(
    terminalTabsForSftp.reduce((linkedSessions, tab) => {
      if (!tab.sessionId || tab.kind !== 'terminal' || tab.protocol !== 'ssh' || terminalStoppedByTabId[tab.id]) {
        return linkedSessions
      }

      const session = sessions.find((item) => item.id === tab.sessionId && item.kind === 'ssh')
      if (!session || linkedSessions.has(tab.id)) {
        return linkedSessions
      }

      linkedSessions.set(tab.id, {
        ...session,
        id: `linked-sftp-${tab.id}`,
        name: `${session.name} files`,
        kind: 'sftp' as const,
        linkedSshTabId: tab.id,
        linkedSshSessionId: session.id,
      })
      return linkedSessions
    }, new Map<string, SessionDefinition>()),
  ).map(([, session]) => session)
  const preferredSftpSessionId =
    activeTab?.sessionId
    && activeTab.kind === 'terminal'
    && activeTab.protocol === 'ssh'
    && !terminalStoppedByTabId[activeTab.id]
      ? `linked-sftp-${activeTab.id}`
      : liveLinkedSftpSessions[0]?.id
  const sidebarWidth = sidebarWidthDraft ?? (preferences.sidebarWidth ?? 252)
  const folderOptions = sessionFolders.map((folder) => folder.path)
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
  }, [sidebarWidth])

  useEffect(() => {
    if (preferences.activeSidebar === 'sftp' && liveLinkedSftpSessions.length === 0) {
      void setSidebar('sessions')
    }
  }, [liveLinkedSftpSessions.length, preferences.activeSidebar, setSidebar])

  useEffect(() => {
    if (!preferredSftpSessionId) {
      return
    }

    if (lastAutoSftpSessionIdRef.current === preferredSftpSessionId) {
      return
    }

    lastAutoSftpSessionIdRef.current = preferredSftpSessionId
    void setSidebar('sftp')
  }, [preferredSftpSessionId, setSidebar])

  function handleSidebarResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = sidebarWidthRef.current

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.min(840, Math.max(220, startWidth + (moveEvent.clientX - startX)))
      sidebarWidthRef.current = nextWidth
      setSidebarWidthDraft(nextWidth)
    }

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const finalWidth = sidebarWidthRef.current
      void setSidebarWidth(finalWidth).then(() => {
        setSidebarWidthDraft(null)
      })
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  if (!initialized) {
    return <div className="boot-screen">Booting OpenXTerm...</div>
  }

  return (
    <div className="app-shell" data-theme={preferences.theme}>
      {!isMacOS && (
        <TopBar
          onMenuAction={handleMenuAction}
        />
      )}

      <div
        className="workbench"
        style={{
          gridTemplateColumns: `${Math.round(sidebarWidth)}px 6px minmax(0, 1fr)`,
        }}
      >
        <Sidebar
          activeSection={preferences.activeSidebar}
          activeTab={activeTab}
          macros={macros}
          sessions={sessions}
          preferredSftpSessionId={preferredSftpSessionId}
          sshSftpLinks={liveLinkedSftpSessions}
          terminalCwdByTabId={terminalCwdByTabId}
          onDeleteMacro={(macroId) => void removeMacro(macroId)}
          onDeleteSession={(sessionId) => void removeSession(sessionId)}
          onDeleteSessionFolder={(folderId) => void removeSessionFolder(folderId)}
          onEditMacro={(macro) => {
            setEditingMacro(macro)
            setMacroModalOpen(true)
          }}
          onEditSession={(session) => {
            setEditingSession(session)
            setSessionDraftFolderPath(session.folderPath ?? '')
            setSessionModalOpen(true)
          }}
          onDropFolderToFolder={(folderId, folderPath) => void moveSessionFolder(folderId, folderPath)}
          onDropSessionToFolder={(sessionId, folderPath) => void moveSessionToFolder(sessionId, folderPath)}
          onMoveSession={(session) => {
            setMovingSession(session)
            setMoveSessionModalOpen(true)
          }}
          onNewMacro={() => {
            setEditingMacro(null)
            setMacroModalOpen(true)
          }}
          onNewSessionInFolder={(folderPath) => {
            setEditingSession(null)
            setSessionDraftFolderPath(folderPath)
            setSessionModalOpen(true)
          }}
          onNewSessionFolder={(parentPath) => {
            setNewSessionFolderParentPath(parentPath)
            setSessionFolderModalOpen(true)
          }}
          onNewSession={() => {
            setEditingSession(null)
            setSessionDraftFolderPath('')
            setSessionModalOpen(true)
          }}
          onOpenLinkedSftp={(sessionId, linkedSshTabId) => void openLinkedSftp(sessionId, linkedSshTabId)}
          onOpenSession={(sessionId) => void openSession(sessionId)}
          onRunMacro={(command) => void runMacro(command)}
          sessionFolders={sessionFolders}
          onSelectSection={(section) => void setSidebar(section)}
        />
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          onPointerDown={handleSidebarResizeStart}
        />

        <div className="workspace-frame">
          <Workspace
            activeTabId={activeTabId}
            sessions={sessions}
            onCreateSession={() => {
              setEditingSession(null)
              setSessionDraftFolderPath('')
              setSessionModalOpen(true)
            }}
            onOpenSession={(sessionId) => void openSession(sessionId)}
            onRestartTab={(tabId) => void restartTab(tabId)}
            onShowSftp={() => void setSidebar('sftp')}
            onShowTools={() => void setSidebar('tools')}
            onTerminalInput={sendInputToTab}
            onTerminalResize={resizeTab}
            terminalCommandRequest={terminalCommandRequest}
            sessionMap={new Map([...sessions, ...liveLinkedSftpSessions].map((session) => [session.id, session]))}
            tabs={tabs}
            terminalFeeds={terminalFeeds}
            terminalStoppedByTabId={terminalStoppedByTabId}
            onCloseTab={closeTab}
            onSelectTab={selectTab}
          />
          {preferences.statusBarVisible !== false && (
            <StatusBar
              activeTab={activeTab}
              sessionCpuHistoryByTabId={sessionCpuHistoryByTabId}
              sessionStatusByTabId={sessionStatusByTabId}
              sessions={sessions}
            />
          )}
        </div>
      </div>

      {settingsModalOpen && (
        <AppSettingsModal
          lockSupport={lockSupport}
          open={settingsModalOpen}
          preferences={preferences}
          onClose={() => setSettingsModalOpen(false)}
          onLockApp={() => {
            setSettingsModalOpen(false)
            handleLockApp()
          }}
          onSave={updatePreferences}
        />
      )}

      {sessionModalOpen && (
        <SessionEditorModal
          key={editingSession?.id ?? `new-session:${sessionDraftFolderPath || 'root'}`}
          folderOptions={folderOptions}
          initialFolderPath={sessionDraftFolderPath}
          open={sessionModalOpen}
          session={editingSession}
          onClose={() => {
            setSessionModalOpen(false)
            setEditingSession(null)
            setSessionDraftFolderPath('')
          }}
          onSave={async (draft) => {
            await upsertSession(draft)
            setSessionModalOpen(false)
            setEditingSession(null)
            setSessionDraftFolderPath('')
          }}
        />
      )}

      {moveSessionModalOpen && (
        <MoveSessionModal
          key={movingSession?.id ?? 'move-session'}
          open={moveSessionModalOpen}
          session={movingSession}
          folderOptions={folderOptions}
          onClose={() => {
            setMoveSessionModalOpen(false)
            setMovingSession(null)
          }}
          onSave={async (folderPath) => {
            if (movingSession) {
              await moveSessionToFolder(movingSession.id, folderPath)
            }
            setMoveSessionModalOpen(false)
            setMovingSession(null)
          }}
        />
      )}

      {sessionFolderModalOpen && (
        <SessionFolderModal
          key={`folder:${newSessionFolderParentPath ?? 'root'}`}
          open={sessionFolderModalOpen}
          parentPath={newSessionFolderParentPath}
          onClose={() => {
            setSessionFolderModalOpen(false)
            setNewSessionFolderParentPath(null)
          }}
          onSave={async (name) => {
            await createSessionFolder(newSessionFolderParentPath, name.trim())
            setSessionFolderModalOpen(false)
            setNewSessionFolderParentPath(null)
          }}
        />
      )}

      {macroModalOpen && (
        <MacroEditorModal
          key={editingMacro?.id ?? 'new-macro'}
          macro={editingMacro}
          open={macroModalOpen}
          onClose={() => {
            setMacroModalOpen(false)
            setEditingMacro(null)
          }}
          onSave={async (draft) => {
            await upsertMacro(draft)
            setMacroModalOpen(false)
            setEditingMacro(null)
          }}
        />
      )}

      {appLocked && (
        <AppLockOverlay
          busy={unlockBusy}
          error={unlockError}
          onUnlock={() => void handleUnlockApp()}
          support={lockSupport}
        />
      )}
    </div>
  )
}
