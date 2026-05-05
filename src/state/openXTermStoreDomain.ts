import {
  deleteMacro,
  deleteSession,
  deleteSessionFolder,
  saveMacro,
  saveSession,
  saveSessionFolder,
  stopTerminalSession,
} from '../lib/bridge'
import { parseMobaXtermSessionsFile } from '../lib/mobaxtermImport'
import {
  buildSessionTranscript,
  createWelcomeTab,
  normalizeSessionFolderPath,
  toTerminalChunks,
} from '../lib/sessionUtils'
import type {
  MacroDefinition,
  SessionDefinition,
  SessionFolderDefinition,
} from '../types/domain'
import {
  buildSessionImportFingerprint,
  isFolderPathInSubtree,
  joinSessionFolderPath,
  replaceFolderPathPrefix,
  sortMacros,
  sortSessionFolders,
  sortSessions,
  summarizeImportedSessions,
} from './openXTermStoreHelpers'
import type { OpenXTermState, StoreSetter } from './openXTermStoreTypes'

type StoreGetter = () => OpenXTermState
type DomainActionKeys =
  | 'createSessionFolder'
  | 'removeSessionFolder'
  | 'moveSessionToFolder'
  | 'moveSessionFolder'
  | 'importMobaXtermSessions'
  | 'upsertSession'
  | 'removeSession'
  | 'upsertMacro'
  | 'removeMacro'

