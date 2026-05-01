import { useCallback, useRef, useState } from 'react'

import { inspectDownloadTarget } from '../lib/bridge'
import {
  normalizedNameKey,
  uniqueConflictName,
  type FileConflictRequest,
  type FileConflictResolution,
} from '../lib/fileConflict'
import type { RemoteFileEntry } from '../types/domain'

interface UseSftpConflictResolverOptions {
  compareNames?: 'exact' | 'normalized'
}

export function useSftpConflictResolver(
  entries: RemoteFileEntry[],
  { compareNames = 'exact' }: UseSftpConflictResolverOptions = {},
) {
  const conflictResolverRef = useRef<((resolution: FileConflictResolution) => void) | null>(null)
  const [conflictRequest, setConflictRequest] = useState<FileConflictRequest | null>(null)

  const hasEntryNamed = useCallback((name: string, ignoredPath?: string) => {
    if (compareNames === 'normalized') {
      const key = normalizedNameKey(name)
      return entries.some((entry) => normalizedNameKey(entry.name) === key && entry.path !== ignoredPath)
    }

    return entries.some((entry) => entry.name === name && entry.path !== ignoredPath)
  }, [compareNames, entries])

  const askFileConflict = useCallback((request: FileConflictRequest) => {
    setConflictRequest(request)
    return new Promise<FileConflictResolution>((resolve) => {
      conflictResolverRef.current = resolve
    })
  }, [])

  function resolveConflict(resolution: FileConflictResolution) {
    conflictResolverRef.current?.(resolution)
    conflictResolverRef.current = null
    setConflictRequest(null)
  }

  const resolveUploadTargets = useCallback(async <T extends { name: string },>(
    items: T[],
    targetPathForName: (name: string) => string,
  ) => {
    const reservedNames = new Set<string>()
    let applyToAll: FileConflictResolution | null = null
    const resolved: Array<T & { targetName: string; conflictAction: 'overwrite' | 'error' }> = []

    for (const item of items) {
      const nameTaken = (candidate: string) => hasEntryNamed(candidate) || reservedNames.has(normalizedNameKey(candidate))
      let targetName = item.name
      let conflictAction: 'overwrite' | 'error' = 'error'

      if (nameTaken(targetName)) {
        const suggestedName = uniqueConflictName(targetName, nameTaken)
        const resolution: FileConflictResolution = applyToAll ?? await askFileConflict({
          itemName: targetName,
          targetPath: targetPathForName(targetName),
          suggestedName,
          operation: 'upload',
          allowApplyToAll: items.length > 1,
        })

        if (resolution.applyToAll) {
          applyToAll = resolution
        }

        if (resolution.action === 'skip') {
          continue
        }

        if (resolution.action === 'rename') {
          targetName = resolution.applyToAll ? suggestedName : (resolution.newName ?? suggestedName)
          if (nameTaken(targetName)) {
            targetName = uniqueConflictName(targetName, nameTaken)
          }
        } else {
          conflictAction = 'overwrite'
        }
      }

      reservedNames.add(normalizedNameKey(targetName))
      resolved.push({ ...item, targetName, conflictAction })
    }

    return resolved
  }, [askFileConflict, hasEntryNamed])

  const resolveDownloadTarget = useCallback(async (
    entry: RemoteFileEntry,
    allowApplyToAll: boolean,
    applyToAll: FileConflictResolution | null = null,
  ) => {
    const inspection = await inspectDownloadTarget(entry.name)
    if (!inspection.exists) {
      return {
        targetName: inspection.fileName,
        conflictAction: 'error' as const,
        resolution: applyToAll,
      }
    }

    const resolution: FileConflictResolution = applyToAll ?? await askFileConflict({
      itemName: inspection.fileName,
      targetPath: inspection.path,
      suggestedName: inspection.suggestedFileName,
      operation: 'download',
      allowApplyToAll,
    })

    if (resolution.action === 'skip') {
      return {
        targetName: '',
        conflictAction: 'error' as const,
        skipped: true,
        resolution: resolution.applyToAll ? resolution : applyToAll,
      }
    }

    if (resolution.action === 'rename') {
      return {
        targetName: resolution.applyToAll ? inspection.suggestedFileName : (resolution.newName ?? inspection.suggestedFileName),
        conflictAction: 'error' as const,
        resolution: resolution.applyToAll ? resolution : applyToAll,
      }
    }

    return {
      targetName: inspection.fileName,
      conflictAction: 'overwrite' as const,
      resolution: resolution.applyToAll ? resolution : applyToAll,
    }
  }, [askFileConflict])

  return {
    conflictRequest,
    hasEntryNamed,
    resolveConflict,
    resolveDownloadTarget,
    resolveUploadTargets,
  }
}
