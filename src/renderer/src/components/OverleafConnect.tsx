import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/appStore'

interface Props {
  onConnected: (projectPath: string) => void
  onCancel: () => void
}

export default function OverleafConnect({ onConnected, onCancel }: Props) {
  const [projectUrl, setProjectUrl] = useState('')
  const [token, setToken] = useState('')
  const [hasStoredToken, setHasStoredToken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyText, setBusyText] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [error, setError] = useState('')
  const { setStatusMessage } = useAppStore()

  // Check if we already have stored credentials
  useEffect(() => {
    window.api.overleafCheck().then(({ loggedIn }) => {
      if (loggedIn) setHasStoredToken(true)
    })
  }, [])

  const extractProjectId = (url: string): string | null => {
    const cleaned = url.trim()
    if (!cleaned) return null
    const patterns = [
      /overleaf\.com\/project\/([a-zA-Z0-9]+)/,
      /overleaf\.com\/read\/([a-zA-Z0-9]+)/,
      /git\.overleaf\.com\/([a-zA-Z0-9]+)/,
      /^([a-zA-Z0-9]{10,})$/,
    ]
    for (const p of patterns) {
      const m = cleaned.match(p)
      if (m) return m[1]
    }
    return null
  }

  const projectId = extractProjectId(projectUrl)

  const handleClone = async () => {
    if (!projectUrl.trim()) {
      setError('Please paste an Overleaf project URL'); return
    }
    if (!projectId) {
      setError('Could not find project ID in this URL.\nExpected: https://www.overleaf.com/project/abc123...'); return
    }
    if (!token.trim()) {
      setError('Please enter your Git Authentication Token'); return
    }

    setError('')
    setBusy(true)
    setBusyText('Choose where to save...')
    setStatusMessage('Connecting to Overleaf...')

    const parentDir = await window.api.selectSaveDir()
    if (!parentDir) {
      setBusy(false)
      return
    }
    const dest = parentDir + '/overleaf-' + projectId

    setBusyText('Verifying token & cloning...')

    const result = await window.api.overleafCloneWithAuth(projectId, dest, token.trim(), rememberMe)

    setBusy(false)

    if (result.success) {
      setStatusMessage('Cloned successfully')
      onConnected(dest)
    } else {
      setStatusMessage('Clone failed')
      setError(result.detail || 'Unknown error')
    }
  }

  const handleClearToken = async () => {
    await window.api.overleafLogout()
    setHasStoredToken(false)
    setToken('')
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="overleaf-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="overleaf-header">
          <h2>Clone from Overleaf</h2>
          <button className="overleaf-close" onClick={onCancel}>x</button>
        </div>

        {error && <div className="overleaf-error">{error}</div>}

        {busy ? (
          <div className="overleaf-body">
            <div className="overleaf-cloning">
              <div className="overleaf-spinner" />
              <div className="overleaf-log">{busyText}</div>
            </div>
          </div>
        ) : (
          <div className="overleaf-body">
            {/* Project URL */}
            <label className="overleaf-label">Project URL</label>
            <input
              className="modal-input"
              type="text"
              value={projectUrl}
              onChange={(e) => { setProjectUrl(e.target.value); setError('') }}
              placeholder="https://www.overleaf.com/project/..."
              autoFocus
            />
            <div className="overleaf-help">
              Copy from your browser address bar, or from Overleaf Menu &rarr; Sync &rarr; Git.
            </div>
            {projectId && (
              <div className="overleaf-id-preview">
                Project ID: <code>{projectId}</code>
              </div>
            )}

            {/* Token */}
            <div className="overleaf-section-title" style={{ marginTop: 20 }}>
              Git Authentication Token
              {hasStoredToken && (
                <span className="overleaf-saved-hint">
                  (saved in Keychain — <button className="overleaf-link-btn" onClick={handleClearToken}>clear</button>)
                </span>
              )}
            </div>
            <input
              className="modal-input"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="olp_..."
              onKeyDown={(e) => { if (e.key === 'Enter') handleClone() }}
            />
            <label className="overleaf-checkbox">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              Remember token (saved in macOS Keychain)
            </label>

            <div className="overleaf-help">
              Generate at{' '}
              <span className="overleaf-link" onClick={() => window.api.openExternal('https://www.overleaf.com/user/settings')}>
                Overleaf Account Settings
              </span>
              {' '}&rarr; Git Integration. Requires premium.
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
              <button className="btn btn-primary" onClick={handleClone}>
                Verify & Clone
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
