import { useEffect, useMemo, useState } from 'react'
import { FileText, Folder } from 'lucide-react'

import { renameRemoteEntry, updateRemoteEntryPermissions } from '../../lib/bridge'
import { logOpenXTermError } from '../../lib/errorLog'
import type { RemoteFileEntry, SessionDefinition } from '../../types/domain'

export interface RemoteEntryPropertiesPanelProps {
  session: SessionDefinition
  entry: RemoteFileEntry
  currentPath: string
  busy: boolean
  showInlineTitlebar?: boolean
  onClose: () => void
  onApplied: (message: string) => Promise<void>
}

function parentPathOf(path: string) {
  if (!path || path === '/') {
    return '/'
  }

  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 1) {
    return '/'
  }

  return `/${parts.slice(0, -1).join('/')}`
}

function joinRemotePath(parent: string, name: string) {
  return parent === '/' ? `/${name}` : `${parent.replace(/\/+$/, '')}/${name}`
}

function remoteSizeKbLabel(entry: RemoteFileEntry) {
  if (entry.kind === 'folder') {
    return ''
  }

  if (typeof entry.sizeBytes === 'number') {
    return Math.max(1, Math.ceil(entry.sizeBytes / 1024)).toLocaleString()
  }

  return entry.sizeLabel === '--' ? '' : entry.sizeLabel
}

function remoteSizeDetailLabel(entry: RemoteFileEntry) {
  if (entry.kind === 'folder') {
    return 'Folder'
  }

  if (typeof entry.sizeBytes !== 'number') {
    return entry.sizeLabel || '--'
  }

  return `${entry.sizeBytes.toLocaleString()} bytes (${remoteSizeKbLabel(entry)} KB)`
}

function fileTypeLabel(entry: RemoteFileEntry) {
  return entry.kind === 'folder' ? 'File folder' : 'File'
}

function parseAccessPermissions(accessLabel?: string) {
  if (!accessLabel || accessLabel.length < 10) {
    return undefined
  }

  return accessLabel
    .slice(1, 10)
    .split('')
    .reduce((mode, char, index) => {
      if (char === '-') {
        return mode
      }

      const bit = index % 3 === 0 ? 0o4 : index % 3 === 1 ? 0o2 : 0o1
      const shift = 6 - Math.floor(index / 3) * 3
      return mode | (bit << shift)
    }, 0)
}

function entryPermissions(entry: RemoteFileEntry) {
  return entry.permissions ?? parseAccessPermissions(entry.accessLabel) ?? (entry.kind === 'folder' ? 0o755 : 0o644)
}