export function createDomainActions(
  set: StoreSetter,
  get: StoreGetter,
): Pick<OpenXTermState, DomainActionKeys> {
  return {
    async createSessionFolder(parentPath, name) {
      const normalizedPath = joinSessionFolderPath(parentPath, name)
      if (!normalizedPath) {
        return
      }

      const existing = get().sessionFolders.find((folder) => folder.path === normalizedPath)
      if (existing) {
        return
      }

      const now = new Date().toISOString()
      const folder: SessionFolderDefinition = {
        id: crypto.randomUUID(),
        path: normalizedPath,
        createdAt: now,
        updatedAt: now,
      }

      await saveSessionFolder(folder)
      set((state) => ({
        sessionFolders: sortSessionFolders([...state.sessionFolders, folder]),
      }))
    },
    async removeSessionFolder(folderId) {
      const folder = get().sessionFolders.find((item) => item.id === folderId)
      await deleteSessionFolder(folderId)

      if (!folder) {
        set((state) => ({
          sessionFolders: state.sessionFolders.filter((item) => item.id !== folderId),
        }))
        return
      }

      set((state) => ({
        sessionFolders: state.sessionFolders.filter((item) => !isFolderPathInSubtree(item.path, folder.path)),
        sessions: state.sessions.filter((session) => (
          !isFolderPathInSubtree(normalizeSessionFolderPath(session.folderPath), folder.path)
        )),
      }))
    },
    async moveSessionToFolder(sessionId, folderPath) {
      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session) {
        return
      }

      const normalizedFolderPath = normalizeSessionFolderPath(folderPath)
      const nextSession: SessionDefinition = {
        ...session,
        folderPath: normalizedFolderPath,
        updatedAt: new Date().toISOString(),
      }

      await saveSession(nextSession)
      set((state) => ({
        sessions: sortSessions(
          state.sessions.map((item) => (item.id === nextSession.id ? nextSession : item)),
        ),
      }))
    },
    async moveSessionFolder(folderId, parentPath) {
      const folder = get().sessionFolders.find((item) => item.id === folderId)
      if (!folder) {
        return
      }

      const normalizedParentPath = normalizeSessionFolderPath(parentPath)
      const folderName = folder.path.split('/').filter(Boolean).at(-1) ?? folder.path
      const nextFolderPath = joinSessionFolderPath(normalizedParentPath || null, folderName)

      if (!nextFolderPath || nextFolderPath === folder.path) {
        return
      }

      if (isFolderPathInSubtree(normalizedParentPath, folder.path)) {
        return
      }

      if (get().sessionFolders.some((item) => item.id !== folderId && item.path === nextFolderPath)) {
        return
      }

      const now = new Date().toISOString()
      const foldersToUpdate = get().sessionFolders
        .filter((item) => isFolderPathInSubtree(item.path, folder.path))
        .map((item) => ({
          ...item,
          path: replaceFolderPathPrefix(item.path, folder.path, nextFolderPath),
          updatedAt: now,
        }))

      const sessionsToUpdate = get().sessions
        .filter((item) => item.folderPath && isFolderPathInSubtree(item.folderPath, folder.path))
        .map((item) => ({
          ...item,
          folderPath: replaceFolderPathPrefix(item.folderPath ?? '', folder.path, nextFolderPath),
          updatedAt: now,
        }))

      for (const item of foldersToUpdate) {
        await saveSessionFolder(item)
      }

      for (const item of sessionsToUpdate) {
        await saveSession(item)
      }

      set((state) => ({
        sessionFolders: sortSessionFolders(
          state.sessionFolders.map((item) => foldersToUpdate.find((updated) => updated.id === item.id) ?? item),
        ),
        sessions: sortSessions(
          state.sessions.map((item) => sessionsToUpdate.find((updated) => updated.id === item.id) ?? item),
        ),
      }))
    },
    async importMobaXtermSessions(content) {
      const parsed = parseMobaXtermSessionsFile(content)
      const state = get()
      const existingFolderPaths = new Set(state.sessionFolders.map((folder) => folder.path))
      const existingSessionFingerprints = new Set(state.sessions.map(buildSessionImportFingerprint))

      const foldersToImport = parsed.folders.filter((folder) => !existingFolderPaths.has(folder.path))
      const sessionsToImport = parsed.sessions.filter((session) => {
        const fingerprint = buildSessionImportFingerprint(session)
        if (existingSessionFingerprints.has(fingerprint)) {
          return false
        }

        existingSessionFingerprints.add(fingerprint)
        return true
      })

      for (const folder of foldersToImport) {
        await saveSessionFolder(folder)
      }

      for (const session of sessionsToImport) {
        await saveSession(session)
      }

      const summary = summarizeImportedSessions(parsed, foldersToImport, sessionsToImport)

      if (foldersToImport.length === 0 && sessionsToImport.length === 0) {
        return summary
      }

      set((current) => ({
        sessionFolders: sortSessionFolders([...current.sessionFolders, ...foldersToImport]),
        sessions: sortSessions([...current.sessions, ...sessionsToImport]),
      }))

      return summary
    },
    async upsertSession(draft) {
      const now = new Date().toISOString()
      const existing = draft.id ? get().sessions.find((item) => item.id === draft.id) : undefined
      const session: SessionDefinition = {
        id: existing?.id ?? crypto.randomUUID(),
        name: draft.name.trim(),
        folderPath: normalizeSessionFolderPath(draft.folderPath),
        kind: draft.kind,
        host: draft.host.trim(),
        port: draft.port,
        username: draft.username.trim(),
        authType: draft.authType,
        password: draft.password,
        keyPath: draft.keyPath.trim(),
        proxyType: draft.proxyType,
        proxyHost: draft.proxyType === 'none' ? undefined : draft.proxyHost.trim(),
        proxyPort: draft.proxyType === 'none' ? undefined : draft.proxyPort,
        proxyUsername: draft.proxyType === 'none' ? undefined : draft.proxyUsername.trim(),
        proxyPassword: draft.proxyType === 'none' ? undefined : draft.proxyPassword,
        x11Forwarding: draft.x11Forwarding,
        x11Trusted: draft.x11Trusted,
        x11Display: draft.x11Display.trim(),
        terminalFontFamily: draft.terminalFontFamily,
        terminalFontSize: draft.terminalFontSize,
        terminalForeground: draft.terminalForeground,
        terminalBackground: draft.terminalBackground,
        localWorkingDirectory: draft.localWorkingDirectory.trim(),
        serialPort: draft.serialPort.trim(),
        baudRate: draft.baudRate,
        parity: draft.parity,
        stopBits: draft.stopBits,
        dataBits: draft.dataBits,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }

      await saveSession(session)

      set((state) => ({
        sessions: sortSessions(
          state.sessions.some((item) => item.id === session.id)
            ? state.sessions.map((item) => (item.id === session.id ? session : item))
            : [...state.sessions, session],
        ),
        tabs: state.tabs.map((tab) =>
          tab.sessionId === session.id
            ? {
                ...tab,
                title: session.name,
                kind: session.kind === 'sftp' || session.kind === 'ftp' ? 'files' : 'terminal',
                protocol: session.kind,
              }
            : tab,
        ),
        terminalFeeds:
          state.tabs.some((tab) => tab.sessionId === session.id && tab.kind === 'terminal')
            ? Object.fromEntries(
                Object.entries(state.terminalFeeds).map(([tabId, chunks]) => {
                  const relatedTab = state.tabs.find((tab) => tab.id === tabId && tab.sessionId === session.id)
                  return [tabId, relatedTab ? toTerminalChunks(buildSessionTranscript(session)) : chunks]
                }),
              )
            : state.terminalFeeds,
        sessionStatusByTabId: state.sessionStatusByTabId,
      }))
    },
    async removeSession(sessionId) {
      for (const tab of get().tabs) {
        if (tab.sessionId === sessionId && tab.kind === 'terminal' && tab.protocol !== 'welcome') {
          await stopTerminalSession(tab.id)
        }
      }

      await deleteSession(sessionId)
      set((state) => {
        const removedTabIds = new Set(state.tabs.filter((tab) => tab.sessionId === sessionId).map((tab) => tab.id))
        const tabs = state.tabs.filter((tab) => tab.sessionId !== sessionId)
        const nextTabs = tabs.length > 0 ? tabs : [createWelcomeTab()]
        const activeTabId = removedTabIds.has(state.activeTabId) ? nextTabs[0].id : state.activeTabId
        const terminalFeeds = Object.fromEntries(
          Object.entries(state.terminalFeeds).filter(([tabId]) => !removedTabIds.has(tabId)),
        )
        const terminalCwdByTabId = Object.fromEntries(
          Object.entries(state.terminalCwdByTabId).filter(([tabId]) => !removedTabIds.has(tabId)),
        )
        const terminalStoppedByTabId = Object.fromEntries(
          Object.entries(state.terminalStoppedByTabId).filter(([tabId]) => !removedTabIds.has(tabId)),
        )
        const sessionStatusByTabId = Object.fromEntries(
          Object.entries(state.sessionStatusByTabId).filter(([tabId]) => !removedTabIds.has(tabId)),
        )
        const sessionCpuHistoryByTabId = Object.fromEntries(
          Object.entries(state.sessionCpuHistoryByTabId).filter(([tabId]) => !removedTabIds.has(tabId)),
        )

        return {
          sessions: state.sessions.filter((item) => item.id !== sessionId),
          tabs: nextTabs,
          activeTabId,
          terminalFeeds,
          terminalCwdByTabId,
          terminalStoppedByTabId,
          sessionStatusByTabId,
          sessionCpuHistoryByTabId,
        }
      })
    },
    async upsertMacro(draft) {
      const now = new Date().toISOString()
      const existing = draft.id ? get().macros.find((item) => item.id === draft.id) : undefined
      const item: MacroDefinition = {
        id: existing?.id ?? crypto.randomUUID(),
        name: draft.name,
        command: draft.command,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }

      await saveMacro(item)
      set((state) => ({
        macros: sortMacros(
          state.macros.some((macroItem) => macroItem.id === item.id)
            ? state.macros.map((macroItem) => (macroItem.id === item.id ? item : macroItem))
            : [...state.macros, item],
        ),
      }))
    },
    async removeMacro(macroId) {
      await deleteMacro(macroId)
      set((state) => ({
        macros: state.macros.filter((item) => item.id !== macroId),
      }))
    },
  }
}
