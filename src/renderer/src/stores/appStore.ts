// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { create } from 'zustand'

export interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
  docId?: string
  fileRefId?: string
  folderId?: string
}

export type SocketConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/** Which screen is currently active */
export type AppScreen = 'login' | 'projects' | 'editor'

interface OpenTab {
  path: string
  name: string
  modified: boolean
}

export interface CommentContext {
  file: string
  text: string
  pos: number
}

interface AppState {
  // Screen
  screen: AppScreen
  setScreen: (s: AppScreen) => void

  // File tree
  files: FileNode[]
  setFiles: (f: FileNode[]) => void

  // Editor tabs
  openTabs: OpenTab[]
  activeTab: string | null
  openFile: (path: string, name: string) => void
  closeTab: (path: string) => void
  setActiveTab: (path: string) => void
  markModified: (path: string, modified: boolean) => void

  // Editor content cache
  fileContents: Record<string, string>
  setFileContent: (path: string, content: string) => void

  // Main document (rootDocId)
  mainDocument: string | null
  setMainDocument: (p: string | null) => void

  // PDF
  pdfPath: string | null
  setPdfPath: (p: string | null) => void

  // Compile
  compiling: boolean
  setCompiling: (c: boolean) => void
  compileLog: string
  appendCompileLog: (log: string) => void
  clearCompileLog: () => void

  // Panels
  showTerminal: boolean
  toggleTerminal: () => void
  showFileTree: boolean
  toggleFileTree: () => void

  // Overleaf
  overleafProjectId: string | null
  setOverleafProjectId: (id: string | null) => void

  // Socket connection
  connectionState: SocketConnectionState
  setConnectionState: (s: SocketConnectionState) => void
  docPathMap: Record<string, string>   // docId → relativePath
  pathDocMap: Record<string, string>   // relativePath → docId
  setDocMaps: (docPath: Record<string, string>, pathDoc: Record<string, string>) => void
  docVersions: Record<string, number>  // docId → version
  setDocVersion: (docId: string, version: number) => void
  overleafProject: { name: string; rootDocId: string } | null
  setOverleafProject: (p: { name: string; rootDocId: string } | null) => void
  fileRefs: Array<{ id: string; path: string }>
  setFileRefs: (refs: Array<{ id: string; path: string }>) => void
  rootFolderId: string
  setRootFolderId: (id: string) => void
  syncDir: string
  setSyncDir: (dir: string) => void

  // Review panel
  showReviewPanel: boolean
  toggleReviewPanel: () => void

  // Chat panel
  showChat: boolean
  toggleChat: () => void

  // Connected users count
  onlineUsersCount: number
  setOnlineUsersCount: (n: number) => void

  // Comment data
  commentContexts: Record<string, CommentContext>
  setCommentContexts: (c: Record<string, CommentContext>) => void
  overleafDocs: Record<string, string>
  setOverleafDocs: (d: Record<string, string>) => void
  hoveredThreadId: string | null
  setHoveredThreadId: (id: string | null) => void
  focusedThreadId: string | null
  setFocusedThreadId: (id: string | null) => void

  // Navigation
  pendingGoTo: { file: string; line?: number; pos?: number; highlight?: string } | null
  setPendingGoTo: (g: { file: string; line?: number; pos?: number; highlight?: string } | null) => void

  // Status
  statusMessage: string
  setStatusMessage: (m: string) => void

  // Reset editor state (when going back to project list)
  resetEditorState: () => void
}

