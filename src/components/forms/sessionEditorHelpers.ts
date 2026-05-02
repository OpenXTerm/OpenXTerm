import type { SessionDefinition, SessionDraft, SessionKind } from '../../types/domain'

export type SessionEditorTab = 'general' | 'connection' | 'terminal' | 'advanced'

export const DEFAULT_TERMINAL_FONT = '"SF Mono", "JetBrains Mono", Menlo, monospace'
export const DEFAULT_TERMINAL_SIZE = 13
export const DEFAULT_TERMINAL_FOREGROUND = '#d8dadb'
export const DEFAULT_TERMINAL_BACKGROUND = '#111315'
export const PINNED_TERMINAL_FONTS = ['SF Mono', 'JetBrains Mono', 'Menlo', 'Monaco', 'Cascadia Code', 'Consolas', 'Fira Code']

export const TERMINAL_PRESETS = [
  {
    id: 'default',
    label: 'Default',
    note: 'Balanced dark terminal',
    fontFamily: DEFAULT_TERMINAL_FONT,
    fontSize: 13,
    foreground: '#d8dadb',
    background: '#111315',
  },
  {
    id: 'crt',
    label: 'Green CRT',
    note: 'Classic phosphor feel',
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize: 13,
    foreground: '#78f7b0',
    background: '#08110d',
  },
  {
    id: 'night-owl',
    label: 'Night Owl',
    note: 'Soft contrast for long sessions',
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize: 13,
    foreground: '#c6d7ff',
    background: '#0f1824',
  },
  {
    id: 'light',
    label: 'Light',
    note: 'Bright workspace',
    fontFamily: DEFAULT_TERMINAL_FONT,
    fontSize: 13,
    foreground: '#1f2a30',
    background: '#f3f6f8',
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    note: 'Sharper text and darker black',
    fontFamily: DEFAULT_TERMINAL_FONT,
    fontSize: 14,
    foreground: '#ffffff',
    background: '#050607',
  },
] as const

export function createDraft(session?: SessionDefinition | null, initialFolderPath?: string): SessionDraft {
  if (session) {
    return {
      id: session.id,
      name: session.name,
      folderPath: session.folderPath ?? '',
      kind: session.kind,
      host: session.host,
      port: session.port,
      username: session.username,
      authType: session.authType,
      password: session.password ?? '',
      keyPath: session.keyPath ?? '',
      proxyType: session.proxyType ?? 'none',
      proxyHost: session.proxyHost ?? '',
      proxyPort: session.proxyPort ?? 1080,
      proxyUsername: session.proxyUsername ?? '',
      proxyPassword: session.proxyPassword ?? '',
      x11Forwarding: session.x11Forwarding ?? false,
      x11Trusted: session.x11Trusted ?? true,
      x11Display: session.x11Display ?? '',
      terminalFontFamily: session.terminalFontFamily ?? DEFAULT_TERMINAL_FONT,
      terminalFontSize: session.terminalFontSize ?? DEFAULT_TERMINAL_SIZE,
      terminalForeground: session.terminalForeground ?? DEFAULT_TERMINAL_FOREGROUND,
      terminalBackground: session.terminalBackground ?? DEFAULT_TERMINAL_BACKGROUND,
      localWorkingDirectory: session.localWorkingDirectory ?? '',
      serialPort: session.serialPort ?? '',
      baudRate: session.baudRate ?? 115200,
      parity: session.parity,
      stopBits: session.stopBits,
      dataBits: session.dataBits,
    }
  }

  return {
    name: '',
    folderPath: initialFolderPath ?? '',
    kind: 'ssh',
    host: '',
    port: 22,
    username: 'root',
    authType: 'password',
    password: '',
    keyPath: '',
    proxyType: 'none',
    proxyHost: '',
    proxyPort: 1080,
    proxyUsername: '',
    proxyPassword: '',
    x11Forwarding: false,
    x11Trusted: true,
    x11Display: '',
    terminalFontFamily: DEFAULT_TERMINAL_FONT,
    terminalFontSize: DEFAULT_TERMINAL_SIZE,
    terminalForeground: DEFAULT_TERMINAL_FOREGROUND,
    terminalBackground: DEFAULT_TERMINAL_BACKGROUND,
    localWorkingDirectory: '',
    serialPort: '',
    baudRate: 115200,
    parity: 'none',
    stopBits: 1,
    dataBits: 8,
  }
}

export function supportsConnectionTab(kind: SessionKind) {
  return kind !== 'local'
}

export function supportsAdvancedTab(kind: SessionKind) {
  return kind === 'ssh'
}

export function tabDescription(tab: SessionEditorTab, kind: SessionKind) {
  switch (tab) {
    case 'general':
      return 'Name, folder, and transport type.'
    case 'connection':
      if (kind === 'serial') {
        return 'Port and line parameters.'
      }
      return kind === 'local' ? 'Local shell details.' : 'Endpoint and login settings.'
    case 'terminal':
      return 'Per-session terminal appearance.'
    case 'advanced':
      return 'SSH-specific forwarding and compatibility.'
    default:
      return ''
  }
}

export function matchesTerminalPreset(
  draft: SessionDraft,
  preset: (typeof TERMINAL_PRESETS)[number],
) {
  return (
    draft.terminalFontFamily === preset.fontFamily
    && draft.terminalFontSize === preset.fontSize
    && draft.terminalForeground.toLowerCase() === preset.foreground.toLowerCase()
    && draft.terminalBackground.toLowerCase() === preset.background.toLowerCase()
  )
}

export function quoteFontFamily(fontFamily: string) {
  const trimmed = fontFamily.trim()
  if (!trimmed) {
    return DEFAULT_TERMINAL_FONT
  }
  return `"${trimmed.replace(/"/g, '')}", monospace`
}

export function displayFontName(fontFamily: string) {
  const firstFamily = fontFamily.split(',')[0]?.trim() ?? fontFamily.trim()
  return firstFamily.replace(/^['"]|['"]$/g, '')
}
