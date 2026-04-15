import { HardDrive, Network, Plus, Server, Terminal, Usb } from 'lucide-react'

import type { SessionDefinition, SessionKind } from '../../types/domain'

interface WelcomePaneProps {
  sessions: SessionDefinition[]
  onCreateSession: () => void
  onOpenSession: (sessionId: string) => void
  onShowSftp: () => void
  onShowTools: () => void
}

const SESSION_KIND_LABELS: Record<SessionKind, string> = {
  local: 'Local',
  ssh: 'SSH',
  telnet: 'Telnet',
  serial: 'Serial',
  sftp: 'SFTP',
  ftp: 'FTP',
}

function getSessionIcon(kind: SessionKind) {
  if (kind === 'ssh') {
    return <Server size={14} />
  }
  if (kind === 'sftp' || kind === 'ftp') {
    return <HardDrive size={14} />
  }
  if (kind === 'serial') {
    return <Usb size={14} />
  }
  if (kind === 'telnet') {
    return <Network size={14} />
  }
  return <Terminal size={14} />
}

function formatEndpoint(session: SessionDefinition) {
  if (session.kind === 'local') {
    return 'default shell'
  }
  if (session.kind === 'serial') {
    return session.serialPort || 'serial port'
  }
  return `${session.host || 'host'}:${session.port}`
}

function sortSessionsByUpdatedAt(sessions: SessionDefinition[]) {
  return [...sessions].sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt)
    const leftTime = Date.parse(left.updatedAt)
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
  })
}

export function WelcomePane({
  sessions,
  onCreateSession,
  onOpenSession,
  onShowSftp,
  onShowTools,
}: WelcomePaneProps) {
  const recentSessions = sortSessionsByUpdatedAt(sessions).slice(0, 7)
  const localSession = sessions.find((session) => session.kind === 'local')
  const fileSession = sessions.find((session) => session.kind === 'sftp' || session.kind === 'ftp')

  return (
    <div className="welcome-pane">
      <section className="home-card">
        <div className="home-card-header">
          <p className="home-eyebrow">OpenXTerm workspace</p>
          <h1>Start a session</h1>
          <p className="home-subtitle">Open a saved connection, start a local shell, or jump into remote files.</p>
        </div>
        <div className="home-hero-actions" aria-label="Quick actions">
          <button className="home-action primary" type="button" onClick={onCreateSession}>
            <Plus size={15} />
            <span>New session</span>
          </button>
          <button
            className="home-action"
            type="button"
            onClick={() => (localSession ? onOpenSession(localSession.id) : onCreateSession())}
          >
            <Terminal size={15} />
            <span>Local shell</span>
          </button>
          <button
            className="home-action"
            type="button"
            onClick={() => (fileSession ? onOpenSession(fileSession.id) : onShowSftp())}
          >
            <HardDrive size={15} />
            <span>SFTP</span>
          </button>
          <button className="home-action" type="button" onClick={onShowTools}>
            <Network size={15} />
            <span>Tools</span>
          </button>
        </div>

        <div className="home-recent">
          <div className="home-recent-heading">
            <span>Recent connections</span>
            <span>{sessions.length} saved</span>
          </div>

          <div className="home-session-list">
            {recentSessions.length === 0 && (
              <button className="home-empty-row" type="button" onClick={onCreateSession}>
                <Plus size={14} />
                <span>Create your first session</span>
              </button>
            )}

            {recentSessions.map((session) => (
              <button
                key={session.id}
                className="home-session-row"
                type="button"
                onClick={() => onOpenSession(session.id)}
              >
                <span className="home-session-icon">{getSessionIcon(session.kind)}</span>
                <span className="home-session-main">
                  <strong>{session.name}</strong>
                  <span>{formatEndpoint(session)}</span>
                </span>
                <span className="home-session-meta">
                  <span>{SESSION_KIND_LABELS[session.kind]}</span>
                  {session.folderPath && <span>{session.folderPath}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
