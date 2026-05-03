import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { createDefaultBootstrap } from './mockData'
import { buildFileEntries } from './sessionUtils'
import type {
  AppBootstrap,
  DownloadTargetInspection,
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
  TerminalCwdPayload,
  TerminalExitPayload,
  TerminalOutputPayload,
  TransferProgressPayload,
  UiPreferences,
} from '../types/domain'

const BROWSER_STORAGE_KEY = 'openxterm.browser.state'
const syntheticTransferProgressHandlers = new Set<(payload: TransferProgressPayload) => void>()

function isTauriRuntime() {
  return '__TAURI_INTERNALS__' in window
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function joinRemotePath(parent: string, name: string) {
  const cleanName = name.split('/').filter(Boolean).join('/')
  if (!cleanName) {
    return parent || '/'
  }

  if (!parent || parent === '/') {
    return `/${cleanName}`
  }

  return `${parent.replace(/\/+$/, '')}/${cleanName}`
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : String(error || fallback)
}

function emitSyntheticTransferProgress(payload: TransferProgressPayload) {
  queueMicrotask(() => {
    for (const handler of syntheticTransferProgressHandlers) {
      handler(payload)
    }
  })
}

async function invokeTransfer<T>(
  command: string,
  args: Record<string, unknown>,
  fallback: TransferProgressPayload | null,
) {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    if (fallback) {
      const message = errorMessage(error, 'Transfer failed.')
      const canceled = message === 'Transfer canceled'
      emitSyntheticTransferProgress({
        ...fallback,
        state: canceled ? 'canceled' : 'error',
        message: canceled ? 'Canceled' : message,
        retryable: canceled ? false : true,
      })
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function hasStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && isString(value.id)
}

function isSessionList(value: unknown): value is SessionDefinition[] {
  return Array.isArray(value)
    && value.every((item) => (
      hasStringId(item)
      && isString(item.name)
      && isString(item.kind)
      && typeof item.port === 'number'
    ))
}

function isSessionFolderList(value: unknown): value is SessionFolderDefinition[] {
  return Array.isArray(value)
    && value.every((item) => hasStringId(item) && isString(item.path))
}

function isMacroList(value: unknown): value is MacroDefinition[] {
  return Array.isArray(value)
    && value.every((item) => (
      hasStringId(item)
      && isString(item.name)
      && isString(item.command)
    ))
}

function isUiPreferences(value: unknown): value is UiPreferences {
  if (!isRecord(value)) {
    return false
  }

  return value.theme === 'dark'
    && ['sessions', 'sftp', 'tools', 'macros'].includes(String(value.activeSidebar))
    && (
      value.sidebarWidth === undefined
      || typeof value.sidebarWidth === 'number'
    )
    && (
      value.statusBarVisible === undefined
      || typeof value.statusBarVisible === 'boolean'
    )
}

function readBrowserState(): AppBootstrap {
  const seed = createDefaultBootstrap()
  const raw = localStorage.getItem(BROWSER_STORAGE_KEY)
  if (!raw) {
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(seed))
    return seed
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(seed))
    return seed
  }

  if (!isRecord(parsed)) {
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(seed))
    return seed
  }

  return {
    sessions: isSessionList(parsed.sessions) ? parsed.sessions : seed.sessions,
    sessionFolders: isSessionFolderList(parsed.sessionFolders) ? parsed.sessionFolders : seed.sessionFolders,
    macros: isMacroList(parsed.macros) ? parsed.macros : seed.macros,
    preferences: isUiPreferences(parsed.preferences) ? parsed.preferences : seed.preferences,
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

export async function readClipboardText() {
  if (isTauriRuntime()) {
    return invoke<string>('read_clipboard_text')
  }

  return navigator.clipboard?.readText?.() ?? ''
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
      createdLabel: '',
      ownerLabel: '',
      groupLabel: '',
      accessLabel: entry.kind === 'folder' ? 'drwxr-xr-x' : '-rw-r--r--',
      permissions: entry.kind === 'folder' ? 0o755 : 0o644,
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

export async function updateRemoteEntryPermissions(
  session: SessionDefinition,
  path: string,
  permissions: number,
) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('update_remote_entry_permissions', { session, path, permissions })
}

export async function cancelTransfer(transferId: string) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('cancel_transfer', { transferId })
}

export async function retryTransfer(transferId: string) {
  if (!isTauriRuntime()) {
    return
  }

  await invoke('retry_transfer', { transferId })
}

