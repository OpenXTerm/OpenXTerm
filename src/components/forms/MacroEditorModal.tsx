import { useState } from 'react'

import type { MacroDefinition, MacroDraft } from '../../types/domain'

interface MacroEditorModalProps {
  open: boolean
  macro: MacroDefinition | null
  onClose: () => void
  onSave: (draft: MacroDraft) => Promise<void>
}

function createDraft(macro?: MacroDefinition | null): MacroDraft {
  if (!macro) {
    return {
      name: '',
      command: '',
    }
  }

  return {
    id: macro.id,
    name: macro.name,
    command: macro.command,
  }
}

export function MacroEditorModal({ open, macro, onClose, onSave }: MacroEditorModalProps) {
  const [draft, setDraft] = useState<MacroDraft>(createDraft(macro))

  if (!open) {
    return null
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-panel" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{macro ? 'Edit macro' : 'New macro'}</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <form
          className="editor-form"
          onSubmit={(event) => {
            event.preventDefault()
            void onSave(draft)
          }}
        >
          <label>
            <span>Macro name</span>
            <input
              required
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>

          <label>
            <span>Command</span>
            <textarea
              required
              rows={6}
              value={draft.command}
              onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
            />
          </label>

          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="solid-button" type="submit">
              Save macro
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
