interface SidebarFooterProps {
  canFollowRemoteTerminal: boolean
  followRemoteTerminal: boolean
  onFollowRemoteTerminalChange: (enabled: boolean) => void
}

export function SidebarFooter({
  canFollowRemoteTerminal,
  followRemoteTerminal,
  onFollowRemoteTerminalChange,
}: SidebarFooterProps) {
  return (
    <div className="sidebar-footer">
      <label className="sidebar-follow-toggle">
        <input
          type="checkbox"
          checked={followRemoteTerminal}
          disabled={!canFollowRemoteTerminal}
          onChange={(event) => onFollowRemoteTerminalChange(event.target.checked)}
        />
        <span>follow remote terminal</span>
      </label>
    </div>
  )
}
