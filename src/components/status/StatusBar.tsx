import { useMemo, type ReactNode } from 'react'
import { Activity, Clock3, Cpu, HardDrive, Monitor, Network, Timer, User } from 'lucide-react'

import type { SessionDefinition, SessionStatusSnapshot, WorkspaceTab } from '../../types/domain'

interface StatusBarProps {
  activeTab: WorkspaceTab | undefined
  sessions: SessionDefinition[]
  sessionCpuHistoryByTabId: Record<string, number[]>
  sessionStatusByTabId: Record<string, SessionStatusSnapshot>
}

const CPU_HISTORY_SIZE = 22
const EMPTY_CPU_HISTORY = Array.from({ length: CPU_HISTORY_SIZE }, () => 0)

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

function CpuSparkline({ history }: { history: number[] }) {
  return (
    <span className="status-cpu-sparkline" aria-hidden="true">
      {history.map((value, index) => (
        <span
          key={`${index}-${value.toFixed(0)}`}
          className="status-cpu-bar"
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
  sessionStatusByTabId,
}: StatusBarProps) {
  const activeTabId = activeTab?.id
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeTab?.sessionId),
    [activeTab?.sessionId, sessions],
  )
  const liveStatus = activeTabId ? sessionStatusByTabId[activeTabId] : undefined
  const status = liveStatus
  const cpuGraphValues = useMemo(
    () => (activeTabId ? sessionCpuHistoryByTabId[activeTabId] ?? EMPTY_CPU_HISTORY : EMPTY_CPU_HISTORY),
    [activeTabId, sessionCpuHistoryByTabId],
  )

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
        <div className="status-segment status-cpu-segment" title="Waiting for live status">
          <span className="status-segment-icon"><Cpu size={12} /></span>
          <span className="status-segment-label">CPU</span>
          <CpuSparkline history={cpuGraphValues} />
          <span className="status-segment-value">...</span>
        </div>
        <StatusSegment icon={<Activity size={12} />} label="MEM" value="..." />
        <StatusSegment icon={<HardDrive size={12} />} label="DISK" value="..." />
        <StatusSegment icon={<Network size={12} />} value="waiting" />
        <StatusSegment icon={<Timer size={12} />} value="..." />
        <StatusSegment icon={<Clock3 size={12} />} value="up ..." />
        <StatusSegment icon={<Monitor size={12} />} value={activeSession.name} accent />
      </footer>
    )
  }

  return (
    <footer className="statusbar">
      <StatusSegment icon={<Activity size={12} />} value={status.mode} accent />
      <StatusSegment icon={<Monitor size={12} />} value={compactValue(status.host, 'host')} title={status.remoteOs} />
      <StatusSegment icon={<User size={12} />} value={compactValue(status.user, 'user')} />
      <div className="status-segment status-cpu-segment" title={`CPU load ${status.cpuLoad}`}>
        <span className="status-segment-icon"><Cpu size={12} /></span>
        <span className="status-segment-label">CPU</span>
        <CpuSparkline history={cpuGraphValues} />
        <span className="status-segment-value">{compactValue(status.cpuLoad)}</span>
      </div>
      <StatusSegment icon={<Activity size={12} />} label="MEM" value={compactValue(status.memoryUsage)} />
      <StatusSegment icon={<HardDrive size={12} />} label="DISK" value={compactValue(status.diskUsage)} />
      <StatusSegment icon={<Network size={12} />} value={compactValue(status.network, 'network')} />
      <StatusSegment icon={<Timer size={12} />} value={compactValue(status.latency, '--')} />
      <StatusSegment icon={<Clock3 size={12} />} value={`up ${formatUptimeValue(status.uptime)}`} title={status.uptime} />
      <StatusSegment icon={<Monitor size={12} />} value={activeSession.name} accent title={status.remoteOs} />
    </footer>
  )
}
