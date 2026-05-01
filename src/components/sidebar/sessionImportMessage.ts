import type { SessionImportSummary } from '../../state/useOpenXTermStore'

export function buildSessionImportMessage(summary: SessionImportSummary) {
  const parts: string[] = []

  if (summary.importedSessions > 0) {
    parts.push(`imported ${summary.importedSessions} session${summary.importedSessions === 1 ? '' : 's'}`)
  }
  if (summary.importedFolders > 0) {
    parts.push(`created ${summary.importedFolders} folder${summary.importedFolders === 1 ? '' : 's'}`)
  }
  if (summary.skippedExistingSessions > 0) {
    parts.push(`skipped ${summary.skippedExistingSessions} existing session${summary.skippedExistingSessions === 1 ? '' : 's'}`)
  }
  if (summary.skippedExistingFolders > 0) {
    parts.push(`skipped ${summary.skippedExistingFolders} existing folder${summary.skippedExistingFolders === 1 ? '' : 's'}`)
  }
  if (summary.skippedUnsupported > 0) {
    parts.push(`ignored ${summary.skippedUnsupported} unsupported item${summary.skippedUnsupported === 1 ? '' : 's'}`)
  }

  return parts.length > 0 ? `MobaXterm import: ${parts.join(', ')}.` : 'MobaXterm import: nothing new to add.'
}
