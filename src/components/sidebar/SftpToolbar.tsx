import type { RefObject } from 'react'
import { ArrowDownToLine, ArrowUp, FolderPlus, FolderUp, RefreshCw, Trash2, Upload } from 'lucide-react'

import { SidebarIconButton } from './SidebarIconButton'

interface SftpToolbarProps {
  currentSftpPath: string
  hasSelectedSftpSession: boolean
  selectedSftpEntryCount: number
  sftpLoading: boolean
  uploadFolderInputRef: RefObject<HTMLInputElement | null>
  uploadInputRef: RefObject<HTMLInputElement | null>
  onCreateFolderToggle: () => void
  onDelete: () => void
  onDownload: () => void
  onLoadDirectory: (path: string) => void
}

export function SftpToolbar({
  currentSftpPath,
  hasSelectedSftpSession,
  selectedSftpEntryCount,
  sftpLoading,
  uploadFolderInputRef,
  uploadInputRef,
  onCreateFolderToggle,
  onDelete,
  onDownload,
  onLoadDirectory,
}: SftpToolbarProps) {
  const parentSegments = currentSftpPath.split('/').filter(Boolean).slice(0, -1)
  const parentPath = parentSegments.length > 0 ? `/${parentSegments.join('/')}` : '/'

  return (
    <div className="sidebar-sftp-toolbar">
      <SidebarIconButton
        accent="folder"
        icon={<ArrowUp size={14} />}
        label="Up"
        disabled={sftpLoading || currentSftpPath === '/' || !hasSelectedSftpSession}
        onClick={() => onLoadDirectory(parentPath)}
      />
      <SidebarIconButton
        accent="transfer"
        icon={<ArrowDownToLine size={14} />}
        label="Download"
        disabled={sftpLoading || selectedSftpEntryCount === 0}
        onClick={onDownload}
      />
      <SidebarIconButton
        accent="transfer"
        icon={<Upload size={14} />}
        label="Upload"
        disabled={sftpLoading || !hasSelectedSftpSession}
        onClick={() => uploadInputRef.current?.click()}
      />
      <SidebarIconButton
        accent="transfer"
        icon={<FolderUp size={14} />}
        label="Upload folder"
        disabled={sftpLoading || !hasSelectedSftpSession}
        onClick={() => uploadFolderInputRef.current?.click()}
      />
      <SidebarIconButton
        accent="success"
        icon={<RefreshCw size={14} className={sftpLoading ? 'spinning' : undefined} />}
        label="Refresh"
        disabled={sftpLoading || !hasSelectedSftpSession}
        onClick={() => onLoadDirectory(currentSftpPath)}
      />
      <SidebarIconButton
        accent="folder"
        icon={<FolderPlus size={14} />}
        label="New folder"
        disabled={sftpLoading || !hasSelectedSftpSession}
        onClick={onCreateFolderToggle}
      />
      <SidebarIconButton
        accent="danger"
        icon={<Trash2 size={14} />}
        label="Delete"
        disabled={sftpLoading || selectedSftpEntryCount === 0}
        onClick={onDelete}
      />
    </div>
  )
}
