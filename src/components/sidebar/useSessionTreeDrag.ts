import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import type { SessionDefinition } from '../../types/domain'
import { movedEnough } from './sftpUtils'
import {
  SESSION_ROOT_DROP_TARGET,
  type SessionSidebarDragState,
  type SessionTreeFolder,
} from './sessionTree'

interface UseSessionTreeDragOptions {
  onDropFolderToFolder: (folderId: string, folderPath: string) => void
  onDropSessionToFolder: (sessionId: string, folderPath: string) => void
}

export function useSessionTreeDrag({
  onDropFolderToFolder,
  onDropSessionToFolder,
}: UseSessionTreeDragOptions) {
  const sessionDropTargetPathRef = useRef<string | null>(null)
  const suppressSessionTreeClickRef = useRef(false)
  const [expandedSessionFolders, setExpandedSessionFolders] = useState<Record<string, boolean>>({})
  const [sessionTreeDragState, setSessionTreeDragState] = useState<SessionSidebarDragState | null>(null)
  const [sessionDropTargetPath, setSessionDropTargetPath] = useState<string | null>(null)

  function isSessionFolderExpanded(path: string) {
    return expandedSessionFolders[path] ?? false
  }

  function toggleSessionFolder(path: string) {
    setExpandedSessionFolders((current) => ({
      ...current,
      [path]: !(current[path] ?? false),
    }))
  }

  function clearSessionDragState() {
    setSessionTreeDragState(null)
    setSessionDropTargetPath(null)
    sessionDropTargetPathRef.current = null
  }

  function consumeSuppressedSessionTreeClick() {
    if (!suppressSessionTreeClickRef.current) {
      return false
    }

    suppressSessionTreeClickRef.current = false
    return true
  }

  function canDropSessionOnTarget(session: SessionDefinition, targetPath: string) {
    const currentFolderPath = session.folderPath ?? ''
    if (targetPath === SESSION_ROOT_DROP_TARGET) {
      return currentFolderPath !== ''
    }

    return currentFolderPath !== targetPath
  }

  function canDropFolderOnTarget(folder: SessionTreeFolder, targetPath: string) {
    if (targetPath === SESSION_ROOT_DROP_TARGET) {
      return folder.path.includes('/')
    }

    if (targetPath === folder.path) {
      return false
    }

    if (targetPath.startsWith(`${folder.path}/`)) {
      return false
    }

    const folderName = folder.name
    const currentParentPath = folder.path.includes('/') ? folder.path.split('/').slice(0, -1).join('/') : ''
    const nextPath = targetPath ? `${targetPath}/${folderName}` : folderName

    if (nextPath === folder.path || currentParentPath === targetPath) {
      return false
    }

    return true
  }

  function updateSessionDropTarget(clientX: number, clientY: number, dragState: SessionSidebarDragState) {
    const targetElement = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-session-drop-target]')
    const targetPath = targetElement?.dataset.sessionDropTarget ?? null

    if (!targetPath) {
      setSessionDropTargetPath(null)
      sessionDropTargetPathRef.current = null
      return
    }

    const canDrop = dragState.kind === 'session'
      ? canDropSessionOnTarget(dragState.session, targetPath)
      : canDropFolderOnTarget(dragState.folder, targetPath)

    const nextTargetPath = canDrop ? targetPath : null
    setSessionDropTargetPath(nextTargetPath)
    sessionDropTargetPathRef.current = nextTargetPath
  }

  function startSessionTreePointerDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    dragState: SessionSidebarDragState,
  ) {
    if (event.button !== 0) {
      return
    }

    const target = event.target as HTMLElement
    if (target.closest('button,input,textarea,select,a,[data-no-row-drag="true"]')) {
      return
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Ignore capture failures from the embedded webview.
    }

    const startX = event.clientX
    const startY = event.clientY
    let started = false
    const previousUserSelect = document.body.style.userSelect
    const previousWebkitUserSelect = document.body.style.webkitUserSelect
    const previousCursor = document.body.style.cursor

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
      document.body.style.userSelect = previousUserSelect
      document.body.style.webkitUserSelect = previousWebkitUserSelect
      document.body.style.cursor = previousCursor
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!started && !movedEnough(startX, startY, moveEvent.clientX, moveEvent.clientY)) {
        return
      }

      if (!started) {
        started = true
        suppressSessionTreeClickRef.current = true
        document.body.style.userSelect = 'none'
        document.body.style.webkitUserSelect = 'none'
        document.body.style.cursor = 'grabbing'
        setSessionTreeDragState(dragState)
      }

      updateSessionDropTarget(moveEvent.clientX, moveEvent.clientY, dragState)
    }

    const handlePointerUp = () => {
      cleanup()

      if (!started) {
        return
      }

      const dropTargetPath = sessionDropTargetPathRef.current

      if (dropTargetPath) {
        if (dragState.kind === 'session') {
          onDropSessionToFolder(dragState.session.id, dropTargetPath === SESSION_ROOT_DROP_TARGET ? '' : dropTargetPath)
        } else if (dragState.folder.folderId) {
          onDropFolderToFolder(dragState.folder.folderId, dropTargetPath === SESSION_ROOT_DROP_TARGET ? '' : dropTargetPath)
        }
      }

      clearSessionDragState()
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)
  }

  return {
    consumeSuppressedSessionTreeClick,
    isSessionFolderExpanded,
    sessionDropTargetPath,
    sessionTreeDragState,
    startSessionTreePointerDrag,
    toggleSessionFolder,
  }
}
