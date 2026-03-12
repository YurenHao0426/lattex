import { useState, useEffect, useCallback, Component, type ReactNode } from 'react'
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
import StatusBar from './components/StatusBar'
import type { OverleafDocSync } from './ot/overleafSync'

export const activeDocSyncs = new Map<string, OverleafDocSync>()

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

    return () => {
      unsubRemoteOp()
      unsubAck()
      unsubState()
      unsubRejoined()
      unsubExternalEdit()
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
            <h1>ClaudeTeX</h1>
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
          {showReviewPanel && (
            <div className="review-sidebar">
              <ReviewPanel />
            </div>
          )}
        </div>
        <StatusBar />
      </div>
    </ErrorBoundary>
  )
}
