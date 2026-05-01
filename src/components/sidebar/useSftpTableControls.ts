import { useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

import {
  SFTP_TABLE_DEFAULT_COLUMN_WIDTHS,
  SFTP_TABLE_MIN_COLUMN_WIDTHS,
  type SftpSortKey,
  type SortDirection,
} from './sftpUtils'

export function useSftpTableControls() {
  const [sftpColumnWidths, setSftpColumnWidths] = useState(SFTP_TABLE_DEFAULT_COLUMN_WIDTHS)
  const [sftpSortState, setSftpSortState] = useState<{ key: SftpSortKey, direction: SortDirection }>({
    key: 'name',
    direction: 'asc',
  })
  const sftpTableStyle = useMemo(
    () => ({
      '--sftp-table-columns': sftpColumnWidths.map((width) => `${width}px`).join(' '),
    }) as CSSProperties,
    [sftpColumnWidths],
  )

  function handleSftpColumnResizeStart(index: number, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    const startWidth = sftpColumnWidths[index]

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const minWidth = SFTP_TABLE_MIN_COLUMN_WIDTHS[index] ?? 58
      const nextWidth = Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX))
      setSftpColumnWidths((current) => current.map((width, columnIndex) => (
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

  function handleSftpSortColumn(key: SftpSortKey) {
    setSftpSortState((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    ))
  }

  return {
    handleSftpColumnResizeStart,
    handleSftpSortColumn,
    sftpSortState,
    sftpTableStyle,
  }
}