export const useAppStore = create<AppState>((set) => ({
  screen: 'login',
  setScreen: (s) => set({ screen: s }),

  files: [],
  setFiles: (f) => set({ files: f }),

  openTabs: [],
  activeTab: null,
  openFile: (path, name) =>
    set((s) => {
      const exists = s.openTabs.find((t) => t.path === path)
      if (exists) return { activeTab: path }
      return {
        openTabs: [...s.openTabs, { path, name, modified: false }],
        activeTab: path
      }
    }),
  closeTab: (path) =>
    set((s) => {
      const tabs = s.openTabs.filter((t) => t.path !== path)
      const newContents = { ...s.fileContents }
      delete newContents[path]
      return {
        openTabs: tabs,
        activeTab: s.activeTab === path ? (tabs[tabs.length - 1]?.path ?? null) : s.activeTab,
        fileContents: newContents
      }
    }),
  setActiveTab: (path) => set({ activeTab: path }),
  markModified: (path, modified) =>
    set((s) => ({
      openTabs: s.openTabs.map((t) => (t.path === path ? { ...t, modified } : t))
    })),

  fileContents: {},
  setFileContent: (path, content) =>
    set((s) => ({ fileContents: { ...s.fileContents, [path]: content } })),

  mainDocument: null,
  setMainDocument: (p) => set({ mainDocument: p }),

  pdfPath: null,
  setPdfPath: (p) => set({ pdfPath: p }),

  compiling: false,
  setCompiling: (c) => set({ compiling: c }),
  compileLog: '',
  appendCompileLog: (log) => set((s) => ({ compileLog: s.compileLog + log })),
  clearCompileLog: () => set({ compileLog: '' }),

  showTerminal: true,
  toggleTerminal: () => set((s) => ({ showTerminal: !s.showTerminal })),
  showFileTree: true,
  toggleFileTree: () => set((s) => ({ showFileTree: !s.showFileTree })),

  overleafProjectId: null,
  setOverleafProjectId: (id) => set({ overleafProjectId: id }),

  connectionState: 'disconnected',
  setConnectionState: (s) => set({ connectionState: s }),
  docPathMap: {},
  pathDocMap: {},
  setDocMaps: (docPath, pathDoc) => set({ docPathMap: docPath, pathDocMap: pathDoc }),
  docVersions: {},
  setDocVersion: (docId, version) =>
    set((s) => ({ docVersions: { ...s.docVersions, [docId]: version } })),
  overleafProject: null,
  setOverleafProject: (p) => set({ overleafProject: p }),
  fileRefs: [],
  setFileRefs: (refs) => set({ fileRefs: refs }),
  rootFolderId: '',
  setRootFolderId: (id) => set({ rootFolderId: id }),
  syncDir: '',
  setSyncDir: (dir) => set({ syncDir: dir }),

  showReviewPanel: false,
  toggleReviewPanel: () => set((s) => ({ showReviewPanel: !s.showReviewPanel })),

  showChat: false,
  toggleChat: () => set((s) => ({ showChat: !s.showChat })),

  onlineUsersCount: 0,
  setOnlineUsersCount: (n) => set({ onlineUsersCount: n }),

  commentContexts: {},
  setCommentContexts: (c) => set({ commentContexts: c }),
  overleafDocs: {},
  setOverleafDocs: (d) => set({ overleafDocs: d }),
  hoveredThreadId: null,
  setHoveredThreadId: (id) => set({ hoveredThreadId: id }),
  focusedThreadId: null,
  setFocusedThreadId: (id) => set({ focusedThreadId: id }),

  pendingGoTo: null,
  setPendingGoTo: (g) => set({ pendingGoTo: g }),

  statusMessage: 'Ready',
  setStatusMessage: (m) => set({ statusMessage: m }),

  resetEditorState: () => set({
    files: [],
    openTabs: [],
    activeTab: null,
    fileContents: {},
    mainDocument: null,
    pdfPath: null,
    compileLog: '',
    compiling: false,
    overleafProjectId: null,
    connectionState: 'disconnected',
    docPathMap: {},
    pathDocMap: {},
    docVersions: {},
    overleafProject: null,
    fileRefs: [],
    rootFolderId: '',
    syncDir: '',
    commentContexts: {},
    overleafDocs: {},
    hoveredThreadId: null,
    focusedThreadId: null,
    pendingGoTo: null,
    statusMessage: 'Ready',
    showChat: false,
    onlineUsersCount: 0
  })
}))
