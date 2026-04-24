import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { createDefaultBootstrap } from './mockData'
import { buildFileEntries } from './sessionUtils'
import type {
  AppBootstrap,
  FileDownloadResult,
  LibsshProbePayload,
  LocalX11Support,
  MacroDefinition,
  MenuActionPayload,
  RemoteDirectorySnapshot,
  RemoteDragEntry,
  SessionDefinition,
  SessionFolderDefinition,
  SessionStatusPayload,
  SystemAuthSupport,
  TerminalExitPayload,
  TerminalOutputPayload,
  TransferProgressPayload,
  UiPreferences,
} from '../types/domain'

const BROWSER_STORAGE_KEY = 'openxterm.browser.state'

function isTauriRuntime() {
  return '__TAURI_INTERNALS__' in window
}

function readBrowserState(): AppBootstrap {
  const raw = localStorage.getItem(BROWSER_STORAGE_KEY)
  if (!raw) {
    const seed = createDefaultBootstrap()
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(seed))
    return seed
  }

  const parsed = JSON.parse(raw) as Partial<AppBootstrap>
  const seed = createDefaultBootstrap()

  return {
    sessions: parsed.sessions ?? seed.sessions,
    sessionFolders: parsed.sessionFolders ?? seed.sessionFolders,
    macros: parsed.macros ?? seed.macros,
    preferences: parsed.preferences ?? seed.preferences,
  }
}

function writeBrowserState(state: AppBootstrap) {
  localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(state))
}

export async function bootstrapState() {
  if (isTauriRuntime()) {
    return invoke<AppBootstrap>('bootstrap_state')
  }
  return readBrowserState()
}

export async function saveSession(session: SessionDefinition) {
  if (isTauriRuntime()) {
    return invoke<SessionDefinition>('save_session', { session })
  }

  const state = readBrowserState()
  const sessions = state.sessions.some((item) => item.id === session.id)
    ? state.sessions.map((item) => (item.id === session.id ? session : item))
    : [...state.sessions, session]

  writeBrowserState({ ...state, sessions })
  return session
}

export async function saveSessionFolder(folder: SessionFolderDefinition) {
  if (isTauriRuntime()) {
    return invoke<SessionFolderDefinition>('save_session_folder', { folder })
  }

  const state = readBrowserState()
  const sessionFolders = state.sessionFolders.some((item) => item.id === folder.id)
    ? state.sessionFolders.map((item) => (item.id === folder.id ? folder : item))
    : [...state.sessionFolders, folder]

  writeBrowserState({ ...state, sessionFolders })
  return folder
}

export async function deleteSession(sessionId: string) {
  if (isTauriRuntime()) {
    return invoke<void>('delete_session', { sessionId })
  }

  const state = readBrowserState()
  writeBrowserState({
    ...state,
    sessions: state.sessions.filter((item) => item.id !== sessionId),
  })
}

export async function deleteSessionFolder(folderId: string) {
  if (isTauriRuntime()) {
    return invoke<void>('delete_session_folder', { folderId })
  }

  const state = readBrowserState()
  writeBrowserState({
    ...state,
    sessionFolders: state.sessionFolders.filter((item) => item.id !== folderId),
  })
}

export async function saveMacro(item: MacroDefinition) {
  if (isTauriRuntime()) {
    return invoke<MacroDefinition>('save_macro', { item })
  }

  const state = readBrowserState()
  const macros = state.macros.some((macroItem) => macroItem.id === item.id)
    ? state.macros.map((macroItem) => (macroItem.id === item.id ? item : macroItem))
    : [...state.macros, item]

  writeBrowserState({ ...state, macros })
  return item
}

export async function deleteMacro(macroId: string) {
  if (isTauriRuntime()) {
    return invoke<void>('delete_macro', { macroId })
  }

  const state = readBrowserState()
  writeBrowserState({
    ...state,
    macros: state.macros.filter((item) => item.id !== macroId),
  })
}

export async function savePreferences(preferences: UiPreferences) {
  if (isTauriRuntime()) {
    return invoke<UiPreferences>('save_preferences', { preferences })
  }

  const state = readBrowserState()
  writeBrowserState({ ...state, preferences })
  return preferences
}

