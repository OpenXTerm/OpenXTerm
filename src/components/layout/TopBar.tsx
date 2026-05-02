import { useEffect, useRef, useState } from 'react'

import type { MenuAction } from '../../types/domain'

interface TopBarProps {
  onMenuAction: (action: MenuAction) => void
}

interface TopBarMenu {
  label: string
  items: Array<{
    label: string
    action: MenuAction
  }>
}

const MENUS: TopBarMenu[] = [
  {
    label: 'OpenXTerm',
    items: [
      { label: 'Settings...', action: 'open-settings' },
      { label: 'Lock OpenXTerm', action: 'lock-app' },
    ],
  },
  {
    label: 'Terminal',
    items: [
      { label: 'New Session', action: 'new-session' },
      { label: 'New Macro', action: 'new-macro' },
      { label: 'Search in Terminal', action: 'search-terminal' },
      { label: 'Clear Terminal', action: 'clear-terminal' },
      { label: 'Reset Terminal', action: 'reset-terminal' },
      { label: 'Lock OpenXTerm', action: 'lock-app' },
    ],
  },
  {
    label: 'Sessions',
    items: [
      { label: 'Show Sessions', action: 'show-sessions' },
      { label: 'Show SFTP', action: 'show-sftp' },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Show Sessions', action: 'show-sessions' },
      { label: 'Show SFTP', action: 'show-sftp' },
      { label: 'Show Tools', action: 'show-tools' },
      { label: 'Show Macros', action: 'show-macros' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { label: 'Open Tools', action: 'show-tools' },
    ],
  },
  {
    label: 'Macros',
    items: [
      { label: 'New Macro', action: 'new-macro' },
      { label: 'Show Macros', action: 'show-macros' },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: 'Open Sessions', action: 'show-sessions' },
    ],
  },
]

export function TopBar({ onMenuAction }: TopBarProps) {
  const [openMenuLabel, setOpenMenuLabel] = useState<string | null>(null)
  const menubarRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!menubarRef.current?.contains(event.target as Node)) {
        setOpenMenuLabel(null)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpenMenuLabel(null)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  function handleMenuItemClick(label: string) {
    setOpenMenuLabel((current) => current === label ? null : label)
  }

  function handleAction(action: MenuAction) {
    setOpenMenuLabel(null)
    onMenuAction(action)
  }

  return (
    <header className="topbar">
      <div className="topbar-menubar">
        <div ref={menubarRef} className="topbar-menuitems">
          {MENUS.map((menu) => {
            const expanded = openMenuLabel === menu.label
            return (
              <div
                key={menu.label}
                className="topbar-menu-group"
                onMouseEnter={() => {
                  if (openMenuLabel) {
                    setOpenMenuLabel(menu.label)
                  }
                }}
              >
                <button
                  className={`topbar-menuitem ${expanded ? 'active' : ''}`}
                  type="button"
                  aria-expanded={expanded}
                  aria-haspopup="menu"
                  onClick={() => handleMenuItemClick(menu.label)}
                >
                  {menu.label}
                </button>
                {expanded && (
                  <div className="topbar-dropdown" role="menu" aria-label={menu.label}>
                    {menu.items.map((item) => (
                      <button
                        key={`${menu.label}:${item.action}:${item.label}`}
                        className="topbar-dropdown-item"
                        type="button"
                        role="menuitem"
                        onClick={() => handleAction(item.action)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </header>
  )
}
