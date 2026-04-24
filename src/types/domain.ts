export type SidebarSection = 'sessions' | 'sftp' | 'tools' | 'macros'
export type SessionKind = 'local' | 'ssh' | 'telnet' | 'serial' | 'sftp' | 'ftp'
export type AuthType = 'password' | 'key' | 'none'

export interface SessionDefinition {
  id: string
  name: string
  folderPath?: string
  kind: SessionKind
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  keyPath?: string
  x11Forwarding?: boolean
  x11Trusted?: boolean
  x11Display?: string
  terminalFontFamily?: string
  terminalFontSize?: number
  terminalForeground?: string
  terminalBackground?: string
  linkedSshTabId?: string
  linkedSshSessionId?: string
  localWorkingDirectory?: string
  serialPort?: string
  baudRate?: number
  parity: 'none' | 'even' | 'odd'
  stopBits: 1 | 2
  dataBits: 5 | 6 | 7 | 8
  createdAt: string
  updatedAt: string
}

export interface SessionFolderDefinition {
  id: string
  path: string
  createdAt: string
  updatedAt: string
}

export interface MacroDefinition {
  id: string
  name: string
  command: string
  createdAt: string
  updatedAt: string
}

export interface UiPreferences {
  theme: 'dark'
  activeSidebar: SidebarSection
  sidebarWidth?: number
}

export interface SystemAuthSupport {
  available: boolean
  methodLabel: string
  detail: string
}

export interface LocalX11Support {
  systemX11Available: boolean
  systemDisplay?: string
  message: string
  detail: string
}

export interface LibsshProbePayload {
  backend: string
  authenticatedUser: string
  knownHosts: string
  ptySupported: boolean
  ptyTerm: string
  remoteCommand: string
  execStdout: string
  execStderr: string
  execExitStatus?: number | null
  remotePath: string
  sftpEntries: RemoteFileEntry[]
  notes: string[]
}

export interface AppBootstrap {
  sessions: SessionDefinition[]
  sessionFolders: SessionFolderDefinition[]
  macros: MacroDefinition[]
  preferences: UiPreferences
}

export interface WorkspaceTab {
  id: string
  title: string
  kind: 'welcome' | 'terminal' | 'files'
  protocol: 'welcome' | SessionKind
  sessionId?: string
  closable: boolean
}

export interface SessionStatusSnapshot {
  mode: 'live' | 'limited' | 'offline' | 'error'
  host: string
  user: string
  remoteOs: string
  uptime: string
  cpuLoad: string
  memoryUsage: string
  diskUsage: string
  network: string
  latency: string
}

export interface TerminalOutputPayload {
  tabId: string
  chunk: string
}

export interface TerminalExitPayload {
  tabId: string
  code?: number | null
  reason: string
}

export interface SessionStatusPayload {
  tabId: string
  mode: 'live' | 'limited' | 'offline' | 'error'
  host: string
  user: string
  remoteOs: string
  uptime: string
  cpuLoad: string
  memoryUsage: string
  diskUsage: string
  network: string
  latency: string
}

export interface SessionDraft {
  id?: string
  name: string
  folderPath: string
  kind: SessionKind
  host: string
  port: number
  username: string
  authType: AuthType
  password: string
  keyPath: string
  x11Forwarding: boolean
  x11Trusted: boolean
  x11Display: string
  terminalFontFamily: string
  terminalFontSize: number
  terminalForeground: string
  terminalBackground: string
  localWorkingDirectory: string
  serialPort: string
  baudRate: number
  parity: 'none' | 'even' | 'odd'
  stopBits: 1 | 2
  dataBits: 5 | 6 | 7 | 8
}

export interface MacroDraft {
  id?: string
  name: string
  command: string
}

export interface FileEntry {
  name: string
  kind: 'folder' | 'file'
  size: string
  modified: string
}

export interface RemoteFileEntry {
  name: string
  path: string
  kind: 'folder' | 'file'
  sizeBytes?: number
  sizeLabel: string
  modifiedLabel: string
}

export interface RemoteDirectorySnapshot {
  path: string
  entries: RemoteFileEntry[]
}

export interface FileDownloadResult {
  fileName: string
  savedTo: string
}

export interface RemoteDragEntry {
  remotePath: string
  fileName: string
  kind: 'folder' | 'file'
  transferId?: string
}

export type MenuAction =
  | 'new-session'
  | 'new-macro'
  | 'show-sessions'
  | 'show-tools'
  | 'show-macros'
  | 'lock-app'
  | 'search-terminal'
  | 'clear-terminal'
  | 'reset-terminal'

export interface MenuActionPayload {
  action: MenuAction
}

export type TransferDirection = 'download' | 'upload'
export type TransferPurpose = 'drag-export' | 'download' | 'upload'
export type TransferState = 'queued' | 'running' | 'completed' | 'error'

export interface TransferProgressPayload {
  transferId: string
  fileName: string
  remotePath: string
  direction: TransferDirection
  purpose: TransferPurpose
  state: TransferState
  transferredBytes: number
  totalBytes?: number
  message: string
  localPath?: string
  itemCount?: number
}
