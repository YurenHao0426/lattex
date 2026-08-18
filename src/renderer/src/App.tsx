// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useState, useEffect, useCallback, useRef, Component, type ReactNode } from 'react'
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels'
import { useAppStore } from './stores/appStore'
import ModalProvider from './components/ModalProvider'
import ProjectList from './components/ProjectList'
import Toolbar from './components/Toolbar'
import FileTree from './components/FileTree'
import OutlineView from './components/OutlineView'
import Editor from './components/Editor'
import PdfViewer from './components/PdfViewer'
import Terminal from './components/Terminal'
import ReviewPanel from './components/ReviewPanel'
import ChatPanel from './components/ChatPanel'
import SearchPanel from './components/SearchPanel'
import StatusBar from './components/StatusBar'
import type { OverleafDocSync } from './ot/overleafSync'
import { colorForUser, type RemoteCursor } from './extensions/remoteCursors'
import {
  startAutocompleteSync,
  stopAutocompleteSync,
  scheduleAutocompleteRefresh,
} from './extensions/latexAutocomplete'
import {
  applyEntityCreated,
  applyEntityMoved,
  applyEntityRemoved,
  applyEntityRenamed,
} from './utils/projectEntitySync'

export const activeDocSyncs = new Map<string, OverleafDocSync>()

// Global remote cursor state — shared between App and Editor
export const remoteCursors = new Map<string, RemoteCursor & { docId: string }>()

// Set when this window was opened for a specific project (browser-tab model:
// the list window opens each project in its own window via ?projectId=)
const initialProjectId = new URLSearchParams(window.location.search).get('projectId')

/** Update-available card (home renderer only). Checks GitHub Releases once
 *  per launch; "Skip this version" is remembered in localStorage. */
