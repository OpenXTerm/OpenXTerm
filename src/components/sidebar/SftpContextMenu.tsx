import type { RemoteFileEntry } from '../../types/domain'

export interface SftpContextMenuState {
  entry: RemoteFileEntry
  x: number
  y: number
}

interface SftpContextMenuProps {
  menu: SftpContextMenuState
  onDelete: (entry: RemoteFileEntry) => void
  onDownload: (entry: RemoteFileEntry) => void
  onProperties: (entry: RemoteFileEntry) => void
  onRename: (entry: RemoteFileEntry) => void
}

export function SftpContextMenu({
  menu,
  onDelete,
  onDownload,
  onProperties,
  onRename,
}: SftpContextMenuProps) {
  return (
    <div
      className="sidebar-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={() => onRename(menu.entry)}>
        Rename
      </button>
      <button type="button" role="menuitem" onClick={() => onProperties(menu.entry)}>
        Properties
      </button>
      <button type="button" role="menuitem" onClick={() => onDelete(menu.entry)}>
        Delete
      </button>
      <button type="button" role="menuitem" onClick={() => onDownload(menu.entry)}>
        Download
      </button>
    </div>
  )
}
