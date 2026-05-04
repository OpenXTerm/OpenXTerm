import {
  startLocalSession,
  startSerialSession,
  startSshSession,
  startTelnetSession,
  stopTerminalSession,
} from '../lib/bridge'
import { logOpenXTermError } from '../lib/errorLog'
import {
  createSessionTabInstance,
  createWelcomeTab,
} from '../lib/sessionUtils'
import type { SessionDefinition } from '../types/domain'
import {
  buildLinkedSftpSession,
  defaultOfflineStatus,
  isLiveTerminalKind,
  nextSessionTabOrdinal,
  seedTerminalTabState,
} from './openXTermStoreHelpers'
import type { OpenXTermState, StoreSetter } from './openXTermStoreTypes'

type StoreGetter = () => OpenXTermState
type TabActionKeys = 'selectTab' | 'closeTab' | 'restartTab' | 'openSession' | 'openLinkedSftp'

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

async function waitForTerminalTabPaint() {
  if (typeof window === 'undefined') {
    return
  }

  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
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

export function createTabActions(
  set: StoreSetter,
  get: StoreGetter,
): Pick<OpenXTermState, TabActionKeys> {
  return {
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
        await waitForTerminalTabPaint()
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
        await waitForTerminalTabPaint()
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
  }
}
