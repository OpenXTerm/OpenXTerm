import { describe, expect, it } from 'vitest'

import type { AppBootstrap, SessionDefinition } from '../types/domain'
import { stripBrowserStorageSecrets } from './browserStorage'

function createSession(): SessionDefinition {
  return {
    id: 'session-1',
    name: 'Production',
    kind: 'ssh',
    host: 'server.example.com',
    port: 22,
    username: 'developer',
    authType: 'key',
    password: 'secret-password',
    keyPath: '/home/developer/.ssh/id_ed25519',
    keyPassphrase: 'secret-passphrase',
    proxyType: 'socks5',
    proxyHost: 'proxy.example.com',
    proxyPort: 1080,
    proxyUsername: 'proxy-user',
    proxyPassword: 'secret-proxy-password',
    parity: 'none',
    stopBits: 1,
    dataBits: 8,
    createdAt: '2026-06-13T00:00:00Z',
    updatedAt: '2026-06-13T00:00:00Z',
  }
}

describe('stripBrowserStorageSecrets', () => {
  it('removes session credentials without mutating the in-memory state', () => {
    const session = createSession()
    const state: AppBootstrap = {
      schemaVersion: 2,
      sessions: [session],
      sessionFolders: [],
      macros: [],
      preferences: {
        theme: 'dark',
        activeSidebar: 'sessions',
      },
    }

    const persisted = stripBrowserStorageSecrets(state)

    expect(persisted.sessions[0]).not.toHaveProperty('password')
    expect(persisted.sessions[0]).not.toHaveProperty('keyPassphrase')
    expect(persisted.sessions[0]).not.toHaveProperty('proxyPassword')
    expect(persisted.sessions[0]).toMatchObject({
      id: session.id,
      host: session.host,
      keyPath: session.keyPath,
      proxyUsername: session.proxyUsername,
    })
    expect(session.password).toBe('secret-password')
    expect(session.keyPassphrase).toBe('secret-passphrase')
    expect(session.proxyPassword).toBe('secret-proxy-password')
  })
})
