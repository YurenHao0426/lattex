import { useState, useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { showInput, showConfirm } from '../hooks/useModal'

interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

function FileTreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  const { activeTab, mainDocument, openFile, setFileContent, setStatusMessage } = useAppStore()
  const isActive = activeTab === node.path
  const isMainDoc = mainDocument === node.path

  const handleClick = useCallback(async () => {
    if (node.isDir) {
      setExpanded(!expanded)
      return
    }

    const ext = node.name.split('.').pop()?.toLowerCase()
    if (ext === 'pdf' || ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'svg') {
      if (ext === 'pdf') {
        useAppStore.getState().setPdfPath(node.path)
      }
      return
    }

    try {
      const content = await window.api.readFile(node.path)
      setFileContent(node.path, content)
      openFile(node.path, node.name)
    } catch {
      setStatusMessage('Failed to read file')
    }
  }, [node, expanded, openFile, setFileContent, setStatusMessage])

  const ext = node.name.split('.').pop()?.toLowerCase() ?? ''
  const icon = node.isDir
    ? expanded ? '📂' : '📁'
    : ext === 'tex' ? '📄'
    : ext === 'bib' ? '📚'
    : ext === 'pdf' ? '📕'
    : ext === 'png' || ext === 'jpg' ? '🖼️'
    : '📝'

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
    const handler = () => { setContextMenu(null); window.removeEventListener('click', handler) }
    window.addEventListener('click', handler)
  }

  const handleNewFile = async () => {
    setContextMenu(null)
    const name = await showInput('New File', 'main.tex')
    if (!name) return
    const dir = node.isDir ? node.path : node.path.substring(0, node.path.lastIndexOf('/'))
    await window.api.createFile(dir, name)
  }

  const handleNewFolder = async () => {
    setContextMenu(null)
    const name = await showInput('New Folder', 'figures')
    if (!name) return
    const dir = node.isDir ? node.path : node.path.substring(0, node.path.lastIndexOf('/'))
    await window.api.createDir(dir, name)
  }

  const handleRename = async () => {
    setContextMenu(null)
    const newName = await showInput('Rename', node.name, node.name)
    if (!newName || newName === node.name) return
    const dir = node.path.substring(0, node.path.lastIndexOf('/'))
    await window.api.renameFile(node.path, dir + '/' + newName)
  }

  const handleDelete = async () => {
    setContextMenu(null)
    const ok = await showConfirm('Delete', `Delete "${node.name}"?`, true)
    if (!ok) return
    await window.api.deleteFile(node.path)
  }

  const handleSetMainDoc = () => {
    setContextMenu(null)
    useAppStore.getState().setMainDocument(node.path)
    setStatusMessage(`Main document: ${node.name}`)
  }

  const handleReveal = () => {
    window.api.showInFinder(node.path)
    setContextMenu(null)
  }

  return (
    <div>
      <div
        className={`file-tree-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <span className="file-icon">{icon}</span>
        <span className="file-name">{node.name}</span>
        {isMainDoc && <span className="main-doc-badge">main</span>}
      </div>
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {!node.isDir && ext === 'tex' && (
            <>
              <div className="context-menu-item" onClick={handleSetMainDoc}>
                {isMainDoc ? '✓ Main Document' : 'Set as Main Document'}
              </div>
              <div className="context-menu-separator" />
            </>
          )}
          <div className="context-menu-item" onClick={handleNewFile}>New File</div>
          <div className="context-menu-item" onClick={handleNewFolder}>New Folder</div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={handleRename}>Rename</div>
          <div className="context-menu-item danger" onClick={handleDelete}>Delete</div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={handleReveal}>Reveal in Finder</div>
        </div>
      )}
      {node.isDir && expanded && node.children?.map((child) => (
        <FileTreeNode key={child.path} node={child} depth={depth + 1} />
      ))}
    </div>
  )
}

export default function FileTree() {
  const { files, projectPath } = useAppStore()

  const handleNewFile = async () => {
    if (!projectPath) return
    const name = await showInput('New File', 'main.tex')
    if (!name) return
    await window.api.createFile(projectPath, name)
  }

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>FILES</span>
        <button className="file-tree-action" onClick={handleNewFile} title="New file">+</button>
      </div>
      <div className="file-tree-content">
        {files.map((node) => (
          <FileTreeNode key={node.path} node={node} depth={0} />
        ))}
        {files.length === 0 && (
          <div className="file-tree-empty">No files found</div>
        )}
      </div>
    </div>
  )
}
