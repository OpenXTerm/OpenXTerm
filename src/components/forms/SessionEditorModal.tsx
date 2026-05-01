import { useEffect, useMemo, useState } from 'react'
import {
  FolderTree,
  Palette,
  Server,
  Settings2,
} from 'lucide-react'

import { inspectLocalX11Support, listSystemFontFamilies } from '../../lib/bridge'
import type { LocalX11Support, SessionDefinition, SessionDraft } from '../../types/domain'
import {
  SessionEditorAdvancedTab,
  SessionEditorConnectionTab,
  SessionEditorGeneralTab,
  SessionEditorTerminalTab,
} from './SessionEditorTabs'
import {
  createDraft,
  supportsAdvancedTab,
  supportsConnectionTab,
  tabDescription,
  type SessionEditorTab,
} from './sessionEditorHelpers'

interface SessionEditorModalProps {
  open: boolean
  session: SessionDefinition | null
  initialFolderPath?: string
  folderOptions: string[]
  onClose: () => void
  onSave: (draft: SessionDraft) => Promise<void>
}

const EDITOR_TABS: Array<{
  id: SessionEditorTab
  label: string
  icon: typeof Settings2
}> = [
  { id: 'general', label: 'General', icon: FolderTree },
  { id: 'connection', label: 'Connection', icon: Server },
  { id: 'terminal', label: 'Terminal', icon: Palette },
  { id: 'advanced', label: 'Advanced', icon: Settings2 },
]

