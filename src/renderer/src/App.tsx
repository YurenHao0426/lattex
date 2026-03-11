import { useState, useEffect, useCallback } from 'react'
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels'
import { useAppStore } from './stores/appStore'
import { showConfirm } from './hooks/useModal'
import ModalProvider from './components/ModalProvider'
import OverleafConnect from './components/OverleafConnect'
import Toolbar from './components/Toolbar'
import FileTree from './components/FileTree'
import Editor from './components/Editor'
import PdfViewer from './components/PdfViewer'
import Terminal from './components/Terminal'
import StatusBar from './components/StatusBar'

export default function App() {
  const {
    projectPath,
    setProjectPath,
    setFiles,
    showTerminal,
    showFileTree,
    setIsGitRepo,
    setGitStatus,
    setStatusMessage
  } = useAppStore()

  const refreshFiles = useCallback(async () => {
    if (!projectPath) return
    const files = await window.api.readDir(projectPath)
    setFiles(files)
  }, [projectPath, setFiles])

  // Load project
  useEffect(() => {
    if (!projectPath) return

    refreshFiles()
    window.api.watchStart(projectPath)

    // Check git status
    window.api.gitStatus(projectPath).then(({ isGit, status }) => {
      setIsGitRepo(isGit)
      setGitStatus(status)
    })

    // Auto-detect main document if not set
    if (!useAppStore.getState().mainDocument) {
      window.api.findMainTex(projectPath).then((mainTex) => {
        if (mainTex) {
          useAppStore.getState().setMainDocument(mainTex)
          setStatusMessage(`Main document: ${mainTex.split('/').pop()}`)
        }
      })
    }

    const unsub = window.api.onWatchChange(() => {
      refreshFiles()
    })

    return () => {
      unsub()
      window.api.watchStop()
    }
  }, [projectPath, refreshFiles, setIsGitRepo, setGitStatus])

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
      if (e.metaKey || e.ctrlKey) {
        if (e.key === 's') {
          e.preventDefault()
          handleSave()
        }
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
  }, [])

  const handleSave = async () => {
    const { activeTab, fileContents } = useAppStore.getState()
    if (!activeTab || !fileContents[activeTab]) return
    await window.api.writeFile(activeTab, fileContents[activeTab])
    useAppStore.getState().markModified(activeTab, false)
    setStatusMessage('Saved')
  }

  const handleCompile = async () => {
    const { activeTab, mainDocument } = useAppStore.getState()
    const target = mainDocument || activeTab
    if (!target || !target.endsWith('.tex')) return

    useAppStore.getState().setCompiling(true)
    useAppStore.getState().clearCompileLog()
    setStatusMessage('Compiling...')

    const result = await window.api.compile(target) as {
      success: boolean; log: string; missingPackages?: string[]
    }

    console.log('[compile] result.success:', result.success, 'log length:', result.log?.length, 'missingPkgs:', result.missingPackages)

    // Ensure compile log is populated (fallback if streaming events missed)
    const storeLog = useAppStore.getState().compileLog
    console.log('[compile] storeLog length:', storeLog?.length)
    if (!storeLog && result.log) {
      useAppStore.getState().appendCompileLog(result.log)
    }

    // Always try to load PDF BEFORE setting compiling=false
    const pdfPath = await window.api.getPdfPath(target)
    console.log('[compile] checking pdfPath:', pdfPath)
    try {
      const s = await window.api.fileStat(pdfPath)
      console.log('[compile] PDF exists, size:', s.size)
      useAppStore.getState().setPdfPath(pdfPath)
    } catch (err) {
      console.log('[compile] PDF not found:', err)
    }

    // Now signal compilation done
    useAppStore.getState().setCompiling(false)

    // Missing packages detected — offer to install
    if (result.missingPackages && result.missingPackages.length > 0) {
      const pkgs = result.missingPackages
      const ok = await showConfirm(
        'Missing LaTeX Packages',
        `The following packages are needed:\n\n${pkgs.join(', ')}\n\nInstall them now? (may require your password in terminal)`,
      )
      if (ok) {
        setStatusMessage(`Installing ${pkgs.join(', ')}...`)
        const installResult = await window.api.installTexPackages(pkgs)
        if (installResult.success) {
          setStatusMessage('Packages installed. Recompiling...')
          handleCompile()
          return
        } else if (installResult.message === 'need_sudo') {
          setStatusMessage('Need sudo — installing via terminal...')
          useAppStore.getState().showTerminal || useAppStore.getState().toggleTerminal()
          await window.api.ptyWrite(`sudo tlmgr install ${pkgs.join(' ')}\n`)
          setStatusMessage('Enter your password in terminal, then recompile with Cmd+B')
          return
        } else {
          setStatusMessage('Package install failed')
        }
      }
    }

    if (result.success) {
      setStatusMessage('Compiled successfully')
    } else {
      setStatusMessage('Compilation had errors — check Log tab')
    }
  }

  const [showOverleaf, setShowOverleaf] = useState(false)

  const handleOpenProject = async () => {
    const path = await window.api.openProject()
    if (path) setProjectPath(path)
  }

  return (
    <>
      <ModalProvider />
      {showOverleaf && (
        <OverleafConnect
          onConnected={(path) => {
            setShowOverleaf(false)
            setProjectPath(path)
          }}
          onCancel={() => setShowOverleaf(false)}
        />
      )}
      {!projectPath ? (
        <div className="welcome-screen">
          <div className="welcome-drag-bar" />
          <div className="welcome-content">
            <h1>ClaudeTeX</h1>
            <p>LaTeX editor with AI and Overleaf sync</p>
            <button className="btn btn-primary btn-large" onClick={handleOpenProject}>
              Open Project
            </button>
            <button className="btn btn-secondary btn-large" onClick={() => setShowOverleaf(true)}>
              Clone from Overleaf
            </button>
          </div>
        </div>
      ) : (
        <div className="app">
          <Toolbar onCompile={handleCompile} onSave={handleSave} onOpenProject={handleOpenProject} />
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
          </div>
          <StatusBar />
        </div>
      )}
    </>
  )
}
