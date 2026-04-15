import { useEffect, useMemo, useState } from 'react'
import {
  Cable,
  ExternalLink,
  FolderTree,
  HardDrive,
  KeyRound,
  LockKeyhole,
  Monitor,
  Palette,
  Server,
  Settings2,
  ShieldOff,
  Terminal,
  Usb,
} from 'lucide-react'

import { inspectLocalX11Support, listSystemFontFamilies, openExternalTarget } from '../../lib/bridge'
import { getDefaultPort } from '../../lib/sessionUtils'
import type { LocalX11Support, SessionDefinition, SessionDraft, SessionKind } from '../../types/domain'

interface SessionEditorModalProps {
  open: boolean
  session: SessionDefinition | null
  initialFolderPath?: string
  folderOptions: string[]
  onClose: () => void
  onSave: (draft: SessionDraft) => Promise<void>
}

type SessionEditorTab = 'general' | 'connection' | 'terminal' | 'advanced'

const DEFAULT_TERMINAL_FONT = '"SF Mono", "JetBrains Mono", Menlo, monospace'
const DEFAULT_TERMINAL_SIZE = 13
const DEFAULT_TERMINAL_FOREGROUND = '#d8dadb'
const DEFAULT_TERMINAL_BACKGROUND = '#111315'
const PINNED_TERMINAL_FONTS = ['SF Mono', 'JetBrains Mono', 'Menlo', 'Monaco', 'Cascadia Code', 'Consolas', 'Fira Code']

const TERMINAL_PRESETS = [
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

const SESSION_KIND_OPTIONS: Array<{
  kind: SessionKind
  label: string
  note: string
  icon: typeof Server
}> = [
  { kind: 'local', label: 'Local', note: 'This computer', icon: Terminal },
  { kind: 'ssh', label: 'SSH', note: 'Shell access', icon: Server },
  { kind: 'telnet', label: 'Telnet', note: 'Legacy terminal', icon: Cable },
  { kind: 'serial', label: 'Serial', note: 'Direct line', icon: Usb },
  { kind: 'sftp', label: 'SFTP', note: 'Secure file browser', icon: HardDrive },
  { kind: 'ftp', label: 'FTP', note: 'File transfer', icon: HardDrive },
]

const AUTH_OPTIONS: Array<{
  value: SessionDraft['authType']
  label: string
  note: string
  icon: typeof LockKeyhole
}> = [
  { value: 'password', label: 'Password', note: 'Saved secret', icon: LockKeyhole },
  { value: 'key', label: 'Private key', note: 'SSH key path', icon: KeyRound },
  { value: 'none', label: 'None', note: 'Manual login', icon: ShieldOff },
]

const EDITOR_TABS: Array<{
  id: SessionEditorTab
  label: string
  icon: typeof Settings2
}> = [
  { id: 'general', label: 'General', icon: FolderTree },
  { id: 'connection', label: 'Connection', icon: Server },
  { id: 'terminal', label: 'Terminal', icon: Palette },
  { id: 'advanced', label: 'Advanced', icon: Settings2 },
]

function createDraft(session?: SessionDefinition | null, initialFolderPath?: string): SessionDraft {
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
      x11Forwarding: session.x11Forwarding ?? false,
      x11Trusted: session.x11Trusted ?? true,
      x11Display: session.x11Display ?? '',
      terminalFontFamily: session.terminalFontFamily ?? DEFAULT_TERMINAL_FONT,
      terminalFontSize: session.terminalFontSize ?? DEFAULT_TERMINAL_SIZE,
      terminalForeground: session.terminalForeground ?? DEFAULT_TERMINAL_FOREGROUND,
      terminalBackground: session.terminalBackground ?? DEFAULT_TERMINAL_BACKGROUND,
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
    x11Forwarding: false,
    x11Trusted: true,
    x11Display: '',
    terminalFontFamily: DEFAULT_TERMINAL_FONT,
    terminalFontSize: DEFAULT_TERMINAL_SIZE,
    terminalForeground: DEFAULT_TERMINAL_FOREGROUND,
    terminalBackground: DEFAULT_TERMINAL_BACKGROUND,
    serialPort: '',
    baudRate: 115200,
    parity: 'none',
    stopBits: 1,
    dataBits: 8,
  }
}

