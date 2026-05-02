import type { RemoteFileEntry, SessionDefinition } from '../../types/domain'
export { batchLocalPathLabel, itemCountLabel, joinRemotePath } from '../../lib/sftpTransfers'

export type SftpSortKey = 'name' | 'size' | 'modified' | 'owner' | 'group' | 'access'
export type SortDirection = 'asc' | 'desc'

interface SftpTableColumn {
  key: SftpSortKey
  label: string
}

export const SFTP_TABLE_COLUMNS: SftpTableColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size (KB)' },
  { key: 'modified', label: 'Last modified' },
  { key: 'owner', label: 'Owner' },
  { key: 'group', label: 'Group' },
  { key: 'access', label: 'Access' },
]

export const SFTP_TABLE_DEFAULT_COLUMN_WIDTHS = [220, 82, 132, 82, 82, 104]
export const SFTP_TABLE_MIN_COLUMN_WIDTHS = [140, 58, 96, 58, 58, 78]

export function remoteSizeKbLabel(entry: RemoteFileEntry) {
  if (entry.kind === 'folder') {
    return ''
  }

  if (typeof entry.sizeBytes === 'number') {
    return Math.max(1, Math.ceil(entry.sizeBytes / 1024)).toLocaleString()
  }

  return entry.sizeLabel === '--' ? '' : entry.sizeLabel
}

export function normalizeRemotePath(path: string) {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }

  return `/${trimmed.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`.replace(/\/+$/, '') || '/'
}

function compareText(left: string | undefined, right: string | undefined) {
  return (left ?? '').localeCompare(right ?? '', undefined, { numeric: true, sensitivity: 'base' })
}

export function compareSftpEntries(
  left: RemoteFileEntry,
  right: RemoteFileEntry,
  key: SftpSortKey,
  direction: SortDirection,
) {
  if (left.kind !== right.kind) {
    return left.kind === 'folder' ? -1 : 1
  }

  const multiplier = direction === 'asc' ? 1 : -1
  let result = 0

  switch (key) {
    case 'size':
      result = (left.sizeBytes ?? -1) - (right.sizeBytes ?? -1)
      break
    case 'modified':
      result = compareText(left.modifiedLabel, right.modifiedLabel)
      break
    case 'owner':
      result = compareText(left.ownerLabel, right.ownerLabel)
      break
    case 'group':
      result = compareText(left.groupLabel, right.groupLabel)
      break
    case 'access':
      result = compareText(left.accessLabel, right.accessLabel)
      break
    case 'name':
    default:
      result = compareText(left.name, right.name)
      break
  }

  if (result === 0) {
    result = compareText(left.name, right.name)
  }

  return result * multiplier
}

export function sidebarSftpErrorContext(session: SessionDefinition, action: string, path: string) {
  return {
    action,
    path,
    sessionId: session.id,
    sessionName: session.name,
    host: session.host,
    kind: session.kind,
    linkedSshTabId: session.linkedSshTabId,
  }
}

export function movedEnough(startX: number, startY: number, currentX: number, currentY: number) {
  return Math.hypot(currentX - startX, currentY - startY) > 5
}
