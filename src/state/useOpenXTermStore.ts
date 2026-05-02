import { create } from 'zustand'

import { logOpenXTermError } from '../lib/errorLog'
import {
  bootstrapState,
  resizeTerminalSession,
  savePreferences,
  sendTerminalInput,
  startLocalSession,
  startSerialSession,
  startSshSession,
  startTelnetSession,
  stopTerminalSession,
} from '../lib/bridge'
import {
  buildMacroTranscript,
  createSessionTabInstance,
  createWelcomeTab,
  toTerminalChunks,
} from '../lib/sessionUtils'
import type { SessionDefinition } from '../types/domain'
import {
  buildLinkedSftpSession,
  clampSidebarWidth,
  defaultOfflineStatus,
  isLiveTerminalKind,
  nextSessionTabOrdinal,
  seedTerminalTabState,
  sortMacros,
  sortSessionFolders,
  sortSessions,
} from './openXTermStoreHelpers'
import { createDomainActions } from './openXTermStoreDomain'
import {
  clearCompletedTransferItems,
  enqueueTransferItem,
} from './openXTermStoreTransfers'
import { ensureTransportListeners } from './openXTermStoreListeners'
import type { OpenXTermState, StoreSetter } from './openXTermStoreTypes'

export type { SessionImportSummary } from './openXTermStoreTypes'

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
    enqueueTransferItem(set, item)
  },
  dismissTransferModal() {
    set({ transferModalDismissed: true })
  },
  clearCompletedTransfers() {
    clearCompletedTransferItems(set)
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
  ...createDomainActions(set, get),
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
