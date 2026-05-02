import {
  resizeTerminalSession,
  sendTerminalInput,
} from '../lib/bridge'
import { logOpenXTermError } from '../lib/errorLog'
import {
  buildMacroTranscript,
  toTerminalChunks,
} from '../lib/sessionUtils'
import { isLiveTerminalKind } from './openXTermStoreHelpers'
import type { OpenXTermState, StoreSetter } from './openXTermStoreTypes'

type StoreGetter = () => OpenXTermState
type TerminalActionKeys = 'runMacro' | 'sendInputToTab' | 'resizeTab'

export function createTerminalActions(
  set: StoreSetter,
  get: StoreGetter,
): Pick<OpenXTermState, TerminalActionKeys> {
  return {
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
  }
}
