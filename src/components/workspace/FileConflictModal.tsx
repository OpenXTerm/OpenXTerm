import { useMemo, useState } from 'react'

import type { FileConflictAction, FileConflictRequest, FileConflictResolution } from '../../lib/fileConflict'

interface FileConflictModalProps {
  request: FileConflictRequest | null
  onResolve: (resolution: FileConflictResolution) => void
}

function actionLabel(action: FileConflictAction) {
  switch (action) {
    case 'overwrite':
      return 'Overwrite'
    case 'skip':
      return 'Skip'
    case 'rename':
      return 'Rename'
  }
}

export function FileConflictModal({ request, onResolve }: FileConflictModalProps) {
  if (!request) {
    return null
  }

  return (
    <FileConflictModalContent
      key={`${request.operation}:${request.targetPath}:${request.itemName}:${request.suggestedName}`}
      request={request}
      onResolve={onResolve}
    />
  )
}

function FileConflictModalContent({ request, onResolve }: { request: FileConflictRequest; onResolve: (resolution: FileConflictResolution) => void }) {
  const [action, setAction] = useState<FileConflictAction>('rename')
  const [newName, setNewName] = useState(request.suggestedName)
  const [applyToAll, setApplyToAll] = useState(false)
  const effectiveName = newName.trim()
  const canApply = action !== 'rename' || Boolean(effectiveName)
  const title = request.operation === 'download' ? 'Download conflict' : 'Upload conflict'
  const detail = useMemo(() => {
    return `${request.itemName} already exists at ${request.targetPath}.`
  }, [request])

  function resolve(nextAction: FileConflictAction) {
    if (nextAction === 'rename' && !effectiveName) {
      return
    }

    onResolve({
      action: nextAction,
      applyToAll: request.allowApplyToAll ? applyToAll : false,
      newName: nextAction === 'rename' ? effectiveName : undefined,
    })
  }

  return (
    <div className="modal-backdrop compact-modal-backdrop" role="presentation">
      <section className="modal-panel file-conflict-modal" role="dialog" aria-modal="true" aria-labelledby="file-conflict-title">
        <div className="modal-header">
          <div>
            <h2 id="file-conflict-title">{title}</h2>
            <p>{detail}</p>
          </div>
        </div>

        <div className="file-conflict-actions" role="radiogroup" aria-label="Conflict action">
          {(['rename', 'overwrite', 'skip'] satisfies FileConflictAction[]).map((item) => (
            <button
              key={item}
              type="button"
              className={action === item ? 'active' : ''}
              onClick={() => setAction(item)}
            >
              {actionLabel(item)}
            </button>
          ))}
        </div>

        {action === 'rename' && (
          <label className="file-conflict-rename">
            <span>New name</span>
            <input
              value={newName}
              spellCheck={false}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
        )}

        {request.allowApplyToAll && (
          <label className="file-conflict-apply-all">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(event) => setApplyToAll(event.target.checked)}
            />
            <span>Apply this choice to remaining conflicts</span>
          </label>
        )}

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={() => resolve('skip')}>
            Skip
          </button>
          <button type="button" className="solid-button" disabled={!canApply} onClick={() => resolve(action)}>
            {actionLabel(action)}
          </button>
        </div>
      </section>
    </div>
  )
}
