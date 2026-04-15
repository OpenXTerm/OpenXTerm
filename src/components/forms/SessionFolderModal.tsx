import { useState } from 'react'

interface SessionFolderModalProps {
  open: boolean
  parentPath: string | null
  onClose: () => void
  onSave: (name: string) => Promise<void>
}

export function SessionFolderModal({ open, parentPath, onClose, onSave }: SessionFolderModalProps) {
  const [name, setName] = useState('')

  if (!open) {
    return null
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-panel" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>New folder</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <form
          className="editor-form"
          onSubmit={(event) => {
            event.preventDefault()
            void onSave(name)
          }}
        >
          <label>
            <span>Parent</span>
            <input value={parentPath ?? 'Root'} disabled />
          </label>

          <label>
            <span>Folder name</span>
            <input required value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>

          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="solid-button" type="submit">
              Create folder
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
