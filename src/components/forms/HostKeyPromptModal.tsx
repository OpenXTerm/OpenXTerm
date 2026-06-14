import { ShieldAlert, ShieldQuestion } from 'lucide-react'

import type { HostKeyDecision, HostKeyPromptPayload } from '../../types/domain'

interface HostKeyPromptModalProps {
  prompt: HostKeyPromptPayload
  onDecision: (decision: HostKeyDecision) => void
}

export function HostKeyPromptModal({ prompt, onDecision }: HostKeyPromptModalProps) {
  const changed = prompt.kind === 'changed'
  const endpoint = `${prompt.host}:${prompt.port}`
  const showSessionLabel = Boolean(prompt.sessionLabel) && prompt.sessionLabel !== prompt.host

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-panel host-key-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="host-key-title"
        aria-describedby="host-key-copy"
      >
        <div className="modal-header">
          <h2 id="host-key-title" className={changed ? 'host-key-title danger' : 'host-key-title'}>
            {changed ? <ShieldAlert size={18} /> : <ShieldQuestion size={18} />}
            {changed ? 'Server host key has changed' : 'Unknown server host key'}
          </h2>
        </div>

        <div className="host-key-body">
          <p id="host-key-copy" className={changed ? 'host-key-warning' : undefined}>
            {changed ? (
              <>
                The host key for <strong>{endpoint}</strong> does not match the key saved on an earlier
                connection. The server may have been reinstalled — or someone could be intercepting the
                connection (a man-in-the-middle attack). Continue only if you know why the key changed.
              </>
            ) : (
              <>
                The authenticity of <strong>{endpoint}</strong> can&apos;t be established yet. Check that the
                fingerprint below matches the server before you trust it.
              </>
            )}
          </p>

          <dl className="host-key-fields">
            {showSessionLabel && (
              <div className="host-key-field">
                <dt>Session</dt>
                <dd>{prompt.sessionLabel}</dd>
              </div>
            )}
            <div className="host-key-field">
              <dt>Host</dt>
              <dd>{endpoint}</dd>
            </div>
            <div className="host-key-field">
              <dt>SHA256</dt>
              <dd className="host-key-fingerprint">{prompt.fingerprint}</dd>
            </div>
          </dl>
        </div>

        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={() => onDecision('reject')}>
            Cancel
          </button>
          <button className="ghost-button" type="button" onClick={() => onDecision('once')}>
            Connect once
          </button>
          <button
            className={changed ? 'solid-button danger' : 'solid-button'}
            type="button"
            onClick={() => onDecision('store')}
          >
            {changed ? 'Overwrite & save' : 'Accept & save'}
          </button>
        </div>
      </div>
    </div>
  )
}
