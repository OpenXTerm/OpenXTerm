import { useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

import type { RemoteDirectorySnapshot, RemoteFileEntry } from '../../types/domain'
import {
  FILE_TABLE_DEFAULT_COLUMN_WIDTHS,
  FILE_TABLE_MIN_COLUMN_WIDTHS,
  type FileSortKey,
  type SortDirection,
} from './fileTableModel'

function isHiddenEntry(entry: RemoteFileEntry) {
  return entry.name.startsWith('.')
}

function compareText(left: string | undefined, right: string | undefined) {
  return (left ?? '').localeCompare(right ?? '', undefined, { numeric: true, sensitivity: 'base' })
}

function compareFileEntries(left: RemoteFileEntry, right: RemoteFileEntry, key: FileSortKey, direction: SortDirection) {
  if (left.kind !== right.kind) {
    return left.kind === 'folder' ? -1 : 1
  }

  const multiplier = direction === 'asc' ? 1 : -1
  let result = 0

  switch (key) {
    case 'size':
      result = (left.sizeBytes ?? -1) - (right.sizeBytes ?? -1)
      break
    case 'modified':
      result = compareText(left.modifiedLabel, right.modifiedLabel)
      break
    case 'owner':
      result = compareText(left.ownerLabel, right.ownerLabel)
      break
    case 'group':
      result = compareText(left.groupLabel, right.groupLabel)
      break
    case 'access':
      result = compareText(left.accessLabel, right.accessLabel)
      break
    case 'name':
    default:
      result = compareText(left.name, right.name)
      break
  }

  if (result === 0) {
    result = compareText(left.name, right.name)
  }

  return result * multiplier
}

export function useFileTableControls(snapshot: RemoteDirectorySnapshot | null) {
  const [showHidden, setShowHidden] = useState(false)
  const [columnWidths, setColumnWidths] = useState(FILE_TABLE_DEFAULT_COLUMN_WIDTHS)
  const [sortState, setSortState] = useState<{ key: FileSortKey; direction: SortDirection }>({
    key: 'name',
    direction: 'asc',
  })

  const visibleEntries = useMemo(() => {
    const entries = snapshot?.entries ?? []
    const filteredEntries = showHidden ? entries : entries.filter((entry) => !isHiddenEntry(entry))
    return [...filteredEntries].sort((left, right) => (
      compareFileEntries(left, right, sortState.key, sortState.direction)
    ))
  }, [showHidden, snapshot, sortState.direction, sortState.key])

  const fileTableStyle = useMemo(
    () => ({
      '--file-table-columns': columnWidths.map((width) => `${width}px`).join(' '),
    }) as CSSProperties,
    [columnWidths],
  )

  function handleColumnResizeStart(index: number, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    const startWidth = columnWidths[index]

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const minWidth = FILE_TABLE_MIN_COLUMN_WIDTHS[index] ?? 58
      const nextWidth = Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX))
      setColumnWidths((current) => current.map((width, columnIndex) => (
        columnIndex === index ? nextWidth : width
      )))
    }

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  function handleSortColumn(key: FileSortKey) {
    setSortState((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    ))
  }

  return {
    fileTableStyle,
    handleColumnResizeStart,
    handleSortColumn,
    setShowHidden,
    showHidden,
    sortState,
    visibleEntries,
  }
}
