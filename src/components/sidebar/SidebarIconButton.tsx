import type { ReactNode } from 'react'

interface SidebarIconButtonProps {
  accent: 'danger' | 'folder' | 'success' | 'transfer'
  disabled?: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}

export function SidebarIconButton({ accent, disabled, icon, label, onClick }: SidebarIconButtonProps) {
  return (
    <button
      className={`sidebar-icon-button ${accent}`}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}
