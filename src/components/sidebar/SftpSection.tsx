import type {
  ChangeEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'

import type { RemoteFileEntry, SessionDefinition } from '../../types/domain'
import { RemoteEntryPropertiesModal } from '../workspace/RemoteEntryPropertiesModal'
import { FileConflictModal } from '../workspace/FileConflictModal'
import type { FileConflictRequest, FileConflictResolution } from '../../lib/fileConflict'
import { SftpContextMenu, type SftpContextMenuState } from './SftpContextMenu'
import { SftpDirectoryList } from './SftpDirectoryList'
import { SftpForms } from './SftpForms'
import { SftpToolbar } from './SftpToolbar'
import type { SftpSortKey, SortDirection } from './sftpUtils'

interface SftpSectionProps {
  currentSftpPath: string
  dropActive: boolean
  entries: RemoteFileEntry[]
  listRef: RefObject<HTMLDivElement | null>
  newFolderName: string
  propertiesEntry: RemoteFileEntry | null
  renameName: string
  renamingEntry: RemoteFileEntry | null
  selectedEntryCount: number
  selectedEntryPaths: string[]
  selectedSession: SessionDefinition | undefined
  sftpConflictRequest: FileConflictRequest | null
  sftpContextMenu: SftpContextMenuState | null
  sftpLoading: boolean
  sftpMessage: string
  sftpPathDraft: string
  showNewFolderForm: boolean
  sortState: { key: SftpSortKey, direction: SortDirection }
  tableStyle: CSSProperties
  uploadFolderInputRef: RefObject<HTMLInputElement | null>
  uploadInputRef: RefObject<HTMLInputElement | null>
  onColumnResizeStart: (index: number, event: ReactPointerEvent<HTMLButtonElement>) => void
  onContextMenuDelete: (entry: RemoteFileEntry) => void
  onContextMenuDownload: (entry: RemoteFileEntry) => void
  onCreateFolder: (event: FormEvent<HTMLFormElement>) => void
  onCreateFolderToggle: () => void
  onDelete: () => void
  onDownload: () => void
  onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void
  onEntryClick: (entry: RemoteFileEntry, event: ReactMouseEvent<HTMLDivElement>) => void
  onEntryContextMenu: (entry: RemoteFileEntry, event: ReactMouseEvent<HTMLDivElement>) => void
  onEntryDelete: (entry: RemoteFileEntry) => void
  onEntryOpen: (entry: RemoteFileEntry) => void
  onEntryPointerDown: (event: ReactPointerEvent<HTMLElement>, entry: RemoteFileEntry, source: 'row' | 'handle') => void
  onNewFolderCancel: () => void
  onNewFolderNameChange: (value: string) => void
  onPathDraftChange: (value: string) => void
  onPathSubmit: (event: FormEvent<HTMLFormElement>) => void
  onPropertiesApplied: (nextMessage: string) => Promise<void>
  onPropertiesClose: () => void
  onPropertiesOpen: (entry: RemoteFileEntry) => void
  onRename: (event: FormEvent<HTMLFormElement>) => void
  onRenameCancel: () => void
  onRenameNameChange: (value: string) => void
  onRenameStart: (entry: RemoteFileEntry) => void
  onSftpConflictResolve: (resolution: FileConflictResolution) => void
  onSortColumn: (key: SftpSortKey) => void
  onUploadChange: (event: ChangeEvent<HTMLInputElement>) => void
  onUploadFolderChange: (event: ChangeEvent<HTMLInputElement>) => void
  onLoadDirectory: (path: string) => void
}

export function SftpSection({
  currentSftpPath,
  dropActive,
  entries,
  listRef,
  newFolderName,
  propertiesEntry,
  renameName,
  renamingEntry,
  selectedEntryCount,
  selectedEntryPaths,
  selectedSession,
  sftpConflictRequest,
  sftpContextMenu,
  sftpLoading,
  sftpMessage,
  sftpPathDraft,
  showNewFolderForm,
  sortState,
  tableStyle,
  uploadFolderInputRef,
  uploadInputRef,
  onColumnResizeStart,
  onContextMenuDelete,
  onContextMenuDownload,
  onCreateFolder,
  onCreateFolderToggle,
  onDelete,
  onDownload,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  onEntryClick,
  onEntryContextMenu,
  onEntryDelete,
  onEntryOpen,
  onEntryPointerDown,
  onLoadDirectory,
  onNewFolderCancel,
  onNewFolderNameChange,
  onPathDraftChange,
  onPathSubmit,
  onPropertiesApplied,
  onPropertiesClose,
  onPropertiesOpen,
  onRename,
  onRenameCancel,
  onRenameNameChange,
  onRenameStart,
  onSftpConflictResolve,
  onSortColumn,
  onUploadChange,
  onUploadFolderChange,
}: SftpSectionProps) {
  return (
    <>
      <div className="sidebar-header">
        <span>SFTP</span>
        <span className="sidebar-caption">{selectedSession?.host ?? 'SSH-linked'}</span>
      </div>
      <SftpToolbar
        currentSftpPath={currentSftpPath}
        hasSelectedSftpSession={Boolean(selectedSession)}
        selectedSftpEntryCount={selectedEntryCount}
        sftpLoading={sftpLoading}
        uploadFolderInputRef={uploadFolderInputRef}
        uploadInputRef={uploadInputRef}
        onCreateFolderToggle={onCreateFolderToggle}
        onDelete={onDelete}
        onDownload={onDownload}
        onLoadDirectory={onLoadDirectory}
      />
      <input
        ref={uploadInputRef}
        className="sr-only-input"
        type="file"
        multiple
        onChange={onUploadChange}
      />
      <input
        ref={uploadFolderInputRef}
        className="sr-only-input"
        type="file"
        multiple
        // React's DOM types do not include Chromium's folder-picker attributes yet.
        {...{ webkitdirectory: '', directory: '' }}
        onChange={onUploadFolderChange}
      />
      <SftpForms
        currentPathDraft={sftpPathDraft}
        hasSelectedSftpSession={Boolean(selectedSession)}
        newFolderName={newFolderName}
        renameName={renameName}
        renaming={Boolean(renamingEntry)}
        selectedEntryCount={selectedEntryCount}
        showNewFolderForm={showNewFolderForm}
        sftpLoading={sftpLoading}
        onCreateFolder={onCreateFolder}
        onNewFolderCancel={onNewFolderCancel}
        onNewFolderNameChange={onNewFolderNameChange}
        onPathDraftChange={onPathDraftChange}
        onPathSubmit={onPathSubmit}
        onRename={onRename}
        onRenameCancel={onRenameCancel}
        onRenameNameChange={onRenameNameChange}
      />
      <SftpDirectoryList
        currentSftpPath={currentSftpPath}
        dropActive={dropActive}
        entries={entries}
        hasSelectedSftpSession={Boolean(selectedSession)}
        listRef={listRef}
        selectedEntryPaths={selectedEntryPaths}
        sftpLoading={sftpLoading}
        sftpMessage={sftpMessage}
        sortState={sortState}
        tableStyle={tableStyle}
        onColumnResizeStart={onColumnResizeStart}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onEntryClick={onEntryClick}
        onEntryContextMenu={onEntryContextMenu}
        onEntryDelete={onEntryDelete}
        onEntryOpen={onEntryOpen}
        onEntryPointerDown={onEntryPointerDown}
        onSortColumn={onSortColumn}
      />
      {sftpContextMenu && (
        <SftpContextMenu
          menu={sftpContextMenu}
          onDelete={onContextMenuDelete}
          onDownload={onContextMenuDownload}
          onProperties={onPropertiesOpen}
          onRename={onRenameStart}
        />
      )}
      {propertiesEntry && selectedSession && (
        <RemoteEntryPropertiesModal
          session={selectedSession}
          entry={propertiesEntry}
          currentPath={currentSftpPath}
          busy={sftpLoading}
          onClose={onPropertiesClose}
          onApplied={onPropertiesApplied}
        />
      )}
      <FileConflictModal request={sftpConflictRequest} onResolve={onSftpConflictResolve} />
    </>
  )
}
