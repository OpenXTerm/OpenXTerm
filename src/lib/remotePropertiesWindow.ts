import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import type { RemoteFileEntry, SessionDefinition } from '../types/domain'

const REMOTE_PROPERTIES_PAYLOAD_PREFIX = 'openxterm.remote-properties.payload.'
const REMOTE_PROPERTIES_RESULT_KEY = 'openxterm.remote-properties.result'

export interface RemotePropertiesWindowPayload {
  requestId: string
  session: SessionDefinition
  entry: RemoteFileEntry
  currentPath: string
}

export interface RemotePropertiesWindowResult {
  requestId: string
  sessionId: string
  currentPath: string
  message: string
  changedAt: number
}

function isTauriRuntime() {
  return '__TAURI_INTERNALS__' in window
}

function propertiesWindowLabel(requestId: string) {
  return `properties-${requestId.replace(/[^A-Za-z0-9:_-]/g, '-')}`
}

function propertiesWindowUrl(requestId: string) {
  return `/?remote-properties-window=1&properties-request-id=${encodeURIComponent(requestId)}`
}

export function remotePropertiesPayloadKey(requestId: string) {
  return `${REMOTE_PROPERTIES_PAYLOAD_PREFIX}${requestId}`
}

export function remotePropertiesResultKey() {
  return REMOTE_PROPERTIES_RESULT_KEY
}

export function readRemotePropertiesPayload(requestId: string): RemotePropertiesWindowPayload | null {
  const raw = localStorage.getItem(remotePropertiesPayloadKey(requestId))
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as RemotePropertiesWindowPayload
  } catch {
    return null
  }
}

export function clearRemotePropertiesPayload(requestId: string) {
  localStorage.removeItem(remotePropertiesPayloadKey(requestId))
}

export function writeRemotePropertiesResult(result: RemotePropertiesWindowResult) {
  localStorage.setItem(REMOTE_PROPERTIES_RESULT_KEY, JSON.stringify(result))
}

export async function requestRemoteEntryPropertiesWindow(
  session: SessionDefinition,
  entry: RemoteFileEntry,
  currentPath: string,
) {
  if (!isTauriRuntime()) {
    return false
  }

  const requestId = crypto.randomUUID()
  const payload: RemotePropertiesWindowPayload = {
    requestId,
    session,
    entry,
    currentPath,
  }
  localStorage.setItem(remotePropertiesPayloadKey(requestId), JSON.stringify(payload))

  const label = propertiesWindowLabel(requestId)
  try {
    const win = new WebviewWindow(label, {
      url: propertiesWindowUrl(requestId),
      title: `Properties - ${entry.name}`,
      width: 680,
      height: 590,
      minWidth: 560,
      minHeight: 560,
      resizable: true,
      center: true,
      visible: true,
      focus: true,
    })

    void win.once('tauri://created', () => {
      void win.show()
      void win.setFocus()
    })

    void win.once('tauri://error', () => {
      clearRemotePropertiesPayload(requestId)
    })

    return true
  } catch {
    clearRemotePropertiesPayload(requestId)
    return false
  }
}
