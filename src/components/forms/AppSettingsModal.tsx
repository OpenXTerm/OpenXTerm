import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Activity, Info, Shield, SlidersHorizontal } from 'lucide-react'

import {
  DEFAULT_STATUS_BAR_METRICS,
  normalizeUiPreferences,
} from '../../lib/preferences'
import { openExternalTarget } from '../../lib/bridge'
import type {
  SidebarSection,
  StatusBarMetrics,
  StatusBarSize,
  SystemAuthSupport,
  UiPreferences,
} from '../../types/domain'

export type AppSettingsTab = 'interface' | 'status' | 'security' | 'about'

interface AppSettingsModalProps {
  initialTab: AppSettingsTab
  lockSupport: SystemAuthSupport
  open: boolean
  preferences: UiPreferences
  onClose: () => void
  onLockApp: () => void
  onSave: (preferences: UiPreferences) => Promise<void>
}

const SIDEBAR_OPTIONS: Array<{ value: SidebarSection; label: string }> = [
  { value: 'sessions', label: 'Sessions' },
  { value: 'sftp', label: 'SFTP' },
  { value: 'tools', label: 'Tools' },
  { value: 'macros', label: 'Macros' },
]

const STATUS_BAR_SIZE_OPTIONS: Array<{ value: StatusBarSize; label: string }> = [
  { value: 'compact', label: 'Compact' },
  { value: 'regular', label: 'Regular' },
  { value: 'large', label: 'Large' },
]

const STATUS_BAR_METRIC_OPTIONS: Array<{ value: keyof StatusBarMetrics; label: string }> = [
  { value: 'host', label: 'Host' },
  { value: 'user', label: 'User' },
  { value: 'cpu', label: 'CPU' },
  { value: 'memory', label: 'Memory' },
  { value: 'disk', label: 'Disk' },
  { value: 'networkDown', label: 'Download' },
  { value: 'networkUp', label: 'Upload' },
  { value: 'uptime', label: 'Uptime' },
]

const THIRD_PARTY_LICENSES_URL = 'https://github.com/OpenXTerm/OpenXTerm/blob/main/THIRD_PARTY_LICENSES.md'
const TRADEMARKS_URL = 'https://github.com/OpenXTerm/OpenXTerm/blob/main/TRADEMARKS.md'

const SETTINGS_TABS: Array<{
  id: AppSettingsTab
  label: string
  description: string
  icon: typeof SlidersHorizontal
}> = [
  {
    id: 'interface',
    label: 'Interface',
    description: 'Default sidebar behavior and workspace sizing.',
    icon: SlidersHorizontal,
  },
  {
    id: 'status',
    label: 'Status bar',
    description: 'Visible monitoring fields and status bar density.',
    icon: Activity,
  },
  {
    id: 'security',
    label: 'Security',
    description: 'Local app lock and platform authentication.',
    icon: Shield,
  },
  {
    id: 'about',
    label: 'About',
    description: 'Project identity, license, and product positioning.',
    icon: Info,
  },
]

