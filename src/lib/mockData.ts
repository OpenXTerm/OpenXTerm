import type { AppBootstrap, MacroDefinition, UiPreferences } from '../types/domain'
import { DEFAULT_STATUS_BAR_METRICS } from './preferences'

const DEFAULT_PREFERENCES: UiPreferences = {
  theme: 'dark',
  activeSidebar: 'sessions',
  sidebarWidth: 252,
  statusBarVisible: true,
  statusBarSize: 'regular',
  statusBarMetrics: { ...DEFAULT_STATUS_BAR_METRICS },
}

const DEFAULT_MACROS: MacroDefinition[] = [
  {
    id: 'macro-df',
    name: 'Disk usage',
    command: 'df -h',
    createdAt: '2026-04-13T09:30:00.000Z',
    updatedAt: '2026-04-13T09:30:00.000Z',
  },
  {
    id: 'macro-top',
    name: 'Load snapshot',
    command: 'uptime && free -m',
    createdAt: '2026-04-13T09:31:00.000Z',
    updatedAt: '2026-04-13T09:31:00.000Z',
  },
  {
    id: 'macro-tail',
    name: 'Tail auth log',
    command: 'tail -n 100 /var/log/auth.log',
    createdAt: '2026-04-13T09:32:00.000Z',
    updatedAt: '2026-04-13T09:32:00.000Z',
  },
]

export function createDefaultBootstrap(): AppBootstrap {
  return {
    schemaVersion: 2,
    sessions: [],
    sessionFolders: [],
    macros: DEFAULT_MACROS.map((item) => ({ ...item })),
    preferences: { ...DEFAULT_PREFERENCES },
  }
}
