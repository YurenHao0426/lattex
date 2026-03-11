import { create } from 'zustand'

interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

interface OpenTab {
  path: string
  name: string
  modified: boolean
}

interface AppState {
  // Project
  projectPath: string | null
  setProjectPath: (p: string | null) => void

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

  // Main document
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

  // Git/Overleaf
  isGitRepo: boolean
  setIsGitRepo: (v: boolean) => void
  gitStatus: string
  setGitStatus: (s: string) => void

  // Navigation (from log click → editor)
  pendingGoTo: { file: string; line: number } | null
  setPendingGoTo: (g: { file: string; line: number } | null) => void

  // Status
  statusMessage: string
  setStatusMessage: (m: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  projectPath: null,
  setProjectPath: (p) => set({ projectPath: p }),

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

  isGitRepo: false,
  setIsGitRepo: (v) => set({ isGitRepo: v }),
  gitStatus: '',
  setGitStatus: (s) => set({ gitStatus: s }),

  pendingGoTo: null,
  setPendingGoTo: (g) => set({ pendingGoTo: g }),

  statusMessage: 'Ready',
  setStatusMessage: (m) => set({ statusMessage: m })
}))
