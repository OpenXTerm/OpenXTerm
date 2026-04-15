import { normalizeSessionFolderPath } from './sessionUtils'
import type { SessionDefinition, SessionFolderDefinition } from '../types/domain'

interface ParsedImportSession {
  session: SessionDefinition
  folderPath: string
}

export interface MobaXtermImportResult {
  folders: SessionFolderDefinition[]
  sessions: SessionDefinition[]
  skipped: Array<{ name: string; reason: string }>
}

function ensureFolderAncestors(folderPath: string, bucket: Map<string, SessionFolderDefinition>) {
  const parts = normalizeSessionFolderPath(folderPath).split('/').filter(Boolean)
  let currentPath = ''

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part
    if (bucket.has(currentPath)) {
      continue
    }

    const now = new Date().toISOString()
    bucket.set(currentPath, {
      id: crypto.randomUUID(),
      path: currentPath,
      createdAt: now,
      updatedAt: now,
    })
  }
}

function parsePort(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function pickKeyPath(fields: string[]) {
  return fields.find((field) => /(_DesktopDir_|\.ppk$|\.pem$|id_[a-z0-9_-]+)/i.test(field))
}

function parseSshLikeSession(
  kind: 'ssh' | 'telnet' | 'ftp' | 'sftp',
  name: string,
  folderPath: string,
  fields: string[],
): SessionDefinition | null {
  const host = fields[1]?.trim() ?? ''
  if (!host) {
    return null
  }

  const keyPath = pickKeyPath(fields)
  const now = new Date().toISOString()

  return {
    id: crypto.randomUUID(),
    name,
    folderPath,
    kind,
    host,
    port: parsePort(fields[2] ?? '', kind === 'ftp' ? 21 : kind === 'telnet' ? 23 : 22),
    username: fields[3]?.trim() ?? '',
    authType: kind === 'telnet' ? 'password' : (keyPath ? 'key' : 'password'),
    password: '',
    keyPath: keyPath ?? '',
    serialPort: '',
    baudRate: 115200,
    parity: 'none',
    stopBits: 1,
    dataBits: 8,
    createdAt: now,
    updatedAt: now,
  }
}

function parseSerialBaud(raw: string) {
  const commonRates = [115200, 57600, 38400, 19200, 9600, 4800, 2400]
  for (const rate of commonRates) {
    if (raw.endsWith(String(rate))) {
      return rate
    }
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 115200
  }

  return parsed > 1000000 ? Math.floor(parsed / 10) : parsed
}

function parseSerialSession(name: string, folderPath: string, fields: string[]): SessionDefinition | null {
  const serialPort = fields.at(-1)?.trim() ?? ''
  if (!serialPort) {
    return null
  }

  const dataBitsMap: Record<string, 5 | 6 | 7 | 8> = {
    '0': 5,
    '1': 6,
    '2': 7,
    '3': 8,
  }
  const parityMap: Record<string, 'none' | 'odd' | 'even'> = {
    '0': 'none',
    '1': 'odd',
    '2': 'even',
  }

  const now = new Date().toISOString()

  return {
    id: crypto.randomUUID(),
    name,
    folderPath,
    kind: 'serial',
    host: '',
    port: 0,
    username: '',
    authType: 'none',
    password: '',
    keyPath: '',
    serialPort,
    baudRate: parseSerialBaud(fields[2] ?? ''),
    parity: parityMap[fields[4] ?? '0'] ?? 'none',
    stopBits: fields[6] === '2' ? 2 : 1,
    dataBits: dataBitsMap[fields[3] ?? '3'] ?? 8,
    createdAt: now,
    updatedAt: now,
  }
}

function parseBookmarkLine(name: string, rawValue: string, folderPath: string): ParsedImportSession | { name: string; reason: string } {
  const match = /^#(\d+)#(.*)$/.exec(rawValue)
  if (!match) {
    return { name, reason: 'Unrecognized session record' }
  }

  const iconCode = Number.parseInt(match[1], 10)
  const connectionPayload = match[2].split('#MobaFont')[0] ?? ''
  const fields = connectionPayload.split('%')

  const session =
    iconCode === 109 ? parseSshLikeSession('ssh', name, folderPath, fields)
    : iconCode === 98 ? parseSshLikeSession('telnet', name, folderPath, fields)
    : iconCode === 130 ? parseSshLikeSession('ftp', name, folderPath, fields)
    : iconCode === 140 ? parseSshLikeSession('sftp', name, folderPath, fields)
    : iconCode === 131 ? parseSerialSession(name, folderPath, fields)
    : null

  if (!session) {
    return { name, reason: `Unsupported or incomplete MobaXterm session type (${iconCode})` }
  }

  return { session, folderPath }
}

export function parseMobaXtermSessionsFile(content: string): MobaXtermImportResult {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const folders = new Map<string, SessionFolderDefinition>()
  const sessions: SessionDefinition[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  let inBookmarksSection = false
  let currentFolderPath = ''

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      inBookmarksSection = /^\[Bookmarks(?:_\d+)?\]$/.test(line)
      currentFolderPath = ''
      continue
    }

    if (!inBookmarksSection) {
      continue
    }

    const delimiterIndex = line.indexOf('=')
    if (delimiterIndex < 0) {
      continue
    }

    const key = line.slice(0, delimiterIndex)
    const value = line.slice(delimiterIndex + 1)

    if (key === 'SubRep') {
      currentFolderPath = normalizeSessionFolderPath(value.replace(/\\/g, '/'))
      if (currentFolderPath) {
        ensureFolderAncestors(currentFolderPath, folders)
      }
      continue
    }

    if (key === 'ImgNum') {
      continue
    }

    const parsed = parseBookmarkLine(key, value, currentFolderPath)
    if ('reason' in parsed) {
      skipped.push(parsed)
      continue
    }

    sessions.push(parsed.session)
    if (parsed.folderPath) {
      ensureFolderAncestors(parsed.folderPath, folders)
    }
  }

  return {
    folders: [...folders.values()].sort((left, right) => left.path.localeCompare(right.path)),
    sessions,
    skipped,
  }
}
