import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // File system
  openProject: () => ipcRenderer.invoke('dialog:openProject'),
  selectSaveDir: () => ipcRenderer.invoke('dialog:selectSaveDir'),
  readDir: (path: string) => ipcRenderer.invoke('fs:readDir', path),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  findMainTex: (dir: string) => ipcRenderer.invoke('fs:findMainTex', dir) as Promise<string | null>,
  readBinary: (path: string) => ipcRenderer.invoke('fs:readBinary', path) as Promise<ArrayBuffer>,
  writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
  createFile: (dir: string, name: string) => ipcRenderer.invoke('fs:createFile', dir, name),
  createDir: (dir: string, name: string) => ipcRenderer.invoke('fs:createDir', dir, name),
  renameFile: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  deleteFile: (path: string) => ipcRenderer.invoke('fs:delete', path),
  fileStat: (path: string) => ipcRenderer.invoke('fs:stat', path),

  // File watcher
  watchStart: (path: string) => ipcRenderer.invoke('watcher:start', path),
  watchStop: () => ipcRenderer.invoke('watcher:stop'),
  onWatchChange: (cb: (data: { event: string; path: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { event: string; path: string }) => cb(data)
    ipcRenderer.on('watcher:change', handler)
    return () => ipcRenderer.removeListener('watcher:change', handler)
  },

  // LaTeX
  compile: (path: string) => ipcRenderer.invoke('latex:compile', path),
  getPdfPath: (texPath: string) => ipcRenderer.invoke('latex:getPdfPath', texPath),
  onCompileLog: (cb: (log: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, log: string) => cb(log)
    ipcRenderer.on('latex:log', handler)
    return () => ipcRenderer.removeListener('latex:log', handler)
  },

  // Terminal
  ptySpawn: (cwd: string) => ipcRenderer.invoke('pty:spawn', cwd),
  ptyWrite: (data: string) => ipcRenderer.invoke('pty:write', data),
  ptyResize: (cols: number, rows: number) => ipcRenderer.invoke('pty:resize', cols, rows),
  ptyKill: () => ipcRenderer.invoke('pty:kill'),
  onPtyData: (cb: (data: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
  onPtyExit: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  },

  // Overleaf
  overleafCloneWithAuth: (projectId: string, dest: string, token: string, remember: boolean) =>
    ipcRenderer.invoke('overleaf:cloneWithAuth', projectId, dest, token, remember) as Promise<{ success: boolean; message: string; detail: string }>,
  overleafCheck: () => ipcRenderer.invoke('overleaf:check') as Promise<{ loggedIn: boolean; email: string }>,
  overleafLogout: () => ipcRenderer.invoke('overleaf:logout'),
  gitPull: (cwd: string) => ipcRenderer.invoke('git:pull', cwd),
  gitPush: (cwd: string) => ipcRenderer.invoke('git:push', cwd),
  gitStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),

  // SyncTeX
  synctexEdit: (pdfPath: string, page: number, x: number, y: number) =>
    ipcRenderer.invoke('synctex:editFromPdf', pdfPath, page, x, y) as Promise<{ file: string; line: number } | null>,
  synctexView: (texPath: string, line: number, pdfPath: string) =>
    ipcRenderer.invoke('synctex:viewFromSource', texPath, line, pdfPath) as Promise<{ page: number; x: number; y: number } | null>,

  // LaTeX package management
  installTexPackages: (packages: string[]) =>
    ipcRenderer.invoke('latex:installPackages', packages) as Promise<{ success: boolean; message: string; packages?: string[] }>,

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  showInFinder: (path: string) => ipcRenderer.invoke('shell:showInFinder', path)
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
