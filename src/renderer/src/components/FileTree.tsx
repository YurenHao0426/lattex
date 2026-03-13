// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useState, useCallback, useEffect, useRef } from 'react'
import { useAppStore, type FileNode } from '../stores/appStore'

interface ContextMenuState {
  x: number
  y: number
  node: FileNode
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
  const { activeTab, openFile, setFileContent, setStatusMessage, mainDocument, docPathMap } = useAppStore()
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

  const ext = node.name.split('.').pop()?.toLowerCase() ?? ''
  const icon = node.isDir
    ? expanded ? '📂' : '📁'
    : ext === 'tex' ? '📄'
    : ext === 'bib' ? '📚'
    : ext === 'pdf' ? '📕'
    : ext === 'png' || ext === 'jpg' ? '🖼️'
    : '📝'

  return (
    <div>
      <div
        className={`file-tree-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span className="file-icon">{icon}</span>
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

export default function FileTree() {
  const { files } = useAppStore()
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

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
    setCtxMenu({ x: e.clientX, y: e.clientY, node })
  }, [])

  const closeMenu = () => setCtxMenu(null)

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
      // Reconnect to refresh file tree
      await reconnectProject(projectId)
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
      await reconnectProject(projectId)
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
      await reconnectProject(projectId)
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
      await reconnectProject(projectId)
    } else {
      useAppStore.getState().setStatusMessage(`Create failed: ${result.message}`)
    }
    closeMenu()
  }

  const handleOpenInOverleaf = () => {
    const projectId = useAppStore.getState().overleafProjectId
    if (projectId) {
      window.api.openExternal(`https://www.overleaf.com/project/${projectId}`)
    }
    closeMenu()
  }

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>FILES</span>
      </div>
      <div className="file-tree-content">
        {files.map((node) => (
          <FileTreeNode key={node.path} node={node} depth={0} onContextMenu={handleContextMenu} />
        ))}
        {files.length === 0 && (
          <div className="file-tree-empty">No files found</div>
        )}
      </div>

      {ctxMenu && (
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
    </div>
  )
}

/** Reconnect to refresh the file tree after a file operation */
async function reconnectProject(projectId: string) {
  const result = await window.api.otConnect(projectId)
  if (result.success) {
    const store = useAppStore.getState()
    if (result.files) store.setFiles(result.files as any)
    if (result.project) store.setOverleafProject(result.project)
    if (result.docPathMap && result.pathDocMap) store.setDocMaps(result.docPathMap, result.pathDocMap)
    if (result.fileRefs) store.setFileRefs(result.fileRefs)
    if (result.rootFolderId) store.setRootFolderId(result.rootFolderId)
  }
}
