import { useMemo, useState } from 'react'
import {
  Cable,
  ExternalLink,
  FolderTree,
  HardDrive,
  KeyRound,
  LockKeyhole,
  Monitor,
  Server,
  ShieldOff,
  Terminal,
  Usb,
} from 'lucide-react'

import { openExternalTarget } from '../../lib/bridge'
import { getDefaultPort } from '../../lib/sessionUtils'
import type { LocalX11Support, SessionDraft, SessionKind } from '../../types/domain'
import {
  DEFAULT_TERMINAL_BACKGROUND,
  DEFAULT_TERMINAL_FONT,
  DEFAULT_TERMINAL_FOREGROUND,
  DEFAULT_TERMINAL_SIZE,
  displayFontName,
  matchesTerminalPreset,
  PINNED_TERMINAL_FONTS,
  quoteFontFamily,
  TERMINAL_PRESETS,
} from './sessionEditorHelpers'

type UpdateSessionDraft = (patch: Partial<SessionDraft>) => void

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

export function SessionEditorGeneralTab({
  draft,
  normalizedFolderOptions,
  updateDraft,
}: {
  draft: SessionDraft
  normalizedFolderOptions: string[]
  updateDraft: UpdateSessionDraft
}) {
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

export function SessionEditorConnectionTab({
  draft,
  updateDraft,
}: {
  draft: SessionDraft
  updateDraft: UpdateSessionDraft
}) {
  const isSerial = draft.kind === 'serial'
  const isLocal = draft.kind === 'local'
  const isFile = draft.kind === 'sftp' || draft.kind === 'ftp'

  if (isLocal) {
    return (
      <section className="session-editor-tab-panel">
        <div className="session-editor-grid">
          <label className="editor-field editor-field-wide">
            <span>Working directory</span>
            <input
              placeholder="~"
              value={draft.localWorkingDirectory}
              onChange={(event) => updateDraft({ localWorkingDirectory: event.target.value })}
            />
          </label>
        </div>
        <p className="editor-hint">
          Local sessions open the default shell for this operating system. Leave the working directory empty to start in the home directory. `~` expands to the local home folder.
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

      <div className="session-editor-inline-heading">Network proxy</div>
      <div className="session-editor-grid">
        <label className="editor-field">
          <span>Proxy type</span>
          <select
            value={draft.proxyType}
            onChange={(event) => updateDraft({ proxyType: event.target.value as SessionDraft['proxyType'] })}
          >
            <option value="none">Direct connection</option>
            <option value="http">HTTP CONNECT</option>
            <option value="socks5">SOCKS5</option>
          </select>
        </label>

        {draft.proxyType !== 'none' && (
          <>
            <label className="editor-field editor-field-wide">
              <span>Proxy host</span>
              <input
                placeholder="127.0.0.1"
                value={draft.proxyHost}
                onChange={(event) => updateDraft({ proxyHost: event.target.value })}
              />
            </label>

            <label className="editor-field editor-field-compact">
              <span>Proxy port</span>
              <input
                min={1}
                max={65535}
                type="number"
                value={draft.proxyPort}
                onChange={(event) => updateDraft({ proxyPort: Number(event.target.value) })}
              />
            </label>

            <label className="editor-field">
              <span>Proxy username</span>
              <input
                value={draft.proxyUsername}
                onChange={(event) => updateDraft({ proxyUsername: event.target.value })}
              />
            </label>

            <label className="editor-field">
              <span>Proxy password</span>
              <input
                type="password"
                value={draft.proxyPassword}
                onChange={(event) => updateDraft({ proxyPassword: event.target.value })}
              />
            </label>
          </>
        )}
      </div>

      <p className="editor-hint">
        Proxy settings apply to SSH, linked SFTP, standalone SFTP, Telnet, and FTP for this session.
      </p>
    </section>
  )
}

export function SessionEditorTerminalTab({
  draft,
  systemFonts,
  systemFontsBusy,
  systemFontsError,
  updateDraft,
}: {
  draft: SessionDraft
  systemFonts: string[]
  systemFontsBusy: boolean
  systemFontsError: string
  updateDraft: UpdateSessionDraft
}) {
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

export function SessionEditorAdvancedTab({
  draft,
  isMacOS,
  recommendedGuiHelperName,
  recommendedGuiHelperUrl,
  x11DisplayPlaceholder,
  x11NeedsInstallHelp,
  x11Support,
  x11SupportBusy,
  x11SupportError,
  onCheckX11Support,
  updateDraft,
}: {
  draft: SessionDraft
  isMacOS: boolean
  recommendedGuiHelperName: string
  recommendedGuiHelperUrl: string
  x11DisplayPlaceholder: string
  x11NeedsInstallHelp: boolean
  x11Support: LocalX11Support | null
  x11SupportBusy: boolean
  x11SupportError: string
  onCheckX11Support: () => void
  updateDraft: UpdateSessionDraft
}) {
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
                onClick={() => onCheckX11Support()}
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
