import type { FormEvent } from 'react'

import {
  createRemoteDirectory,
  deleteRemoteEntry,
  renameRemoteEntry,
} from '../../lib/bridge'
import { logOpenXTermError } from '../../lib/errorLog'
import type { FileConflictResolution } from '../../lib/fileConflict'
import { isTransferCanceledError } from '../../lib/transferQueue'
import { runRemoteEntryDownloads } from '../../lib/sftpTransfers'
import type { RemoteFileEntry, SessionDefinition, TransferProgressPayload } from '../../types/domain'
import { sidebarSftpErrorContext } from './sftpUtils'

type DownloadTargetResolution = {
  targetName: string
  conflictAction: 'overwrite' | 'error'
  resolution: FileConflictResolution | null
  skipped?: boolean
}

interface UseSftpEntryOperationsOptions {
  currentPath: string
  enqueueTransfer: (item: TransferProgressPayload) => void
  hasEntryNamed: (name: string, ignoredPath?: string) => boolean
  loadDirectory: (path: string) => Promise<boolean>
  newFolderName: string
  renameName: string
  renamingEntry: RemoteFileEntry | null
  resolveDownloadTarget: (
    entry: RemoteFileEntry,
    allowApplyToAll: boolean,
    applyToAll?: FileConflictResolution | null,
  ) => Promise<DownloadTargetResolution>
  selectedEntries: RemoteFileEntry[]
  selectedOrEntry: (entry: RemoteFileEntry) => RemoteFileEntry[]
  selectedSession: SessionDefinition | undefined
  setLoading: (loading: boolean) => void
  setMessage: (message: string) => void
  setNewFolderName: (name: string) => void
  setRenameName: (name: string) => void
  setRenamingEntry: (entry: RemoteFileEntry | null) => void
  setSelectedEntryPaths: (paths: string[]) => void
  setShowNewFolderForm: (show: boolean) => void
}

export function useSftpEntryOperations({
  currentPath,
  enqueueTransfer,
  hasEntryNamed,
  loadDirectory,
  newFolderName,
  renameName,
  renamingEntry,
  resolveDownloadTarget,
  selectedEntries,
  selectedOrEntry,
  selectedSession,
  setLoading,
  setMessage,
  setNewFolderName,
  setRenameName,
  setRenamingEntry,
  setSelectedEntryPaths,
  setShowNewFolderForm,
}: UseSftpEntryOperationsOptions) {
  function startRenameEntry(entry: RemoteFileEntry) {
    setSelectedEntryPaths(selectedOrEntry(entry).map((item) => item.path))
    setRenamingEntry(entry)
    setRenameName(entry.name)
  }

  async function handlePathSubmit(event: FormEvent<HTMLFormElement>, pathDraft: string) {
    event.preventDefault()
    await loadDirectory(pathDraft)
  }

  async function handleCreateFolder(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!selectedSession) {
      return
    }

    const session = selectedSession
    const name = newFolderName
    if (!name || !name.trim()) {
      setMessage('Enter a folder name.')
      return
    }

    setLoading(true)
    try {
      await createRemoteDirectory(session, currentPath, name.trim())
      setMessage(`Created folder ${name.trim()}`)
      setNewFolderName('')
      setShowNewFolderForm(false)
      await loadDirectory(currentPath)
    } catch (error) {
      logOpenXTermError('sidebar.sftp.create-folder', error, {
        ...sidebarSftpErrorContext(session, 'create-folder', currentPath),
        folderName: name.trim(),
      })
      setMessage(error instanceof Error ? error.message : 'Unable to create remote folder.')
    } finally {
      setLoading(false)
    }
  }

  async function handleRenameEntry(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!selectedSession || !renamingEntry) {
      return
    }

    const session = selectedSession
    const entry = renamingEntry
    const nextName = renameName.trim()
    if (!nextName) {
      setMessage('Enter a new name.')
      return
    }
    if (nextName.includes('/') || nextName.includes('\\')) {
      setMessage('Names cannot contain path separators.')
      return
    }
    if (hasEntryNamed(nextName, entry.path)) {
      setMessage(`${nextName} already exists in this directory.`)
      return
    }

    setLoading(true)
    try {
      await renameRemoteEntry(session, entry.path, nextName)
      setMessage(`Renamed ${entry.name} to ${nextName}`)
      setRenamingEntry(null)
      setRenameName('')
      await loadDirectory(currentPath)
    } catch (error) {
      logOpenXTermError('sidebar.sftp.rename-entry', error, {
        ...sidebarSftpErrorContext(session, 'rename', currentPath),
        path: entry.path,
        newName: nextName,
      })
      setMessage(error instanceof Error ? error.message : 'Unable to rename remote entry.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDeleteEntry(entries = selectedEntries) {
    if (!selectedSession || entries.length === 0) {
      return
    }

    const session = selectedSession
    setLoading(true)
    try {
      for (const entry of entries) {
        await deleteRemoteEntry(session, entry.path, entry.kind)
      }
      setMessage(entries.length === 1 ? `Deleted ${entries[0].name}` : `Deleted ${entries.length} items`)
      await loadDirectory(currentPath)
    } catch (error) {
      logOpenXTermError('sidebar.sftp.delete-entry', error, {
        ...sidebarSftpErrorContext(session, 'delete', currentPath),
        entries: entries.map((entry) => ({ path: entry.path, kind: entry.kind })),
      })
      setMessage(error instanceof Error ? error.message : 'Unable to delete remote entry.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDownloadEntry(entries = selectedEntries) {
    if (!selectedSession || entries.length === 0) {
      return
    }

    const session = selectedSession
    setLoading(true)
    try {
      let applyToAll: FileConflictResolution | null = null
      const downloadItems: Array<{
        entry: RemoteFileEntry
        targetName: string
        conflictAction: 'overwrite' | 'error'
      }> = []

      for (const entry of entries) {
        const target = await resolveDownloadTarget(entry, entries.length > 1, applyToAll)
        applyToAll = target.resolution
        if (!target.skipped) {
          downloadItems.push({
            entry,
            targetName: target.targetName,
            conflictAction: target.conflictAction,
          })
        }
      }

      if (downloadItems.length === 0) {
        setMessage('Download skipped.')
        return
      }

      const result = await runRemoteEntryDownloads({
        currentPath,
        enqueueTransfer,
        items: downloadItems,
        session,
      })
      setMessage(
        downloadItems.length === 1
          ? `Downloaded ${result.lastResult}`
          : `Downloaded ${result.downloadedCount} item${result.downloadedCount > 1 ? 's' : ''}`,
      )
    } catch (error) {
      if (isTransferCanceledError(error)) {
        setMessage('Transfer canceled.')
        return
      }
      logOpenXTermError('sidebar.sftp.download-entry', error, {
        ...sidebarSftpErrorContext(session, 'download', currentPath),
        entries: entries.map((entry) => ({ path: entry.path, kind: entry.kind })),
      })
      setMessage(error instanceof Error ? error.message : 'Unable to download remote item.')
    } finally {
      setLoading(false)
    }
  }

  return {
    handleCreateFolder,
    handleDeleteEntry,
    handleDownloadEntry,
    handlePathSubmit,
    handleRenameEntry,
    startRenameEntry,
  }
}
