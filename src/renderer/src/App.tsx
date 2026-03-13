// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useState, useEffect, useCallback, useRef, Component, type ReactNode } from 'react'
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels'
import { useAppStore } from './stores/appStore'
import ModalProvider from './components/ModalProvider'
import ProjectList from './components/ProjectList'
import Toolbar from './components/Toolbar'
import FileTree from './components/FileTree'
import Editor from './components/Editor'
import PdfViewer from './components/PdfViewer'
import Terminal from './components/Terminal'
import ReviewPanel from './components/ReviewPanel'
import ChatPanel from './components/ChatPanel'
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
  } = useAppStore()

  const [checkingSession, setCheckingSession] = useState(true)

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
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [screen])

  const handleCompile = async () => {
    const state = useAppStore.getState()
    const mainDoc = state.mainDocument || state.overleafProject?.rootDocId
    if (!mainDoc) {
      setStatusMessage('No main document set')
      return
    }
    const relPath = state.docPathMap[mainDoc] || mainDoc
    state.setCompiling(true)
    state.clearCompileLog()
    setStatusMessage('Compiling...')

    const result = await window.api.overleafSocketCompile(relPath)

    const storeLog = useAppStore.getState().compileLog
    if (!storeLog && result.log) {
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
                <defs>
                  <linearGradient id="wcG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#FFF8E7"/><stop offset="100%" stopColor="#EDE5CE"/></linearGradient>
                  <linearGradient id="wcC" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#A0782C"/><stop offset="100%" stopColor="#7A5A1E"/></linearGradient>
                </defs>
                <circle cx="256" cy="256" r="240" fill="#6B5B3E"/>
                <path d="M130 190 Q124 390 185 405 L327 405 Q388 390 382 190 Z" fill="url(#wcG)"/>
                <ellipse cx="256" cy="190" rx="126" ry="36" fill="url(#wcC)"/>
                <path d="M256 175 Q240 165 232 172 Q224 180 236 192 L256 208 L276 192 Q288 180 280 172 Q272 165 256 175Z" fill="#D4B880" opacity="0.6"/>
                <ellipse cx="256" cy="190" rx="126" ry="36" fill="none" stroke="#D6CEBC" strokeWidth="3"/>
                <path d="M382 230 Q435 235 438 300 Q440 365 390 370" fill="none" stroke="#FFF8E7" strokeWidth="12" strokeLinecap="round"/>
                <path d="M216 148 Q210 118 220 95" fill="none" stroke="#FFF8E7" strokeWidth="5" strokeLinecap="round" opacity="0.5"/>
                <path d="M256 140 Q250 105 260 80" fill="none" stroke="#FFF8E7" strokeWidth="5" strokeLinecap="round" opacity="0.45"/>
                <path d="M296 148 Q290 118 300 95" fill="none" stroke="#FFF8E7" strokeWidth="5" strokeLinecap="round" opacity="0.4"/>
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
        <Toolbar onCompile={handleCompile} onBack={handleBackToProjects} />
        <div className="main-content">
          <PanelGroup direction="horizontal">
            {showFileTree && (
              <>
                <Panel defaultSize={18} minSize={12} maxSize={35}>
                  <FileTree />
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
