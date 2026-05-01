import { create } from 'zustand'

import {
  aggregateBatchProgress,
  rememberBatchTransfer,
} from '../lib/transferBatch'
import { logOpenXTermError } from '../lib/errorLog'
import { parseMobaXtermSessionsFile } from '../lib/mobaxtermImport'
import {
  bootstrapState,
  deleteMacro,
  deleteSession,
  deleteSessionFolder,
  listenTransferProgress,
  listenSessionStatus,
  listenTerminalCwd,
  listenTerminalExit,
  listenTerminalOutput,
  resizeTerminalSession,
  saveMacro,
  savePreferences,
  saveSession,
  saveSessionFolder,
  sendTerminalInput,
  startLocalSession,
  startSerialSession,
  startSshSession,
  startTelnetSession,
  stopTerminalSession,
} from '../lib/bridge'
import {
  buildMacroTranscript,
  buildSessionTranscript,
  createSessionTabInstance,
  createWelcomeTab,
  normalizeSessionFolderPath,
  toTerminalChunks,
} from '../lib/sessionUtils'
import { mergeTransferProgress, writeTransferQueueSnapshot } from '../lib/transferQueue'
import { requestTransferWindow } from '../lib/transferWindow'
import type {
  MacroDefinition,
  SessionDefinition,
  SessionFolderDefinition,
  TransferProgressPayload,
} from '../types/domain'
import {
  appendCpuHistory,
  buildLinkedSftpSession,
  buildSessionImportFingerprint,
  clampSidebarWidth,
  defaultOfflineStatus,
  isFolderPathInSubtree,
  isLiveTerminalKind,
  joinSessionFolderPath,
  mapStatusPayload,
  nextSessionTabOrdinal,
  replaceFolderPathPrefix,
  seedTerminalTabState,
  sortMacros,
  sortSessionFolders,
  sortSessions,
  sortTransfers,
  summarizeImportedSessions,
} from './openXTermStoreHelpers'
import type { OpenXTermState, StoreSetter } from './openXTermStoreTypes'

export type { SessionImportSummary } from './openXTermStoreTypes'

let transportListenersReady: Promise<void> | null = null
let transferFlushScheduled = false
const pendingTransferPayloads = new Map<string, TransferProgressPayload>()
const loggedSessionStatusErrors = new Map<string, string>()
const loggedTransferErrors = new Map<string, string>()

async function startTerminalTransport(tabId: string, session: SessionDefinition) {
  if (session.kind === 'local') {
    await startLocalSession(tabId, session)
  } else if (session.kind === 'ssh') {
    await startSshSession(tabId, session)
  } else if (session.kind === 'telnet') {
    await startTelnetSession(tabId, session)
  } else if (session.kind === 'serial') {
    await startSerialSession(tabId, session)
  }
}

function applyTerminalLaunchError(
  set: StoreSetter,
  tabId: string,
  error: unknown,
) {
  logOpenXTermError('terminal.launch', error, { tabId })
  set((state) => ({
    terminalFeeds: {
      ...state.terminalFeeds,
      [tabId]: [
        ...(state.terminalFeeds[tabId] ?? []),
        `\r\n[error] ${error instanceof Error ? error.message : String(error)}\r\n`,
      ],
    },
    terminalStoppedByTabId: {
      ...state.terminalStoppedByTabId,
      [tabId]: false,
    },
    sessionStatusByTabId: {
      ...state.sessionStatusByTabId,
      [tabId]: {
        ...(state.sessionStatusByTabId[tabId] ?? defaultOfflineStatus()),
        mode: 'error',
        remoteOs: error instanceof Error ? error.message : String(error),
      },
    },
  }))
}

function scheduleTransferFlush(set: StoreSetter, payload: TransferProgressPayload) {
  const pendingPayload = pendingTransferPayloads.get(payload.transferId)
  pendingTransferPayloads.set(payload.transferId, mergeTransferProgress(pendingPayload, payload))

  if (transferFlushScheduled) {
    return
  }

  transferFlushScheduled = true
  window.requestAnimationFrame(() => {
    transferFlushScheduled = false
    const payloads = [...pendingTransferPayloads.values()]
    pendingTransferPayloads.clear()

    set((state) => {
      let changed = false
      const nextTransfers = { ...state.transferItems }

      for (const item of payloads) {
        const mergedTransfer = mergeTransferProgress(nextTransfers[item.transferId], item)
        if (nextTransfers[item.transferId] !== mergedTransfer) {
          nextTransfers[item.transferId] = mergedTransfer
          changed = true
        }
      }

      if (!changed) {
        return state
      }

      const transferItems = sortTransfers(nextTransfers)
      writeTransferQueueSnapshot(transferItems)
      return {
        transferItems,
        transferModalDismissed: false,
      }
    })
  })
}