function UpdateToast() {
  const [info, setInfo] = useState<{
    version: string
    releaseUrl: string
    assetName?: string
    assetUrl?: string
    assetSize?: number
  } | null>(null)
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle')

  useEffect(() => {
    window.api.updateCheck().then((r) => {
      if (!r.available || !r.version) return
      if (localStorage.getItem('lattex-skip-version') === r.version) return
      setInfo({
        version: r.version,
        releaseUrl: r.releaseUrl || 'https://github.com/YurenHao0426/lattex/releases',
        assetName: r.assetName,
        assetUrl: r.assetUrl,
        assetSize: r.assetSize
      })
    }).catch(() => {})
  }, [])

  if (!info) return null

  const sizeMb = info.assetSize ? ` (${(info.assetSize / 1024 / 1024).toFixed(0)} MB)` : ''

  const download = async () => {
    if (!info.assetUrl || !info.assetName) {
      // No installer for this platform in the release — open the page
      window.api.openExternal(info.releaseUrl)
      return
    }
    setPhase('downloading')
    const r = await window.api.updateDownload(info.assetUrl, info.assetName)
    setPhase(r.success ? 'done' : 'error')
  }

  return (
    <div className="update-toast">
      <div className="update-toast-title">
        Update available: v{info.version}
        <button className="update-toast-link" onClick={() => window.api.openExternal(info.releaseUrl)}>
          release notes
        </button>
      </div>
      {phase === 'done' ? (
        <div className="update-toast-body">
          Installer opened — quit LatteX and replace the app to finish updating.
        </div>
      ) : phase === 'error' ? (
        <div className="update-toast-body">
          Download failed — you can get it from the releases page instead.
        </div>
      ) : (
        <div className="update-toast-actions">
          <button className="btn btn-primary btn-sm" onClick={download} disabled={phase === 'downloading'}>
            {phase === 'downloading' ? 'Downloading…' : `Download${sizeMb}`}
          </button>
          <button className="btn btn-sm" onClick={() => setInfo(null)}>Later</button>
          <button
            className="btn btn-sm"
            onClick={() => {
              localStorage.setItem('lattex-skip-version', info.version)
              setInfo(null)
            }}
          >
            Skip this version
          </button>
        </div>
      )}
      {(phase === 'done' || phase === 'error') && (
        <div className="update-toast-actions">
          <button className="btn btn-sm" onClick={() => setInfo(null)}>Dismiss</button>
          {phase === 'error' && (
            <button className="btn btn-sm" onClick={() => window.api.openExternal(info.releaseUrl)}>
              Open releases page
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Browser-style tab strip: persistent home tab + one tab per open project.
 *  Rendered by the home renderer only, in the top TAB_BAR_HEIGHT (38px) strip
 *  that project views never cover. Hidden entirely when no project is open. */
function TabBar({ tabs, active }: { tabs: Array<{ id: string; title: string }>; active: string }) {
  const isMac = navigator.platform.toLowerCase().includes('mac')
  return (
    <div className={`wt-bar${isMac ? ' wt-bar-mac' : ''}`}>
      <button
        className={`wt-tab wt-home${active === 'home' ? ' active' : ''}`}
        onClick={() => window.api.tabsActivate('home')}
        title="Projects"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
        </svg>
        <span className="wt-tab-title">Projects</span>
      </button>
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`wt-tab${active === t.id ? ' active' : ''}`}
          onClick={() => window.api.tabsActivate(t.id)}
        >
          <span className="wt-tab-title">{t.title}</span>
          <button
            className="wt-tab-close"
            title="Close project"
            onClick={(ev) => {
              ev.stopPropagation()
              window.api.tabsClose(t.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#c00', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <h2>Render Error</h2>
          <p>{this.state.error.message}</p>
          <pre>{this.state.error.stack}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const {
    screen,
    setScreen,
    setStatusMessage,
    showTerminal,
    showFileTree,
    showReviewPanel,
    showChat,
    showSearch,
  } = useAppStore()

  const [checkingSession, setCheckingSession] = useState(true)
  const [connectError, setConnectError] = useState('')

  // Tab strip state, mirrored from main (home renderer only)
  const [tabStrip, setTabStrip] = useState<{ tabs: Array<{ id: string; title: string }>; active: string }>({
    tabs: [],
    active: 'home'
  })
  useEffect(() => {
    if (initialProjectId) return // project tabs don't render the strip
    window.api.tabsList().then(setTabStrip).catch(() => {})
    return window.api.onTabsChanged(setTabStrip)
  }, [])

  // Prevent Electron from navigating to dropped files
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault()
    document.addEventListener('dragover', prevent)
    document.addEventListener('drop', prevent)
    return () => {
      document.removeEventListener('dragover', prevent)
      document.removeEventListener('drop', prevent)
    }
  }, [])

  // Check session on startup. Project windows (?projectId=) connect straight
  // into the editor; the list window shows the dashboard.
  const startupRanRef = useRef(false)
  useEffect(() => {
    // Once per window — StrictMode double-invokes effects and a second
    // ot:connect mid-flight would race the first
    if (startupRanRef.current) return
    startupRanRef.current = true
    window.api.overleafHasWebSession().then(async ({ loggedIn }) => {
      if (!loggedIn) {
        setScreen('login')
        setCheckingSession(false)
        return
      }
      if (initialProjectId) {
        await connectAndOpen(initialProjectId)
      } else {
        setScreen('projects')
      }
      setCheckingSession(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setScreen])

  // Window title mirrors the open project, like a browser tab
  const projectName = useAppStore((s) => s.overleafProject?.name)
  useEffect(() => {
    document.title = projectName ? `${projectName} — LatteX` : 'LatteX'
  }, [projectName])

  // OT event listeners (always active when in editor)
  useEffect(() => {
    if (screen !== 'editor') return

    const unsubRemoteOp = window.api.onOtRemoteOp((data) => {
      const sync = activeDocSyncs.get(data.docId)
      if (sync) sync.onRemoteOps(data.ops as any, data.version)
    })

    const unsubAck = window.api.onOtAck((data) => {
      const sync = activeDocSyncs.get(data.docId)
      if (sync) sync.onAck()
    })

    const unsubState = window.api.onOtConnectionState((state) => {
      useAppStore.getState().setConnectionState(state as any)
      if (state === 'reconnecting') setStatusMessage('Reconnecting...')
      else if (state === 'connected') setStatusMessage('Connected')
      else if (state === 'disconnected') setStatusMessage('Disconnected')
    })

    const unsubRejoined = window.api.onOtDocRejoined((data) => {
      const sync = activeDocSyncs.get(data.docId)
      if (sync) sync.reset(data.version, data.content)
    })

    // Project-wide autocomplete data (all docs + official metadata endpoint)
    const projectId = useAppStore.getState().overleafProjectId
    if (projectId) startAutocompleteSync(projectId)
    const refreshAutocomplete = () => {
      const pid = useAppStore.getState().overleafProjectId
      if (pid) scheduleAutocompleteRefresh(pid)
    }

    // Listen for external edits from file sync bridge (disk changes)
    const unsubExternalEdit = window.api.onSyncExternalEdit((data) => {
      const sync = activeDocSyncs.get(data.docId)
      if (sync) sync.replaceContent(data.content, data.baseContent)
      refreshAutocomplete()
    })

    // Surface sync retry state in the status bar
    const unsubFileStatus = window.api.onSyncFileStatus?.((data) => {
      if (data.status === 'retrying') {
        setStatusMessage(`Sync failed for ${data.relPath} — retrying (attempt ${data.attempts ?? 1})`)
      } else if (data.status === 'failed') {
        setStatusMessage(`Sync failed for ${data.relPath} — gave up (edit the file to retry)`)
      } else {
        setStatusMessage(`Synced ${data.relPath}`)
      }
    })

    // Session cookie died mid-session — sync can't recover without a re-login
    const unsubAuthExpired = window.api.onAuthSessionExpired?.(() => {
      setStatusMessage('Overleaf session expired — please sign in again')
    })

    // Keep the file tree in sync with Overleaf project-entity socket events.
    const unsubEntityCreated = window.api.onSyncEntityCreated((data) => {
      applyEntityCreated(data)
      refreshAutocomplete()
    })
    const unsubEntityRemoved = window.api.onSyncEntityRemoved((data) => {
      applyEntityRemoved(data)
      refreshAutocomplete()
    })
    const unsubEntityRenamed = window.api.onSyncEntityRenamed((data) => {
      applyEntityRenamed(data)
      refreshAutocomplete()
    })
    const unsubEntityMoved = window.api.onSyncEntityMoved((data) => {
      applyEntityMoved(data)
      refreshAutocomplete()
    })

    // Listen for initial comment data (threads + contexts) from background fetch on connect
    const unsubInitThreads = window.api.onCommentsInitThreads?.((data) => {
      const store = useAppStore.getState()
      store.setResolvedThreadIds(new Set(data.resolvedIds))
    })
    const unsubInitContexts = window.api.onCommentsInitContexts?.((data) => {
      useAppStore.getState().setCommentContexts(data.contexts)
    })

    // Listen for comment events to update resolvedThreadIds immediately
    // (ReviewPanel may not be mounted, so highlights wouldn't update otherwise)
    const unsubCommentsEvent = window.api.onCommentsEvent?.((event) => {
      const { type, args } = event
      const store = useAppStore.getState()
      if (type === 'resolve-thread') {
        const threadId = args[0] as string
        store.setResolvedThreadIds(new Set([...(store.resolvedThreadIds || []), threadId]))
      } else if (type === 'reopen-thread') {
        const threadId = args[0] as string
        const ids = new Set(store.resolvedThreadIds || [])
        ids.delete(threadId)
        store.setResolvedThreadIds(ids)
      } else if (type === 'delete-thread') {
        const threadId = args[0] as string
        const newCtx = { ...store.commentContexts }
        delete newCtx[threadId]
        store.setCommentContexts(newCtx)
        const ids = new Set(store.resolvedThreadIds || [])
        ids.delete(threadId)
        store.setResolvedThreadIds(ids)
      }
    })

    // Listen for remote cursor updates
    const unsubCursorUpdate = window.api.onCursorRemoteUpdate((raw) => {
      const data = raw as {
        id: string; user_id: string; name: string; email: string;
        doc_id: string; row: number; column: number
      }
      remoteCursors.set(data.id, {
        userId: data.user_id || data.id,
        name: data.name || data.email?.split('@')[0] || 'User',
        color: colorForUser(data.user_id || data.id),
        row: data.row,
        column: data.column,
        docId: data.doc_id
      })
      // Update online users count
      useAppStore.getState().setOnlineUsersCount(remoteCursors.size)
      // Notify editor to refresh cursors
      window.dispatchEvent(new CustomEvent('remoteCursorsChanged'))
    })

    const unsubCursorDisconnected = window.api.onCursorRemoteDisconnected((clientId) => {
      remoteCursors.delete(clientId)
      useAppStore.getState().setOnlineUsersCount(remoteCursors.size)
      window.dispatchEvent(new CustomEvent('remoteCursorsChanged'))
    })

    // Fetch initial connected users
    window.api.cursorGetConnectedUsers().then((users) => {
      const arr = users as Array<{
        client_id: string; user_id: string;
        first_name: string; last_name?: string; email: string;
        cursorData?: { doc_id: string; row: number; column: number }
      }>
      for (const u of arr) {
        if (u.cursorData) {
          const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email?.split('@')[0] || 'User'
          remoteCursors.set(u.client_id, {
            userId: u.user_id || u.client_id,
            name,
            color: colorForUser(u.user_id || u.client_id),
            row: u.cursorData.row,
            column: u.cursorData.column,
            docId: u.cursorData.doc_id
          })
        }
      }
      useAppStore.getState().setOnlineUsersCount(remoteCursors.size)
      window.dispatchEvent(new CustomEvent('remoteCursorsChanged'))
    })

    return () => {
      unsubRemoteOp()
      unsubAck()
      unsubState()
      unsubRejoined()
      unsubExternalEdit()
      unsubEntityCreated()
      unsubEntityRemoved()
      unsubEntityRenamed()
      unsubEntityMoved()
      unsubInitThreads?.()
      unsubInitContexts?.()
      unsubCommentsEvent?.()
      unsubCursorUpdate()
      unsubCursorDisconnected()
      unsubFileStatus?.()
      unsubAuthExpired?.()
      remoteCursors.clear()
      stopAutocompleteSync()
    }
  }, [screen, setStatusMessage])

  // Compile log listener
  useEffect(() => {
    const unsub = window.api.onCompileLog((log) => {
      useAppStore.getState().appendCompileLog(log)
    })
    return unsub
  }, [])

  // MCP compile events (Claude Code triggered compile)
  useEffect(() => {
    const unsubStart = window.api.onMcpCompileStarted(() => {
      const state = useAppStore.getState()
      state.setCompiling(true)
      state.clearCompileLog()
      setStatusMessage('Compiling (triggered by Claude Code)...')
    })
    const unsubFinish = window.api.onMcpCompileFinished((data) => {
      const state = useAppStore.getState()
      if (data.pdfPath) {
        state.setPdfPath(data.pdfPath)
      }
      state.setCompiling(false)
      setStatusMessage(data.success ? 'Compiled successfully' : 'Compilation had errors — check Log tab')
    })
    return () => { unsubStart(); unsubFinish() }
  }, [setStatusMessage])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (screen !== 'editor') return
      if (e.metaKey || e.ctrlKey) {
        if (e.key === 'b') {
          e.preventDefault()
          handleCompile()
        }
        if (e.key === '`') {
          e.preventDefault()
          useAppStore.getState().toggleTerminal()
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          handleForwardSearch()
        }
        if (e.key === 'f' && e.shiftKey) {
          e.preventDefault()
          useAppStore.getState().toggleSearch()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [screen])

  const handleForwardSearch = async () => {
    const state = useAppStore.getState()
    const activeTab = state.activeTab
    if (!activeTab) return
    // Get cursor line from the active editor view
    const docId = state.pathDocMap[activeTab]
    const sync = docId ? activeDocSyncs.get(docId) : null
    const view = sync?.editorView
    if (!view) return
    const cursor = view.state.selection.main.head
    const line = view.state.doc.lineAt(cursor)
    const lineNum = line.number
    const col = cursor - line.from
    const result = await window.api.synctexView(lineNum, col, activeTab)
    if (result) {
      state.setPendingPdfGoTo({ page: result.page, y: result.v })
    }
  }

  const handleCompile = async () => {
    const state = useAppStore.getState()
    const mainDoc = state.mainDocument || state.overleafProject?.rootDocId
    if (!mainDoc) {
      setStatusMessage('No main document set')
      return
    }
    state.setCompiling(true)
    state.clearCompileLog()
    setStatusMessage('Compiling on server...')

    const result = await window.api.overleafServerCompile(mainDoc)

    if (result.log) {
      useAppStore.getState().appendCompileLog(result.log)
    }
    if (result.pdfPath) {
      useAppStore.getState().setPdfPath(result.pdfPath)
    }
    useAppStore.getState().setCompiling(false)
    setStatusMessage(result.success ? 'Compiled successfully' : 'Compilation had errors — check Log tab')
  }

  const handleLocalCompile = async () => {
    const state = useAppStore.getState()
    const mainDoc = state.mainDocument || state.overleafProject?.rootDocId
    if (!mainDoc) {
      setStatusMessage('No main document set')
      return
    }
    const relPath = state.docPathMap[mainDoc] || mainDoc
    state.setCompiling(true)
    state.clearCompileLog()
    setStatusMessage('Compiling locally...')

    const result = await window.api.overleafSocketCompile(relPath)

    if (!useAppStore.getState().compileLog && result.log) {
      useAppStore.getState().appendCompileLog(result.log)
    }
    if (result.pdfPath) {
      useAppStore.getState().setPdfPath(null)
      useAppStore.getState().setPdfPath(result.pdfPath)
    }
    useAppStore.getState().setCompiling(false)
    setStatusMessage(result.success ? 'Compiled successfully' : 'Compilation had errors — check Log tab')
  }

  const handleLogin = async () => {
    const result = await window.api.overleafWebLogin()
    if (result.success) {
      if (initialProjectId) {
        setCheckingSession(true)
        await connectAndOpen(initialProjectId)
        setCheckingSession(false)
      } else {
        setScreen('projects')
      }
    }
  }

  // Connect this window to its project and enter the editor (project windows only)
  const connectAndOpen = async (pid: string) => {
    setConnectError('')
    setStatusMessage('Connecting to project...')
    const result = await window.api.otConnect(pid)
    if (!result.success) {
      if (result.message === 'already_open') {
        // Another window owns this project and was focused — close this one
        window.api.closeWindow()
        return
      }
      setConnectError(result.message || 'Failed to connect')
      return
    }
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
    await handleOpenProject(pid)
  }

  const handleOpenProject = async (pid: string) => {
    setScreen('editor')

    // Auto-open root doc
    const store = useAppStore.getState()
    const rootDocId = store.overleafProject?.rootDocId
    if (rootDocId) {
      const relPath = store.docPathMap[rootDocId]
      if (relPath) {
        setStatusMessage('Opening root document...')
        const result = await window.api.otJoinDoc(rootDocId)
        if (result.success && result.content !== undefined) {
          const fileName = relPath.split('/').pop() || relPath
          useAppStore.getState().setFileContent(relPath, result.content)
          useAppStore.getState().openFile(relPath, fileName)
          useAppStore.getState().setMainDocument(rootDocId)
          if (result.version !== undefined) {
            useAppStore.getState().setDocVersion(rootDocId, result.version)
          }
          if (result.ranges?.comments) {
            const contexts: Record<string, { file: string; text: string; pos: number }> = {}
            for (const c of result.ranges.comments) {
              if (c.op?.t) {
                contexts[c.op.t] = { file: relPath, text: c.op.c || '', pos: c.op.p || 0 }
              }
            }
            useAppStore.getState().setCommentContexts(contexts)
          }
          setStatusMessage(`${store.overleafProject?.name || 'Project'}`)
        }
      }
    }

    // Pre-load .bib files in background for citation autocomplete
    const st = useAppStore.getState()
    for (const [docId, relPath] of Object.entries(st.docPathMap)) {
      if (relPath.endsWith('.bib') && !st.fileContents[relPath]) {
        window.api.otJoinDoc(docId).then((res) => {
          if (res.success && res.content !== undefined) {
            useAppStore.getState().setFileContent(relPath, res.content)
            if (res.version !== undefined) {
              useAppStore.getState().setDocVersion(docId, res.version)
            }
          }
          // Release back to bridge — we only needed the content for autocomplete,
          // not an active editor session. Without this, the bridge permanently thinks
          // the renderer handles OT for .bib files and defers disk changes to a
          // non-existent docSync.
          window.api.otLeaveDoc(docId)
        }).catch(() => {})
      }
    }
  }

  const handleBackToProjects = async () => {
    if (initialProjectId) {
      // Project window: closing it is the "back" action — the list window
      // stays open, and main tears the session down on 'closed'
      window.api.closeWindow()
      return
    }
    await window.api.otDisconnect()
    activeDocSyncs.forEach((s) => s.destroy())
    activeDocSyncs.clear()
    useAppStore.getState().resetEditorState()
    setScreen('projects')
  }

  if (checkingSession) {
    return (
      <div className="welcome-screen">
        <div className="welcome-drag-bar" />
        <div className="welcome-content">
          <div className="overleaf-spinner" />
          {initialProjectId && <p style={{ marginTop: 16 }}>Opening project...</p>}
        </div>
      </div>
    )
  }

  // Project window failed to connect — offer retry or close
  if (initialProjectId && connectError && screen !== 'editor') {
    return (
      <div className="welcome-screen">
        <div className="welcome-drag-bar" />
        <div className="welcome-content">
          <h2>Could not open project</h2>
          <p style={{ color: '#a33', maxWidth: 480, wordBreak: 'break-word' }}>{connectError}</p>
          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <button
              className="btn btn-primary"
              onClick={async () => {
                setCheckingSession(true)
                await connectAndOpen(initialProjectId)
                setCheckingSession(false)
              }}
            >
              Retry
            </button>
            <button className="btn" onClick={() => window.api.closeWindow()}>
              Close Tab
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Login screen
  if (screen === 'login') {
    return (
      <>
        <ModalProvider />
        <div className="welcome-screen">
          <div className="welcome-drag-bar" />
          <div className="welcome-content">
            <div className="welcome-logo">
              <svg viewBox="0 0 512 512" width="96" height="96">
                <rect width="512" height="512" rx="80" fill="#6B5B3E"/>
                <path d="M148 195 Q142 375 195 395 L317 395 Q370 375 364 195 Z" fill="#FFF8E7" stroke="#EDE5CE" strokeWidth="2"/>
                <path d="M364 235 Q410 240 412 305 Q414 365 370 370" fill="none" stroke="#FFF8E7" strokeWidth="14" strokeLinecap="round"/>
                <ellipse cx="256" cy="195" rx="108" ry="30" fill="#4ECDA0"/>
                <ellipse cx="256" cy="195" rx="108" ry="30" fill="none" stroke="#EDE5CE" strokeWidth="3"/>
                <path d="M218 128 L224 108 L230 128 L250 134 L230 140 L224 160 L218 140 L198 134 Z" fill="#4ECDA0" opacity="0.9"/>
                <path d="M268 100 L273 84 L278 100 L294 105 L278 110 L273 126 L268 110 L252 105 Z" fill="#4ECDA0" opacity="0.7"/>
                <path d="M308 118 L313 102 L318 118 L334 123 L318 128 L313 144 L308 128 L292 123 Z" fill="#4ECDA0" opacity="0.55"/>
              </svg>
            </div>
            <h1>Latte<span className="lattex-x">X</span></h1>
            <p>LaTeX editor with real-time Overleaf sync</p>
            <button className="btn btn-primary btn-large" onClick={handleLogin}>
              Sign in to Overleaf
            </button>
          </div>
        </div>
      </>
    )
  }

  // Project list screen (home tab). The tab strip only appears once a
  // project is open — home alone shows no tab bar.
  if (screen === 'projects') {
    const showTabBar = tabStrip.tabs.length > 0
    return (
      <>
        <ModalProvider />
        <div className={`home-root${showTabBar ? ' with-tab-bar' : ''}`}>
          {showTabBar && <TabBar tabs={tabStrip.tabs} active={tabStrip.active} />}
          <div className="home-content">
            <ProjectList />
          </div>
          <UpdateToast />
        </div>
      </>
    )
  }

  // Editor screen
  return (
    <ErrorBoundary>
      <ModalProvider />
      <div className="app">
        <Toolbar onCompile={handleCompile} onLocalCompile={handleLocalCompile} onBack={handleBackToProjects} />
        <div className="main-content">
          <PanelGroup direction="horizontal">
            {(showFileTree || showSearch) && (
              <>
                <Panel defaultSize={18} minSize={12} maxSize={35}>
                  {showSearch ? (
                    <SearchPanel />
                  ) : (
                    <div className="sidebar-panel">
                      <FileTree />
                      <OutlineView />
                    </div>
                  )}
                </Panel>
                <PanelResizeHandle className="resize-handle resize-handle-h" />
              </>
            )}
            <Panel minSize={30}>
              <PanelGroup direction="vertical">
                <Panel defaultSize={showTerminal ? 70 : 100} minSize={30}>
                  <PanelGroup direction="horizontal">
                    <Panel defaultSize={50} minSize={25}>
                      <Editor />
                    </Panel>
                    <PanelResizeHandle className="resize-handle resize-handle-h" />
                    <Panel defaultSize={50} minSize={20}>
                      <PdfViewer />
                    </Panel>
                  </PanelGroup>
                </Panel>
                {showTerminal && (
                  <>
                    <PanelResizeHandle className="resize-handle resize-handle-v" />
                    <Panel defaultSize={30} minSize={15} maxSize={60}>
                      <Terminal />
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </Panel>
          </PanelGroup>
          {(showReviewPanel || showChat) && (
            <div className="review-sidebar">
              {showReviewPanel && <ReviewPanel />}
              {showChat && <ChatPanel />}
            </div>
          )}
        </div>
        <StatusBar />
      </div>
    </ErrorBoundary>
  )
}