export async function getSystemAuthSupport() {
  if (isTauriRuntime()) {
    return invoke<SystemAuthSupport>('get_system_auth_support')
  }

  return {
    available: false,
    methodLabel: 'System authentication',
    detail: 'Available only in the desktop Tauri build.',
  } satisfies SystemAuthSupport
}

export async function requestSystemUnlock(reason: string) {
  if (!isTauriRuntime()) {
    return false
  }

  return invoke<boolean>('request_system_unlock', { reason })
}

export async function inspectLocalX11Support(displayOverride?: string) {
  if (isTauriRuntime()) {
    return invoke<LocalX11Support>('inspect_local_x11_support', { displayOverride })
  }

  return {
    systemX11Available: false,
    message: 'Local X11 checks are available only in the desktop Tauri build.',
    detail: 'Use the desktop app to inspect local X11 support.',
  } satisfies LocalX11Support
}

export async function openExternalTarget(target: string) {
  if (isTauriRuntime()) {
    return invoke<void>('open_external_target', { target })
  }

  window.open(target, '_blank', 'noopener,noreferrer')
}

export async function listSystemFontFamilies() {
  if (isTauriRuntime()) {
    return invoke<string[]>('list_system_font_families')
  }

  return [
    'SF Mono',
    'JetBrains Mono',
    'Menlo',
    'Monaco',
    'Cascadia Code',
    'Consolas',
    'Fira Code',
    'IBM Plex Mono',
    'Source Code Pro',
    'Ubuntu Mono',
    'DejaVu Sans Mono',
  ]
}

export async function runLibsshProbe(
  session: SessionDefinition,
  remoteCommand?: string,
  remotePath?: string,
) {
  if (!isTauriRuntime()) {
    throw new Error('libssh-rs probe is available only in the desktop Tauri build.')
  }

  return invoke<LibsshProbePayload>('run_libssh_probe', { session, remoteCommand, remotePath })
}

export async function startSshSession(tabId: string, session: SessionDefinition) {
  if (!isTauriRuntime()) {
    return false
  }

  return invoke<boolean>('start_ssh_session', { tabId, session })
}

export async function startLocalSession(tabId: string, session: SessionDefinition) {
  if (!isTauriRuntime()) {
    return false
  }

  return invoke<boolean>('start_local_session', { tabId, session })
}

export async function startTelnetSession(tabId: string, session: SessionDefinition) {
  if (!isTauriRuntime()) {
    return false
  }

  return invoke<boolean>('start_telnet_session', { tabId, session })
}

export async function startSerialSession(tabId: string, session: SessionDefinition) {
  if (!isTauriRuntime()) {
    return false
  }

  return invoke<boolean>('start_serial_session', { tabId, session })
}

export async function sendTerminalInput(tabId: string, data: string) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('send_terminal_input', { tabId, data })
}

export async function stopTerminalSession(tabId: string) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('stop_terminal_session', { tabId })
}

export async function resizeTerminalSession(tabId: string, cols: number, rows: number) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('resize_terminal_session', { tabId, cols, rows })
}

export async function listRemoteDirectory(session: SessionDefinition, path?: string) {
  if (isTauriRuntime()) {
    return invoke<RemoteDirectorySnapshot>('list_remote_directory', { session, path })
  }

  const effectivePath = path && path.trim().length > 0 ? path : '/'
  return {
    path: effectivePath,
    entries: buildFileEntries(session).map((entry) => ({
      name: entry.name,
      path: effectivePath === '/' ? `/${entry.name}` : `${effectivePath}/${entry.name}`,
      kind: entry.kind,
      sizeLabel: entry.size,
      modifiedLabel: entry.modified,
    })),
  } satisfies RemoteDirectorySnapshot
}

export async function createRemoteDirectory(session: SessionDefinition, parentPath: string, name: string) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('create_remote_directory', { session, parentPath, name })
}

export async function deleteRemoteEntry(
  session: SessionDefinition,
  path: string,
  kind: 'folder' | 'file',
) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('delete_remote_entry', { session, path, kind })
}

export async function renameRemoteEntry(session: SessionDefinition, path: string, newName: string) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('rename_remote_entry', { session, path, newName })
}

