import { useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import {
  clearRemotePropertiesPayload,
  readRemotePropertiesPayload,
  writeRemotePropertiesResult,
} from '../../lib/remotePropertiesWindow'
import { RemoteEntryPropertiesPanel } from './RemoteEntryPropertiesModal'

function closeCurrentWindow() {
  void getCurrentWindow().close().catch(() => {
    // Missing close permissions should not leave an unhandled rejection.
  })
}

export function RemoteEntryPropertiesWindowPage() {
  const requestId = new URLSearchParams(window.location.search).get('properties-request-id') ?? ''
  const [payload] = useState(() => {
    if (!requestId) {
      return null
    }

    const nextPayload = readRemotePropertiesPayload(requestId)
    clearRemotePropertiesPayload(requestId)
    return nextPayload
  })
  if (!payload) {
    return (
      <div className="properties-window-page">
        <section className="modal-panel remote-properties-modal">
          <div className="remote-properties-body">
            <p className="remote-properties-error">Properties payload is no longer available.</p>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={closeCurrentWindow}>Close</button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="properties-window-page">
      <RemoteEntryPropertiesPanel
        session={payload.session}
        entry={payload.entry}
        currentPath={payload.currentPath}
        busy={false}
        showInlineTitlebar={false}
        onClose={closeCurrentWindow}
        onApplied={async (message) => {
          writeRemotePropertiesResult({
            requestId: payload.requestId,
            sessionId: payload.session.id,
            currentPath: payload.currentPath,
            message,
            changedAt: Date.now(),
          })
          closeCurrentWindow()
        }}
      />
    </div>
  )
}
