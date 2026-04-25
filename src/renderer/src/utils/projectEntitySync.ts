// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useAppStore, type FileNode } from '../stores/appStore'

export type SyncEntityKind = 'doc' | 'file' | 'folder'

export interface SyncEntityCreated {
  kind: SyncEntityKind
  entityId: string
  relPath: string
  name: string
  parentFolderId?: string
}

export interface SyncEntityRemoved {
  kind: SyncEntityKind
  entityId: string
  relPath: string
}

export interface SyncEntityRenamed {
  kind: SyncEntityKind
  entityId: string
  oldPath: string
  newPath: string
  newName: string
}

export interface SyncEntityMoved {
  kind: SyncEntityKind
  entityId: string
  oldPath: string
  newPath: string
  parentFolderId: string
}

function stripTrailingSlash(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '')
}

function normalizePath(path: string, kind: SyncEntityKind): string {
  const stripped = stripTrailingSlash(path)
  if (kind === 'folder') return stripped ? `${stripped}/` : ''
  return stripped
}

function pathParts(path: string, kind: SyncEntityKind): string[] {
  const normalized = normalizePath(path, kind)
  return stripTrailingSlash(normalized).split('/').filter(Boolean)
}

function pathMatchesKind(path: string, kind: SyncEntityKind, targetPath: string): boolean {
  return normalizePath(path, kind) === normalizePath(targetPath, kind)
}

function isNodeMatch(node: FileNode, kind: SyncEntityKind, entityId: string, relPath?: string): boolean {
  if (kind === 'doc') {
    return node.docId === entityId || (!!relPath && !node.isDir && pathMatchesKind(node.path, kind, relPath))
  }
  if (kind === 'file') {
    return node.fileRefId === entityId || (!!relPath && !node.isDir && pathMatchesKind(node.path, kind, relPath))
  }
  return node.folderId === entityId || (!!relPath && node.isDir && pathMatchesKind(node.path, kind, relPath))
}

function withNode(nodes: FileNode[], index: number, node: FileNode): FileNode[] {
  if (index === -1) return [...nodes, node]
  return nodes.map((existing, i) => (i === index ? node : existing))
}

function createLeafNode(entity: SyncEntityCreated, existing?: FileNode): FileNode {
  const path = normalizePath(entity.relPath, entity.kind)
  const base: FileNode = {
    name: entity.name,
    path,
    isDir: entity.kind === 'folder'
  }

  if (entity.kind === 'doc') {
    base.docId = entity.entityId
  } else if (entity.kind === 'file') {
    base.fileRefId = entity.entityId
  } else {
    base.folderId = entity.entityId
    base.children = existing?.children ?? []
  }

  return base
}

function upsertFileTreeNode(files: FileNode[], entity: SyncEntityCreated): FileNode[] {
  const parts = pathParts(entity.relPath, entity.kind)
  if (parts.length === 0) return files
  const parentFolderPath = entity.kind === 'folder' || parts.length <= 1
    ? ''
    : `${parts.slice(0, -1).join('/')}/`

  const upsert = (nodes: FileNode[], depth: number, prefix: string): FileNode[] => {
    const name = parts[depth]
    const isLeaf = depth === parts.length - 1
    const currentPath = isLeaf
      ? normalizePath(entity.relPath, entity.kind)
      : `${prefix}${name}/`

    const index = nodes.findIndex((node) => (
      node.path === currentPath || (isLeaf && isNodeMatch(node, entity.kind, entity.entityId, entity.relPath))
    ))
    const existing = index >= 0 ? nodes[index] : undefined

    if (isLeaf) {
      return withNode(nodes, index, createLeafNode(entity, existing))
    }

    const folderNode: FileNode = {
      name,
      path: currentPath,
      isDir: true,
      folderId: currentPath === parentFolderPath ? entity.parentFolderId : existing?.folderId,
      children: upsert(existing?.children ?? [], depth + 1, currentPath)
    }

    return withNode(nodes, index, folderNode)
  }

  return upsert(files, 0, '')
}

function removeFileTreeNode(files: FileNode[], entity: SyncEntityRemoved): FileNode[] {
  return files.flatMap((node) => {
    if (isNodeMatch(node, entity.kind, entity.entityId, entity.relPath)) return []
    if (node.children) {
      return [{ ...node, children: removeFileTreeNode(node.children, entity) }]
    }
    return [node]
  })
}

function rewriteNodePath(node: FileNode, oldPath: string, newPath: string): FileNode {
  const oldPrefix = normalizePath(oldPath, 'folder')
  const newPrefix = normalizePath(newPath, 'folder')
  const rewrittenPath = node.path.startsWith(oldPrefix)
    ? newPrefix + node.path.slice(oldPrefix.length)
    : node.path

  return {
    ...node,
    path: rewrittenPath,
    children: node.children?.map((child) => rewriteNodePath(child, oldPath, newPath))
  }
}

