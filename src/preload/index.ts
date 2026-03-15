// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import { createHash } from 'crypto'

// Prevent Electron's built-in Ctrl+wheel zoom so editor can handle font scaling
webFrame.setVisualZoomLevelLimits(1, 1)
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) e.preventDefault()
}, { passive: false })

const api = {
  // File system
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  readBinary: (path: string) => ipcRenderer.invoke('fs:readBinary', path) as Promise<ArrayBuffer>,

  // LaTeX
  onCompileLog: (cb: (log: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, log: string) => cb(log)
    ipcRenderer.on('latex:log', handler)
    return () => ipcRenderer.removeListener('latex:log', handler)
  },

  // Terminal (supports multiple named instances)
  ptySpawn: (id: string, cwd: string, cmd?: string, args?: string[]) => ipcRenderer.invoke('pty:spawn', id, cwd, cmd, args),
  ptyWrite: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyKill: (id: string) => ipcRenderer.invoke('pty:kill', id),
  onPtyData: (id: string, cb: (data: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on(`pty:data:${id}`, handler)
    return () => ipcRenderer.removeListener(`pty:data:${id}`, handler)
  },
  onPtyExit: (id: string, cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on(`pty:exit:${id}`, handler)
    return () => ipcRenderer.removeListener(`pty:exit:${id}`, handler)
  },

  // SyncTeX
  synctexEdit: (pdfPath: string, page: number, x: number, y: number) =>
    ipcRenderer.invoke('synctex:editFromPdf', pdfPath, page, x, y) as Promise<{ file: string; line: number } | null>,
  synctexView: (line: number, col: number, relPath: string) =>
    ipcRenderer.invoke('synctex:viewFromSource', line, col, relPath) as Promise<{ page: number; x: number; y: number; h: number; v: number; W: number; H: number } | null>,

  // Multi-file search
  searchFiles: (query: string, caseSensitive: boolean) =>
    ipcRenderer.invoke('search:files', query, caseSensitive) as Promise<Array<{ file: string; line: number; content: string; col: number }>>,

  // Overleaf web session (comments)
  overleafWebLogin: () => ipcRenderer.invoke('overleaf:webLogin') as Promise<{ success: boolean }>,
  overleafHasWebSession: () => ipcRenderer.invoke('overleaf:hasWebSession') as Promise<{ loggedIn: boolean }>,
  overleafGetThreads: (projectId: string) =>
    ipcRenderer.invoke('overleaf:getThreads', projectId) as Promise<{ success: boolean; threads?: Record<string, unknown>; message?: string }>,
  overleafReplyThread: (projectId: string, threadId: string, content: string) =>
    ipcRenderer.invoke('overleaf:replyThread', projectId, threadId, content) as Promise<{ success: boolean }>,
  overleafResolveThread: (projectId: string, threadId: string, docId?: string) =>
    ipcRenderer.invoke('overleaf:resolveThread', projectId, threadId, docId) as Promise<{ success: boolean }>,
  overleafReopenThread: (projectId: string, threadId: string, docId?: string) =>
    ipcRenderer.invoke('overleaf:reopenThread', projectId, threadId, docId) as Promise<{ success: boolean }>,
  overleafDeleteMessage: (projectId: string, threadId: string, messageId: string) =>
    ipcRenderer.invoke('overleaf:deleteMessage', projectId, threadId, messageId) as Promise<{ success: boolean }>,
  overleafEditMessage: (projectId: string, threadId: string, messageId: string, content: string) =>
    ipcRenderer.invoke('overleaf:editMessage', projectId, threadId, messageId, content) as Promise<{ success: boolean }>,
  overleafDeleteThread: (projectId: string, docId: string, threadId: string) =>
    ipcRenderer.invoke('overleaf:deleteThread', projectId, docId, threadId) as Promise<{ success: boolean }>,
  overleafAddComment: (projectId: string, docId: string, pos: number, text: string, content: string) =>
    ipcRenderer.invoke('overleaf:addComment', projectId, docId, pos, text, content) as Promise<{ success: boolean; threadId?: string; message?: string }>,

  // OT / Socket mode
  otConnect: (projectId: string) =>
    ipcRenderer.invoke('ot:connect', projectId) as Promise<{
      success: boolean
      files?: unknown[]
      project?: { name: string; rootDocId: string }
      docPathMap?: Record<string, string>
      pathDocMap?: Record<string, string>
      fileRefs?: Array<{ id: string; path: string }>
      rootFolderId?: string
      syncDir?: string
      cachedPdfPath?: string
      message?: string
    }>,
  otDisconnect: () => ipcRenderer.invoke('ot:disconnect'),
  otJoinDoc: (docId: string) =>
    ipcRenderer.invoke('ot:joinDoc', docId) as Promise<{
      success: boolean
      content?: string
      version?: number
      ranges?: { comments: Array<{ id: string; op: { c: string; p: number; t: string } }>; changes: unknown[] }
      message?: string
    }>,
  otLeaveDoc: (docId: string) => ipcRenderer.invoke('ot:leaveDoc', docId),
  otSendOp: (docId: string, ops: unknown[], version: number, hash: string) =>
    ipcRenderer.invoke('ot:sendOp', docId, ops, version, hash),
  otFetchAllCommentContexts: () =>
    ipcRenderer.invoke('ot:fetchAllCommentContexts') as Promise<{
      success: boolean
      contexts?: Record<string, { file: string; text: string; pos: number }>
    }>,
  onOtRemoteOp: (cb: (data: { docId: string; ops: unknown[]; version: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { docId: string; ops: unknown[]; version: number }) => cb(data)
    ipcRenderer.on('ot:remoteOp', handler)
    return () => ipcRenderer.removeListener('ot:remoteOp', handler)
  },
  onOtAck: (cb: (data: { docId: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { docId: string }) => cb(data)
    ipcRenderer.on('ot:ack', handler)
    return () => ipcRenderer.removeListener('ot:ack', handler)
  },
  onOtConnectionState: (cb: (state: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: string) => cb(state)
    ipcRenderer.on('ot:connectionState', handler)
    return () => ipcRenderer.removeListener('ot:connectionState', handler)
  },
  onOtDocRejoined: (cb: (data: { docId: string; content: string; version: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { docId: string; content: string; version: number }) => cb(data)
    ipcRenderer.on('ot:docRejoined', handler)
    return () => ipcRenderer.removeListener('ot:docRejoined', handler)
  },
  overleafListProjects: () =>
    ipcRenderer.invoke('overleaf:listProjects') as Promise<{
      success: boolean
      projects?: Array<{
        id: string; name: string; lastUpdated: string
        owner?: { firstName: string; lastName: string; email?: string }
        lastUpdatedBy?: { firstName: string; lastName: string } | null
        accessLevel?: string; source?: string
      }>
      message?: string
    }>,
  overleafCreateProject: (name: string) =>
    ipcRenderer.invoke('overleaf:createProject', name) as Promise<{
      success: boolean; projectId?: string; message?: string
    }>,
  overleafUploadProject: () =>
    ipcRenderer.invoke('overleaf:uploadProject') as Promise<{
      success: boolean; projectId?: string; message?: string
    }>,
  overleafSocketCompile: (mainTexRelPath: string) =>
    ipcRenderer.invoke('overleaf:socketCompile', mainTexRelPath) as Promise<{
      success: boolean; log: string; pdfPath: string
    }>,
  overleafServerCompile: (rootDocId?: string) =>
    ipcRenderer.invoke('overleaf:serverCompile', rootDocId) as Promise<{
      success: boolean; log: string; pdfPath: string
    }>,
  overleafRenameEntity: (projectId: string, entityType: string, entityId: string, newName: string) =>
    ipcRenderer.invoke('overleaf:renameEntity', projectId, entityType, entityId, newName) as Promise<{ success: boolean; message?: string }>,
  overleafDeleteEntity: (projectId: string, entityType: string, entityId: string) =>
    ipcRenderer.invoke('overleaf:deleteEntity', projectId, entityType, entityId) as Promise<{ success: boolean; message?: string }>,
  overleafCreateDoc: (projectId: string, parentFolderId: string, name: string) =>
    ipcRenderer.invoke('overleaf:createDoc', projectId, parentFolderId, name) as Promise<{ success: boolean; data?: unknown; message?: string }>,
  overleafCreateFolder: (projectId: string, parentFolderId: string, name: string) =>
    ipcRenderer.invoke('overleaf:createFolder', projectId, parentFolderId, name) as Promise<{ success: boolean; data?: unknown; message?: string }>,
  uploadFileToProject: (projectId: string, folderId: string, filePath: string, fileName: string) =>
    ipcRenderer.invoke('project:uploadFile', projectId, folderId, filePath, fileName) as Promise<{ success: boolean; message?: string }>,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  sha1: (text: string): string => createHash('sha1').update(text).digest('hex'),

  // File sync bridge
  onSyncExternalEdit: (cb: (data: { docId: string; content: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { docId: string; content: string }) => cb(data)
    ipcRenderer.on('sync:externalEdit', handler)
    return () => ipcRenderer.removeListener('sync:externalEdit', handler)
  },
  syncContentChanged: (docId: string, content: string) =>
    ipcRenderer.invoke('sync:contentChanged', docId, content),
  onSyncNewDoc: (cb: (data: { docId: string | null; relPath: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { docId: string | null; relPath: string }) => cb(data)
    ipcRenderer.on('sync:newDoc', handler)
    return () => ipcRenderer.removeListener('sync:newDoc', handler)
  },

  // Cursor tracking
  cursorUpdate: (docId: string, row: number, column: number) =>
    ipcRenderer.invoke('cursor:update', docId, row, column),
  cursorGetConnectedUsers: () =>
    ipcRenderer.invoke('cursor:getConnectedUsers') as Promise<unknown[]>,
  onCursorRemoteUpdate: (cb: (data: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data)
    ipcRenderer.on('cursor:remoteUpdate', handler)
    return () => ipcRenderer.removeListener('cursor:remoteUpdate', handler)
  },
  onCursorRemoteDisconnected: (cb: (clientId: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, clientId: string) => cb(clientId)
    ipcRenderer.on('cursor:remoteDisconnected', handler)
    return () => ipcRenderer.removeListener('cursor:remoteDisconnected', handler)
  },

  // Chat
  chatGetMessages: (projectId: string, limit?: number) =>
    ipcRenderer.invoke('chat:getMessages', projectId, limit) as Promise<{ success: boolean; messages: unknown[] }>,
  chatSendMessage: (projectId: string, content: string) =>
    ipcRenderer.invoke('chat:sendMessage', projectId, content) as Promise<{ success: boolean }>,
  onChatMessage: (cb: (msg: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, msg: unknown) => cb(msg)
    ipcRenderer.on('chat:newMessage', handler)
    return () => ipcRenderer.removeListener('chat:newMessage', handler)
  },

  // Comments real-time events
  onCommentsEvent: (cb: (event: { type: string; args: unknown[] }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { type: string; args: unknown[] }) => cb(event)
    ipcRenderer.on('comments:event', handler)
    return () => ipcRenderer.removeListener('comments:event', handler)
  },
  onCommentsInitThreads: (cb: (data: { threads: Record<string, unknown>; resolvedIds: string[] }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { threads: Record<string, unknown>; resolvedIds: string[] }) => cb(data)
    ipcRenderer.on('comments:initThreads', handler)
    return () => ipcRenderer.removeListener('comments:initThreads', handler)
  },
  onCommentsInitContexts: (cb: (data: { contexts: Record<string, { file: string; text: string; pos: number }> }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { contexts: Record<string, { file: string; text: string; pos: number }> }) => cb(data)
    ipcRenderer.on('comments:initContexts', handler)
    return () => ipcRenderer.removeListener('comments:initContexts', handler)
  },

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  showInFinder: (path: string) => ipcRenderer.invoke('shell:showInFinder', path),
  savePdf: (sourcePath: string) =>
    ipcRenderer.invoke('shell:savePdf', sourcePath) as Promise<{ success: boolean; path?: string }>
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
