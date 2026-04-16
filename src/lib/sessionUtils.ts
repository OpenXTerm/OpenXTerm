import type {
  FileEntry,
  SessionDefinition,
  SessionKind,
  WorkspaceTab,
} from '../types/domain'

export function createWelcomeTab(): WorkspaceTab {
  return {
    id: 'welcome',
    title: 'OpenXTerm',
    kind: 'welcome',
    protocol: 'welcome',
    closable: false,
  }
}

export function createSessionTab(session: SessionDefinition): WorkspaceTab {
  return createSessionTabInstance(session, 1)
}

export function createSessionTabInstance(session: SessionDefinition, ordinal: number): WorkspaceTab {
  const kind = session.kind === 'sftp' || session.kind === 'ftp' ? 'files' : 'terminal'
  return {
    id: `tab-${crypto.randomUUID()}`,
    title: ordinal > 1 ? `${session.name} (${ordinal})` : session.name,
    kind,
    protocol: session.kind,
    sessionId: session.id,
    closable: true,
  }
}

export function normalizeSessionFolderPath(folderPath?: string | null) {
  return (folderPath ?? '')
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
}

export function splitSessionFolderPath(folderPath?: string | null) {
  const normalized = normalizeSessionFolderPath(folderPath)
  return normalized.length > 0 ? normalized.split('/') : []
}

export function getDefaultPort(kind: SessionKind) {
  switch (kind) {
    case 'local':
      return 0
    case 'ssh':
    case 'sftp':
      return 22
    case 'telnet':
      return 23
    case 'ftp':
      return 21
    case 'serial':
      return 0
  }
}

export function buildSessionTranscript(session: SessionDefinition) {
  const target =
    session.kind === 'local'
      ? 'this computer'
      : session.kind === 'serial'
      ? session.serialPort || '/dev/tty.*'
      : session.username
        ? `${session.username}@${session.host || 'host'}`
        : session.host || 'host'
  const transportLabel = session.kind.toUpperCase()
  const promptUser = session.username || 'terminal'
  const localWorkingDirectory = session.localWorkingDirectory?.trim() || '~'

  return [
    session.kind === 'ssh'
      ? '\x1b[38;2;54;255;187m • OpenXTerm SSH runtime\x1b[0m'
      : session.kind === 'local'
        ? '\x1b[38;2;54;255;187m • OpenXTerm LOCAL runtime\x1b[0m'
        : session.kind === 'telnet'
        ? '\x1b[38;2;54;255;187m • OpenXTerm TELNET runtime\x1b[0m'
        : session.kind === 'serial'
          ? '\x1b[38;2;54;255;187m • OpenXTerm SERIAL runtime\x1b[0m'
      : '\x1b[38;2;54;255;187m • OpenXTerm file browser\x1b[0m',
    session.kind === 'ssh'
      ? '\x1b[38;2;255;220;102m (key / agent auth path is active in this pass)\x1b[0m'
      : session.kind === 'local'
        ? '\x1b[38;2;255;220;102m (native local shell backend is active in this pass)\x1b[0m'
        : session.kind === 'telnet'
        ? '\x1b[38;2;255;220;102m (native telnet negotiation backend is active in this pass)\x1b[0m'
        : session.kind === 'serial'
          ? '\x1b[38;2;255;220;102m (native serial backend is active in this pass)\x1b[0m'
      : `\x1b[38;2;255;220;102m (${transportLabel} transport shell scheduled for next stage)\x1b[0m`,
    '',
    `> preparing ${transportLabel} session to ${target}`,
    `> profile: ${session.name}`,
    session.kind === 'local'
      ? `> shell: operating system default (${localWorkingDirectory})`
      : session.kind === 'serial'
      ? `> line settings: ${session.baudRate || 115200} baud / ${session.dataBits}${session.parity[0].toUpperCase()}${session.stopBits}`
      : `> endpoint: ${session.host}:${session.port}`,
    ...(session.kind === 'ssh' && !session.username
      ? ['> login: remote server will ask for username in the terminal']
      : []),
    ...(session.kind === 'ssh'
      ? [
          session.x11Forwarding
            ? `> X11: ${session.x11Trusted ?? true ? 'trusted' : 'untrusted'} forwarding enabled${session.x11Display?.trim() ? ` via ${session.x11Display.trim()}` : ''}`
            : '> X11: disabled in this profile',
        ]
      : []),
    '',
    session.kind === 'local' || session.kind === 'ssh' || session.kind === 'telnet' || session.kind === 'serial'
      ? '[information] terminal host is switching to the system transport process'
      : '[information] tab shell is live, protocol adapter is the next milestone',
    '[information] copy/paste, scrollback, resize, macros and status rail are already wired',
    session.kind === 'local' || session.kind === 'ssh' || session.kind === 'telnet' || session.kind === 'serial'
      ? '[information] waiting for transport output...'
      : '[warning] no remote socket is opened in this foundation stage yet',
    '',
    `${promptUser}@openxterm:${session.kind === 'serial' ? '~' : session.kind === 'local' ? localWorkingDirectory : '/'}$ `,
  ]
}

export function buildMacroTranscript(command: string) {
  return [
    '',
    `\x1b[38;2;102;224;255m$ ${command}\x1b[0m`,
    '[queued] macro entered into terminal host',
    '[queued] transport execution will be attached in the next protocol pass',
  ]
}

export function toTerminalChunks(lines: string[]) {
  return lines.map((line) => (line.endsWith('$ ') ? line : `${line}\r\n`))
}

export function buildFileEntries(session: SessionDefinition): FileEntry[] {
  if (session.kind === 'ftp') {
    return [
      { name: 'incoming', kind: 'folder', size: '--', modified: 'today 09:20' },
      { name: 'release', kind: 'folder', size: '--', modified: 'today 09:04' },
      { name: 'archive-2026-04.tar.gz', kind: 'file', size: '182 MB', modified: 'yesterday' },
      { name: 'checksums.txt', kind: 'file', size: '2 KB', modified: 'yesterday' },
    ]
  }

  return [
    { name: 'etc', kind: 'folder', size: '--', modified: 'today 09:18' },
    { name: 'home', kind: 'folder', size: '--', modified: 'today 09:12' },
    { name: 'var', kind: 'folder', size: '--', modified: 'today 08:48' },
    { name: 'motd', kind: 'file', size: '1 KB', modified: 'today 08:32' },
    { name: '.bashrc', kind: 'file', size: '4 KB', modified: 'yesterday' },
  ]
}
