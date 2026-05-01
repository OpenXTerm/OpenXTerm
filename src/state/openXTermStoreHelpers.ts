import type { MobaXtermImportResult } from '../lib/mobaxtermImport'
import {
  buildSessionTranscript,
  normalizeSessionFolderPath,
  toTerminalChunks,
} from '../lib/sessionUtils'
import type {
  MacroDefinition,
  SessionDefinition,
  SessionFolderDefinition,
  SessionStatusPayload,
  SessionStatusSnapshot,
  TransferProgressPayload,
  WorkspaceTab,
} from '../types/domain'
import type { OpenXTermState, SessionImportSummary } from './openXTermStoreTypes'

const CPU_HISTORY_SIZE = 22

export function sortSessions(sessions: SessionDefinition[]) {
  return [...sessions].sort((left, right) => {
    const folderCompare = normalizeSessionFolderPath(left.folderPath).localeCompare(
      normalizeSessionFolderPath(right.folderPath),
    )

    if (folderCompare !== 0) {
      return folderCompare
    }

    return left.name.localeCompare(right.name)
  })
}

export function sortMacros(macros: MacroDefinition[]) {
  return [...macros].sort((left, right) => left.name.localeCompare(right.name))
}

export function sortSessionFolders(sessionFolders: SessionFolderDefinition[]) {
  return [...sessionFolders].sort((left, right) => left.path.localeCompare(right.path))
}

export function buildSessionImportFingerprint(session: SessionDefinition) {
  return [
    session.kind,
    normalizeSessionFolderPath(session.folderPath),
    session.name.trim().toLowerCase(),
    session.host.trim().toLowerCase(),
    String(session.port || 0),
    session.username.trim().toLowerCase(),
    session.serialPort?.trim().toLowerCase() ?? '',
    String(session.baudRate || 0),
    session.parity,
    String(session.stopBits),
    String(session.dataBits),
    session.keyPath?.trim().toLowerCase() ?? '',
  ].join('|')
}

export function summarizeImportedSessions(
  result: MobaXtermImportResult,
  importedFolders: SessionFolderDefinition[],
  importedSessions: SessionDefinition[],
): SessionImportSummary {
  return {
    importedFolders: importedFolders.length,
    importedSessions: importedSessions.length,
    skippedExistingFolders: result.folders.length - importedFolders.length,
    skippedExistingSessions: result.sessions.length - importedSessions.length,
    skippedUnsupported: result.skipped.length,
  }
}

export function joinSessionFolderPath(parentPath: string | null, name: string) {
  const normalizedParent = normalizeSessionFolderPath(parentPath)
  const normalizedName = normalizeSessionFolderPath(name)
  return normalizedParent.length > 0 ? `${normalizedParent}/${normalizedName}` : normalizedName
}

export function isFolderPathInSubtree(path: string, subtreeRootPath: string) {
  return path === subtreeRootPath || path.startsWith(`${subtreeRootPath}/`)
}

export function replaceFolderPathPrefix(path: string, fromPrefix: string, toPrefix: string) {
  if (path === fromPrefix) {
    return toPrefix
  }

  if (!path.startsWith(`${fromPrefix}/`)) {
    return path
  }

  const suffix = path.slice(fromPrefix.length + 1)
  return toPrefix ? `${toPrefix}/${suffix}` : suffix
}

export function defaultOfflineStatus(): SessionStatusSnapshot {
  return {
    mode: 'offline',
    host: '--',
    user: '--',
    remoteOs: '--',
    uptime: '--',
    cpuLoad: '--',
    memoryUsage: '--',
    diskUsage: '--',
    network: '--',
    latency: '--',
  }
}

function parseCpuHistoryValue(cpuLoad: string) {
  const normalized = cpuLoad.trim()
  if (!normalized || normalized === '--' || normalized === 'unknown' || normalized === 'unavailable') {
    return 0
  }

  const percentMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%/)
  if (percentMatch) {
    return Math.min(100, Number(percentMatch[1]))
  }

  const firstNumber = normalized.match(/\d+(?:\.\d+)?/)
  if (!firstNumber) {
    return 0
  }

  const value = Number(firstNumber[0])
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(100, value))
}

export function appendCpuHistory(history: number[] | undefined, cpuLoad: string) {
  const nextHistory = [...(history ?? []), parseCpuHistoryValue(cpuLoad)]
  if (nextHistory.length >= CPU_HISTORY_SIZE) {
    return nextHistory.slice(nextHistory.length - CPU_HISTORY_SIZE)
  }

  return [...Array.from({ length: CPU_HISTORY_SIZE - nextHistory.length }, () => 0), ...nextHistory]
}

export function seedTerminalTabState(
  state: OpenXTermState,
  tabId: string,
  session: SessionDefinition,
): Pick<OpenXTermState, 'terminalFeeds' | 'terminalCwdByTabId' | 'terminalStoppedByTabId' | 'sessionStatusByTabId' | 'sessionCpuHistoryByTabId'> {
  const nextStatuses = { ...state.sessionStatusByTabId }
  const nextCpuHistory = { ...state.sessionCpuHistoryByTabId }
  const nextCwd = { ...state.terminalCwdByTabId }
  delete nextStatuses[tabId]
  delete nextCpuHistory[tabId]
  delete nextCwd[tabId]

  return {
    terminalFeeds: {
      ...state.terminalFeeds,
      [tabId]: toTerminalChunks(buildSessionTranscript(session)),
    },
    terminalCwdByTabId: nextCwd,
    terminalStoppedByTabId: {
      ...state.terminalStoppedByTabId,
      [tabId]: false,
    },
    sessionStatusByTabId: nextStatuses,
    sessionCpuHistoryByTabId: nextCpuHistory,
  }
}

export function mapStatusPayload(payload: SessionStatusPayload): SessionStatusSnapshot {
  return {
    mode: payload.mode,
    host: payload.host,
    user: payload.user,
    remoteOs: payload.remoteOs,
    uptime: payload.uptime,
    cpuLoad: payload.cpuLoad,
    memoryUsage: payload.memoryUsage,
    diskUsage: payload.diskUsage,
    network: payload.network,
    latency: payload.latency,
  }
}

export function isLiveTerminalKind(kind: SessionDefinition['kind']) {
  return kind === 'local' || kind === 'ssh' || kind === 'telnet' || kind === 'serial'
}

export function clampSidebarWidth(width: number) {
  return Math.min(840, Math.max(220, Math.round(width)))
}

export function buildLinkedSftpSession(session: SessionDefinition, linkedSshTabId?: string): SessionDefinition {
  return {
    ...session,
    id: linkedSshTabId ? `linked-sftp-${linkedSshTabId}` : `linked-sftp-${session.id}`,
    name: `${session.name} files`,
    kind: 'sftp',
    linkedSshTabId,
    linkedSshSessionId: session.id,
  }
}

export function nextSessionTabOrdinal(tabs: WorkspaceTab[], sessionId: string) {
  return tabs.filter((tab) => tab.sessionId === sessionId).length + 1
}

export function sortTransfers(items: Record<string, TransferProgressPayload>) {
  return Object.fromEntries(
    Object.entries(items).sort(([, left], [, right]) => left.fileName.localeCompare(right.fileName)),
  )
}
