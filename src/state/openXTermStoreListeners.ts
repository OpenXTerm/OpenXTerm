import {
  listenSessionStatus,
  listenTerminalCwd,
  listenTerminalExit,
  listenTerminalOutput,
  listenTransferProgress,
} from '../lib/bridge'
import { logOpenXTermError } from '../lib/errorLog'
import {
  appendCpuHistory,
  defaultOfflineStatus,
  mapStatusPayload,
} from './openXTermStoreHelpers'
import { handleTransferProgress } from './openXTermStoreTransfers'
import type { StoreSetter } from './openXTermStoreTypes'

let transportListenersReady: Promise<void> | null = null
const loggedSessionStatusErrors = new Map<string, string>()

export function ensureTransportListeners(set: StoreSetter) {
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

    await listenTransferProgress((payload) => handleTransferProgress(set, payload))
  })()

  return transportListenersReady
}
