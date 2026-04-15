import { Plus, Play, Search, Terminal } from 'lucide-react'

interface TopBarProps {
  activeTabTitle: string
  onCreateSession: () => void
  onCreateMacro: () => void
}

const MENU_ITEMS = ['Terminal', 'Sessions', 'View', 'Tools', 'Macros', 'Help']

export function TopBar({ activeTabTitle, onCreateSession, onCreateMacro }: TopBarProps) {
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-menubar" data-tauri-drag-region>
        <div className="topbar-menuitems">
          {MENU_ITEMS.map((item) => (
            <button key={item} className="topbar-menuitem" type="button">
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="topbar-toolbar">
        <div className="topbar-actions">
          <button className="chrome-action" type="button" onClick={onCreateSession}>
            <Plus size={14} />
          </button>
          <button className="chrome-action" type="button" onClick={onCreateMacro}>
            <Terminal size={14} />
          </button>
          <button className="chrome-action" type="button">
            <Search size={14} />
          </button>
          <button className="chrome-action accent" type="button">
            <Play size={14} />
          </button>
        </div>

        <div className="topbar-breadcrumb">{activeTabTitle}</div>
      </div>
    </header>
  )
}