function ensureTransportListeners(set: StoreSetter) {
  if (transportListenersReady) {
    return transportListenersReady
  }

  transportListenersReady = (async () => {
    await listenTerminalOutput((payload) => {
      set((state) => ({
        terminalFeeds: {
          ...state.terminalFeeds,
          [payload.tabId]: [...(state.terminalFeeds[payload.tabId] ?? []), payload.chunk],
        },
        terminalStoppedByTabId: {
          ...state.terminalStoppedByTabId,
          [payload.tabId]: false,
        },
      }))
    })

    await listenTerminalCwd((payload) => {
      set((state) => ({
        terminalCwdByTabId: {
          ...state.terminalCwdByTabId,
          [payload.tabId]: payload.path,
        },
      }))
    })

    await listenTerminalExit((payload) => {
      set((state) => ({
        terminalFeeds: {
          ...state.terminalFeeds,
          [payload.tabId]: [
            ...(state.terminalFeeds[payload.tabId] ?? []),
            `\r\n[connection closed] ${payload.reason}\r\n`,
          ],
        },
        terminalStoppedByTabId: {
          ...state.terminalStoppedByTabId,
          [payload.tabId]: true,
        },
        sessionStatusByTabId: {
          ...state.sessionStatusByTabId,
          [payload.tabId]: {
            ...(state.sessionStatusByTabId[payload.tabId] ?? defaultOfflineStatus()),
            mode: 'offline',
          },
        },
      }))
    })

    await listenSessionStatus((payload) => {
      const nextStatus = mapStatusPayload(payload)
      if (nextStatus.mode === 'error') {
        const signature = `${nextStatus.remoteOs}|${nextStatus.host}|${nextStatus.user}`
        if (loggedSessionStatusErrors.get(payload.tabId) !== signature) {
          loggedSessionStatusErrors.set(payload.tabId, signature)
          logOpenXTermError('session.status', nextStatus.remoteOs, {
            tabId: payload.tabId,
            host: nextStatus.host,
            user: nextStatus.user,
          })
        }
      } else {
        loggedSessionStatusErrors.delete(payload.tabId)
      }
      set((state) => ({
        sessionStatusByTabId: {
          ...state.sessionStatusByTabId,
          [payload.tabId]: nextStatus,
        },
        sessionCpuHistoryByTabId: {
          ...state.sessionCpuHistoryByTabId,
          [payload.tabId]: appendCpuHistory(state.sessionCpuHistoryByTabId[payload.tabId], nextStatus.cpuLoad),
        },
      }))
    })

    await listenTransferProgress((payload) => {
      const aggregatePayload = aggregateBatchProgress(payload)
      const transferPayload = aggregatePayload ?? payload
      if (transferPayload.state === 'error') {
        const signature = `${transferPayload.message}|${transferPayload.remotePath}|${transferPayload.localPath ?? ''}`
        if (loggedTransferErrors.get(transferPayload.transferId) !== signature) {
          loggedTransferErrors.set(transferPayload.transferId, signature)
          logOpenXTermError('transfer.progress', transferPayload.message, {
            transferId: transferPayload.transferId,
            fileName: transferPayload.fileName,
            remotePath: transferPayload.remotePath,
            localPath: transferPayload.localPath,
            direction: transferPayload.direction,
            purpose: transferPayload.purpose,
          })
        }
      } else if (transferPayload.state === 'completed') {
        loggedTransferErrors.delete(transferPayload.transferId)
      }
      if (aggregatePayload) {
        scheduleTransferFlush(set, payload)
      }
      scheduleTransferFlush(set, transferPayload)
      requestTransferWindow(transferPayload)
    })
  })()

  return transportListenersReady
}