function supportsConnectionTab(kind: SessionKind) {
  return kind !== 'local'
}

function supportsAdvancedTab(kind: SessionKind) {
  return kind === 'ssh'
}

function tabDescription(tab: SessionEditorTab, kind: SessionKind) {
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

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const pickerValue = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'

  return (
    <label className="editor-field">
      <span>{label}</span>
      <div className="color-field-row">
        <input
          className="color-field-picker"
          type="color"
          value={pickerValue}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          className="color-field-text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </label>
  )
}

function matchesTerminalPreset(
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

function quoteFontFamily(fontFamily: string) {
  const trimmed = fontFamily.trim()
  if (!trimmed) {
    return DEFAULT_TERMINAL_FONT
  }
  return `"${trimmed.replace(/"/g, '')}", monospace`
}

function displayFontName(fontFamily: string) {
  const firstFamily = fontFamily.split(',')[0]?.trim() ?? fontFamily.trim()
  return firstFamily.replace(/^['"]|['"]$/g, '')
}

function FontFamilyPicker({
  availableFonts,
  error,
  loading,
  value,
  onChange,
}: {
  availableFonts: string[]
  error: string
  loading: boolean
  value: string
  onChange: (value: string) => void
}) {
  const [query, setQuery] = useState('')
  const pinnedFonts = useMemo(
    () => PINNED_TERMINAL_FONTS.filter((font) => availableFonts.includes(font)),
    [availableFonts],
  )
  const filteredFonts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return availableFonts
    }
    return availableFonts.filter((font) => font.toLowerCase().includes(normalizedQuery))
  }, [availableFonts, query])
  const selectedName = useMemo(() => {
    if (!value.trim() || value === DEFAULT_TERMINAL_FONT) {
      return 'System Default'
    }
    return displayFontName(value)
  }, [value])
  const selectedOptionValue = useMemo(() => {
    if (!value.trim() || value === DEFAULT_TERMINAL_FONT) {
      return 'system'
    }
    return availableFonts.includes(selectedName) ? selectedName : 'custom'
  }, [availableFonts, selectedName, value])
  const customValue = query.trim()
  const filteredPinnedFonts = pinnedFonts.filter((font) => filteredFonts.includes(font))
  const filteredOtherFonts = filteredFonts.filter((font) => !filteredPinnedFonts.includes(font))

  return (
    <div className="font-picker">
      <div className="font-picker-head">
        <label className="editor-field">
          <span>{`Search fonts (${availableFonts.length} available)`}</span>
          <input
            placeholder={loading ? 'Loading system fonts...' : 'Type to filter fonts'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <label className="editor-field">
          <span>Font</span>
          <select
            value={selectedOptionValue}
            onChange={(event) => {
              const nextValue = event.target.value
              if (nextValue === 'system') {
                onChange(DEFAULT_TERMINAL_FONT)
                return
              }
              if (nextValue === 'custom') {
                return
              }
              onChange(quoteFontFamily(nextValue))
            }}
          >
            <option value="system">System Default</option>
            {filteredPinnedFonts.length > 0 && (
              <optgroup label="Common monospace">
                {filteredPinnedFonts.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </optgroup>
            )}
            {filteredOtherFonts.length > 0 && (
              <optgroup label="Matching fonts">
                {filteredOtherFonts.slice(0, 200).map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="custom">Custom...</option>
          </select>
        </label>
      </div>

      {selectedOptionValue === 'custom' && (
        <label className="editor-field">
          <span>Custom font family</span>
          <input
            placeholder={DEFAULT_TERMINAL_FONT}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}

      {!error && customValue && selectedOptionValue !== 'custom' && !availableFonts.includes(customValue) && (
        <div className="font-picker-custom">
          <button className="ghost-button" type="button" onClick={() => onChange(quoteFontFamily(customValue))}>
            Use custom font: {customValue}
          </button>
        </div>
      )}

      {error && <div className="editor-hint">Could not load system fonts: {error}</div>}
      {!error && !loading && query && filteredFonts.length === 0 && <div className="editor-hint">No fonts matched this search.</div>}

      <div className="font-picker-preview" style={{ fontFamily: value || DEFAULT_TERMINAL_FONT }}>
        AaBbCc 123 // {selectedName}
      </div>
    </div>
  )
}

export function SessionEditorModal({
  open,
  session,
  initialFolderPath,
  folderOptions,
  onClose,
  onSave,
}: SessionEditorModalProps) {
  const isMacOS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
  const [draft, setDraft] = useState<SessionDraft>(createDraft(session, initialFolderPath))
  const [activeTab, setActiveTab] = useState<SessionEditorTab>('general')
  const [x11Support, setX11Support] = useState<LocalX11Support | null>(null)
  const [x11SupportBusy, setX11SupportBusy] = useState(false)
  const [x11SupportError, setX11SupportError] = useState('')
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  const [systemFontsBusy, setSystemFontsBusy] = useState(false)
  const [systemFontsError, setSystemFontsError] = useState('')

  const normalizedFolderOptions = useMemo(
    () =>
      Array.from(new Set([...(draft.folderPath ? [draft.folderPath] : []), ...folderOptions])).sort((left, right) =>
        left.localeCompare(right),
      ),
    [draft.folderPath, folderOptions],
  )

  useEffect(() => {
    if (!open) {
      return
    }

    setDraft(createDraft(session, initialFolderPath))
    setActiveTab('general')
    setX11Support(null)
    setX11SupportBusy(false)
    setX11SupportError('')
    setSystemFonts([])
    setSystemFontsBusy(false)
    setSystemFontsError('')
  }, [initialFolderPath, open, session])

  useEffect(() => {
    if (!open) {
      return
    }

    let disposed = false
    setSystemFontsBusy(true)
    setSystemFontsError('')

    void listSystemFontFamilies()
      .then((fonts) => {
        if (disposed) {
          return
        }
        setSystemFonts(fonts)
      })
      .catch((error) => {
        if (disposed) {
          return
        }
        setSystemFonts([])
        setSystemFontsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!disposed) {
          setSystemFontsBusy(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [open])

  useEffect(() => {
    if (activeTab === 'connection' && !supportsConnectionTab(draft.kind)) {
      setActiveTab('general')
      return
    }
    if (activeTab === 'advanced' && !supportsAdvancedTab(draft.kind)) {
      setActiveTab('general')
    }
  }, [activeTab, draft.kind])

  useEffect(() => {
    if (!open || draft.kind !== 'ssh' || !draft.x11Forwarding) {
      return
    }

    let disposed = false
    setX11SupportBusy(true)
    setX11SupportError('')

    void inspectLocalX11Support(draft.x11Display.trim() || undefined)
      .then((payload) => {
        if (!disposed) {
          setX11Support(payload)
        }
      })
      .catch((error) => {
        if (!disposed) {
          setX11Support(null)
          setX11SupportError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!disposed) {
          setX11SupportBusy(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [draft.kind, draft.x11Display, draft.x11Forwarding, open])

  if (!open) {
    return null
  }

  const isSerial = draft.kind === 'serial'
  const isLocal = draft.kind === 'local'
  const isFile = draft.kind === 'sftp' || draft.kind === 'ftp'
  const x11DisplayPlaceholder =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
      ? '127.0.0.1:0.0'
      : 'Auto-detect from DISPLAY'
  const x11NeedsInstallHelp = draft.x11Forwarding && x11Support !== null && !x11Support.systemX11Available
  const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
  const recommendedGuiHelperName = isMacOS ? 'XQuartz' : isWindows ? 'VcXsrv' : 'X.Org'
  const recommendedGuiHelperUrl = isMacOS
    ? 'https://www.xquartz.org/'
    : isWindows
      ? 'https://vcxsrv.com/'
      : 'https://www.x.org/wiki/'
  const visibleTabs = EDITOR_TABS.filter((tab) => {
    if (tab.id === 'connection') {
      return supportsConnectionTab(draft.kind)
    }
    if (tab.id === 'advanced') {
      return supportsAdvancedTab(draft.kind)
    }
    return true
  })

  async function handleCheckX11Support() {
    setX11SupportBusy(true)
    setX11SupportError('')

    try {
      const payload = await inspectLocalX11Support(draft.x11Display.trim() || undefined)
      setX11Support(payload)
    } catch (error) {
      setX11Support(null)
      setX11SupportError(error instanceof Error ? error.message : String(error))
    } finally {
      setX11SupportBusy(false)
    }
  }

  function updateDraft(patch: Partial<SessionDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
  }

  function renderGeneralTab() {
    return (
      <section className="session-editor-tab-panel">
        <div className="session-editor-grid session-editor-grid-basics">
          <label className="editor-field editor-field-wide">
            <span>Session name</span>
            <input
              required
              placeholder="debian-lab"
              value={draft.name}
              onChange={(event) => updateDraft({ name: event.target.value })}
            />
          </label>

          <label className="editor-field">
            <span>Folder</span>
            <select value={draft.folderPath} onChange={(event) => updateDraft({ folderPath: event.target.value })}>
              <option value="">Root</option>
              {normalizedFolderOptions.map((folderPath) => (
                <option key={folderPath} value={folderPath}>
                  {folderPath}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="session-kind-grid" role="radiogroup" aria-label="Session type">
          {SESSION_KIND_OPTIONS.map((option) => {
            const Icon = option.icon
            const selected = draft.kind === option.kind
            return (
              <button
                key={option.kind}
                className={`session-kind-option ${selected ? 'active' : ''}`}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  updateDraft({
                    kind: option.kind,
                    port: getDefaultPort(option.kind),
                    host: option.kind === 'local' ? '' : draft.host,
                    username: option.kind === 'local' ? '' : draft.username,
                    authType: option.kind === 'local' ? 'none' : draft.authType,
                  })
                }}
              >
                <span className="session-kind-icon">
                  <Icon size={15} />
                </span>
                <span className="session-kind-copy">
                  <strong>{option.label}</strong>
                  <span>{option.note}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="session-editor-footer-summary">
          <span className="session-editor-summary-icon">
            <FolderTree size={14} />
          </span>
          <span>{draft.folderPath ? `Will appear in ${draft.folderPath}` : 'Will appear in the root of Sessions'}</span>
        </div>
      </section>
    )
  }

  function renderConnectionTab() {
    if (isLocal) {
      return (
        <section className="session-editor-tab-panel">
          <p className="editor-hint">
            Local sessions open the default shell for this operating system. Use the Terminal tab if you want a different font or colors for this local profile.
          </p>
        </section>
      )
    }

    if (isSerial) {
      return (
        <section className="session-editor-tab-panel">
          <div className="session-editor-grid">
            <label className="editor-field editor-field-wide">
              <span>Serial port</span>
              <input
                required
                placeholder="/dev/tty.usbserial-1420"
                value={draft.serialPort}
                onChange={(event) => updateDraft({ serialPort: event.target.value })}
              />
            </label>

            <label className="editor-field editor-field-compact">
              <span>Baud rate</span>
              <input
                type="number"
                value={draft.baudRate}
                onChange={(event) => updateDraft({ baudRate: Number(event.target.value) })}
              />
            </label>

            <label className="editor-field">
              <span>Parity</span>
              <select
                value={draft.parity}
                onChange={(event) => updateDraft({ parity: event.target.value as SessionDraft['parity'] })}
              >
                <option value="none">None</option>
                <option value="even">Even</option>
                <option value="odd">Odd</option>
              </select>
            </label>

            <label className="editor-field">
              <span>Stop bits</span>
              <select
                value={draft.stopBits}
                onChange={(event) => updateDraft({ stopBits: Number(event.target.value) as 1 | 2 })}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>

            <label className="editor-field">
              <span>Data bits</span>
              <select
                value={draft.dataBits}
                onChange={(event) => updateDraft({ dataBits: Number(event.target.value) as 5 | 6 | 7 | 8 })}
              >
                <option value={5}>5</option>
                <option value={6}>6</option>
                <option value={7}>7</option>
                <option value={8}>8</option>
              </select>
            </label>
          </div>
        </section>
      )
    }

    return (
      <section className="session-editor-tab-panel">
        <div className="session-editor-grid">
          <label className="editor-field editor-field-wide">
            <span>Host or IP</span>
            <input
              required
              placeholder="10.0.0.21"
              value={draft.host}
              onChange={(event) => updateDraft({ host: event.target.value })}
            />
          </label>

          <label className="editor-field editor-field-compact">
            <span>Port</span>
            <input
              required
              type="number"
              value={draft.port}
              onChange={(event) => updateDraft({ port: Number(event.target.value) })}
            />
          </label>

          <label className="editor-field editor-field-wide">
            <span>Username</span>
            <input
              placeholder={draft.kind === 'ssh' ? 'Leave empty to prompt in terminal' : ''}
              value={draft.username}
              onChange={(event) => updateDraft({ username: event.target.value })}
            />
          </label>
        </div>

        {!isFile && (
          <>
            <div className="session-editor-inline-heading">Authentication</div>
            <div className="session-auth-grid" role="radiogroup" aria-label="Authentication type">
              {AUTH_OPTIONS.map((option) => {
                const Icon = option.icon
                const selected = draft.authType === option.value
                return (
                  <button
                    key={option.value}
                    className={`session-auth-option ${selected ? 'active' : ''}`}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => updateDraft({ authType: option.value })}
                  >
                    <span className="session-auth-icon">
                      <Icon size={14} />
                    </span>
                    <span className="session-auth-copy">
                      <strong>{option.label}</strong>
                      <span>{option.note}</span>
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="session-editor-grid">
              {draft.authType === 'password' && (
                <label className="editor-field editor-field-wide">
                  <span>Password</span>
                  <input
                    type="password"
                    placeholder="Stored locally in app state"
                    value={draft.password}
                    onChange={(event) => updateDraft({ password: event.target.value })}
                  />
                </label>
              )}

              {draft.authType === 'key' && (
                <label className="editor-field editor-field-wide">
                  <span>Key path</span>
                  <input
                    placeholder="~/.ssh/id_ed25519"
                    value={draft.keyPath}
                    onChange={(event) => updateDraft({ keyPath: event.target.value })}
                  />
                </label>
              )}
            </div>
          </>
        )}

        {isFile && (
          <p className="editor-hint">
            File sessions open directly in the navigator view. Use SFTP for secure file access and FTP for older endpoints.
          </p>
        )}
      </section>
    )
  }

  function renderTerminalTab() {
    return (
      <section className="session-editor-tab-panel">
        <div className="session-editor-inline-heading">Presets</div>
        <div className="terminal-preset-grid" role="list" aria-label="Terminal appearance presets">
          {TERMINAL_PRESETS.map((preset) => {
            const active = matchesTerminalPreset(draft, preset)
            return (
              <button
                key={preset.id}
                className={`terminal-preset-card ${active ? 'active' : ''}`}
                type="button"
                onClick={() =>
                  updateDraft({
                    terminalFontFamily: preset.fontFamily,
                    terminalFontSize: preset.fontSize,
                    terminalForeground: preset.foreground,
                    terminalBackground: preset.background,
                  })}
              >
                <span
                  className="terminal-preset-swatch"
                  style={{
                    background: preset.background,
                    color: preset.foreground,
                    fontFamily: preset.fontFamily,
                    fontSize: `${preset.fontSize}px`,
                  }}
                >
                  $ _
                </span>
                <span className="terminal-preset-copy">
                  <strong>{preset.label}</strong>
                  <span>{preset.note}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="session-editor-grid">
          <label className="editor-field editor-field-compact">
            <span>Font size</span>
            <input
              min={9}
              max={32}
              type="number"
              value={draft.terminalFontSize}
              onChange={(event) => updateDraft({ terminalFontSize: Number(event.target.value) })}
            />
          </label>
        </div>

        <FontFamilyPicker
          availableFonts={systemFonts}
          error={systemFontsError}
          loading={systemFontsBusy}
          value={draft.terminalFontFamily}
          onChange={(value) => updateDraft({ terminalFontFamily: value })}
        />

        <div className="session-editor-grid">
          <ColorField
            label="Text color"
            value={draft.terminalForeground}
            onChange={(value) => updateDraft({ terminalForeground: value })}
          />
          <ColorField
            label="Background color"
            value={draft.terminalBackground}
            onChange={(value) => updateDraft({ terminalBackground: value })}
          />
        </div>

        <div className="terminal-reset-row">
          <button
            className="ghost-button"
            type="button"
            onClick={() =>
              updateDraft({
                terminalFontFamily: DEFAULT_TERMINAL_FONT,
                terminalFontSize: DEFAULT_TERMINAL_SIZE,
                terminalForeground: DEFAULT_TERMINAL_FOREGROUND,
                terminalBackground: DEFAULT_TERMINAL_BACKGROUND,
              })}
          >
            Reset to default
          </button>
        </div>

        <div className="terminal-preview-card">
          <div
            className="terminal-preview-swatch"
            style={{
              background: draft.terminalBackground,
              color: draft.terminalForeground,
              fontFamily: draft.terminalFontFamily || DEFAULT_TERMINAL_FONT,
              fontSize: `${draft.terminalFontSize}px`,
            }}
          >
            <span>{draft.username || 'user'}@openxterm:~$ ls</span>
            <span>Documents  Projects  notes.txt</span>
          </div>
        </div>
      </section>
    )
  }

  function renderAdvancedTab() {
    return (
      <section className="session-editor-tab-panel">
        <div className="session-auth-grid" role="radiogroup" aria-label="X11 forwarding mode">
          <button
            className={`session-auth-option ${!draft.x11Forwarding ? 'active' : ''}`}
            type="button"
            role="radio"
            aria-checked={!draft.x11Forwarding}
            onClick={() => updateDraft({ x11Forwarding: false })}
          >
            <span className="session-auth-icon">
              <ShieldOff size={14} />
            </span>
            <span className="session-auth-copy">
              <strong>Disabled</strong>
              <span>No GUI forwarding.</span>
            </span>
          </button>

          <button
            className={`session-auth-option ${draft.x11Forwarding ? 'active' : ''}`}
            type="button"
            role="radio"
            aria-checked={draft.x11Forwarding}
            onClick={() => updateDraft({ x11Forwarding: true })}
          >
            <span className="session-auth-icon">
              <Monitor size={14} />
            </span>
            <span className="session-auth-copy">
              <strong>Enabled</strong>
              <span>Forward remote windows to this desktop.</span>
            </span>
          </button>
        </div>

        {draft.x11Forwarding && (
          <>
            <div className="session-auth-grid" role="radiogroup" aria-label="X11 trust mode">
              <button
                className={`session-auth-option ${!draft.x11Trusted ? 'active' : ''}`}
                type="button"
                role="radio"
                aria-checked={!draft.x11Trusted}
                onClick={() => updateDraft({ x11Trusted: false })}
              >
                <span className="session-auth-icon">
                  <ShieldOff size={14} />
                </span>
                <span className="session-auth-copy">
                  <strong>Untrusted</strong>
                  <span>Stricter X11 sandbox.</span>
                </span>
              </button>

              <button
                className={`session-auth-option ${draft.x11Trusted ? 'active' : ''}`}
                type="button"
                role="radio"
                aria-checked={draft.x11Trusted}
                onClick={() => updateDraft({ x11Trusted: true })}
              >
                <span className="session-auth-icon">
                  <Monitor size={14} />
                </span>
                <span className="session-auth-copy">
                  <strong>Trusted</strong>
                  <span>Best compatibility for apps like Chromium.</span>
                </span>
              </button>
            </div>

            <div className="session-editor-grid">
              <label className="editor-field editor-field-wide">
                <span>Display override</span>
                <input
                  placeholder={x11DisplayPlaceholder}
                  value={draft.x11Display}
                  onChange={(event) => updateDraft({ x11Display: event.target.value })}
                />
              </label>
            </div>

            <div className="editor-hint">
              Requires a local X server: XQuartz on macOS, Xorg/XWayland on Linux, or VcXsrv/X410 on Windows.
            </div>

            <div className={`x11-assistant-card ${x11Support?.systemX11Available ? 'ready' : 'attention'}`}>
              <div className="x11-assistant-copy">
                <strong>Local GUI forwarding check</strong>
                <span>
                  {x11SupportBusy
                    ? 'Checking local DISPLAY and X11 availability...'
                    : x11Support?.message ?? 'Check this computer before saving the session.'}
                </span>
                {!x11SupportBusy && x11Support?.detail && (
                  <span className="x11-assistant-detail">{x11Support.detail}</span>
                )}
                {x11Support?.systemDisplay && (
                  <span className="x11-assistant-detail">Detected display: {x11Support.systemDisplay}</span>
                )}
                {x11SupportError && <span className="x11-assistant-error">{x11SupportError}</span>}
              </div>

              <div className="x11-assistant-actions">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => void handleCheckX11Support()}
                  disabled={x11SupportBusy}
                >
                  {x11SupportBusy ? 'Checking...' : 'Check local X11'}
                </button>

                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => void openExternalTarget(recommendedGuiHelperUrl)}
                  disabled={x11SupportBusy}
                >
                  <ExternalLink size={14} />
                  <span>{`Open official ${recommendedGuiHelperName} page`}</span>
                </button>
              </div>
            </div>

            {x11NeedsInstallHelp && (
              <div className="editor-hint">
                {isMacOS
                  ? 'Recommended path for this machine: install XQuartz. That gives macOS a real local X11 display, so built-in SSH X11 forwarding can work without installing anything on the server.'
                  : `Recommended path for this machine: install ${recommendedGuiHelperName}.`}
              </div>
            )}
          </>
        )}
      </section>
    )
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-panel session-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-heading">
            <p className="modal-eyebrow">Session</p>
            <h2 id="session-editor-title">{session ? 'Edit session' : 'New session'}</h2>
            <p className="modal-subtitle">
              Compact editor for connection details and per-session terminal style.
            </p>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <form
          className="editor-form"
          onSubmit={(event) => {
            event.preventDefault()
            void onSave(draft)
          }}
        >
          <div className="session-editor-tabstrip" role="tablist" aria-label="Session settings tabs">
            {visibleTabs.map((tab) => {
              const Icon = tab.icon
              const selected = tab.id === activeTab
              return (
                <button
                  key={tab.id}
                  className={`session-editor-tab ${selected ? 'active' : ''}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon size={14} />
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </div>

          <div className="session-editor-tab-meta">
            <strong>{visibleTabs.find((tab) => tab.id === activeTab)?.label}</strong>
            <span>{tabDescription(activeTab, draft.kind)}</span>
          </div>

          {activeTab === 'general' && renderGeneralTab()}
          {activeTab === 'connection' && renderConnectionTab()}
          {activeTab === 'terminal' && renderTerminalTab()}
          {activeTab === 'advanced' && renderAdvancedTab()}

          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="solid-button" type="submit">
              Save session
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
