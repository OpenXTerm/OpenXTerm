import { useCallback, type PointerEvent as ReactPointerEvent } from 'react'

import { startNativeFileDrag } from '../../lib/bridge'
import { logOpenXTermError } from '../../lib/errorLog'
import { sessionErrorContext } from '../../lib/sessionErrorContext'
import { useDragOutTracking } from '../../hooks/useDragOutTracking'
import type { RemoteFileEntry, SessionDefinition } from '../../types/domain'

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
  const startDrag = useCallback((entry: RemoteFileEntry, _event: ReactPointerEvent<HTMLButtonElement>, moveEvent: PointerEvent) => {
    setSelectedPath(entry.path)
    void startNativeFileDrag(session, entry.path, entry.name, entry.sizeBytes, moveEvent.clientX, moveEvent.clientY)
      .then((dragStarted) => {
        if (!dragStarted) {
          setMessage('Native drag-out could not start for this file.')
        }
      })
      .catch((error) => {
        logOpenXTermError('file-browser.native-drag', error, sessionErrorContext(session, 'native-drag', entry.path))
        setMessage(error instanceof Error ? error.message : 'Native drag-out failed.')
      })
  }, [session, setMessage, setSelectedPath])

  return useDragOutTracking<RemoteFileEntry, HTMLButtonElement>({
    canStart: (entry) => entry.kind === 'file',
    onStart: startDrag,
  })
}
