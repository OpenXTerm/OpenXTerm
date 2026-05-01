import type {
  MacroDefinition,
  MacroDraft,
  SessionDefinition,
  SessionDraft,
  SessionFolderDefinition,
  SessionStatusSnapshot,
  SidebarSection,
  TransferProgressPayload,
  UiPreferences,
  WorkspaceTab,
} from '../types/domain'

export interface OpenXTermState {
  initialized: boolean
  sessions: SessionDefinition[]
  sessionFolders: SessionFolderDefinition[]
  macros: MacroDefinition[]
  preferences: UiPreferences
  tabs: WorkspaceTab[]
  activeTabId: string
  terminalFeeds: Record<string, string[]>
  terminalCwdByTabId: Record<string, string>
  terminalStoppedByTabId: Record<string, boolean>
  sessionStatusByTabId: Record<string, SessionStatusSnapshot>
  sessionCpuHistoryByTabId: Record<string, number[]>
  transferItems: Record<string, TransferProgressPayload>
  transferModalDismissed: boolean
  initialize: () => Promise<void>
  setSidebar: (section: SidebarSection) => Promise<void>
  setSidebarWidth: (width: number) => Promise<void>
  enqueueTransfer: (item: TransferProgressPayload) => void
  dismissTransferModal: () => void
  clearCompletedTransfers: () => void
  selectTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  restartTab: (tabId: string) => Promise<void>
  openSession: (sessionId: string) => Promise<void>
  openLinkedSftp: (sshSessionId: string, linkedSshTabId?: string) => Promise<void>
  createSessionFolder: (parentPath: string | null, name: string) => Promise<void>
  removeSessionFolder: (folderId: string) => Promise<void>
  moveSessionToFolder: (sessionId: string, folderPath: string) => Promise<void>
  moveSessionFolder: (folderId: string, parentPath: string) => Promise<void>
  importMobaXtermSessions: (content: string) => Promise<SessionImportSummary>
  upsertSession: (draft: SessionDraft) => Promise<void>
  removeSession: (sessionId: string) => Promise<void>
  upsertMacro: (draft: MacroDraft) => Promise<void>
  removeMacro: (macroId: string) => Promise<void>
  runMacro: (command: string) => Promise<void>
  sendInputToTab: (tabId: string, data: string) => void
  resizeTab: (tabId: string, cols: number, rows: number) => void
}

export type StoreSetter = (
  partial:
    | Partial<OpenXTermState>
    | OpenXTermState
    | ((state: OpenXTermState) => Partial<OpenXTermState> | OpenXTermState),
) => void

export interface SessionImportSummary {
  importedSessions: number
  importedFolders: number
  skippedExistingSessions: number
  skippedExistingFolders: number
  skippedUnsupported: number
}
