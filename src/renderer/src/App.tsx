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

export const activeDocSyncs = new Map<string, OverleafDocSync>()

// Global remote cursor state — shared between App and Editor
export const remoteCursors = new Map<string, RemoteCursor & { docId: string }>()

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

  // Check session on startup
  useEffect(() => {
    window.api.overleafHasWebSession().then(({ loggedIn }) => {
      setScreen(loggedIn ? 'projects' : 'login')
      setCheckingSession(false)
    })
  }, [setScreen])

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

    // Listen for external edits from file sync bridge (disk changes)
    const unsubExternalEdit = window.api.onSyncExternalEdit((data) => {
      const sync = activeDocSyncs.get(data.docId)
      if (sync) sync.replaceContent(data.content)
    })

    // Listen for new docs created locally (e.g. by Claude Code)
    const unsubNewDoc = window.api.onSyncNewDoc((data) => {
      if (data.docId) {
        useAppStore.getState().addDocPath(data.docId, data.relPath)
      }
    })

    // Listen for initial comment data (threads + contexts) from background fetch on connect
    const unsubInitThreads = window.api.onCommentsInitThreads?.((data) => {
      const store = useAppStore.getState()
      store.setResolvedThreadIds(new Set(data.resolvedIds))
    })
    const unsubInitContexts = window.api.onCommentsInitContexts?.((data) => {
      useAppStore.getState().setCommentContexts(data.contexts)
    })

    // Listen for remote cursor updates
    const unsubCursorUpdate = window.api.onCursorRemoteUpdate((raw) => {
      const data = raw as {
        id: string; user_id: string; name: string; email: string;
        doc_id: string; row: number; column: number
      }
      remoteCursors.set(data.id, {
        userId: data.id,
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
            userId: u.client_id,
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
      unsubNewDoc()
      unsubInitThreads?.()
      unsubInitContexts?.()
      unsubCursorUpdate()
      unsubCursorDisconnected()
      remoteCursors.clear()
    }
  }, [screen, setStatusMessage])

  // Compile log listener
  useEffect(() => {
    const unsub = window.api.onCompileLog((log) => {
      useAppStore.getState().appendCompileLog(log)
    })
    return unsub
  }, [])

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
      useAppStore.getState().setPdfPath(result.pdfPath)
    }
    useAppStore.getState().setCompiling(false)
    setStatusMessage(result.success ? 'Compiled successfully' : 'Compilation had errors — check Log tab')
  }

  const handleLogin = async () => {
    const result = await window.api.overleafWebLogin()
    if (result.success) {
      setScreen('projects')
    }
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
        }).catch(() => {})
      }
    }
  }

  const handleBackToProjects = async () => {
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

  // Project list screen
  if (screen === 'projects') {
    return (
      <>
        <ModalProvider />
        <ProjectList onOpenProject={handleOpenProject} />
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
