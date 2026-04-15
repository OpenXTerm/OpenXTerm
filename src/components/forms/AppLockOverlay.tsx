import { Lock } from 'lucide-react'

import type { SystemAuthSupport } from '../../types/domain'

interface AppLockOverlayProps {
  support: SystemAuthSupport
  busy: boolean
  error: string
  onUnlock: () => void
}

export function AppLockOverlay({ support, busy, error, onUnlock }: AppLockOverlayProps) {
  const unlockLabel = support.methodLabel
    ? `Unlock with ${support.methodLabel}`
    : 'Unlock'

  return (
    <div className="app-lock-backdrop" role="presentation">
      <div
        className="app-lock-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-lock-title"
        aria-describedby="app-lock-copy"
      >
        <div className="app-lock-icon">
          <Lock size={20} />
        </div>
        <h2 id="app-lock-title">OpenXTerm is locked</h2>
        <p id="app-lock-copy">
          {support.available
            ? `Use ${support.methodLabel} to unlock this workspace and return to your sessions.`
            : support.detail}
        </p>
        {error && <p className="app-lock-error">{error}</p>}
        <div className="app-lock-actions">
          <button
            className="chrome-action accent app-lock-unlock"
            type="button"
            onClick={onUnlock}
            disabled={!support.available || busy}
          >
            {busy ? 'Waiting for system authentication...' : unlockLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
