import { HardDrive, Server, Terminal, Usb, X } from 'lucide-react'

import { FileBrowserView } from './FileBrowserView'
import { TerminalSurface } from './TerminalSurface'
import { WelcomePane } from './WelcomePane'
import type { SessionDefinition, WorkspaceTab } from '../../types/domain'

interface WorkspaceProps {
  activeTabId: string
  tabs: WorkspaceTab[]
  sessions: SessionDefinition[]
  sessionMap: Map<string, SessionDefinition>
  terminalFeeds: Record<string, string[]>
  terminalStoppedByTabId: Record<string, boolean>
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onCreateSession: () => void
  onOpenSession: (sessionId: string) => void
  onShowSftp: () => void
  onShowTools: () => void
  onRestartTab: (tabId: string) => void
  onTerminalInput: (tabId: string, data: string) => void
  onTerminalResize: (tabId: string, cols: number, rows: number) => void
  terminalCommandRequest: { action: 'clear' | 'reset' | 'search'; nonce: number; tabId: string } | null
}

function getTabIcon(tab: WorkspaceTab) {
  if (tab.protocol === 'welcome') {
    return <Terminal size={13} />
  }
  if (tab.protocol === 'serial') {
    return <Usb size={13} />
  }
  if (tab.protocol === 'local') {
    return <Terminal size={13} />
  }
  if (tab.protocol === 'sftp' || tab.protocol === 'ftp') {
    return <HardDrive size={13} />
  }
  if (tab.protocol === 'ssh') {
    return <Server size={13} />
  }
  return <Terminal size={13} />
}

function isInteractiveTerminal(kind: SessionDefinition['kind'] | undefined) {
  return kind === 'local' || kind === 'ssh' || kind === 'telnet' || kind === 'serial'
}

export function Workspace({
  activeTabId,
  tabs,
  sessions,
  sessionMap,
  terminalFeeds,
  terminalStoppedByTabId,
  onCloseTab,
  onCreateSession,
  onOpenSession,
  onRestartTab,
  onSelectTab,
  onShowSftp,
  onShowTools,
  terminalCommandRequest,
  onTerminalInput,
  onTerminalResize,
}: WorkspaceProps) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]
  const session = activeTab.sessionId ? sessionMap.get(activeTab.sessionId) : undefined

  return (
    <section className="workspace">
      <div className="tabstrip">
        <div className="tabstrip-list">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`workspace-tab ${tab.id === activeTabId ? 'active' : ''}`}
              type="button"
              onClick={() => onSelectTab(tab.id)}
            >
              {getTabIcon(tab)}
              <span>{tab.title}</span>
              {tab.closable && (
                <span
                  className="workspace-tab-close"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.stopPropagation()
                      onCloseTab(tab.id)
                    }
                  }}
                >
                  <X size={12} />
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="tabstrip-add">+</div>
      </div>

      <div className="workspace-content">
        {activeTab.kind === 'welcome' && (
          <WelcomePane
            sessions={sessions}
            onCreateSession={onCreateSession}
            onOpenSession={onOpenSession}
            onShowSftp={onShowSftp}
            onShowTools={onShowTools}
          />
        )}
        {activeTab.kind === 'terminal' && (
          <TerminalSurface
            key={activeTab.id}
            tabId={activeTab.id}
            title={activeTab.title}
            chunks={terminalFeeds[activeTab.id] ?? []}
            fontFamily={session?.terminalFontFamily}
            fontSize={session?.terminalFontSize}
            foreground={session?.terminalForeground}
            background={session?.terminalBackground}
            interactive={isInteractiveTerminal(session?.kind)}
            stopped={terminalStoppedByTabId[activeTab.id] ?? false}
            onExitTab={() => onCloseTab(activeTab.id)}
            onRestart={() => onRestartTab(activeTab.id)}
            onInput={(data) => onTerminalInput(activeTab.id, data)}
            onResize={(cols, rows) => onTerminalResize(activeTab.id, cols, rows)}
            commandRequest={terminalCommandRequest?.tabId === activeTab.id ? terminalCommandRequest : null}
          />
        )}
        {activeTab.kind === 'files' && session && <FileBrowserView session={session} />}
      </div>
    </section>
  )
}
