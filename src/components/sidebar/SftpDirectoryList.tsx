import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'
import { FileText, FolderClosed } from 'lucide-react'

import type { RemoteFileEntry } from '../../types/domain'
import {
  SFTP_TABLE_COLUMNS,
  remoteSizeKbLabel,
  type SftpSortKey,
  type SortDirection,
} from './sftpUtils'

interface SftpDirectoryListProps {
  currentSftpPath: string
  dropActive: boolean
  entries: RemoteFileEntry[]
  hasSelectedSftpSession: boolean
  listRef: RefObject<HTMLDivElement | null>
  selectedEntryPaths: string[]
  sftpLoading: boolean
  sftpMessage: string
  sortState: { key: SftpSortKey, direction: SortDirection }
  tableStyle: CSSProperties
  onColumnResizeStart: (index: number, event: ReactPointerEvent<HTMLButtonElement>) => void
  onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void
  onEntryClick: (entry: RemoteFileEntry, event: ReactMouseEvent<HTMLDivElement>) => void
  onEntryContextMenu: (entry: RemoteFileEntry, event: ReactMouseEvent<HTMLDivElement>) => void
  onEntryDelete: (entry: RemoteFileEntry) => void
  onEntryOpen: (entry: RemoteFileEntry) => void
  onEntryPointerDown: (event: ReactPointerEvent<HTMLElement>, entry: RemoteFileEntry, source: 'row' | 'handle') => void
  onSortColumn: (key: SftpSortKey) => void
}

export function SftpDirectoryList({
  currentSftpPath,
  dropActive,
  entries,
  hasSelectedSftpSession,
  listRef,
  selectedEntryPaths,
  sftpLoading,
  sftpMessage,
  sortState,
  tableStyle,
  onColumnResizeStart,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  onEntryClick,
  onEntryContextMenu,
  onEntryDelete,
  onEntryOpen,
  onEntryPointerDown,
  onSortColumn,
}: SftpDirectoryListProps) {
  return (
    <div
      ref={listRef}
      className={`sidebar-list ${dropActive ? 'sidebar-drop-active' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {hasSelectedSftpSession && entries.length > 0 && (
        <div
          className="sidebar-sftp-table"
          role="table"
          aria-label="Remote SFTP directory"
          style={tableStyle}
        >
          <div className="sidebar-sftp-table-header" role="row">
            {SFTP_TABLE_COLUMNS.map((column, index) => (
              <span key={column.key} className="file-table-header-cell">
                <button
                  className="file-table-sort-button"
                  type="button"
                  aria-label={`Sort by ${column.label}`}
                  onClick={() => onSortColumn(column.key)}
                >
                  <span>{column.label}</span>
                  {sortState.key === column.key && (
                    <span aria-hidden="true">{sortState.direction === 'asc' ? '^' : 'v'}</span>
                  )}
                </button>
                <button
                  className="file-table-column-resizer"
                  type="button"
                  aria-label={`Resize ${column.label} column`}
                  onPointerDown={(event) => onColumnResizeStart(index, event)}
                />
              </span>
            ))}
          </div>
          {entries.map((entry) => {
            const selected = selectedEntryPaths.includes(entry.path)
            return (
              <div
                key={entry.path}
                className={`sidebar-sftp-table-row ${selected ? 'active' : ''}`}
                role="row"
                tabIndex={0}
                onPointerDown={(event) => onEntryPointerDown(event, entry, 'row')}
                onClick={(event) => onEntryClick(entry, event)}
                onContextMenu={(event) => onEntryContextMenu(entry, event)}
                onDoubleClick={() => onEntryOpen(entry)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    onEntryOpen(entry)
                  }
                  if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault()
                    onEntryDelete(entry)
                  }
                }}
              >
                <span className="sidebar-sftp-name-cell" title={entry.name}>
                  {entry.kind === 'folder' ? <FolderClosed size={13} /> : <FileText size={13} />}
                  <span>{entry.name}</span>
                </span>
                <span>{remoteSizeKbLabel(entry)}</span>
                <span title={entry.modifiedLabel}>{entry.modifiedLabel}</span>
                <span>{entry.ownerLabel ?? ''}</span>
                <span>{entry.groupLabel ?? ''}</span>
                <span className="sidebar-sftp-access-cell">{entry.accessLabel ?? ''}</span>
              </div>
            )
          })}
        </div>
      )}
      {hasSelectedSftpSession && !entries.length && (
        <div className="sidebar-empty-copy">
          {sftpLoading ? 'Loading remote directory...' : sftpMessage || 'This directory is empty.'}
        </div>
      )}
      {!hasSelectedSftpSession && (
        <div className="sidebar-empty-copy">No live SSH-linked SFTP session yet.</div>
      )}
      {dropActive && (
        <div className="sidebar-drop-overlay">
          <strong>Drop files to upload</strong>
          <span>{currentSftpPath}</span>
        </div>
      )}
    </div>
  )
}
