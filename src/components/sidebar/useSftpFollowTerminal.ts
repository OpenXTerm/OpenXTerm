import { useEffect, useRef, useState } from 'react'

import type { SessionDefinition } from '../../types/domain'
import { normalizeRemotePath } from './sftpUtils'

interface UseSftpFollowTerminalOptions {
  currentPath: string
  loadDirectory: (path: string) => Promise<boolean>
  loading: boolean
  selectedSession: SessionDefinition | undefined
  terminalCwdByTabId: Record<string, string>
}

export function useSftpFollowTerminal({
  currentPath,
  loadDirectory,
  loading,
  selectedSession,
  terminalCwdByTabId,
}: UseSftpFollowTerminalOptions) {
  const failedFollowedPathRef = useRef<string | null>(null)
  const [followRemoteTerminal, setFollowRemoteTerminal] = useState(false)
  const followedSftpPath = selectedSession?.linkedSshTabId
    ? terminalCwdByTabId[selectedSession.linkedSshTabId]
    : undefined
  const canFollowRemoteTerminal = Boolean(selectedSession?.linkedSshTabId)
  const effectiveFollowRemoteTerminal = canFollowRemoteTerminal && followRemoteTerminal

  useEffect(() => {
    if (!effectiveFollowRemoteTerminal) {
      failedFollowedPathRef.current = null
    }
  }, [effectiveFollowRemoteTerminal])

  useEffect(() => {
    if (!effectiveFollowRemoteTerminal || !followedSftpPath || !selectedSession || loading) {
      return
    }

    const nextPath = normalizeRemotePath(followedSftpPath)
    if (failedFollowedPathRef.current === nextPath) {
      return
    }

    if (nextPath === normalizeRemotePath(currentPath)) {
      failedFollowedPathRef.current = null
      return
    }

    void loadDirectory(nextPath).then((loaded) => {
      failedFollowedPathRef.current = loaded ? null : nextPath
    })
  }, [
    currentPath,
    effectiveFollowRemoteTerminal,
    followedSftpPath,
    loadDirectory,
    loading,
    selectedSession,
  ])

  return {
    canFollowRemoteTerminal,
    followedSftpPath,
    followRemoteTerminal: effectiveFollowRemoteTerminal,
    setFollowRemoteTerminal,
  }
}
