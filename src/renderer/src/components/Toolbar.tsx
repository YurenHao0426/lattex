import { useAppStore } from '../stores/appStore'

interface ToolbarProps {
  onCompile: () => void
  onSave: () => void
  onOpenProject: () => void
}

export default function Toolbar({ onCompile, onSave, onOpenProject }: ToolbarProps) {
  const { projectPath, compiling, toggleTerminal, toggleFileTree, showTerminal, showFileTree, isGitRepo, mainDocument } = useAppStore()
  const projectName = projectPath?.split('/').pop() ?? 'ClaudeTeX'

  const handlePull = async () => {
    if (!projectPath) return
    useAppStore.getState().setStatusMessage('Pulling from Overleaf...')
    const result = await window.api.gitPull(projectPath)
    useAppStore.getState().setStatusMessage(result.success ? 'Pull complete' : 'Pull failed')
  }

  const handlePush = async () => {
    if (!projectPath) return
    useAppStore.getState().setStatusMessage('Pushing to Overleaf...')
    const result = await window.api.gitPush(projectPath)
    useAppStore.getState().setStatusMessage(result.success ? 'Push complete' : 'Push failed')
  }

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <div className="drag-region" />
        <button className="toolbar-btn" onClick={toggleFileTree} title="Toggle file tree (Cmd+\\)">
          {showFileTree ? '◧' : '☰'}
        </button>
        <span className="project-name">{projectName}</span>
      </div>
      <div className="toolbar-center">
        <button className="toolbar-btn" onClick={onOpenProject} title="Open project">
          Open
        </button>
        <button className="toolbar-btn" onClick={onSave} title="Save (Cmd+S)">
          Save
        </button>
        <button
          className={`toolbar-btn toolbar-btn-primary ${compiling ? 'compiling' : ''}`}
          onClick={onCompile}
          disabled={compiling}
          title={`Compile (Cmd+B)${mainDocument ? ' — ' + mainDocument.split('/').pop() : ''}`}
        >
          {compiling ? 'Compiling...' : 'Compile'}
        </button>
        {mainDocument && (
          <span className="toolbar-main-doc" title={mainDocument}>
            {mainDocument.split('/').pop()}
          </span>
        )}
        {isGitRepo && (
          <>
            <div className="toolbar-separator" />
            <button className="toolbar-btn" onClick={handlePull} title="Pull from Overleaf">
              Pull
            </button>
            <button className="toolbar-btn" onClick={handlePush} title="Push to Overleaf">
              Push
            </button>
          </>
        )}
      </div>
      <div className="toolbar-right">
        <button className="toolbar-btn" onClick={toggleTerminal} title="Toggle terminal (Cmd+`)">
          {showTerminal ? 'Hide Terminal' : 'Terminal'}
        </button>
      </div>
    </div>
  )
}
