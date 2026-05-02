import { type PointerEvent as ReactPointerEvent } from 'react'

import { startNativeFileDrag } from '../../lib/bridge'
import { logOpenXTermError } from '../../lib/errorLog'
import type { RemoteFileEntry, SessionDefinition } from '../../types/domain'

function movedEnough(startX: number, startY: number, currentX: number, currentY: number) {
  return Math.hypot(currentX - startX, currentY - startY) > 5
}

function fileBrowserErrorContext(session: SessionDefinition, action: string, path: string) {
  return {
    action,
    path,
    sessionId: session.id,
    sessionName: session.name,
    host: session.host,
    kind: session.kind,
    linkedSshTabId: session.linkedSshTabId,
  }
}

interface UseFileNativeDragOutOptions {
  session: SessionDefinition
  setMessage: (message: string) => void
  setSelectedPath: (path: string) => void
}

export function useFileNativeDragOut({
  session,
  setMessage,
  setSelectedPath,
}: UseFileNativeDragOutOptions) {
  return function handleNativeDragPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    entry: RemoteFileEntry,
  ) {
    if (entry.kind !== 'file' || event.button !== 0) {
      return
    }

    setSelectedPath(entry.path)
    const startX = event.clientX
    const startY = event.clientY
    const dragButton = event.currentTarget
    const pointerId = event.pointerId
    let started = false

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (started || !movedEnough(startX, startY, moveEvent.clientX, moveEvent.clientY)) {
        return
      }

      started = true
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      try {
        dragButton.releasePointerCapture(pointerId)
      } catch {
        // Native drag can outlive the webview pointer capture on Windows.
      }
      moveEvent.preventDefault()
      moveEvent.stopPropagation()
      void startNativeFileDrag(session, entry.path, entry.name, entry.sizeBytes, moveEvent.clientX, moveEvent.clientY)
        .then((dragStarted) => {
          if (!dragStarted) {
            setMessage('Native drag-out could not start for this file.')
          }
        })
        .catch((error) => {
          logOpenXTermError('file-browser.native-drag', error, fileBrowserErrorContext(session, 'native-drag', entry.path))
          setMessage(error instanceof Error ? error.message : 'Native drag-out failed.')
        })
    }

    const handlePointerUp = () => {
      try {
        dragButton.releasePointerCapture(pointerId)
      } catch {
        // The pointer may already be released when drag never starts.
      }
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }
}
