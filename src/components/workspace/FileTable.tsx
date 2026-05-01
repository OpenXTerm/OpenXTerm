import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { FileText, Folder } from 'lucide-react'

import type { RemoteFileEntry } from '../../types/domain'
import { FILE_TABLE_COLUMNS, type FileSortKey, type SortDirection } from './fileTableModel'

function remoteSizeKbLabel(entry: RemoteFileEntry) {
  if (entry.kind === 'folder') {
    return ''
  }

  if (typeof entry.sizeBytes === 'number') {
    return Math.max(1, Math.ceil(entry.sizeBytes / 1024)).toLocaleString()
  }

  return entry.sizeLabel === '--' ? '' : entry.sizeLabel
}

export function FileTable({
  entries,
  rawEntryCount,
  selectedPath,
  showHidden,
  sortState,
  style,
  onColumnResizeStart,
  onNativeDragPointerDown,
  onOpenContextMenu,
  onOpenDirectory,
  onSelectEntry,
  onSortColumn,
}: {
  entries: RemoteFileEntry[]
  rawEntryCount: number
  selectedPath: string | null
  showHidden: boolean
  sortState: { key: FileSortKey; direction: SortDirection }
  style: CSSProperties
  onColumnResizeStart: (index: number, event: ReactPointerEvent<HTMLButtonElement>) => void
  onNativeDragPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, entry: RemoteFileEntry) => void
  onOpenContextMenu: (entry: RemoteFileEntry, x: number, y: number) => void
  onOpenDirectory: (entry: RemoteFileEntry) => void
  onSelectEntry: (entry: RemoteFileEntry) => void
  onSortColumn: (key: FileSortKey) => void
}) {
  return (
    <div className="file-list" style={style}>
      {entries.length ? (
        <>
          <div className="file-row file-row-header" role="row">
            {FILE_TABLE_COLUMNS.map((column, index) => (
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
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={`file-row ${selectedPath === entry.path ? 'selected' : ''} ${entry.kind === 'file' ? 'draggable' : ''}`}
              onPointerDown={(event) => onNativeDragPointerDown(event, entry)}
              onClick={() => onSelectEntry(entry)}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onOpenContextMenu(entry, event.clientX, event.clientY)
              }}
              onDoubleClick={() => {
                if (entry.kind === 'folder') {
                  onOpenDirectory(entry)
                }
              }}
            >
              <div className="file-row-name">
                {entry.kind === 'folder' ? <Folder size={14} /> : <FileText size={14} />}
                <span>{entry.name}</span>
              </div>
              <span>{remoteSizeKbLabel(entry)}</span>
              <span>{entry.modifiedLabel}</span>
              <span>{entry.ownerLabel ?? ''}</span>
              <span>{entry.groupLabel ?? ''}</span>
              <span>{entry.accessLabel ?? ''}</span>
            </button>
          ))}
        </>
      ) : (
        <div className="file-empty">
          {rawEntryCount > 0 && !showHidden
            ? 'Only hidden files are present. Turn on Show hidden to view them.'
            : 'This directory is empty.'}
        </div>
      )}
    </div>
  )
}