function octalModeLabel(mode: number) {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

function accessLabelForMode(kind: RemoteFileEntry['kind'], mode: number) {
  const triplet = (bits: number) => `${bits & 0o4 ? 'r' : '-'}${bits & 0o2 ? 'w' : '-'}${bits & 0o1 ? 'x' : '-'}`
  return `${kind === 'folder' ? 'd' : '-'}${triplet((mode >> 6) & 0o7)}${triplet((mode >> 3) & 0o7)}${triplet(mode & 0o7)}`
}

function fileBrowserErrorContext(session: SessionDefinition, action: string, path: string) {
  return {
    action,
    path,
    sessionId: session.id,
    sessionName: session.name,
    host: session.host,
    kind: session.kind,
    linkedSshTabId: session.linkedSshTabId,
  }
}

export function RemoteEntryPropertiesPanel({
  session,
  entry,
  currentPath,
  busy,
  showInlineTitlebar = true,
  onClose,
  onApplied,
}: RemoteEntryPropertiesPanelProps) {
  const initialMode = useMemo(() => entryPermissions(entry), [entry])
  const [nameDraft, setNameDraft] = useState(entry.name)
  const [mode, setMode] = useState(initialMode)
  const [modeDraft, setModeDraft] = useState(octalModeLabel(initialMode))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const canEditPermissions = session.kind === 'sftp'
  const isDirty = nameDraft.trim() !== entry.name || mode !== initialMode
  const parentPath = parentPathOf(entry.path)
  const displayLocation = parentPath || currentPath
  const permissionRows = [
    { label: 'User', read: 0o400, write: 0o200, execute: 0o100 },
    { label: 'Group', read: 0o040, write: 0o020, execute: 0o010 },
    { label: 'Other', read: 0o004, write: 0o002, execute: 0o001 },
  ]

  useEffect(() => {
    const nextMode = entryPermissions(entry)
    setNameDraft(entry.name)
    setMode(nextMode)
    setModeDraft(octalModeLabel(nextMode))
    setError('')
    setSaving(false)
  }, [entry])

  function updateMode(nextMode: number) {
    const normalized = nextMode & 0o777
    setMode(normalized)
    setModeDraft(octalModeLabel(normalized))
  }

  function togglePermission(bit: number, checked: boolean) {
    updateMode(checked ? mode | bit : mode & ~bit)
  }

  function handleOctalModeChange(value: string) {
    const next = value.replace(/[^0-7]/g, '').slice(0, 3)
    setModeDraft(next)
    if (next.length === 3) {
      setMode(Number.parseInt(next, 8))
    }
  }

  async function handleApply() {
    const nextName = nameDraft.trim()
    if (!nextName) {
      setError('File name cannot be empty.')
      return
    }
    if (nextName.includes('/') || nextName.includes('\\')) {
      setError('File name cannot contain path separators.')
      return
    }
    if (modeDraft.length !== 3) {
      setError('Octal mode must contain exactly three digits.')
      return
    }
    if (mode !== initialMode && !canEditPermissions) {
      setError('Permissions editing is currently supported for SFTP sessions only.')
      return
    }

    setSaving(true)
    setError('')
    try {
      let effectivePath = entry.path
      const changes: string[] = []

      if (nextName !== entry.name) {
        await renameRemoteEntry(session, entry.path, nextName)
        effectivePath = joinRemotePath(parentPath, nextName)
        changes.push('name')
      }

      if (mode !== initialMode) {
        await updateRemoteEntryPermissions(session, effectivePath, mode)
        changes.push('permissions')
      }

      await onApplied(changes.length ? `Updated ${changes.join(' and ')} for ${nextName}` : `No changes for ${entry.name}`)
    } catch (applyError) {
      logOpenXTermError('file-browser.properties-apply', applyError, {
        ...fileBrowserErrorContext(session, 'properties-apply', entry.path),
        nextName,
        mode: octalModeLabel(mode),
      })
      setError(applyError instanceof Error ? applyError.message : 'Unable to update remote properties.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      className="modal-panel remote-properties-modal"
      role="dialog"
      aria-modal="true"
      aria-label={showInlineTitlebar ? undefined : 'Properties'}
      aria-labelledby={showInlineTitlebar ? 'remote-properties-title' : undefined}
    >
      {showInlineTitlebar && (
        <div className="remote-properties-window-titlebar">
          <h2 id="remote-properties-title">Properties</h2>
          <button type="button" aria-label="Close properties" onClick={onClose} disabled={saving}>
            x
          </button>
        </div>
      )}

      <div className="remote-properties-body">
        <div className="remote-properties-heading">
          <div className="remote-properties-icon" aria-hidden="true">
            {entry.kind === 'folder' ? <Folder size={26} /> : <FileText size={26} />}
          </div>
          <label className="remote-properties-name">
            <span>File name</span>
            <input
              value={nameDraft}
              disabled={saving || busy}
              spellCheck={false}
              onChange={(event) => setNameDraft(event.target.value)}
            />
          </label>
        </div>

          <section className="remote-properties-section">
            <h3>General</h3>
            <dl className="remote-properties-facts">
              <dt>Type:</dt>
              <dd>{fileTypeLabel(entry)}</dd>
              <dt>Location:</dt>
              <dd title={displayLocation}>{displayLocation}</dd>
              <dt>Size:</dt>
              <dd>{remoteSizeDetailLabel(entry)}</dd>
              <dt>Created:</dt>
              <dd>{entry.createdLabel || '--'}</dd>
              <dt>Modified:</dt>
              <dd>{entry.modifiedLabel || '--'}</dd>
              <dt>Owner:</dt>
              <dd>{entry.ownerLabel || '--'}</dd>
              <dt>Group:</dt>
              <dd>{entry.groupLabel || '--'}</dd>
            </dl>
          </section>

          <section className="remote-properties-section remote-properties-permissions-section">
            <h3>Permissions</h3>
            <div className="remote-properties-permissions">
              <label className="remote-properties-mode-line">
                <span>Symbolic:</span>
                <input value={accessLabelForMode(entry.kind, mode)} readOnly />
              </label>

              <div className="remote-permission-grid" role="group" aria-label="Permissions">
                <span />
                <strong>Read</strong>
                <strong>Write</strong>
                <strong>Execute</strong>
                {permissionRows.map((row) => (
                  <div className="remote-permission-row" key={row.label}>
                    <strong>{row.label}:</strong>
                    {(['read', 'write', 'execute'] as const).map((key) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={(mode & row[key]) !== 0}
                          disabled={saving || busy || !canEditPermissions}
                          onChange={(event) => togglePermission(row[key], event.target.checked)}
                        />
                        <span>{key[0].toUpperCase() + key.slice(1)}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>

              <label className="remote-properties-octal">
                <span>Octal mode:</span>
                <input
                  value={modeDraft}
                  inputMode="numeric"
                  pattern="[0-7]{3}"
                  disabled={saving || busy || !canEditPermissions}
                  onChange={(event) => handleOctalModeChange(event.target.value)}
                />
              </label>
              {!canEditPermissions && (
                <p className="remote-properties-note">Permissions editing is available for SFTP sessions. FTP entries are shown read-only.</p>
              )}
            </div>
          </section>

          {error && <p className="remote-properties-error">{error}</p>}
      </div>

      <div className="modal-actions">
        <button type="button" onClick={onClose} disabled={saving}>
          Close
        </button>
        <button type="button" className="primary" onClick={() => void handleApply()} disabled={saving || busy || !isDirty}>
          {saving ? 'Applying...' : 'Apply'}
        </button>
      </div>
    </section>
  )
}

export function RemoteEntryPropertiesModal(props: RemoteEntryPropertiesPanelProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        props.onClose()
      }
    }}>
      <RemoteEntryPropertiesPanel {...props} />
    </div>
  )
}
