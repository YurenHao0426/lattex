// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useState, useCallback, useEffect, useRef } from 'react'
import { useAppStore, type FileNode } from '../stores/appStore'

const BINARY_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'eps', 'zip', 'tiff', 'bmp'])

interface ContextMenuState {
  x: number
  y: number
  node: FileNode
  view: 'project' | 'workspace'
}

function fileIcon(node: FileNode, expanded: boolean): string {
  if (node.isDir) return expanded ? '📂' : '📁'
  const ext = node.name.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'tex' ? '📄'
    : ext === 'bib' ? '📚'
    : ext === 'pdf' ? '📕'
    : ext === 'png' || ext === 'jpg' || ext === 'jpeg' ? '🖼️'
    : ext === 'py' || ext === 'sh' ? '⚙️'
    : '📝'
}

function FileTreeNode({
  node,
  depth,
  onContextMenu
}: {
  node: FileNode
  depth: number
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void
}) {
  const [expanded, setExpanded] = useState(depth < 2)
  const { activeTab, openFile, setFileContent, setStatusMessage, mainDocument } = useAppStore()
  const isActive = activeTab === node.path
  const isMainDoc = node.docId && mainDocument === node.docId

  const handleClick = useCallback(async () => {
    if (node.isDir) {
      setExpanded(!expanded)
      return
    }

    // Binary files — skip
    const ext = node.name.split('.').pop()?.toLowerCase()
    if (ext === 'pdf' || ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'svg') {
      if (ext === 'pdf') {
        useAppStore.getState().setPdfPath(node.path)
      }
      return
    }

    // Join doc via socket
    if (node.docId) {
      setStatusMessage('Opening document...')
      try {
        const result = await window.api.otJoinDoc(node.docId)
        if (result.success && result.content !== undefined) {
          setFileContent(node.path, result.content)
          openFile(node.path, node.name)
          if (result.version !== undefined) {
            useAppStore.getState().setDocVersion(node.docId, result.version)
          }
          if (result.ranges?.comments) {
            const contexts: Record<string, { file: string; text: string; pos: number }> = {}
            for (const c of result.ranges.comments) {
              if (c.op?.t) {
                contexts[c.op.t] = { file: node.path, text: c.op.c || '', pos: c.op.p || 0 }
              }
            }
            const existing = useAppStore.getState().commentContexts
            useAppStore.getState().setCommentContexts({ ...existing, ...contexts })
          }
          setStatusMessage('Ready')
        } else {
          setStatusMessage(result.message || 'Failed to open document')
        }
      } catch {
        setStatusMessage('Failed to open document')
      }
    }
  }, [node, expanded, openFile, setFileContent, setStatusMessage])

  return (
    <div>
      <div
        className={`file-tree-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span className="file-icon">{fileIcon(node, expanded)}</span>
        <span className="file-name">
          {node.name}
          {isMainDoc && <span className="main-doc-badge">main</span>}
        </span>
      </div>
      {node.isDir && expanded && node.children?.map((child) => (
        <FileTreeNode key={child.path} node={child} depth={depth + 1} onContextMenu={onContextMenu} />
      ))}
    </div>
  )
}

/** Workspace (agent scratch space) node — files live on disk, not on Overleaf */
function WorkspaceNode({
  node,
  depth,
  onContextMenu
}: {
  node: FileNode
  depth: number
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void
}) {
  const [expanded, setExpanded] = useState(depth < 2)
  const { activeTab, openFile, setFileContent, setStatusMessage, syncDir } = useAppStore()
  const isActive = activeTab === node.path

  const handleClick = useCallback(async () => {
    if (node.isDir) {
      setExpanded(!expanded)
      return
    }
    const abs = `${syncDir}/${node.path}`
    const ext = node.name.split('.').pop()?.toLowerCase() ?? ''
    if (BINARY_EXTS.has(ext)) {
      // Open binaries with the system default app
      window.api.openPath(abs)
      return
    }
    try {
      const content = await window.api.readFile(abs)
      setFileContent(node.path, content)
      openFile(node.path, node.name)
    } catch {
      setStatusMessage(`Failed to open ${node.name}`)
    }
  }, [node, expanded, syncDir, openFile, setFileContent, setStatusMessage])

  return (
    <div>
      <div
        className={`file-tree-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span className="file-icon">{fileIcon(node, expanded)}</span>
        <span className="file-name">{node.name}</span>
      </div>
      {node.isDir && expanded && node.children?.map((child) => (
        <WorkspaceNode key={child.path} node={child} depth={depth + 1} onContextMenu={onContextMenu} />
      ))}
    </div>
  )
}

export default function FileTree() {
  const { files, syncDir } = useAppStore()
  const [view, setView] = useState<'project' | 'workspace'>('project')
  const [wsNodes, setWsNodes] = useState<FileNode[]>([])
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const workspaceRoot = syncDir ? `${syncDir}/claude-workspace` : ''

  const loadWorkspace = useCallback(async () => {
    if (!workspaceRoot) return
    try {
      const nodes = await window.api.listDirTree(workspaceRoot, 'claude-workspace/')
      setWsNodes(nodes as FileNode[])
    } catch { /* workspace may not exist yet */ }
  }, [workspaceRoot])

  // Refresh workspace on switch + poll while visible (agents write here)
  useEffect(() => {
    if (view !== 'workspace') return
    loadWorkspace()
    const timer = setInterval(loadWorkspace, 5000)
    return () => clearInterval(timer)
  }, [view, loadWorkspace])

  // Close context menu on outside click or escape
  useEffect(() => {
    if (!ctxMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [ctxMenu])

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, node, view })
  }, [view])

  const closeMenu = () => setCtxMenu(null)

  // ── Project view actions (Overleaf entities) ──

  const handleSetMainDoc = () => {
    if (!ctxMenu) return
    const node = ctxMenu.node
    if (node.docId) {
      useAppStore.getState().setMainDocument(node.docId)
      useAppStore.getState().setStatusMessage(`Main document set to ${node.name}`)
    }
    closeMenu()
  }

  const handleCopyPath = () => {
    if (!ctxMenu) return
    navigator.clipboard.writeText(ctxMenu.node.path)
    useAppStore.getState().setStatusMessage('Path copied')
    closeMenu()
  }

  const handleRename = async () => {
    if (!ctxMenu) return
    const node = ctxMenu.node
    const projectId = useAppStore.getState().overleafProjectId
    if (!projectId) { closeMenu(); return }

    const newName = prompt('New name:', node.name)
    if (!newName?.trim() || newName === node.name) { closeMenu(); return }

    let entityType: string
    let entityId: string
    if (node.isDir && node.folderId) {
      entityType = 'folder'
      entityId = node.folderId
    } else if (node.docId) {
      entityType = 'doc'
      entityId = node.docId
    } else if (node.fileRefId) {
      entityType = 'file'
      entityId = node.fileRefId
    } else {
      closeMenu(); return
    }

    const result = await window.api.overleafRenameEntity(projectId, entityType, entityId, newName.trim())
    if (result.success) {
      useAppStore.getState().setStatusMessage(`Renamed to ${newName.trim()}`)
    } else {
      useAppStore.getState().setStatusMessage(`Rename failed: ${result.message}`)
    }
    closeMenu()
  }

  const handleDelete = async () => {
    if (!ctxMenu) return
    const node = ctxMenu.node
    const projectId = useAppStore.getState().overleafProjectId
    if (!projectId) { closeMenu(); return }

    if (!confirm(`Delete "${node.name}"?`)) { closeMenu(); return }

    let entityType: string
    let entityId: string
    if (node.isDir && node.folderId) {
      entityType = 'folder'
      entityId = node.folderId
    } else if (node.docId) {
      entityType = 'doc'
      entityId = node.docId
    } else if (node.fileRefId) {
      entityType = 'file'
      entityId = node.fileRefId
    } else {
      closeMenu(); return
    }

    const result = await window.api.overleafDeleteEntity(projectId, entityType, entityId)
    if (result.success) {
      useAppStore.getState().setStatusMessage(`Deleted ${node.name}`)
    } else {
      useAppStore.getState().setStatusMessage(`Delete failed: ${result.message}`)
    }
    closeMenu()
  }

  const handleNewFile = async () => {
    if (!ctxMenu) return
    const node = ctxMenu.node
    const projectId = useAppStore.getState().overleafProjectId
    if (!projectId) { closeMenu(); return }

    const name = prompt('New file name:', 'untitled.tex')
    if (!name?.trim()) { closeMenu(); return }

    const parentId = node.isDir && node.folderId
      ? node.folderId
      : useAppStore.getState().rootFolderId

    const result = await window.api.overleafCreateDoc(projectId, parentId, name.trim())
    if (result.success) {
      useAppStore.getState().setStatusMessage(`Created ${name.trim()}`)
    } else {
      useAppStore.getState().setStatusMessage(`Create failed: ${result.message}`)
    }
    closeMenu()
  }

  const handleNewFolder = async () => {
    if (!ctxMenu) return
    const node = ctxMenu.node
    const projectId = useAppStore.getState().overleafProjectId
    if (!projectId) { closeMenu(); return }

    const name = prompt('New folder name:', 'new-folder')
    if (!name?.trim()) { closeMenu(); return }

    const parentId = node.isDir && node.folderId
      ? node.folderId
      : useAppStore.getState().rootFolderId

    const result = await window.api.overleafCreateFolder(projectId, parentId, name.trim())
    if (result.success) {
      useAppStore.getState().setStatusMessage(`Created folder ${name.trim()}`)
    } else {
      useAppStore.getState().setStatusMessage(`Create failed: ${result.message}`)
    }
    closeMenu()
  }

  // ── Workspace view actions (disk files under claude-workspace/) ──

  const wsAbs = (node: FileNode) => `${syncDir}/${node.path}`

  /** Copy a workspace file/folder into the project root — the sync bridge
      detects it and creates it on Overleaf. */
  const handleImportToProject = async () => {
    if (!ctxMenu || !syncDir) return
    const node = ctxMenu.node
    closeMenu()

    // Avoid clobbering an existing project file with the same name
    let destName = node.name
    if (await window.api.pathExists(`${syncDir}/${destName}`)) {
      const dot = destName.lastIndexOf('.')
      const stem = dot > 0 ? destName.slice(0, dot) : destName
      const ext = dot > 0 ? destName.slice(dot) : ''
      destName = `${stem}-imported${ext}`
      if (await window.api.pathExists(`${syncDir}/${destName}`)) {
        useAppStore.getState().setStatusMessage(`Import failed: ${destName} already exists`)
        return
      }
    }

    try {
      await window.api.copyPath(wsAbs(node), `${syncDir}/${destName}`)
      useAppStore.getState().setStatusMessage(`Imported ${destName} — syncing to Overleaf`)
    } catch (e) {
      useAppStore.getState().setStatusMessage(`Import failed: ${e}`)
    }
  }

  const handleWsRename = async () => {
    if (!ctxMenu || !syncDir) return
    const node = ctxMenu.node
    const newName = prompt('New name:', node.name)
    closeMenu()
    if (!newName?.trim() || newName === node.name) return
    const parent = node.path.slice(0, node.path.lastIndexOf('/'))
    try {
      await window.api.renamePath(wsAbs(node), `${syncDir}/${parent}/${newName.trim()}`)
      loadWorkspace()
    } catch (e) {
      useAppStore.getState().setStatusMessage(`Rename failed: ${e}`)
    }
  }

  const handleWsDelete = async () => {
    if (!ctxMenu || !syncDir) return
    const node = ctxMenu.node
    closeMenu()
    if (!confirm(`Delete "${node.name}" from workspace?`)) return
    try {
      await window.api.deletePath(wsAbs(node))
      useAppStore.getState().closeTab(node.path)
      loadWorkspace()
    } catch (e) {
      useAppStore.getState().setStatusMessage(`Delete failed: ${e}`)
    }
  }

  const handleWsNewFile = async (parentNode?: FileNode) => {
    if (!syncDir) return
    closeMenu()
    const name = prompt('New file name:', 'notes.md')
    if (!name?.trim()) return
    const parentPath = parentNode?.isDir ? parentNode.path : 'claude-workspace'
    try {
      await window.api.writeFile(`${syncDir}/${parentPath}/${name.trim()}`, '')
      loadWorkspace()
    } catch (e) {
      useAppStore.getState().setStatusMessage(`Create failed: ${e}`)
    }
  }

  const handleWsNewFolder = async (parentNode?: FileNode) => {
    if (!syncDir) return
    closeMenu()
    const name = prompt('New folder name:', 'new-folder')
    if (!name?.trim()) return
    const parentPath = parentNode?.isDir ? parentNode.path : 'claude-workspace'
    try {
      await window.api.mkdirp(`${syncDir}/${parentPath}/${name.trim()}`)
      loadWorkspace()
    } catch (e) {
      useAppStore.getState().setStatusMessage(`Create failed: ${e}`)
    }
  }

  const handleRevealInFinder = () => {
    if (!ctxMenu || !syncDir) return
    window.api.showInFinder(wsAbs(ctxMenu.node))
    closeMenu()
  }

  // ── Drag & drop ──

  const [dragOver, setDragOver] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)

    const droppedFiles = e.dataTransfer.files
    if (droppedFiles.length === 0) return

    if (view === 'workspace') {
      // Copy into the agent workspace on disk (not synced to Overleaf)
      const dir = useAppStore.getState().syncDir
      if (!dir) return
      for (let i = 0; i < droppedFiles.length; i++) {
        const file = droppedFiles[i]
        const srcPath = window.api.getPathForFile(file)
        try {
          await window.api.copyPath(srcPath, `${dir}/claude-workspace/${file.name}`)
          useAppStore.getState().setStatusMessage(`Copied ${file.name} to workspace`)
        } catch (err) {
          useAppStore.getState().setStatusMessage(`Copy failed: ${err}`)
          return
        }
      }
      loadWorkspace()
      return
    }

    const projectId = useAppStore.getState().overleafProjectId
    const folderId = useAppStore.getState().rootFolderId
    if (!projectId || !folderId) return

    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i]
      const filePath = window.api.getPathForFile(file)
      const fileName = file.name

      useAppStore.getState().setStatusMessage(`Uploading ${fileName}...`)
      const result = await window.api.uploadFileToProject(projectId, folderId, filePath, fileName)
      if (result.success) {
        useAppStore.getState().setStatusMessage(`Uploaded ${fileName}`)
      } else {
        useAppStore.getState().setStatusMessage(`Upload failed: ${result.message}`)
        return
      }
    }
  }, [view, loadWorkspace])

  const handleOpenInOverleaf = () => {
    const projectId = useAppStore.getState().overleafProjectId
    if (projectId) {
      window.api.openExternal(`https://www.overleaf.com/project/${projectId}`)
    }
    closeMenu()
  }

  return (
    <div
      className={`file-tree${dragOver ? ' file-tree-dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="file-tree-header file-tree-tabs">
        <button
          className={`file-tree-tab ${view === 'project' ? 'active' : ''}`}
          onClick={() => setView('project')}
          title="Overleaf project files (synced)"
        >
          Project
        </button>
        <button
          className={`file-tree-tab ${view === 'workspace' ? 'active' : ''}`}
          onClick={() => setView('workspace')}
          title="Agent scratch space (claude-workspace/, not synced to Overleaf)"
        >
          Workspace
        </button>
      </div>

      {view === 'workspace' && (
        <div className="file-tree-ws-toolbar">
          <button className="file-tree-ws-btn" title="New file" onClick={() => handleWsNewFile()}>＋ File</button>
          <button className="file-tree-ws-btn" title="New folder" onClick={() => handleWsNewFolder()}>＋ Folder</button>
          <button className="file-tree-ws-btn" title="Refresh" onClick={loadWorkspace}>↻</button>
          <button
            className="file-tree-ws-btn"
            title="Reveal workspace in Finder"
            onClick={() => workspaceRoot && window.api.showInFinder(workspaceRoot)}
          >
            Finder
          </button>
        </div>
      )}

      <div className="file-tree-content">
        {view === 'project' ? (
          <>
            {files.map((node) => (
              <FileTreeNode key={node.path} node={node} depth={0} onContextMenu={handleContextMenu} />
            ))}
            {files.length === 0 && (
              <div className="file-tree-empty">No files found</div>
            )}
          </>
        ) : (
          <>
            {wsNodes.map((node) => (
              <WorkspaceNode key={node.path} node={node} depth={0} onContextMenu={handleContextMenu} />
            ))}
            {wsNodes.length === 0 && (
              <div className="file-tree-empty">
                Workspace is empty — agents use this scratch space for notes,
                experiments, and generated files. Drop files here to add them.
              </div>
            )}
          </>
        )}
      </div>

      {ctxMenu && ctxMenu.view === 'project' && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {ctxMenu.node.docId && ctxMenu.node.name.endsWith('.tex') && (
            <div className="context-menu-item" onClick={handleSetMainDoc}>
              Set as Main Document
            </div>
          )}
          <div className="context-menu-item" onClick={handleCopyPath}>
            Copy Path
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={handleRename}>
            Rename
          </div>
          {ctxMenu.node.isDir && (
            <>
              <div className="context-menu-item" onClick={handleNewFile}>
                New File
              </div>
              <div className="context-menu-item" onClick={handleNewFolder}>
                New Folder
              </div>
            </>
          )}
          <div className="context-menu-separator" />
          <div className="context-menu-item danger" onClick={handleDelete}>
            Delete
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={handleOpenInOverleaf}>
            Open in Overleaf
          </div>
        </div>
      )}

      {ctxMenu && ctxMenu.view === 'workspace' && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {!ctxMenu.node.isDir && (
            <div className="context-menu-item" onClick={handleImportToProject}>
              Import to Project
            </div>
          )}
          {ctxMenu.node.isDir && (
            <div className="context-menu-item" onClick={handleImportToProject}>
              Import Folder to Project
            </div>
          )}
          <div className="context-menu-item" onClick={handleCopyPath}>
            Copy Path
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={handleWsRename}>
            Rename
          </div>
          {ctxMenu.node.isDir && (
            <>
              <div className="context-menu-item" onClick={() => handleWsNewFile(ctxMenu.node)}>
                New File
              </div>
              <div className="context-menu-item" onClick={() => handleWsNewFolder(ctxMenu.node)}>
                New Folder
              </div>
            </>
          )}
          <div className="context-menu-item" onClick={handleRevealInFinder}>
            Reveal in Finder
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item danger" onClick={handleWsDelete}>
            Delete
          </div>
        </div>
      )}
    </div>
  )
}
