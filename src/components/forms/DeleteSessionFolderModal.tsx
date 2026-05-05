interface DeleteSessionFolderModalProps {
  busy?: boolean
  error?: string
  folderName: string
  folderPath: string
  nestedFolderCount: number
  sessionCount: number
  onCancel: () => void
  onConfirm: () => void
}

function itemLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function DeleteSessionFolderModal({
  busy = false,
  error = '',
  folderName,
  folderPath,
  nestedFolderCount,
  sessionCount,
  onCancel,
  onConfirm,
}: DeleteSessionFolderModalProps) {
  const deletedItems = [
    sessionCount > 0 ? itemLabel(sessionCount, 'session', 'sessions') : '',
    nestedFolderCount > 0 ? itemLabel(nestedFolderCount, 'nested folder', 'nested folders') : '',
  ]
    .filter(Boolean)
    .join(' and ')

  return (
    <div className="modal-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div className="modal-panel" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Delete folder</p>
            <h2>{folderName}</h2>
          </div>
          <button className="modal-close" type="button" onClick={onCancel} disabled={busy}>
            x
          </button>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm()
          }}
        >
          <div className="form-grid">
            <div className="form-row">
              <label>Folder path</label>
              <input value={folderPath} readOnly />
            </div>
            <p className="modal-subtitle">
              This folder is not empty. Deleting it will also delete {deletedItems}.
            </p>
            {error && <p className="form-error">{error}</p>}
          </div>

          <div className="modal-actions">
            <button type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="primary danger" type="submit" disabled={busy}>
              {busy ? 'Deleting...' : 'Delete folder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
