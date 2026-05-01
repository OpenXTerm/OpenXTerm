import type { ReactNode } from 'react'
import { Bot, FolderTree, HardDrive, Wrench } from 'lucide-react'

import type { SidebarSection } from '../../types/domain'

interface SidebarRailProps {
  activeSection: SidebarSection
  hasSftpLinks: boolean
  onSelectSection: (section: SidebarSection) => void
}

export function SidebarRail({ activeSection, hasSftpLinks, onSelectSection }: SidebarRailProps) {
  return (
    <div className="sidebar-rail">
      <RailButton
        active={activeSection === 'sessions'}
        icon={<FolderTree size={14} />}
        label="Sessions"
        onClick={() => onSelectSection('sessions')}
      />
      {hasSftpLinks && (
        <RailButton
          active={activeSection === 'sftp'}
          icon={<HardDrive size={14} />}
          label="SFTP"
          onClick={() => onSelectSection('sftp')}
        />
      )}
      <RailButton
        active={activeSection === 'tools'}
        icon={<Wrench size={14} />}
        label="Tools"
        onClick={() => onSelectSection('tools')}
      />
      <RailButton
        active={activeSection === 'macros'}
        icon={<Bot size={14} />}
        label="Macros"
        onClick={() => onSelectSection('macros')}
      />
    </div>
  )
}

interface RailButtonProps {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}

function RailButton({ active, icon, label, onClick }: RailButtonProps) {
  return (
    <button className={`rail-button ${active ? 'active' : ''}`} type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  )
}
