import { useMemo, type ReactNode } from 'react'
import { Activity, Clock3, Cpu, HardDrive, Monitor, Network, User } from 'lucide-react'

import type { SessionDefinition, SessionStatusSnapshot, WorkspaceTab } from '../../types/domain'

interface StatusBarProps {
  activeTab: WorkspaceTab | undefined
  sessions: SessionDefinition[]
  sessionCpuHistoryByTabId: Record<string, number[]>
  sessionMemoryHistoryByTabId: Record<string, number[]>
  sessionNetworkDownHistoryByTabId: Record<string, number[]>
  sessionNetworkUpHistoryByTabId: Record<string, number[]>
  sessionStatusByTabId: Record<string, SessionStatusSnapshot>
}

const STATUS_HISTORY_SIZE = 22
const EMPTY_STATUS_HISTORY = Array.from({ length: STATUS_HISTORY_SIZE }, () => 0)

function compactValue(value: string, fallback = '--') {
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'unknown' || trimmed === 'unavailable') {
    return fallback
  }
  return trimmed
}

function formatUptimeValue(value: string) {
  const trimmed = compactValue(value)
  if (trimmed === '--') {
    return trimmed
  }

  const normalized = trimmed
    .replace(/^up\s+/i, '')
    .replace(/,/g, ' ')
    .toLowerCase()

  const tokens = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)]
  if (tokens.length === 0) {
    return trimmed
  }

  let totalMinutes = 0
  for (const [, amountRaw, unitRaw] of tokens) {
    const amount = Number(amountRaw)
    if (!Number.isFinite(amount)) {
      continue
    }

    if (unitRaw.startsWith('year') || unitRaw === 'y') {
      totalMinutes += Math.round(amount * 365 * 24 * 60)
    } else if (unitRaw.startsWith('month') || unitRaw === 'mo') {
      totalMinutes += Math.round(amount * 30 * 24 * 60)
    } else if (unitRaw.startsWith('week') || unitRaw === 'w') {
      totalMinutes += Math.round(amount * 7 * 24 * 60)
    } else if (unitRaw.startsWith('day') || unitRaw === 'd') {
      totalMinutes += Math.round(amount * 24 * 60)
    } else if (unitRaw.startsWith('hour') || unitRaw === 'h' || unitRaw === 'hr' || unitRaw === 'hrs') {
      totalMinutes += Math.round(amount * 60)
    } else if (unitRaw.startsWith('min') || unitRaw === 'm') {
      totalMinutes += Math.round(amount)
    }
  }

  if (totalMinutes <= 0) {
    return trimmed
  }

  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) {
    return minutes > 0 ? `${days}d ${hours}h ${minutes}m` : `${days}d ${hours}h`
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  return `${minutes}m`
}

function StatusSegment({
  icon,
  label,
  value,
  accent = false,
  title,
}: {
  icon: ReactNode
  label?: string
  value: string
  accent?: boolean
  title?: string
}) {
  return (
    <div className={`status-segment ${accent ? 'status-segment-accent' : ''}`} title={title ?? `${label ?? ''} ${value}`.trim()}>
      <span className="status-segment-icon">{icon}</span>
      {label && <span className="status-segment-label">{label}</span>}
      <span className="status-segment-value">{value}</span>
    </div>
  )
}

function splitNetworkValue(value: string) {
  const trimmed = compactValue(value)
  if (trimmed === '--') {
    return { down: '--', up: '--' }
  }

  const match = trimmed.match(/↓\s*(.*?)\s*↑\s*(.*)$/)
  if (!match) {
    return { down: '--', up: '--' }
  }

  return {
    down: compactValue(match[1]),
    up: compactValue(match[2]),
  }
}

function normalizeAutoHistory(history: number[]) {
  const maxValue = Math.max(...history)
  if (maxValue <= 0) {
    return EMPTY_STATUS_HISTORY
  }

  return history.map((value) => Math.max(0, Math.min(100, (value / maxValue) * 100)))
}

function MetricSparkline({
  history,
  variant = 'default',
  scale = 'percent',
}: {
  history: number[]
  variant?: 'default' | 'memory' | 'download' | 'upload'
  scale?: 'percent' | 'auto'
}) {
  const values = scale === 'auto' ? normalizeAutoHistory(history) : history

  return (
    <span className={`status-sparkline status-sparkline-${variant}`} aria-hidden="true">
      {values.map((value, index) => (
        <span
          key={`${index}-${value.toFixed(0)}`}
          className="status-sparkline-bar"
          style={{ height: `${Math.max(2, Math.round(value / 7))}px` }}
        />
      ))}
    </span>
  )
}