export function SessionEditorModal({
  open,
  session,
  initialFolderPath,
  folderOptions,
  onClose,
  onSave,
}: SessionEditorModalProps) {
  const isMacOS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
  const [draft, setDraft] = useState<SessionDraft>(createDraft(session, initialFolderPath))
  const [activeTab, setActiveTab] = useState<SessionEditorTab>('general')
  const [x11Support, setX11Support] = useState<LocalX11Support | null>(null)
  const [x11SupportBusy, setX11SupportBusy] = useState(false)
  const [x11SupportError, setX11SupportError] = useState('')
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  const [systemFontsBusy, setSystemFontsBusy] = useState(false)
  const [systemFontsError, setSystemFontsError] = useState('')

  const normalizedFolderOptions = useMemo(
    () =>
      Array.from(new Set([...(draft.folderPath ? [draft.folderPath] : []), ...folderOptions])).sort((left, right) =>
        left.localeCompare(right),
      ),
    [draft.folderPath, folderOptions],
  )

  useEffect(() => {
    if (!open) {
      return
    }

    setDraft(createDraft(session, initialFolderPath))
    setActiveTab('general')
    setX11Support(null)
    setX11SupportBusy(false)
    setX11SupportError('')
    setSystemFonts([])
    setSystemFontsBusy(false)
    setSystemFontsError('')
  }, [initialFolderPath, open, session])

  useEffect(() => {
    if (!open) {
      return
    }

    let disposed = false
    setSystemFontsBusy(true)
    setSystemFontsError('')

    void listSystemFontFamilies()
      .then((fonts) => {
        if (disposed) {
          return
        }
        setSystemFonts(fonts)
      })
      .catch((error) => {
        if (disposed) {
          return
        }
        setSystemFonts([])
        setSystemFontsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!disposed) {
          setSystemFontsBusy(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [open])

  useEffect(() => {
    if (activeTab === 'connection' && !supportsConnectionTab(draft.kind)) {
      setActiveTab('general')
      return
    }
    if (activeTab === 'advanced' && !supportsAdvancedTab(draft.kind)) {
      setActiveTab('general')
    }
  }, [activeTab, draft.kind])

  useEffect(() => {
    if (!open || draft.kind !== 'ssh' || !draft.x11Forwarding) {
      return
    }

    let disposed = false
    setX11SupportBusy(true)
    setX11SupportError('')

    void inspectLocalX11Support(draft.x11Display.trim() || undefined)
      .then((payload) => {
        if (!disposed) {
          setX11Support(payload)
        }
      })
      .catch((error) => {
        if (!disposed) {
          setX11Support(null)
          setX11SupportError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!disposed) {
          setX11SupportBusy(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [draft.kind, draft.x11Display, draft.x11Forwarding, open])

  if (!open) {
    return null
  }

  const x11DisplayPlaceholder =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
      ? '127.0.0.1:0.0'
      : 'Auto-detect from DISPLAY'
  const x11NeedsInstallHelp = draft.x11Forwarding && x11Support !== null && !x11Support.systemX11Available
  const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
  const recommendedGuiHelperName = isMacOS ? 'XQuartz' : isWindows ? 'VcXsrv' : 'X.Org'
  const recommendedGuiHelperUrl = isMacOS
    ? 'https://www.xquartz.org/'
    : isWindows
      ? 'https://vcxsrv.com/'
      : 'https://www.x.org/wiki/'
  const visibleTabs = EDITOR_TABS.filter((tab) => {
    if (tab.id === 'connection') {
      return supportsConnectionTab(draft.kind)
    }
    if (tab.id === 'advanced') {
      return supportsAdvancedTab(draft.kind)
    }
    return true
  })

  async function handleCheckX11Support() {
    setX11SupportBusy(true)
    setX11SupportError('')

    try {
      const payload = await inspectLocalX11Support(draft.x11Display.trim() || undefined)
      setX11Support(payload)
    } catch (error) {
      setX11Support(null)
      setX11SupportError(error instanceof Error ? error.message : String(error))
    } finally {
      setX11SupportBusy(false)
    }
  }

  function updateDraft(patch: Partial<SessionDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
  }

  function renderGeneralTab() {
    return (
      <SessionEditorGeneralTab
        draft={draft}
        normalizedFolderOptions={normalizedFolderOptions}
        updateDraft={updateDraft}
      />
    )
  }

  function renderConnectionTab() {
    return (
      <SessionEditorConnectionTab
        draft={draft}
        updateDraft={updateDraft}
      />
    )
  }

  function renderTerminalTab() {
    return (
      <SessionEditorTerminalTab
        draft={draft}
        systemFonts={systemFonts}
        systemFontsBusy={systemFontsBusy}
        systemFontsError={systemFontsError}
        updateDraft={updateDraft}
      />
    )
  }

  function renderAdvancedTab() {
    return (
      <SessionEditorAdvancedTab
        draft={draft}
        isMacOS={isMacOS}
        recommendedGuiHelperName={recommendedGuiHelperName}
        recommendedGuiHelperUrl={recommendedGuiHelperUrl}
        x11DisplayPlaceholder={x11DisplayPlaceholder}
        x11NeedsInstallHelp={x11NeedsInstallHelp}
        x11Support={x11Support}
        x11SupportBusy={x11SupportBusy}
        x11SupportError={x11SupportError}
        onCheckX11Support={() => void handleCheckX11Support()}
        updateDraft={updateDraft}
      />
    )
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-panel session-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-heading">
            <p className="modal-eyebrow">Session</p>
            <h2 id="session-editor-title">{session ? 'Edit session' : 'New session'}</h2>
            <p className="modal-subtitle">
              Compact editor for connection details and per-session terminal style.
            </p>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <form
          className="editor-form"
          onSubmit={(event) => {
            event.preventDefault()
            void onSave(draft)
          }}
        >
          <div className="session-editor-tabstrip" role="tablist" aria-label="Session settings tabs">
            {visibleTabs.map((tab) => {
              const Icon = tab.icon
              const selected = tab.id === activeTab
              return (
                <button
                  key={tab.id}
                  className={`session-editor-tab ${selected ? 'active' : ''}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon size={14} />
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </div>

          <div className="session-editor-tab-meta">
            <strong>{visibleTabs.find((tab) => tab.id === activeTab)?.label}</strong>
            <span>{tabDescription(activeTab, draft.kind)}</span>
          </div>

          {activeTab === 'general' && renderGeneralTab()}
          {activeTab === 'connection' && renderConnectionTab()}
          {activeTab === 'terminal' && renderTerminalTab()}
          {activeTab === 'advanced' && renderAdvancedTab()}

          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="solid-button" type="submit">
              Save session
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
