import { describe, expect, it } from 'vitest'

import type { SessionDefinition, SessionFolderDefinition } from '../../types/domain'
import {
  buildSessionTree,
  countFolderSessions,
  folderContainsSession,
  sessionCountLabel,
} from './sessionTree'

function session(id: string, name: string, folderPath = ''): SessionDefinition {
  return {
    id,
    name,
    folderPath,
    kind: 'ssh',
    host: 'example.com',
    port: 22,
    username: 'root',
    authType: 'password',
    password: '',
    keyPath: '',
    parity: 'none',
    stopBits: 1,
    dataBits: 8,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
  }
}

function folder(id: string, path: string): SessionFolderDefinition {
  return {
    id,
    path,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
  }
}

describe('sessionTree', () => {
  it('builds explicit and implicit folder nodes', () => {
    const tree = buildSessionTree(
      [
        session('root-session', 'Root session'),
        session('api-session', 'API', 'Production/API'),
        session('db-session', 'Database', 'Production/Database'),
      ],
      [folder('folder-production', 'Production')],
    )

    expect(tree.sessions.map((item) => item.id)).toEqual(['root-session'])
    expect(tree.folders).toHaveLength(1)
    expect(tree.folders[0].path).toBe('Production')
    expect(tree.folders[0].explicit).toBe(true)
    expect(tree.folders[0].folderId).toBe('folder-production')
    expect(tree.folders[0].folders.map((item) => item.path)).toEqual(['Production/API', 'Production/Database'])
    expect(tree.folders[0].folders[0].explicit).toBe(false)
  })

  it('counts and searches nested folder sessions', () => {
    const tree = buildSessionTree(
      [
        session('api-session', 'API', 'Production/API'),
        session('db-session', 'Database', 'Production/Database'),
        session('worker-session', 'Worker', 'Production/API'),
      ],
      [folder('folder-production', 'Production')],
    )
    const production = tree.folders[0]

    expect(countFolderSessions(production)).toBe(3)
    expect(folderContainsSession(production, 'worker-session')).toBe(true)
    expect(folderContainsSession(production, 'missing-session')).toBe(false)
    expect(sessionCountLabel(1)).toBe('1 session')
    expect(sessionCountLabel(3)).toBe('3 sessions')
  })
})
