import { Pencil, Play, Terminal, Trash2 } from 'lucide-react'

import type { MacroDefinition } from '../../types/domain'

interface MacrosSectionProps {
  macros: MacroDefinition[]
  onDeleteMacro: (macroId: string) => void
  onEditMacro: (macro: MacroDefinition) => void
  onNewMacro: () => void
  onRunMacro: (command: string) => void
}

export function MacrosSection({
  macros,
  onDeleteMacro,
  onEditMacro,
  onNewMacro,
  onRunMacro,
}: MacrosSectionProps) {
  return (
    <>
      <div className="sidebar-header">
        <span>Macros</span>
        <button className="sidebar-header-button" type="button" onClick={onNewMacro}>
          New
        </button>
      </div>
      <div className="sidebar-list">
        {macros.map((macro) => (
          <div key={macro.id} className="sidebar-row">
            <div className="sidebar-row-main">
              <span className="sidebar-row-icon">
                <Terminal size={13} />
              </span>
              <div className="sidebar-row-copy">
                <strong>{macro.name}</strong>
                <span>{macro.command}</span>
              </div>
            </div>
            <div className="sidebar-row-actions">
              <button type="button" onClick={() => onRunMacro(macro.command)}>
                <Play size={12} />
              </button>
              <button type="button" onClick={() => onEditMacro(macro)}>
                <Pencil size={12} />
              </button>
              <button type="button" onClick={() => onDeleteMacro(macro.id)}>
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