export async function inspectDownloadTarget(fileName: string) {
  if (isTauriRuntime()) {
    return invoke<DownloadTargetInspection>('inspect_download_target', { fileName })
  }

  return {
    fileName,
    path: fileName,
    exists: false,
    suggestedFileName: fileName,
    suggestedPath: fileName,
  } satisfies DownloadTargetInspection
}

export async function uploadRemoteFile(
  session: SessionDefinition,
  remoteDir: string,
  fileName: string,
  bytes: number[],
  transferId?: string,
  conflictAction = 'error',
) {
  if (!isTauriRuntime()) {
    return
  }

  await invokeTransfer('upload_remote_file', { session, remoteDir, fileName, bytes, transferId, conflictAction }, transferId
    ? {
        transferId,
        fileName,
        remotePath: joinRemotePath(remoteDir, fileName),
        direction: 'upload',
        purpose: 'upload',
        state: 'error',
        transferredBytes: 0,
        totalBytes: bytes.length,
        message: 'Transfer failed.',
      }
    : null)
}

export async function uploadLocalFile(
  session: SessionDefinition,
  remoteDir: string,
  localPath: string,
  transferId?: string,
  remoteName?: string,
  conflictAction = 'error',
) {
  if (!isTauriRuntime()) {
    return
  }

  const fileName = remoteName?.trim() || baseName(localPath)
  await invokeTransfer('upload_local_file', { session, remoteDir, localPath, transferId, remoteName, conflictAction }, transferId
    ? {
        transferId,
        fileName,
        remotePath: joinRemotePath(remoteDir, fileName),
        direction: 'upload',
        purpose: 'upload',
        state: 'error',
        transferredBytes: 0,
        message: 'Transfer failed.',
        localPath,
      }
    : null)
}

export async function uploadLocalPath(
  session: SessionDefinition,
  remoteDir: string,
  localPath: string,
  transferId?: string,
  remoteName?: string,
  conflictAction = 'error',
) {
  return uploadLocalFile(session, remoteDir, localPath, transferId, remoteName, conflictAction)
}

export async function downloadRemoteFile(
  session: SessionDefinition,
  remotePath: string,
  transferId?: string,
  fileName?: string,
  conflictAction = 'error',
) {
  if (isTauriRuntime()) {
    return invokeTransfer<FileDownloadResult>('download_remote_file', { session, remotePath, transferId, fileName, conflictAction }, transferId
      ? {
          transferId,
          fileName: fileName?.trim() || baseName(remotePath),
          remotePath,
          direction: 'download',
          purpose: 'download',
          state: 'error',
          transferredBytes: 0,
          message: 'Transfer failed.',
        }
      : null)
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
  fileName?: string,
  conflictAction = 'error',
) {
  if (isTauriRuntime()) {
    return invokeTransfer<FileDownloadResult>('download_remote_entry', {
        session,
        remotePath,
        kind,
        transferId,
        fileName,
        conflictAction,
      },
      transferId
        ? {
            transferId,
            fileName: fileName?.trim() || baseName(remotePath),
            remotePath,
            direction: 'download',
            purpose: 'download',
            state: 'error',
            transferredBytes: 0,
            message: 'Transfer failed.',
          }
        : null,
    )
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

  return invokeTransfer<FileDownloadResult>('prepare_remote_drag_file', { session, remotePath, transferId }, {
    transferId,
    fileName: baseName(remotePath),
    remotePath,
    direction: 'download',
    purpose: 'drag-export',
    state: 'error',
    transferredBytes: 0,
    message: 'Transfer failed.',
  })
}

export async function startNativeFileDrag(
  session: SessionDefinition,
  remotePath: string,
  fileName: string,
  sizeBytes: number | undefined,
  clientX: number,
  clientY: number,
) {
  if (!isTauriRuntime()) {
    return false
  }

  return invoke<boolean>('start_native_file_drag', { session, remotePath, fileName, sizeBytes, clientX, clientY })
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

export async function listenTerminalCwd(handler: (payload: TerminalCwdPayload) => void) {
  if (!isTauriRuntime()) {
    return () => {}
  }

  return listen<TerminalCwdPayload>('openxterm://terminal-cwd', (event) => {
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
  syntheticTransferProgressHandlers.add(handler)
  if (!isTauriRuntime()) {
    return () => {
      syntheticTransferProgressHandlers.delete(handler)
    }
  }

  const unlisten = await listen<TransferProgressPayload>('openxterm://transfer-progress', (event) => {
    handler(event.payload)
  })

  return () => {
    syntheticTransferProgressHandlers.delete(handler)
    void unlisten()
  }
}
