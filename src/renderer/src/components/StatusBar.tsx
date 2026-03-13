// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useAppStore } from '../stores/appStore'

export default function StatusBar() {
  const { statusMessage, activeTab, compiling, connectionState, onlineUsersCount } = useAppStore()

  const lineInfo = activeTab ? activeTab.split('/').pop() : ''

  const connectionLabel = connectionState === 'connected' ? 'Connected'
    : connectionState === 'connecting' ? 'Connecting...'
    : connectionState === 'reconnecting' ? 'Reconnecting...'
    : 'Disconnected'

  const connectionDot = connectionState === 'connected' ? 'connection-dot-green'
    : connectionState === 'connecting' || connectionState === 'reconnecting' ? 'connection-dot-yellow'
    : 'connection-dot-red'

  return (
    <div className="status-bar">
      <div className="status-left">
        {compiling && <span className="status-compiling">Compiling</span>}
        <span className="status-message">{statusMessage}</span>
      </div>
      <div className="status-right">
        <span className="status-connection">
          <span className={`connection-dot ${connectionDot}`} />
          {connectionLabel}
          {onlineUsersCount > 0 && ` (${onlineUsersCount + 1})`}
        </span>
        {lineInfo && <span className="status-file">{lineInfo}</span>}
        <span className="status-encoding">UTF-8</span>
        <span className="status-lang">LaTeX</span>
      </div>
    </div>
  )
}