function renameFileTreeNode(files: FileNode[], entity: SyncEntityRenamed): FileNode[] {
  return files.map((node) => {
    if (isNodeMatch(node, entity.kind, entity.entityId, entity.oldPath)) {
      const nextPath = normalizePath(entity.newPath, entity.kind)
      return {
        ...node,
        name: entity.newName,
        path: nextPath,
        children: node.isDir
          ? node.children?.map((child) => rewriteNodePath(child, entity.oldPath, entity.newPath))
          : node.children
      }
    }
    if (node.children) {
      return { ...node, children: renameFileTreeNode(node.children, entity) }
    }
    return node
  })
}

function extractFileTreeNode(
  files: FileNode[],
  kind: SyncEntityKind,
  entityId: string,
  oldPath: string
): { files: FileNode[]; node: FileNode | null } {
  let found: FileNode | null = null
  const nextFiles = files.flatMap((node) => {
    if (isNodeMatch(node, kind, entityId, oldPath)) {
      found = node
      return []
    }
    if (node.children) {
      const result = extractFileTreeNode(node.children, kind, entityId, oldPath)
      if (result.node) found = result.node
      return [{ ...node, children: result.files }]
    }
    return [node]
  })

  return { files: nextFiles, node: found }
}

function insertExistingNode(files: FileNode[], node: FileNode): FileNode[] {
  const parts = stripTrailingSlash(node.path).split('/').filter(Boolean)
  if (parts.length === 0) return files

  const insert = (nodes: FileNode[], depth: number, prefix: string): FileNode[] => {
    const name = parts[depth]
    const isLeaf = depth === parts.length - 1
    const currentPath = isLeaf ? node.path : `${prefix}${name}/`
    const index = nodes.findIndex((candidate) => candidate.path === currentPath)

    if (isLeaf) {
      return withNode(nodes, index, node)
    }

    const existing = index >= 0 ? nodes[index] : undefined
    const folderNode: FileNode = {
      name,
      path: currentPath,
      isDir: true,
      folderId: existing?.folderId,
      children: insert(existing?.children ?? [], depth + 1, currentPath)
    }

    return withNode(nodes, index, folderNode)
  }

  return insert(files, 0, '')
}

function moveFileTreeNode(files: FileNode[], entity: SyncEntityMoved): FileNode[] {
  const { files: withoutNode, node } = extractFileTreeNode(files, entity.kind, entity.entityId, entity.oldPath)
  if (!node) return files

  const newPath = normalizePath(entity.newPath, entity.kind)
  const movedNode: FileNode = {
    ...node,
    path: newPath,
    children: node.isDir
      ? node.children?.map((child) => rewriteNodePath(child, entity.oldPath, entity.newPath))
      : node.children
  }

  return insertExistingNode(withoutNode, movedNode)
}

function isAffectedPath(path: string, kind: SyncEntityKind, relPath: string): boolean {
  if (kind !== 'folder') return path === normalizePath(relPath, kind)
  const prefix = normalizePath(relPath, 'folder')
  return path.startsWith(prefix)
}

function rewritePath(path: string, kind: SyncEntityKind, oldPath: string, newPath: string): string {
  if (kind !== 'folder') {
    return path === normalizePath(oldPath, kind) ? normalizePath(newPath, kind) : path
  }

  const oldPrefix = normalizePath(oldPath, 'folder')
  const newPrefix = normalizePath(newPath, 'folder')
  return path.startsWith(oldPrefix) ? newPrefix + path.slice(oldPrefix.length) : path
}

function rewriteDocMaps(
  docPathMap: Record<string, string>,
  kind: SyncEntityKind,
  entityId: string,
  oldPath: string,
  newPath: string
) {
  const nextDocPathMap: Record<string, string> = {}
  const nextPathDocMap: Record<string, string> = {}

  for (const [docId, path] of Object.entries(docPathMap)) {
    const rewritten = kind === 'doc' && docId === entityId
      ? normalizePath(newPath, 'doc')
      : rewritePath(path, kind, oldPath, newPath)
    nextDocPathMap[docId] = rewritten
    nextPathDocMap[rewritten] = docId
  }

  return { docPathMap: nextDocPathMap, pathDocMap: nextPathDocMap }
}

function rewriteFileRefs(
  fileRefs: Array<{ id: string; path: string }>,
  kind: SyncEntityKind,
  entityId: string,
  oldPath: string,
  newPath: string
) {
  return fileRefs.map((ref) => ({
    ...ref,
    path: kind === 'file' && ref.id === entityId
      ? normalizePath(newPath, 'file')
      : rewritePath(ref.path, kind, oldPath, newPath)
  }))
}

