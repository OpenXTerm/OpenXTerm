import type { AppBootstrap, UiPreferences } from '../types/domain'
import { DEFAULT_STATUS_BAR_METRICS } from './preferences'

const DEFAULT_PREFERENCES: UiPreferences = {
  theme: 'dark',
  activeSidebar: 'sessions',
  sidebarWidth: 252,
  statusBarVisible: true,
  statusBarSize: 'regular',
  statusBarMetrics: { ...DEFAULT_STATUS_BAR_METRICS },
}

export function createDefaultBootstrap(): AppBootstrap {
  return {
    schemaVersion: 2,
    sessions: [],
    sessionFolders: [],
    macros: [],
    preferences: { ...DEFAULT_PREFERENCES },
  }
}