export function AppSettingsModal({
  initialTab,
  lockSupport,
  open,
  preferences,
  onClose,
  onLockApp,
  onSave,
}: AppSettingsModalProps) {
  const initialDraft = useMemo(() => normalizeUiPreferences(preferences), [preferences])
  const [draft, setDraft] = useState<UiPreferences>(initialDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<AppSettingsTab>(initialTab)

  useEffect(() => {
    if (open) {
      setDraft(initialDraft)
      setError('')
      setSaving(false)
      setActiveTab(initialTab)
    }
  }, [initialDraft, initialTab, open])

  if (!open) {
    return null
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await onSave(normalizeUiPreferences(draft))
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  async function handleOpenExternal(target: string) {
    setError('')
    try {
      await openExternalTarget(target)
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError))
    }
  }

  const sidebarWidth = draft.sidebarWidth ?? 252
  const statusBarMetrics = draft.statusBarMetrics ?? DEFAULT_STATUS_BAR_METRICS
  const activeTabMeta = SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0]

  return (
    <div className="modal-backdrop compact-modal-backdrop" role="presentation">
      <section className="modal-panel app-settings-modal" role="dialog" aria-modal="true" aria-labelledby="app-settings-title">
        <header className="modal-header">
          <div className="modal-heading">
            <p className="modal-eyebrow">OpenXTerm</p>
            <h2 id="app-settings-title">Settings</h2>
            <p className="modal-subtitle">Tune the workspace shell without changing saved sessions.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} disabled={saving}>
            Close
          </button>
        </header>

        <form className="editor-form app-settings-form" onSubmit={handleSubmit}>
          <div className="app-settings-tabstrip" role="tablist" aria-label="Settings sections">
            {SETTINGS_TABS.map((tab) => {
              const Icon = tab.icon
              const selected = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  className={`app-settings-tab ${selected ? 'active' : ''}`}
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

          <div className="app-settings-tab-meta">
            <strong>{activeTabMeta.label}</strong>
            <span>{activeTabMeta.description}</span>
          </div>

          {activeTab === 'interface' && (
            <section className="settings-section" role="tabpanel">
              <div className="settings-section-heading">
                <h3>Interface</h3>
                <p>Choose what opens by default and how much room the sidebar gets.</p>
              </div>

              <label>
                <span>Startup sidebar section</span>
                <select
                  value={draft.activeSidebar}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    activeSidebar: event.target.value as SidebarSection,
                  }))}
                >
                  {SIDEBAR_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="settings-range-field">
                <span>Sidebar width: {sidebarWidth}px</span>
                <input
                  type="range"
                  min={220}
                  max={840}
                  step={10}
                  value={sidebarWidth}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    sidebarWidth: Number(event.target.value),
                  }))}
                />
              </label>

              <button
                className="ghost-button settings-inline-action"
                type="button"
                onClick={() => setDraft((current) => ({ ...current, sidebarWidth: 252 }))}
              >
                Reset sidebar width
              </button>
            </section>
          )}

          {activeTab === 'status' && (
            <section className="settings-section" role="tabpanel">
              <div className="settings-section-heading">
                <h3>Status bar</h3>
                <p>Keep host metrics visible at the bottom of the workspace.</p>
              </div>

              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={draft.statusBarVisible ?? true}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    statusBarVisible: event.target.checked,
                  }))}
                />
                <span>Show status bar</span>
              </label>

              <label>
                <span>Status bar size</span>
                <select
                  value={draft.statusBarSize ?? 'regular'}
                  disabled={draft.statusBarVisible === false}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    statusBarSize: event.target.value as StatusBarSize,
                  }))}
                >
                  {STATUS_BAR_SIZE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <div className="settings-metric-grid" aria-label="Status bar metrics">
                {STATUS_BAR_METRIC_OPTIONS.map((option) => (
                  <label className="settings-checkbox" key={option.value}>
                    <input
                      type="checkbox"
                      checked={statusBarMetrics[option.value]}
                      disabled={draft.statusBarVisible === false}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        statusBarMetrics: {
                          ...(current.statusBarMetrics ?? DEFAULT_STATUS_BAR_METRICS),
                          [option.value]: event.target.checked,
                        },
                      }))}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </section>
          )}

          {activeTab === 'security' && (
            <section className="settings-section settings-security-section" role="tabpanel">
              <div className="settings-section-heading">
                <h3>App lock</h3>
                <p>{lockSupport.detail}</p>
              </div>

              <button
                className="ghost-button settings-inline-action"
                type="button"
                disabled={!lockSupport.available}
                onClick={onLockApp}
              >
                Lock with {lockSupport.methodLabel}
              </button>
            </section>
          )}

          {activeTab === 'about' && (
            <section className="settings-section settings-about-section" role="tabpanel">
              <div className="settings-section-heading">
                <h3>OpenXTerm</h3>
                <p>Open-source desktop terminal workspace for saved sessions, SSH, SFTP, local shells, file transfers, macros, and live host status.</p>
              </div>

              <div className="settings-about-content">
                <dl className="settings-about-list">
                  <div>
                    <dt>Status</dt>
                    <dd>Alpha</dd>
                  </div>
                  <div>
                    <dt>Runtime</dt>
                    <dd>Tauri 2, React, Rust</dd>
                  </div>
                  <div>
                    <dt>License</dt>
                    <dd>MIT</dd>
                  </div>
                </dl>

                <p className="settings-about-note">
                  OpenXTerm is independent software and is not affiliated with, endorsed by, or connected to MobaXterm, Mobatek, or any other terminal product.
                </p>

                <div className="settings-about-actions" aria-label="Project legal documents">
                  <button
                    className="ghost-button settings-about-link"
                    type="button"
                    onClick={() => void handleOpenExternal(THIRD_PARTY_LICENSES_URL)}
                  >
                    Third-party licenses
                  </button>
                  <button
                    className="ghost-button settings-about-link"
                    type="button"
                    onClick={() => void handleOpenExternal(TRADEMARKS_URL)}
                  >
                    Trademarks
                  </button>
                </div>
              </div>
            </section>
          )}

          {error && <p className="settings-error">{error}</p>}

          {activeTab !== 'about' && (
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button className="solid-button" type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Save settings'}
              </button>
            </div>
          )}
        </form>
      </section>
    </div>
  )
}
