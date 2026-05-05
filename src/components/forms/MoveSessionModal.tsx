import { useState } from 'react'

import type { SessionDefinition } from '../../types/domain'

interface MoveSessionModalProps {
  open: boolean
  session: SessionDefinition | null
  folderOptions: string[]
  onClose: () => void
  onSave: (folderPath: string) => Promise<void>
}

export function MoveSessionModal({ open, session, folderOptions, onClose, onSave }: MoveSessionModalProps) {
  if (!open || !session) {
    return null
  }

  return (
    <MoveSessionModalContent
      key={`${session.id}:${session.folderPath ?? ''}`}
      folderOptions={folderOptions}
      session={session}
      onClose={onClose}
      onSave={onSave}
    />
  )
}

function MoveSessionModalContent({
  session,
  folderOptions,
  onClose,
  onSave,
}: Omit<MoveSessionModalProps, 'open'> & { session: SessionDefinition }) {
  const [folderPath, setFolderPath] = useState(session?.folderPath ?? '')
  const current = session?.folderPath ? [session.folderPath] : []
  const options = Array.from(new Set([...current, ...folderOptions])).sort((left, right) => left.localeCompare(right))

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-panel" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Move session</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <form
          className="editor-form"
          onSubmit={(event) => {
            event.preventDefault()
            void onSave(folderPath)
          }}
        >
          <label>
            <span>Session</span>
            <input value={session.name} disabled />
          </label>

          <label>
            <span>Target folder</span>
            <select value={folderPath} onChange={(event) => setFolderPath(event.target.value)}>
              <option value="">Root</option>
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="solid-button" type="submit">
              Move session
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
