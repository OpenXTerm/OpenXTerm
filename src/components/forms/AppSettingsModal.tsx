import { useEffect, useMemo, useState, type FormEvent } from 'react'

import type { SidebarSection, SystemAuthSupport, UiPreferences } from '../../types/domain'

interface AppSettingsModalProps {
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

export function AppSettingsModal({
  lockSupport,
  open,
  preferences,
  onClose,
  onLockApp,
  onSave,
}: AppSettingsModalProps) {
  const initialDraft = useMemo(() => normalizePreferences(preferences), [preferences])
  const [draft, setDraft] = useState<UiPreferences>(initialDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setDraft(initialDraft)
      setError('')
      setSaving(false)
    }
  }, [initialDraft, open])

  if (!open) {
    return null
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await onSave(normalizePreferences(draft))
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  const sidebarWidth = draft.sidebarWidth ?? 252

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
          <section className="settings-section">
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

          <section className="settings-section">
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
          </section>

          <section className="settings-section settings-security-section">
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

          {error && <p className="settings-error">{error}</p>}

          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button className="solid-button" type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save settings'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

function normalizePreferences(preferences: UiPreferences): UiPreferences {
  return {
    theme: 'dark',
    activeSidebar: preferences.activeSidebar,
    sidebarWidth: Math.min(840, Math.max(220, preferences.sidebarWidth ?? 252)),
    statusBarVisible: preferences.statusBarVisible ?? true,
  }
}
