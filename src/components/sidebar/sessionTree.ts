import { splitSessionFolderPath } from '../../lib/sessionUtils'
import type { SessionDefinition, SessionFolderDefinition } from '../../types/domain'

export const SESSION_ROOT_DROP_TARGET = '__root__'

export interface SessionTreeFolder {
  key: string
  folderId?: string
  name: string
  path: string
  explicit: boolean
  folders: SessionTreeFolder[]
  sessions: SessionDefinition[]
}

export interface SessionTreeRoot {
  folders: SessionTreeFolder[]
  sessions: SessionDefinition[]
}

export type SessionSidebarDragState =
  | { kind: 'session', session: SessionDefinition }
  | { kind: 'folder', folder: SessionTreeFolder }

export function buildSessionTree(
  sessions: SessionDefinition[],
  sessionFolders: SessionFolderDefinition[],
): SessionTreeRoot {
  const root: SessionTreeRoot = { folders: [], sessions: [] }
  const folderIndex = new Map<string, SessionTreeFolder>()

  const ensureFolderPath = (path: string, explicitFolder?: SessionFolderDefinition) => {
    const segments = splitSessionFolderPath(path)
    let currentFolders = root.folders
    let currentFolder: SessionTreeFolder | null = null
    let currentPath = ''

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let folder = folderIndex.get(currentPath)

      if (!folder) {
        folder = {
          key: `session-folder:${currentPath}`,
          folderId: undefined,
          name: segment,
          path: currentPath,
          explicit: false,
          folders: [],
          sessions: [],
        }
        folderIndex.set(currentPath, folder)
        currentFolders.push(folder)
      }

      if (explicitFolder && explicitFolder.path === currentPath) {
        folder.explicit = true
        folder.folderId = explicitFolder.id
      }

      currentFolder = folder
      currentFolders = folder.folders
    }
    return currentFolder
  }

  for (const folder of sessionFolders) {
    ensureFolderPath(folder.path, folder)
  }

  for (const session of sessions) {
    const normalizedFolderPath = session.folderPath
    if (!normalizedFolderPath) {
      root.sessions.push(session)
      continue
    }

    ensureFolderPath(normalizedFolderPath)?.sessions.push(session)
  }

  const sortFolder = (folder: SessionTreeFolder) => {
    folder.folders.sort((left, right) => left.name.localeCompare(right.name))
    folder.sessions.sort((left, right) => left.name.localeCompare(right.name))
    folder.folders.forEach(sortFolder)
  }

  root.folders.sort((left, right) => left.name.localeCompare(right.name))
  root.sessions.sort((left, right) => left.name.localeCompare(right.name))
  root.folders.forEach(sortFolder)

  return root
}

export function countFolderSessions(folder: SessionTreeFolder): number {
  return folder.sessions.length + folder.folders.reduce((total, child) => total + countFolderSessions(child), 0)
}

export function folderContainsSession(folder: SessionTreeFolder, sessionId: string | undefined): boolean {
  if (!sessionId) {
    return false
  }

  if (folder.sessions.some((session) => session.id === sessionId)) {
    return true
  }

  return folder.folders.some((child) => folderContainsSession(child, sessionId))
}

export function sessionCountLabel(count: number) {
  return count === 1 ? '1 session' : `${count} sessions`
}
