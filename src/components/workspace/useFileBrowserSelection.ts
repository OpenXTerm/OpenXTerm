import { useCallback, useEffect, useMemo, useState } from 'react'

import type { RemoteDirectorySnapshot, RemoteFileEntry } from '../../types/domain'

export interface FileContextMenuState {
  entry: RemoteFileEntry
  x: number
  y: number
}

interface UseFileBrowserSelectionOptions {
  currentPath: string
  snapshot: RemoteDirectorySnapshot | null
  visibleEntries: RemoteFileEntry[]
}

export function useFileBrowserSelection({
  currentPath,
  snapshot,
  visibleEntries,
}: UseFileBrowserSelectionOptions) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null)

  const selectedEntry = useMemo(
    () => visibleEntries.find((entry) => entry.path === selectedPath) ?? null,
    [selectedPath, visibleEntries],
  )
  const pathToCopy = selectedEntry?.path ?? snapshot?.path ?? currentPath

  const resetSelection = useCallback(() => {
    setSelectedPath(null)
  }, [])

  const setSelectedEntryPaths = useCallback((paths: string[]) => {
    setSelectedPath(paths[0] ?? null)
  }, [])

  const selectEntry = useCallback((entry: RemoteFileEntry) => {
    setSelectedPath(entry.path)
  }, [])

  const openContextMenu = useCallback((entry: RemoteFileEntry, x: number, y: number) => {
    setSelectedPath(entry.path)
    setContextMenu({ entry, x, y })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  useEffect(() => {
    if (!contextMenu) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu()
      }
    }

    window.addEventListener('click', closeContextMenu)
    window.addEventListener('contextmenu', closeContextMenu)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('click', closeContextMenu)
      window.removeEventListener('contextmenu', closeContextMenu)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeContextMenu, contextMenu])

  return {
    closeContextMenu,
    contextMenu,
    openContextMenu,
    pathToCopy,
    resetSelection,
    selectEntry,
    selectedEntry,
    selectedPath,
    setSelectedEntryPaths,
    setSelectedPath,
  }
}