export async function cancelTransfer(transferId: string) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('cancel_transfer', { transferId })
}

export async function uploadRemoteFile(
  session: SessionDefinition,
  remoteDir: string,
  fileName: string,
  bytes: number[],
  transferId?: string,
) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('upload_remote_file', { session, remoteDir, fileName, bytes, transferId })
}

export async function uploadLocalFile(
  session: SessionDefinition,
  remoteDir: string,
  localPath: string,
  transferId?: string,
) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('upload_local_file', { session, remoteDir, localPath, transferId })
}

export async function uploadLocalPath(
  session: SessionDefinition,
  remoteDir: string,
  localPath: string,
  transferId?: string,
) {
  return uploadLocalFile(session, remoteDir, localPath, transferId)
}

export async function downloadRemoteFile(
  session: SessionDefinition,
  remotePath: string,
  transferId?: string,
) {
  if (isTauriRuntime()) {
    return invoke<FileDownloadResult>('download_remote_file', { session, remotePath, transferId })
  }

  return {
    fileName: remotePath.split('/').filter(Boolean).at(-1) ?? 'download.bin',
    savedTo: 'browser download',
  } satisfies FileDownloadResult
}

export async function downloadRemoteEntry(
  session: SessionDefinition,
  remotePath: string,
  kind: 'folder' | 'file',
  transferId?: string,
) {
  if (isTauriRuntime()) {
    return invoke<FileDownloadResult>('download_remote_entry', { session, remotePath, kind, transferId })
  }

  return {
    fileName: remotePath.split('/').filter(Boolean).at(-1) ?? 'download.bin',
    savedTo: 'browser download',
  } satisfies FileDownloadResult
}

export async function prepareRemoteDragFile(
  session: SessionDefinition,
  remotePath: string,
  transferId: string,
) {
  if (!isTauriRuntime()) {
    return {
      fileName: remotePath.split('/').filter(Boolean).at(-1) ?? 'download.bin',
      savedTo: 'browser drag cache',
    } satisfies FileDownloadResult
  }

  return invoke<FileDownloadResult>('prepare_remote_drag_file', { session, remotePath, transferId })
}

export async function startNativeFileDrag(
  session: SessionDefinition,
  remotePath: string,
  fileName: string,
  clientX: number,
  clientY: number,
) {
  if (!isTauriRuntime()) {
    return false
  }

  return invoke<boolean>('start_native_file_drag', { session, remotePath, fileName, clientX, clientY })
}

export async function startNativeEntriesDrag(
  session: SessionDefinition,
  entries: RemoteDragEntry[],
  clientX: number,
  clientY: number,
) {
  if (!isTauriRuntime()) {
    return false
  }

  return invoke<boolean>('start_native_entries_drag', { session, entries, clientX, clientY })
}

export async function listenTerminalOutput(handler: (payload: TerminalOutputPayload) => void) {
  if (!isTauriRuntime()) {
    return () => {}
  }

  return listen<TerminalOutputPayload>('openxterm://terminal-output', (event) => {
    handler(event.payload)
  })
}

export async function listenTerminalExit(handler: (payload: TerminalExitPayload) => void) {
  if (!isTauriRuntime()) {
    return () => {}
  }

  return listen<TerminalExitPayload>('openxterm://terminal-exit', (event) => {
    handler(event.payload)
  })
}

export async function listenSessionStatus(handler: (payload: SessionStatusPayload) => void) {
  if (!isTauriRuntime()) {
    return () => {}
  }

  return listen<SessionStatusPayload>('openxterm://session-status', (event) => {
    handler(event.payload)
  })
}

export async function listenMenuAction(handler: (payload: MenuActionPayload) => void) {
  if (!isTauriRuntime()) {
    return () => {}
  }

  return listen<MenuActionPayload>('openxterm://menu-action', (event) => {
    handler(event.payload)
  })
}

export async function listenTransferProgress(handler: (payload: TransferProgressPayload) => void) {
  if (!isTauriRuntime()) {
    return () => {}
  }

  return listen<TransferProgressPayload>('openxterm://transfer-progress', (event) => {
    handler(event.payload)
  })
}
