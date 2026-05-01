import { useState, type MouseEvent as ReactMouseEvent } from 'react'

import type { RemoteFileEntry } from '../../types/domain'

export function useSftpSelection(entries: RemoteFileEntry[]) {
  const [selectedSftpEntryPaths, setSelectedSftpEntryPaths] = useState<string[]>([])
  const selectedSftpEntries = selectedSftpEntryPaths
    .map((path) => entries.find((entry) => entry.path === path))
    .filter((entry): entry is RemoteFileEntry => Boolean(entry))

  function selectSftpEntry(entry: RemoteFileEntry, event?: ReactMouseEvent) {
    setSelectedSftpEntryPaths((current) => {
      if (event?.shiftKey && current.length > 0) {
        const anchorPath = current[current.length - 1]
        const anchorIndex = entries.findIndex((item) => item.path === anchorPath)
        const targetIndex = entries.findIndex((item) => item.path === entry.path)
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const start = Math.min(anchorIndex, targetIndex)
          const end = Math.max(anchorIndex, targetIndex)
          return entries.slice(start, end + 1).map((item) => item.path)
        }
      }

      if (event?.metaKey || event?.ctrlKey) {
        return current.includes(entry.path)
          ? current.filter((path) => path !== entry.path)
          : [...current, entry.path]
      }

      return [entry.path]
    })
  }

  function selectedOrEntry(entry: RemoteFileEntry) {
    if (selectedSftpEntryPaths.includes(entry.path)) {
      return selectedSftpEntries
    }

    return [entry]
  }

  return {
    selectedOrEntry,
    selectedSftpEntries,
    selectedSftpEntryPaths,
    selectSftpEntry,
    setSelectedSftpEntryPaths,
  }
}
