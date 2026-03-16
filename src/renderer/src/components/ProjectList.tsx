// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '../stores/appStore'

interface OverleafProject {
  id: string
  name: string
  lastUpdated: string
  owner?: { firstName: string; lastName: string; email?: string }
  lastUpdatedBy?: { firstName: string; lastName: string } | null
  accessLevel?: string
  source?: string
}

type SortKey = 'lastUpdated' | 'name' | 'owner'
type SortOrder = 'asc' | 'desc'

interface Props {
  onOpenProject: (projectId: string) => void
}

export default function ProjectList({ onOpenProject }: Props) {
  const [projects, setProjects] = useState<OverleafProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchFilter, setSearchFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyText, setBusyText] = useState('')
  const [sortBy, setSortBy] = useState<SortKey>('lastUpdated')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('Untitled Project')
  const [showApiKeys, setShowApiKeys] = useState(false)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [apiKeysVisible, setApiKeysVisible] = useState<Record<string, boolean>>({})
  const { setStatusMessage } = useAppStore()

  const loadProjects = useCallback(async () => {
    setLoading(true)
    setError('')
    const result = await window.api.overleafListProjects()
    setLoading(false)
    if (result.success && result.projects) {
      setProjects(result.projects)
    } else {
      setError(result.message || 'Failed to load projects')
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  const handleOpen = async (pid: string) => {
    setError('')
    setBusy(true)
    setBusyText('Connecting to project...')
    setStatusMessage('Connecting...')

    const result = await window.api.otConnect(pid)
    setBusy(false)

    if (result.success) {
      const store = useAppStore.getState()
      if (result.files) store.setFiles(result.files as any)
      if (result.project) store.setOverleafProject(result.project)
      if (result.docPathMap && result.pathDocMap) store.setDocMaps(result.docPathMap, result.pathDocMap)
      if (result.fileRefs) store.setFileRefs(result.fileRefs)
      if (result.rootFolderId) store.setRootFolderId(result.rootFolderId)
      store.setOverleafProjectId(pid)
      store.setConnectionState('connected')
      if (result.syncDir) store.setSyncDir(result.syncDir)
      if (result.cachedPdfPath) store.setPdfPath(result.cachedPdfPath)
      setStatusMessage('Connected')
      onOpenProject(pid)
    } else {
      setStatusMessage('Connection failed')
      setError(result.message || 'Failed to connect')
    }
  }

  const handleCreateProject = async () => {
    const name = newProjectName.trim()
    if (!name) return

    setShowNewProject(false)
    setError('')
    setBusy(true)
    setBusyText('Creating project...')

    const result = await window.api.overleafCreateProject(name)
    setBusy(false)

    if (result.success && result.projectId) {
      setStatusMessage(`Created "${name}"`)
      setNewProjectName('Untitled Project')
      loadProjects()
    } else {
      setError(result.message || 'Failed to create project')
    }
  }

  const handleUploadProject = async () => {
    setError('')
    setBusy(true)
    setBusyText('Uploading project...')

    const result = await window.api.overleafUploadProject()
    setBusy(false)

    if (result.success && result.projectId) {
      setStatusMessage('Project uploaded')
      loadProjects()
    } else if (result.message === 'cancelled') {
      // user cancelled file dialog
    } else {
      setError(result.message || 'Failed to upload project')
    }
  }

  const handleLogout = async () => {
    await window.api.otDisconnect()
    useAppStore.getState().resetEditorState()
    useAppStore.getState().setScreen('login')
  }

  const openApiKeys = async () => {
    const keys = await window.api.getApiKeys()
    setApiKeys(keys)
    setApiKeysVisible({})
    setShowApiKeys(true)
  }

  const saveApiKeys = async () => {
    // Strip empty keys before saving
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(apiKeys)) {
      if (v.trim()) cleaned[k] = v.trim()
    }
    await window.api.setApiKeys(cleaned)
    setShowApiKeys(false)
    setStatusMessage('API keys saved')
  }

  const API_KEY_FIELDS = [
    { id: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
    { id: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
    { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
    { id: 'gemini', label: 'Google Gemini', placeholder: 'AIza...' },
    { id: 'semanticScholar', label: 'Semantic Scholar', placeholder: 'API key (optional, avoids rate limits)' }
  ]

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(key)
      setSortOrder(key === 'name' ? 'asc' : 'desc')
    }
  }

  const ownerName = (p: OverleafProject) => {
    if (!p.owner) return ''
    return `${p.owner.firstName} ${p.owner.lastName}`.trim()
  }

  const sortedAndFiltered = useMemo(() => {
    let list = projects.filter((p) =>
      p.name.toLowerCase().includes(searchFilter.toLowerCase())
    )

    list.sort((a, b) => {
      let cmp = 0
      if (sortBy === 'lastUpdated') {
        cmp = new Date(a.lastUpdated).getTime() - new Date(b.lastUpdated).getTime()
      } else if (sortBy === 'name') {
        cmp = a.name.localeCompare(b.name)
      } else if (sortBy === 'owner') {
        cmp = ownerName(a).localeCompare(ownerName(b))
      }
      return sortOrder === 'asc' ? cmp : -cmp
    })

    return list
  }, [projects, searchFilter, sortBy, sortOrder])

  const formatDate = (d: string) => {
    if (!d) return ''
    try {
      const date = new Date(d)
      if (isNaN(date.getTime())) return ''
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffDays = Math.floor(diffMs / 86400000)
      if (diffDays === 0) {
        const diffH = Math.floor(diffMs / 3600000)
        if (diffH === 0) {
          const diffM = Math.floor(diffMs / 60000)
          return diffM <= 1 ? 'Just now' : `${diffM}m ago`
        }
        return `${diffH}h ago`
      }
      if (diffDays === 1) return 'Yesterday'
      if (diffDays < 7) return `${diffDays}d ago`
      if (diffDays < 365) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    } catch { return '' }
  }

  const personName = (p?: { firstName: string; lastName: string } | null) => {
    if (!p) return ''
    return `${p.firstName} ${p.lastName}`.trim()
  }

  const accessLabel = (level?: string) => {
    switch (level) {
      case 'owner': return 'Owner'
      case 'readAndWrite': return 'Can edit'
      case 'readOnly': return 'View only'
      default: return level || ''
    }
  }

  const sortIndicator = (key: SortKey) => {
    if (sortBy !== key) return ''
    return sortOrder === 'asc' ? ' ↑' : ' ↓'
  }

  return (
    <div className="projects-page">
      <div className="projects-drag-bar" />
      <div className="projects-container">
        <div className="projects-header">
          <h1>Latte<span className="lattex-x">X</span></h1>
          <div className="projects-header-actions">
            <button className="btn btn-secondary btn-sm" onClick={openApiKeys}>
              API Keys
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </div>

        {error && <div className="overleaf-error" style={{ margin: '0 0 16px' }}>{error}</div>}

        {busy ? (
          <div className="projects-busy">
            <div className="overleaf-spinner" />
            <div className="overleaf-log">{busyText}</div>
          </div>
        ) : (
          <>
            <div className="projects-toolbar">
              <input
                className="projects-search"
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Search projects..."
                autoFocus
              />
              <button className="btn btn-primary btn-sm" onClick={() => setShowNewProject(true)}>
                New Project
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleUploadProject}>
                Upload
              </button>
              <button className="btn btn-secondary btn-sm" onClick={loadProjects} title="Refresh">
                {loading ? '...' : '↻'}
              </button>
            </div>

            <div className="projects-table-header">
              <span className="projects-col-name" onClick={() => toggleSort('name')}>
                Name{sortIndicator('name')}
              </span>
              <span className="projects-col-owner" onClick={() => toggleSort('owner')}>
                Owner{sortIndicator('owner')}
              </span>
              <span className="projects-col-updated" onClick={() => toggleSort('lastUpdated')}>
                Last Modified{sortIndicator('lastUpdated')}
              </span>
            </div>

            <div className="projects-list">
              {loading && projects.length === 0 ? (
                <div className="projects-empty">Loading projects...</div>
              ) : sortedAndFiltered.length === 0 ? (
                <div className="projects-empty">
                  {searchFilter ? 'No matching projects' : 'No projects yet'}
                </div>
              ) : (
                sortedAndFiltered.map((p) => (
                  <div
                    key={p.id}
                    className="projects-item"
                    onClick={() => handleOpen(p.id)}
                  >
                    <div className="projects-col-name">
                      <span className="projects-item-name">{p.name}</span>
                      {p.accessLevel && p.accessLevel !== 'owner' && (
                        <span className="projects-access-badge">{accessLabel(p.accessLevel)}</span>
                      )}
                    </div>
                    <div className="projects-col-owner">
                      {personName(p.owner)}
                    </div>
                    <div className="projects-col-updated">
                      <span className="projects-date">{formatDate(p.lastUpdated)}</span>
                      {p.lastUpdatedBy && (
                        <span className="projects-updated-by">by {personName(p.lastUpdatedBy)}</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
      {showNewProject && (
        <div className="modal-overlay" onClick={() => setShowNewProject(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px' }}>New Project</h3>
            <input
              type="text"
              className="projects-search"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateProject()
                if (e.key === 'Escape') setShowNewProject(false)
              }}
              autoFocus
              style={{ width: '100%', marginBottom: 12 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowNewProject(false)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={handleCreateProject}>Create</button>
            </div>
          </div>
        </div>
      )}
      {showApiKeys && (
        <div className="modal-overlay" onClick={() => setShowApiKeys(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ minWidth: 460 }}>
            <h3 style={{ margin: '0 0 4px' }}>API Keys</h3>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-secondary)' }}>
              Keys are stored locally on this device.
            </p>
            {API_KEY_FIELDS.map((field) => (
              <div key={field.id} style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4, color: 'var(--text-secondary)' }}>
                  {field.label}
                </label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    type={apiKeysVisible[field.id] ? 'text' : 'password'}
                    className="modal-input"
                    value={apiKeys[field.id] || ''}
                    onChange={(e) => setApiKeys({ ...apiKeys, [field.id]: e.target.value })}
                    placeholder={field.placeholder}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setApiKeysVisible({ ...apiKeysVisible, [field.id]: !apiKeysVisible[field.id] })}
                    style={{ flexShrink: 0, padding: '6px 8px', fontSize: 11 }}
                    title={apiKeysVisible[field.id] ? 'Hide' : 'Show'}
                  >
                    {apiKeysVisible[field.id] ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowApiKeys(false)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={saveApiKeys}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