export function StatusBar({
  activeTab,
  sessions,
  sessionCpuHistoryByTabId,
  sessionMemoryHistoryByTabId,
  sessionNetworkDownHistoryByTabId,
  sessionNetworkUpHistoryByTabId,
  sessionStatusByTabId,
}: StatusBarProps) {
  const activeTabId = activeTab?.id
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeTab?.sessionId),
    [activeTab?.sessionId, sessions],
  )
  const liveStatus = activeTabId ? sessionStatusByTabId[activeTabId] : undefined
  const status = liveStatus
  const cpuHistory = useMemo(
    () => (activeTabId ? sessionCpuHistoryByTabId[activeTabId] ?? EMPTY_STATUS_HISTORY : EMPTY_STATUS_HISTORY),
    [activeTabId, sessionCpuHistoryByTabId],
  )
  const memoryHistory = useMemo(
    () => (activeTabId ? sessionMemoryHistoryByTabId[activeTabId] ?? EMPTY_STATUS_HISTORY : EMPTY_STATUS_HISTORY),
    [activeTabId, sessionMemoryHistoryByTabId],
  )
  const networkDownHistory = useMemo(
    () => (activeTabId ? sessionNetworkDownHistoryByTabId[activeTabId] ?? EMPTY_STATUS_HISTORY : EMPTY_STATUS_HISTORY),
    [activeTabId, sessionNetworkDownHistoryByTabId],
  )
  const networkUpHistory = useMemo(
    () => (activeTabId ? sessionNetworkUpHistoryByTabId[activeTabId] ?? EMPTY_STATUS_HISTORY : EMPTY_STATUS_HISTORY),
    [activeTabId, sessionNetworkUpHistoryByTabId],
  )
  const networkValue = useMemo(() => {
    if (!status) {
      return { down: '--', up: '--' }
    }

    const fallback = splitNetworkValue(status.network)
    return {
      down: compactValue(status.networkDownload, fallback.down),
      up: compactValue(status.networkUpload, fallback.up),
    }
  }, [status])

  if (!activeSession) {
    return (
      <footer className="statusbar">
        <StatusSegment icon={<Monitor size={12} />} value="OpenXTerm" accent />
        <StatusSegment icon={<Activity size={12} />} value="Tauri shell online" />
        <StatusSegment icon={<Network size={12} />} value="Transports queued" />
      </footer>
    )
  }

  if (!status) {
    return (
      <footer className="statusbar">
        <StatusSegment icon={<Activity size={12} />} value="loading" accent />
        <StatusSegment icon={<Monitor size={12} />} value={activeSession.host || 'local'} />
        <StatusSegment icon={<User size={12} />} value={activeSession.username || 'waiting for login'} />
        <div className="status-segment status-metric-segment" title="Waiting for live status">
          <span className="status-segment-icon"><Cpu size={12} /></span>
          <span className="status-segment-label">CPU</span>
          <MetricSparkline history={cpuHistory} />
          <span className="status-segment-value">...</span>
        </div>
        <div className="status-segment status-metric-segment" title="Waiting for memory usage">
          <span className="status-segment-icon"><Activity size={12} /></span>
          <span className="status-segment-label">MEM</span>
          <MetricSparkline history={memoryHistory} variant="memory" />
          <span className="status-segment-value">...</span>
        </div>
        <StatusSegment icon={<HardDrive size={12} />} label="DISK" value="..." />
        <div className="status-segment status-metric-segment" title="Waiting for download speed">
          <span className="status-segment-icon"><Network size={12} /></span>
          <span className="status-segment-label">DL</span>
          <MetricSparkline history={networkDownHistory} variant="download" scale="auto" />
          <span className="status-segment-value">...</span>
        </div>
        <div className="status-segment status-metric-segment" title="Waiting for upload speed">
          <span className="status-segment-icon"><Network size={12} /></span>
          <span className="status-segment-label">UL</span>
          <MetricSparkline history={networkUpHistory} variant="upload" scale="auto" />
          <span className="status-segment-value">...</span>
        </div>
        <StatusSegment icon={<Clock3 size={12} />} value="up ..." />
      </footer>
    )
  }

  return (
    <footer className="statusbar">
      <StatusSegment icon={<Monitor size={12} />} value={compactValue(status.host, 'host')} title={status.remoteOs} />
      <StatusSegment icon={<User size={12} />} value={compactValue(status.user, 'user')} />
      <div className="status-segment status-metric-segment" title={`CPU load ${status.cpuLoad}`}>
        <span className="status-segment-icon"><Cpu size={12} /></span>
        <span className="status-segment-label">CPU</span>
        <MetricSparkline history={cpuHistory} />
        <span className="status-segment-value">{compactValue(status.cpuLoad)}</span>
      </div>
      <div className="status-segment status-metric-segment" title={`Memory ${status.memoryUsage}`}>
        <span className="status-segment-icon"><Activity size={12} /></span>
        <span className="status-segment-label">MEM</span>
        <MetricSparkline history={memoryHistory} variant="memory" />
        <span className="status-segment-value">{compactValue(status.memoryUsage)}</span>
      </div>
      <StatusSegment icon={<HardDrive size={12} />} label="DISK" value={compactValue(status.diskUsage)} />
      <div className="status-segment status-metric-segment" title={`Download ${networkValue.down}`}>
        <span className="status-segment-icon"><Network size={12} /></span>
        <span className="status-segment-label">DL</span>
        <MetricSparkline history={networkDownHistory} variant="download" scale="auto" />
        <span className="status-segment-value">{networkValue.down}</span>
      </div>
      <div className="status-segment status-metric-segment" title={`Upload ${networkValue.up}`}>
        <span className="status-segment-icon"><Network size={12} /></span>
        <span className="status-segment-label">UL</span>
        <MetricSparkline history={networkUpHistory} variant="upload" scale="auto" />
        <span className="status-segment-value">{networkValue.up}</span>
      </div>
      <StatusSegment icon={<Clock3 size={12} />} value={`up ${formatUptimeValue(status.uptime)}`} title={status.uptime} />
    </footer>
  )
}
