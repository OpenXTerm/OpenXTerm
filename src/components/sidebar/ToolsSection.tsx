import { Wrench } from 'lucide-react'

const tools = [
  { name: 'Port Scanner', note: 'Reserved for the next transport pass.' },
  { name: 'Ping', note: 'Quick latency and packet-loss checks.' },
  { name: 'Network Tools', note: 'DNS, traceroute and capture helpers.' },
]

export function ToolsSection() {
  return (
    <>
      <div className="sidebar-header">
        <span>Tools</span>
        <span className="sidebar-caption">Placeholders</span>
      </div>
      <div className="sidebar-list">
        {tools.map((tool) => (
          <button key={tool.name} className="tool-row" type="button" disabled>
            <div className="tool-row-icon">
              <Wrench size={14} />
            </div>
            <div className="tool-row-copy">
              <strong>{tool.name}</strong>
              <span>{tool.note}</span>
            </div>
          </button>
        ))}
      </div>
    </>
  )
}
