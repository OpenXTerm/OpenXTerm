import type { AppBootstrap, SessionDefinition } from '../types/domain'

function stripSessionSecrets(session: SessionDefinition): SessionDefinition {
  const safeSession = { ...session }
  delete safeSession.password
  delete safeSession.keyPassphrase
  delete safeSession.proxyPassword

  return safeSession
}

export function stripBrowserStorageSecrets(state: AppBootstrap): AppBootstrap {
  return {
    ...state,
    sessions: state.sessions.map(stripSessionSecrets),
  }
}
