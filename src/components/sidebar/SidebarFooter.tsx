interface SidebarFooterProps {
  canFollowRemoteTerminal: boolean
  followedSftpPath?: string
  followRemoteTerminal: boolean
  onFollowRemoteTerminalChange: (enabled: boolean) => void
}

export function SidebarFooter({
  canFollowRemoteTerminal,
  followedSftpPath,
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
        {followRemoteTerminal && followedSftpPath ? (
          <span className="sidebar-follow-path" title={followedSftpPath}>
            {followedSftpPath}
          </span>
        ) : null}
      </label>
    </div>
  )
}