export const useOpenXTermStore = create<OpenXTermState>((set, get) => ({
  initialized: false,
  sessions: [],
  sessionFolders: [],
  macros: [],
  preferences: {
    theme: 'dark',
    activeSidebar: 'sessions',
    sidebarWidth: 252,
  },
  tabs: [createWelcomeTab()],
  activeTabId: 'welcome',
  terminalFeeds: {},
  terminalCwdByTabId: {},
  terminalStoppedByTabId: {},
  sessionStatusByTabId: {},
  sessionCpuHistoryByTabId: {},
  transferItems: {},
  transferModalDismissed: false,
  async initialize() {
    if (get().initialized) {
      return
    }

    await ensureTransportListeners(set)
    const bootstrap = await bootstrapState()
    set({
      initialized: true,
      sessions: sortSessions(bootstrap.sessions),
      sessionFolders: sortSessionFolders(bootstrap.sessionFolders ?? []),
      macros: sortMacros(bootstrap.macros),
      preferences: {
        ...bootstrap.preferences,
        sidebarWidth: clampSidebarWidth(bootstrap.preferences.sidebarWidth ?? 252),
      },
      tabs: [createWelcomeTab()],
      activeTabId: 'welcome',
      terminalFeeds: {},
      terminalCwdByTabId: {},
      terminalStoppedByTabId: {},
      sessionStatusByTabId: {},
      sessionCpuHistoryByTabId: {},
      transferItems: {},
      transferModalDismissed: false,
    })
  },
  async setSidebar(section) {
    const nextPreferences = { ...get().preferences, activeSidebar: section }
    await savePreferences(nextPreferences)
    set({ preferences: nextPreferences })
  },
  async setSidebarWidth(width) {
    const nextPreferences = {
      ...get().preferences,
      sidebarWidth: clampSidebarWidth(width),
    }
    await savePreferences(nextPreferences)
    set({ preferences: nextPreferences })
  },
  enqueueTransfer(item) {
    rememberBatchTransfer(item)
    set((state) => {
      const mergedTransfer = mergeTransferProgress(state.transferItems[item.transferId], item)
      if (state.transferItems[item.transferId] === mergedTransfer) {
        requestTransferWindow(mergedTransfer)
        return state
      }

      const transferItems = sortTransfers({
        ...state.transferItems,
        [item.transferId]: mergedTransfer,
      })
      writeTransferQueueSnapshot(transferItems)
      requestTransferWindow(mergedTransfer)
      return {
        transferItems,
        transferModalDismissed: false,
      }
    })
  },
  dismissTransferModal() {
    set({ transferModalDismissed: true })
  },
  clearCompletedTransfers() {
    set((state) => {
      const transferItems = Object.fromEntries(
        Object.entries(state.transferItems).filter(([, item]) => item.state === 'queued' || item.state === 'running'),
      )
      writeTransferQueueSnapshot(transferItems)
      return {
        transferItems,
        transferModalDismissed: false,
      }
    })
  },
  selectTab(tabId) {
    set({ activeTabId: tabId })
  },
  closeTab(tabId) {
    const closingTab = get().tabs.find((tab) => tab.id === tabId)
    if (closingTab && closingTab.kind === 'terminal' && closingTab.protocol !== 'welcome') {
      void stopTerminalSession(tabId)
    }

    const remainingTabs = get().tabs.filter((tab) => tab.id !== tabId)
    const nextTabs = remainingTabs.length > 0 ? remainingTabs : [createWelcomeTab()]
    const nextActive = get().activeTabId === tabId ? nextTabs[nextTabs.length - 1].id : get().activeTabId

    set((state) => {
      const nextTerminalFeeds = { ...state.terminalFeeds }
      const nextCwd = { ...state.terminalCwdByTabId }
      const nextStopped = { ...state.terminalStoppedByTabId }
      const nextStatuses = { ...state.sessionStatusByTabId }
      const nextCpuHistory = { ...state.sessionCpuHistoryByTabId }
      delete nextTerminalFeeds[tabId]
      delete nextCwd[tabId]
      delete nextStopped[tabId]
      delete nextStatuses[tabId]
      delete nextCpuHistory[tabId]

      return {
        tabs: nextTabs,
        activeTabId: nextActive,
        terminalFeeds: nextTerminalFeeds,
        terminalCwdByTabId: nextCwd,
        terminalStoppedByTabId: nextStopped,
        sessionStatusByTabId: nextStatuses,
        sessionCpuHistoryByTabId: nextCpuHistory,
      }
    })
  },
  async restartTab(tabId) {
    const tab = get().tabs.find((item) => item.id === tabId)
    if (!tab || tab.kind !== 'terminal' || !tab.sessionId) {
      return
    }

    const session = get().sessions.find((item) => item.id === tab.sessionId)
    if (!session || !isLiveTerminalKind(session.kind)) {
      return
    }

    await stopTerminalSession(tabId).catch(() => {})

    set((state) => ({
      activeTabId: tabId,
      ...seedTerminalTabState(state, tabId, session),
    }))

    try {
      await startTerminalTransport(tabId, session)
    } catch (error) {
      applyTerminalLaunchError(set, tabId, error)
    }
  },
  async openSession(sessionId) {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session) {
      return
    }

    const tab = createSessionTabInstance(session, nextSessionTabOrdinal(get().tabs, session.id))

    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      ...(tab.kind === 'terminal' ? seedTerminalTabState(state, tab.id, session) : {}),
    }))

    if (!isLiveTerminalKind(session.kind)) {
      return
    }

    try {
      await startTerminalTransport(tab.id, session)
    } catch (error) {
      applyTerminalLaunchError(set, tab.id, error)
    }
  },
  async openLinkedSftp(sshSessionId, linkedSshTabId) {
    const sourceSession = get().sessions.find((item) => item.id === sshSessionId && item.kind === 'ssh')
    if (!sourceSession) {
      return
    }

    const linkedSession = buildLinkedSftpSession(sourceSession, linkedSshTabId)
    const tab = createSessionTabInstance(linkedSession, nextSessionTabOrdinal(get().tabs, linkedSession.id))
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    }))
  },
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
    await deleteSessionFolder(folderId)
    set((state) => ({
      sessionFolders: state.sessionFolders.filter((folder) => folder.id !== folderId),
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
      name: draft.name,
      folderPath: normalizeSessionFolderPath(draft.folderPath),
      kind: draft.kind,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      authType: draft.authType,
      password: draft.password,
      keyPath: draft.keyPath,
      x11Forwarding: draft.x11Forwarding,
      x11Trusted: draft.x11Trusted,
      x11Display: draft.x11Display,
      terminalFontFamily: draft.terminalFontFamily,
      terminalFontSize: draft.terminalFontSize,
      terminalForeground: draft.terminalForeground,
      terminalBackground: draft.terminalBackground,
      localWorkingDirectory: draft.localWorkingDirectory.trim(),
      serialPort: draft.serialPort,
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
  async runMacro(command) {
    const activeTab = get().tabs.find((tab) => tab.id === get().activeTabId)
    if (!activeTab || activeTab.kind !== 'terminal') {
      return
    }

    const activeSession = activeTab.sessionId
      ? get().sessions.find((session) => session.id === activeTab.sessionId)
      : undefined

    if (activeSession && isLiveTerminalKind(activeSession.kind)) {
      try {
        await sendTerminalInput(activeTab.id, `${command}\n`)
        return
      } catch (error) {
        logOpenXTermError('macro.send-input', error, {
          tabId: activeTab.id,
          sessionId: activeSession?.id,
        })
        set((state) => ({
          terminalFeeds: {
            ...state.terminalFeeds,
            [activeTab.id]: [
              ...(state.terminalFeeds[activeTab.id] ?? []),
              `\r\n[error] ${error instanceof Error ? error.message : String(error)}\r\n`,
            ],
          },
        }))
        return
      }
    }

    set((state) => ({
      terminalFeeds: {
        ...state.terminalFeeds,
        [activeTab.id]: [
          ...(state.terminalFeeds[activeTab.id] ?? []),
          ...toTerminalChunks(buildMacroTranscript(command)),
        ],
      },
    }))
  },
  sendInputToTab(tabId, data) {
    const tab = get().tabs.find((item) => item.id === tabId)
    if (!tab) {
      return
    }

    const session = tab.sessionId ? get().sessions.find((item) => item.id === tab.sessionId) : undefined
    if (!session || !isLiveTerminalKind(session.kind)) {
      return
    }

    void sendTerminalInput(tabId, data).catch((error) => {
      logOpenXTermError('terminal.input', error, { tabId, sessionId: session.id })
      set((state) => ({
        terminalFeeds: {
          ...state.terminalFeeds,
          [tabId]: [...(state.terminalFeeds[tabId] ?? []), `\r\n[error] ${String(error)}\r\n`],
        },
      }))
    })
  },
  resizeTab(tabId, cols, rows) {
    void resizeTerminalSession(tabId, cols, rows)
  },
}))
