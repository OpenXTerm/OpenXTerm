import { useEffect, useState } from 'react'

import { logOpenXTermError } from '../lib/errorLog'
import {
  remotePropertiesResultKey,
  requestRemoteEntryPropertiesWindow,
  type RemotePropertiesWindowResult,
} from '../lib/remotePropertiesWindow'
import type { RemoteFileEntry, SessionDefinition } from '../types/domain'

interface UseRemotePropertiesWindowOptions {
  clearSelectionOnStorageResult?: boolean
  closeContextMenu: () => void
  currentPath: string
  errorContext: (session: SessionDefinition, action: string, path: string) => Record<string, unknown>
  errorScope: string
  loadDirectory: (session: SessionDefinition, path: string) => Promise<unknown>
  selectedSession: SessionDefinition | undefined
  sessions: SessionDefinition[]
  setMessage: (message: string) => void
  setSelectedEntryPaths: (paths: string[]) => void
}

export function useRemotePropertiesWindow({
  clearSelectionOnStorageResult = true,
  closeContextMenu,
  currentPath,
  errorContext,
  errorScope,
  loadDirectory,
  selectedSession,
  sessions,
  setMessage,
  setSelectedEntryPaths,
}: UseRemotePropertiesWindowOptions) {
  const [propertiesEntry, setPropertiesEntry] = useState<RemoteFileEntry | null>(null)

  async function openProperties(entry: RemoteFileEntry) {
    closeContextMenu()
    setSelectedEntryPaths([entry.path])
    if (!selectedSession) {
      return
    }

    const opened = await requestRemoteEntryPropertiesWindow(selectedSession, entry, currentPath)
    if (!opened) {
      setPropertiesEntry(entry)
    }
  }

  async function handlePropertiesApplied(nextMessage: string) {
    if (!selectedSession) {
      return
    }

    setPropertiesEntry(null)
    await loadDirectory(selectedSession, currentPath)
    setMessage(nextMessage)
  }

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== remotePropertiesResultKey() || !event.newValue) {
        return
      }

      try {
        const result = JSON.parse(event.newValue) as RemotePropertiesWindowResult
        const session = sessions.find((item) => item.id === result.sessionId)
        if (!session) {
          return
        }

        void loadDirectory(session, result.currentPath).then(() => {
          if (selectedSession?.id === result.sessionId) {
            if (clearSelectionOnStorageResult) {
              setSelectedEntryPaths([])
            }
            setMessage(result.message)
          }
        })
      } catch (error) {
        if (selectedSession) {
          logOpenXTermError(errorScope, error, errorContext(selectedSession, 'properties-result', currentPath))
        }
      }
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [
    clearSelectionOnStorageResult,
    currentPath,
    errorContext,
    errorScope,
    loadDirectory,
    selectedSession,
    sessions,
    setMessage,
    setSelectedEntryPaths,
  ])

  return {
    closeProperties: () => setPropertiesEntry(null),
    handlePropertiesApplied,
    openProperties,
    propertiesEntry,
  }
}
