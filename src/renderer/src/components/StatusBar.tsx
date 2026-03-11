import { useAppStore } from '../stores/appStore'

export default function StatusBar() {
  const { statusMessage, isGitRepo, gitStatus, activeTab, compiling } = useAppStore()

  const lineInfo = activeTab ? activeTab.split('/').pop() : ''

  return (
    <div className="status-bar">
      <div className="status-left">
        {compiling && <span className="status-compiling">Compiling</span>}
        <span className="status-message">{statusMessage}</span>
      </div>
      <div className="status-right">
        {isGitRepo && (
          <span className="status-git">
            Git{gitStatus ? ` (${gitStatus.split('\n').filter(Boolean).length} changes)` : ' (clean)'}
          </span>
        )}
        {lineInfo && <span className="status-file">{lineInfo}</span>}
        <span className="status-encoding">UTF-8</span>
        <span className="status-lang">LaTeX</span>
      </div>
    </div>
  )
}