function rewriteOpenState(
  openTabs: Array<{ path: string; name: string; modified: boolean }>,
  activeTab: string | null,
  fileContents: Record<string, string>,
  kind: SyncEntityKind,
  oldPath: string,
  newPath: string
) {
  const nextOpenTabs = openTabs.map((tab) => {
    const path = rewritePath(tab.path, kind, oldPath, newPath)
    return {
      ...tab,
      path,
      name: path.split('/').pop() || tab.name
    }
  })
  const nextActiveTab = activeTab ? rewritePath(activeTab, kind, oldPath, newPath) : activeTab
  const nextFileContents: Record<string, string> = {}
  for (const [path, content] of Object.entries(fileContents)) {
    nextFileContents[rewritePath(path, kind, oldPath, newPath)] = content
  }

  return { openTabs: nextOpenTabs, activeTab: nextActiveTab, fileContents: nextFileContents }
}

function removeOpenState(
  openTabs: Array<{ path: string; name: string; modified: boolean }>,
  activeTab: string | null,
  fileContents: Record<string, string>,
  kind: SyncEntityKind,
  relPath: string
) {
  const nextOpenTabs = openTabs.filter((tab) => !isAffectedPath(tab.path, kind, relPath))
  const nextActiveTab = activeTab && isAffectedPath(activeTab, kind, relPath)
    ? (nextOpenTabs[nextOpenTabs.length - 1]?.path ?? null)
    : activeTab
  const nextFileContents: Record<string, string> = {}
  for (const [path, content] of Object.entries(fileContents)) {
    if (!isAffectedPath(path, kind, relPath)) nextFileContents[path] = content
  }

  return { openTabs: nextOpenTabs, activeTab: nextActiveTab, fileContents: nextFileContents }
}

export function applyEntityCreated(entity: SyncEntityCreated): void {
  useAppStore.setState((state) => {
    const files = upsertFileTreeNode(state.files, entity)
    const docPathMap = { ...state.docPathMap }
    const pathDocMap = { ...state.pathDocMap }
    let fileRefs = state.fileRefs

    if (entity.kind === 'doc') {
      const relPath = normalizePath(entity.relPath, entity.kind)
      docPathMap[entity.entityId] = relPath
      pathDocMap[relPath] = entity.entityId
    } else if (entity.kind === 'file') {
      const relPath = normalizePath(entity.relPath, entity.kind)
      fileRefs = [
        ...state.fileRefs.filter((ref) => ref.id !== entity.entityId && ref.path !== relPath),
        { id: entity.entityId, path: relPath }
      ]
    }

    return { files, docPathMap, pathDocMap, fileRefs }
  })
}

export function applyEntityRemoved(entity: SyncEntityRemoved): void {
  useAppStore.setState((state) => {
    const relPath = normalizePath(entity.relPath, entity.kind)
    const files = removeFileTreeNode(state.files, entity)
    const docPathMap: Record<string, string> = {}
    const pathDocMap: Record<string, string> = {}

    for (const [docId, path] of Object.entries(state.docPathMap)) {
      if (entity.kind === 'doc' ? docId === entity.entityId : isAffectedPath(path, entity.kind, relPath)) {
        continue
      }
      docPathMap[docId] = path
      pathDocMap[path] = docId
    }

    const fileRefs = state.fileRefs.filter((ref) => (
      entity.kind === 'file'
        ? ref.id !== entity.entityId
        : !isAffectedPath(ref.path, entity.kind, relPath)
    ))
    const openState = removeOpenState(state.openTabs, state.activeTab, state.fileContents, entity.kind, relPath)
    const mainDocument = entity.kind === 'doc' && state.mainDocument === entity.entityId
      ? null
      : state.mainDocument

    return { files, docPathMap, pathDocMap, fileRefs, mainDocument, ...openState }
  })
}

export function applyEntityRenamed(entity: SyncEntityRenamed): void {
  useAppStore.setState((state) => {
    const files = renameFileTreeNode(state.files, entity)
    const maps = rewriteDocMaps(state.docPathMap, entity.kind, entity.entityId, entity.oldPath, entity.newPath)
    const fileRefs = rewriteFileRefs(state.fileRefs, entity.kind, entity.entityId, entity.oldPath, entity.newPath)
    const openState = rewriteOpenState(
      state.openTabs,
      state.activeTab,
      state.fileContents,
      entity.kind,
      entity.oldPath,
      entity.newPath
    )

    return { files, ...maps, fileRefs, ...openState }
  })
}

export function applyEntityMoved(entity: SyncEntityMoved): void {
  useAppStore.setState((state) => {
    const files = moveFileTreeNode(state.files, entity)
    const maps = rewriteDocMaps(state.docPathMap, entity.kind, entity.entityId, entity.oldPath, entity.newPath)
    const fileRefs = rewriteFileRefs(state.fileRefs, entity.kind, entity.entityId, entity.oldPath, entity.newPath)
    const openState = rewriteOpenState(
      state.openTabs,
      state.activeTab,
      state.fileContents,
      entity.kind,
      entity.oldPath,
      entity.newPath
    )

    return { files, ...maps, fileRefs, ...openState }
  })
}
