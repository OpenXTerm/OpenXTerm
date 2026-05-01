import type { FormEvent } from 'react'

interface SftpFormsProps {
  currentPathDraft: string
  hasSelectedSftpSession: boolean
  newFolderName: string
  renameName: string
  renaming: boolean
  selectedEntryCount: number
  showNewFolderForm: boolean
  sftpLoading: boolean
  onCreateFolder: (event: FormEvent<HTMLFormElement>) => void
  onNewFolderNameChange: (value: string) => void
  onPathDraftChange: (value: string) => void
  onPathSubmit: (event: FormEvent<HTMLFormElement>) => void
  onRename: (event: FormEvent<HTMLFormElement>) => void
  onRenameCancel: () => void
  onRenameNameChange: (value: string) => void
  onNewFolderCancel: () => void
}

export function SftpForms({
  currentPathDraft,
  hasSelectedSftpSession,
  newFolderName,
  renameName,
  renaming,
  selectedEntryCount,
  showNewFolderForm,
  sftpLoading,
  onCreateFolder,
  onNewFolderCancel,
  onNewFolderNameChange,
  onPathDraftChange,
  onPathSubmit,
  onRename,
  onRenameCancel,
  onRenameNameChange,
}: SftpFormsProps) {
  return (
    <>
      {showNewFolderForm && hasSelectedSftpSession && (
        <form className="sidebar-sftp-create-form" onSubmit={onCreateFolder}>
          <input
            autoFocus
            value={newFolderName}
            placeholder="Folder name"
            disabled={sftpLoading}
            onChange={(event) => onNewFolderNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onNewFolderCancel()
              }
            }}
          />
          <button type="submit" disabled={sftpLoading || !newFolderName.trim()}>
            Create
          </button>
        </form>
      )}
      {renaming && hasSelectedSftpSession && (
        <form className="sidebar-sftp-create-form" onSubmit={onRename}>
          <input
            autoFocus
            value={renameName}
            placeholder="New name"
            disabled={sftpLoading}
            onChange={(event) => onRenameNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onRenameCancel()
              }
            }}
          />
          <button type="submit" disabled={sftpLoading || !renameName.trim()}>
            Rename
          </button>
        </form>
      )}
      <form className="sidebar-sftp-path" onSubmit={onPathSubmit}>
        <input
          value={currentPathDraft}
          disabled={sftpLoading || !hasSelectedSftpSession}
          aria-label="Remote SFTP path"
          spellCheck={false}
          onChange={(event) => onPathDraftChange(event.target.value)}
        />
        <button type="submit" disabled={sftpLoading || !hasSelectedSftpSession || !currentPathDraft.trim()}>
          Go
        </button>
        {selectedEntryCount > 0 && (
          <strong>{selectedEntryCount} selected</strong>
        )}
      </form>
    </>
  )
}
