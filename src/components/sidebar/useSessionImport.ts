import { useState, type ChangeEvent } from 'react'

import { parseMobaXtermSessionsFile } from '../../lib/mobaxtermImport'
import type { SessionImportSummary } from '../../state/useOpenXTermStore'
import { buildSessionImportMessage } from './sessionImportMessage'

type ImportMobaXtermSessions = (content: string) => Promise<SessionImportSummary>

export function useSessionImport(importMobaXtermSessions: ImportMobaXtermSessions) {
  const [sessionMessage, setSessionMessage] = useState('')

  async function handleSessionImportChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const content = await file.text()
      const preview = parseMobaXtermSessionsFile(content)
      if (preview.sessions.length === 0 && preview.folders.length === 0 && preview.skipped.length > 0) {
        setSessionMessage(`MobaXterm import: no supported sessions found. Ignored ${preview.skipped.length} unsupported item${preview.skipped.length === 1 ? '' : 's'}.`)
        return
      }

      const summary = await importMobaXtermSessions(content)
      setSessionMessage(buildSessionImportMessage(summary))
    } catch (error) {
      setSessionMessage(error instanceof Error ? error.message : 'Unable to import MobaXterm sessions.')
    } finally {
      event.target.value = ''
    }
  }

  return {
    handleSessionImportChange,
    sessionMessage,
  }
}
