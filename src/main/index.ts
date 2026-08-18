// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, net } from 'electron'
import { join, basename, dirname, relative, extname, delimiter } from 'path'
import { copyFile, readFile, writeFile, mkdir as mkdirAsync, unlink, readdir, stat, rename as fsRename, rm, cp } from 'fs/promises'
import { existsSync, createWriteStream } from 'fs'
import { spawn } from 'child_process'
import * as pty from 'node-pty'
import { OverleafSocket, type RootFolder, type SubFolder, type JoinDocResult } from './overleafSocket'
import { CompilationManager } from './compilationManager'
import { FileSyncBridge } from './fileSyncBridge'

// Prevent EPIPE crashes when stdout/stderr is closed (e.g. Electron launched from Finder)
process.stdout?.on('error', () => {})
process.stderr?.on('error', () => {})

let mainWindow: BrowserWindow | null = null   // persistent project-list window
// PTYs are per-window: keyed by `${webContents.id}:${terminalId}` so two
// project windows can both have a "term-1" without clobbering each other.
const ptyInstances = new Map<string, pty.IPty>()

/**
 * All per-project state, one instance per open project tab. Each tab is a
 * WebContentsView with its own webContents, whose id is the session key:
 * every IPC call from a project tab resolves its own session via event.sender.
 */
interface ProjectSession {
  projectId: string
  contents: Electron.WebContents
  webContentsId: number
  sock: OverleafSocket
  compilationManager: CompilationManager
  fileSyncBridge: FileSyncBridge | null
  /** per-doc otUpdateApplied relays, for cleanup on leaveDoc */
  docEventHandlers: Map<string, (name: string, args: unknown[]) => void>
  mcpStateDir: string
  mcpCommentContexts: Record<string, { file: string; text: string; pos: number }>
  mcpPathDocMap: Record<string, string>
  mcpOnlineUsers: Map<string, { name: string; email?: string }>
  mcpOnlineUsersWriteTimer: ReturnType<typeof setTimeout> | null
  commentContextRefreshTimer: ReturnType<typeof setTimeout> | null
  mcpCompileRequestPath: string | null
  mcpCompileActive: boolean
  compileInProgress: Promise<{ success: boolean; log: string; pdfPath: string }> | null
}

const sessions = new Map<number, ProjectSession>()          // webContents.id → session
const sessionsByProject = new Map<string, ProjectSession>() // projectId → session

function getSession(e: Electron.IpcMainInvokeEvent): ProjectSession | undefined {
  return sessions.get(e.sender.id)
}

/** Send IPC to one session's tab — no-op if its webContents is gone */
function sessionSend(s: ProjectSession, channel: string, ...args: unknown[]) {
  if (!s.contents.isDestroyed()) {
    s.contents.send(channel, ...args)
  }
}

/** Send IPC to the home renderer and every project tab */
function broadcast(channel: string, ...args: unknown[]) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
  for (const s of sessions.values()) {
    if (!s.contents.isDestroyed()) s.contents.send(channel, ...args)
  }
}

async function writeMcpState(s: ProjectSession): Promise<void> {
  if (!s.mcpStateDir || !s.projectId) return
  try {
    // Read S2 API key if available
    let s2Key: string | undefined
    try {
      const keys = JSON.parse(await readFile(apiKeysPath, 'utf-8'))
      if (keys.semanticScholar) s2Key = keys.semanticScholar
    } catch { /* ignore */ }
    const state: Record<string, unknown> = {
      projectId: s.projectId,
      cookie: overleafSessionCookie,
      csrf: overleafCsrfToken,
      commentContexts: s.mcpCommentContexts,
      pathDocMap: s.mcpPathDocMap
    }
    if (s2Key) state.semanticScholarApiKey = s2Key
    await writeFile(join(s.mcpStateDir, '.lattex-mcp.json'), JSON.stringify(state, null, 2))
  } catch { /* ignore */ }
}

async function prepareMcpServerPath(tmpDir: string): Promise<string> {
  const sourcePath = app.isPackaged
    ? join(app.getAppPath() + '.unpacked', 'out', 'mcp', 'lattex.mjs')
    : join(__dirname, '..', '..', 'src', 'mcp', 'lattex.mjs')

  if (!app.isPackaged) return sourcePath

  // Unsigned macOS apps can be launched from an App Translocation path. That
  // path is not stable enough to persist in .mcp.json, so copy the bundled MCP
  // server into the live project directory and point Claude at the copy.
  const mcpDir = join(tmpDir, '.lattex')
  await mkdirAsync(mcpDir, { recursive: true })
  const serverPath = join(mcpDir, 'lattex-mcp.mjs')
  await copyFile(sourcePath, serverPath)
  return serverPath
}

async function clearDisabledLattexMcpServer(tmpDir: string): Promise<void> {
  const settingsPath = join(tmpDir, '.claude', 'settings.local.json')
  try {
    const raw = await readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(raw) as Record<string, unknown>
    const disabled = settings.disabledMcpjsonServers
    if (!Array.isArray(disabled) || !disabled.includes('lattex')) return

    const nextDisabled = disabled.filter((name) => name !== 'lattex')
    if (nextDisabled.length > 0) {
      settings.disabledMcpjsonServers = nextDisabled
    } else {
      delete settings.disabledMcpjsonServers
    }
    await writeFile(settingsPath, JSON.stringify(settings, null, 2))
  } catch {
    // No local settings yet, or not JSON. Claude can create it later.
  }
}

function scheduleCommentContextRefresh(s: ProjectSession): void {
  if (s.commentContextRefreshTimer) clearTimeout(s.commentContextRefreshTimer)
  s.commentContextRefreshTimer = setTimeout(async () => {
    s.commentContextRefreshTimer = null
    if (!s.sock.projectData) return
    const { docPathMap: dp } = walkRootFolder(s.sock.projectData.project.rootFolder)
    const contexts: Record<string, { file: string; text: string; pos: number }> = {}
    for (const [did, rp] of Object.entries(dp)) {
      try {
        const result = await s.sock.joinDoc(did)
        if (result.ranges?.comments) {
          for (const c of result.ranges.comments) {
            if (c.op?.t) contexts[c.op.t] = { file: rp, text: c.op.c || '', pos: c.op.p || 0 }
          }
        }
        // Don't leaveDoc — bridge keeps all docs joined
      } catch { /* ignore */ }
    }
    s.mcpCommentContexts = contexts
    writeMcpState(s)
    sessionSend(s, 'comments:initContexts', { contexts })
  }, 2000) // 2s debounce
}

function writeMcpOnlineUsers(s: ProjectSession): void {
  if (!s.mcpStateDir) return
  if (s.mcpOnlineUsersWriteTimer) clearTimeout(s.mcpOnlineUsersWriteTimer)
  s.mcpOnlineUsersWriteTimer = setTimeout(() => {
    const users = Array.from(s.mcpOnlineUsers.entries()).map(([id, u]) => ({ id, ...u }))
    writeFile(join(s.mcpStateDir, '.lattex-online-users.json'), JSON.stringify(users)).catch(() => {})
  }, 500)
}

function createListWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    // Frameless inset title bar is a macOS affordance; use the native
    // frame elsewhere
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 15, y: 15 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Disable Electron's built-in pinch/Ctrl+wheel zoom so editor can handle it
  win.webContents.setVisualZoomLevelLimits(1, 1)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('resize', layoutTabs)
  win.on('enter-full-screen', layoutTabs)
  win.on('leave-full-screen', layoutTabs)

  const wcId = win.webContents.id
  win.on('closed', () => {
    // Child views' webContents are destroyed with the window; their
    // 'destroyed' handlers tear the sessions down
    projectTabs.length = 0
    activeTabId = 'home'
    for (const [key, inst] of ptyInstances) {
      if (key.startsWith(`${wcId}:`)) {
        inst.kill()
        ptyInstances.delete(key)
      }
    }
    mainWindow = null
  })

  mainWindow = win
}

// Per-project teardown chain. Sessions of the same project share a sync dir
// (os.tmpdir()/lattex-<projectId>), so a new ot:connect must wait for the
// previous session's async teardown (bridge stop + rm -rf) to finish before
// it starts writing into that dir again.
const projectTeardowns = new Map<string, Promise<void>>()

/** Tear down everything a project window owned. Idempotent. */
function destroySession(s: ProjectSession): Promise<void> {
  if (sessions.get(s.webContentsId) !== s) {
    return projectTeardowns.get(s.projectId) ?? Promise.resolve()
  }
  sessions.delete(s.webContentsId)
  if (sessionsByProject.get(s.projectId) === s) sessionsByProject.delete(s.projectId)

  stopMcpCompileWatcher(s)
  if (s.commentContextRefreshTimer) clearTimeout(s.commentContextRefreshTimer)
  if (s.mcpOnlineUsersWriteTimer) clearTimeout(s.mcpOnlineUsersWriteTimer)
  if (s.mcpStateDir) {
    unlink(join(s.mcpStateDir, '.lattex-mcp.json')).catch(() => {})
    unlink(join(s.mcpStateDir, '.lattex-online-users.json')).catch(() => {})
  }

  const work = (async () => {
    try { await s.fileSyncBridge?.stop() } catch { /* ignore */ }
    s.fileSyncBridge = null
    try { s.sock.disconnect() } catch { /* ignore */ }
    try { await s.compilationManager.cleanup() } catch { /* ignore */ }
  })()
  const prev = projectTeardowns.get(s.projectId) ?? Promise.resolve()
  const chained = prev.then(() => work, () => work)
  projectTeardowns.set(s.projectId, chained.catch(() => {}))
  return chained
}

// ── Project tabs (browser-tab model inside the main window) ─────
//
// The home renderer (project list) fills the window and draws the tab bar in
// its top TAB_BAR_HEIGHT pixels. Each open project is a WebContentsView laid
// out below the tab bar; inactive tabs stay alive (sync keeps running) but
// hidden. Tab strip state is mirrored to the home renderer via 'tabs:changed'.

const TAB_BAR_HEIGHT = 38

interface ProjectTab {
  projectId: string
  view: WebContentsView
  title: string
}

const projectTabs: ProjectTab[] = []
let activeTabId = 'home' // 'home' or a projectId

function tabsState() {
  return {
    tabs: projectTabs.map((t) => ({ id: t.projectId, title: t.title })),
    active: activeTabId
  }
}

function broadcastTabs(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tabs:changed', tabsState())
  }
}

function layoutTabs(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { width, height } = mainWindow.getContentBounds()
  for (const t of projectTabs) {
    const active = t.projectId === activeTabId
    t.view.setVisible(active)
    if (active) {
      t.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) })
    }
  }
}

function activateTab(id: string): void {
  activeTabId = projectTabs.some((t) => t.projectId === id) ? id : 'home'
  layoutTabs()
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (activeTabId === 'home') mainWindow.webContents.focus()
    else projectTabs.find((t) => t.projectId === activeTabId)?.view.webContents.focus()
  }
  broadcastTabs()
}

function closeTab(projectId: string): void {
  const idx = projectTabs.findIndex((t) => t.projectId === projectId)
  if (idx === -1) return
  const [tab] = projectTabs.splice(idx, 1)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(tab.view)
  }
  const wc = tab.view.webContents
  // 'destroyed' handler (set at creation) tears down the session + PTYs
  if (!wc.isDestroyed()) wc.close()
  if (activeTabId === projectId) {
    // Browser behavior: closing the active tab activates a neighbor
    const next = projectTabs[idx] ?? projectTabs[idx - 1]
    activateTab(next ? next.projectId : 'home')
  } else {
    broadcastTabs()
  }
}

/** Open a project in a tab; activate the existing tab if already open */
ipcMain.handle('project:openTab', async (_e, projectId: string, name?: string) => {
  if (projectTabs.some((t) => t.projectId === projectId)) {
    activateTab(projectId)
    return { success: true, focusedExisting: true }
  }
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false }

  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  view.setBackgroundColor('#FFF8E7')
  view.webContents.setVisualZoomLevelLimits(1, 1)

  const wcId = view.webContents.id
  view.webContents.on('destroyed', () => {
    const s = sessions.get(wcId)
    if (s) destroySession(s)
    for (const [key, inst] of ptyInstances) {
      if (key.startsWith(`${wcId}:`)) {
        inst.kill()
        ptyInstances.delete(key)
      }
    }
  })

  // The tab's renderer sets document.title to the project name on connect
  view.webContents.on('page-title-updated', (_ev, title) => {
    const t = projectTabs.find((tab) => tab.projectId === projectId)
    if (t && title && title !== 'LatteX') {
      t.title = title.replace(/ — LatteX$/, '')
      broadcastTabs()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    view.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?projectId=${encodeURIComponent(projectId)}`)
  } else {
    view.webContents.loadFile(join(__dirname, '../renderer/index.html'), { query: { projectId } })
  }

  mainWindow.contentView.addChildView(view)
  projectTabs.push({ projectId, view, title: name || 'Project' })
  activateTab(projectId)
  return { success: true }
})

ipcMain.handle('tabs:list', async () => tabsState())
ipcMain.handle('tabs:activate', async (_e, id: string) => activateTab(id))
ipcMain.handle('tabs:close', async (_e, id: string) => closeTab(id))

// From inside a project tab, "close" closes the tab; from a window, the window
ipcMain.handle('window:close', async (e) => {
  const tab = projectTabs.find((t) => t.view.webContents.id === e.sender.id)
  if (tab) {
    closeTab(tab.projectId)
    return
  }
  BrowserWindow.fromWebContents(e.sender)?.close()
})


ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
  return readFile(filePath, 'utf-8')
})

ipcMain.handle('fs:readBinary', async (_e, filePath: string) => {
  const buffer = await readFile(filePath)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
})

// ── Workspace file operations (agent scratch space browser) ─────

ipcMain.handle('fs:writeFile', async (_e, filePath: string, content: string) => {
  await mkdirAsync(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf-8')
})

interface DiskNode {
  name: string
  path: string
  isDir: boolean
  children?: DiskNode[]
}

// List a directory tree from disk. Paths in the result are `pathPrefix` +
// path relative to rootPath (so the renderer can key tabs consistently).
ipcMain.handle('fs:listDirTree', async (_e, rootPath: string, pathPrefix: string) => {
  const MAX_ENTRIES_PER_DIR = 500
  const MAX_DEPTH = 10

  async function walk(dir: string, rel: string, depth: number): Promise<DiskNode[]> {
    if (depth > MAX_DEPTH) return []
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    entries = entries
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) =>
        (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name)
      )
      .slice(0, MAX_ENTRIES_PER_DIR)

    const nodes: DiskNode[] = []
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: pathPrefix + relPath,
          isDir: true,
          children: await walk(join(dir, entry.name), relPath, depth + 1)
        })
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: pathPrefix + relPath, isDir: false })
      }
    }
    return nodes
  }

  return walk(rootPath, '', 0)
})

ipcMain.handle('fs:mkdirp', async (_e, dirPath: string) => {
  await mkdirAsync(dirPath, { recursive: true })
})

ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string) => {
  await fsRename(oldPath, newPath)
})

ipcMain.handle('fs:deletePath', async (_e, targetPath: string) => {
  await rm(targetPath, { recursive: true, force: true })
})

ipcMain.handle('fs:copyPath', async (_e, src: string, dest: string) => {
  await mkdirAsync(dirname(dest), { recursive: true })
  await cp(src, dest, { recursive: true })
})

ipcMain.handle('fs:exists', async (_e, targetPath: string) => {
  return existsSync(targetPath)
})

// ── API Key Storage ─────────────────────────────────────────────

const apiKeysPath = join(app.getPath('userData'), 'api-keys.json')

ipcMain.handle('settings:getApiKeys', async () => {
  try {
    return JSON.parse(await readFile(apiKeysPath, 'utf-8'))
  } catch {
    return {}
  }
})

ipcMain.handle('settings:setApiKeys', async (_e, keys: Record<string, string>) => {
  await writeFile(apiKeysPath, JSON.stringify(keys, null, 2))
})

// ── LaTeX Compilation ────────────────────────────────────────────

// Ensure TeX binaries are in PATH (GUI-launched apps may miss them)
const texPaths = process.platform === 'win32'
  ? [
      'C:\\texlive\\2025\\bin\\windows',
      'C:\\texlive\\2024\\bin\\windows',
      join(process.env.LOCALAPPDATA || '', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64')
    ]
  : ['/Library/TeX/texbin', '/usr/local/texlive/2024/bin/universal-darwin', '/usr/texbin', '/opt/homebrew/bin']
const currentPath = process.env.PATH || ''
for (const p of texPaths) {
  if (!currentPath.includes(p)) {
    process.env.PATH = `${p}${delimiter}${process.env.PATH}`
  }
}

// SyncTeX: PDF position → source file:line (inverse search)
ipcMain.handle('synctex:editFromPdf', async (e, pdfPath: string, page: number, x: number, y: number) => {
  const session = getSession(e)
  return new Promise<{ file: string; line: number } | null>((resolve) => {
    const pdfDir = dirname(pdfPath)
    console.log(`[synctex] edit -o ${page}:${x}:${y}:${pdfPath} (cwd: ${pdfDir})`)
    const proc = spawn('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdfPath}`], {
      env: process.env,
      cwd: pdfDir
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => {
      console.log(`[synctex] exit=${code} stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 200)}`)
      // Parse output: Input:filename\nLine:123\n...
      const fileMatch = stdout.match(/Input:(.+)/)
      const lineMatch = stdout.match(/Line:(\d+)/)
      if (fileMatch && lineMatch) {
        let filePath = fileMatch[1].trim()
        // Strip CLSI compilation prefix (server compile uses /compile/ as cwd)
        if (filePath.startsWith('/compile/')) {
          filePath = filePath.slice('/compile/'.length)
        }
        // Convert absolute path to relative (strip tmpDir prefix for local compile)
        const syncDir = session?.compilationManager.dir
        if (syncDir && filePath.startsWith(syncDir)) {
          filePath = filePath.slice(syncDir.length).replace(/^\//, '')
        }
        // Normalize path: strip leading ./, collapse /./
        filePath = filePath.replace(/\/\.\//g, '/').replace(/^\.\//, '')
        console.log(`[synctex] resolved: file=${filePath} line=${lineMatch[1]}`)
        resolve({ file: filePath, line: parseInt(lineMatch[1]) })
      } else {
        console.log('[synctex] no match in output')
        resolve(null)
      }
    })
    proc.on('error', (err) => {
      console.log(`[synctex] spawn error: ${err.message}`)
      resolve(null)
    })
  })
})

// SyncTeX: source file:line → PDF page/position (forward search)
ipcMain.handle('synctex:viewFromSource', async (e, line: number, col: number, relPath: string) => {
  const syncDir = getSession(e)?.compilationManager.dir
  if (!syncDir) return null
  // Look for build dir output.pdf
  const buildDir = join(syncDir, '.build')
  const pdfPath = join(buildDir, 'output.pdf')
  const filePath = join(syncDir, relPath)
  const input = `${line}:${col}:${filePath}`
  console.log(`[synctex] view -i ${input} -o ${pdfPath}`)
  return new Promise<{ page: number; x: number; y: number; h: number; v: number; W: number; H: number } | null>((resolve) => {
    const proc = spawn('synctex', ['view', '-i', input, '-o', pdfPath], {
      env: process.env,
      cwd: syncDir
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => {
      console.log(`[synctex] view exit=${code} stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 200)}`)
      const pageMatch = stdout.match(/Page:(\d+)/)
      const xMatch = stdout.match(/x:([0-9.]+)/)
      const yMatch = stdout.match(/y:([0-9.]+)/)
      const hMatch = stdout.match(/h:([0-9.]+)/)
      const vMatch = stdout.match(/v:([0-9.]+)/)
      const wMatch = stdout.match(/W:([0-9.]+)/)
      const hMatch2 = stdout.match(/H:([0-9.]+)/)
      if (pageMatch) {
        resolve({
          page: parseInt(pageMatch[1]),
          x: xMatch ? parseFloat(xMatch[1]) : 0,
          y: yMatch ? parseFloat(yMatch[1]) : 0,
          h: hMatch ? parseFloat(hMatch[1]) : 0,
          v: vMatch ? parseFloat(vMatch[1]) : 0,
          W: wMatch ? parseFloat(wMatch[1]) : 0,
          H: hMatch2 ? parseFloat(hMatch2[1]) : 0
        })
      } else {
        resolve(null)
      }
    })
    proc.on('error', (err) => {
      console.log(`[synctex] view spawn error: ${err.message}`)
      resolve(null)
    })
  })
})

// ── Multi-file search ────────────────────────────────────────────

const TEXT_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md', '.cfg', '.def', '.dtx', '.ins', '.ltx'])

async function walkDir(dir: string, base: string): Promise<string[]> {
  const results: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await walkDir(full, base))
    } else if (TEXT_EXTS.has(extname(entry.name).toLowerCase())) {
      results.push(relative(base, full))
    }
  }
  return results
}

ipcMain.handle('search:files', async (e, query: string, caseSensitive: boolean) => {
  const syncDir = getSession(e)?.compilationManager.dir
  if (!syncDir || !query) return []

  const files = await walkDir(syncDir, syncDir)
  const results: Array<{ file: string; line: number; content: string; col: number }> = []
  const flags = caseSensitive ? 'g' : 'gi'
  let regex: RegExp
  try {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  } catch {
    return []
  }

  for (const relPath of files) {
    if (results.length >= 200) break
    try {
      const content = await readFile(join(syncDir, relPath), 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= 200) break
        const match = regex.exec(lines[i])
        if (match) {
          results.push({ file: relPath, line: i + 1, content: lines[i].trim().slice(0, 200), col: match.index })
          regex.lastIndex = 0 // reset for next line
        }
      }
    } catch { /* skip unreadable files */ }
  }
  return results
})

// ── Terminal / PTY ───────────────────────────────────────────────

ipcMain.handle('pty:spawn', async (e, id: string, cwd: string, cmd?: string, args?: string[]) => {
  const sender = e.sender
  const key = `${sender.id}:${id}`
  const existing = ptyInstances.get(key)
  if (existing) {
    existing.kill()
    ptyInstances.delete(key)
  }

  const shellPath = cmd || (process.platform === 'win32'
    ? process.env.COMSPEC || 'powershell.exe'
    : process.env.SHELL || '/bin/zsh')
  const shellArgs = args || (process.platform === 'win32' ? [] : ['-l'])
  const ptyEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'LatteX',
    LANG: process.env.LANG || 'en_US.UTF-8',
  }
  const instance = pty.spawn(shellPath, shellArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: ptyEnv
  })

  ptyInstances.set(key, instance)

  instance.onData((data) => {
    // Strip DEC 2026 synchronized output sequences — xterm.js may buffer indefinitely
    // if the begin/end markers are split across PTY chunks
    const cleaned = data.replace(/\x1b\[\?2026[hl]/g, '')
    if (cleaned && !sender.isDestroyed()) sender.send(`pty:data:${id}`, cleaned)
  })

  instance.onExit(() => {
    // Only delete if this is still the current instance (avoid race with re-spawn)
    if (ptyInstances.get(key) === instance) {
      if (!sender.isDestroyed()) sender.send(`pty:exit:${id}`)
      ptyInstances.delete(key)
    }
  })
})

ipcMain.handle('pty:write', async (e, id: string, data: string) => {
  ptyInstances.get(`${e.sender.id}:${id}`)?.write(data)
})

ipcMain.handle('pty:resize', async (e, id: string, cols: number, rows: number) => {
  try {
    ptyInstances.get(`${e.sender.id}:${id}`)?.resize(cols, rows)
  } catch { /* ignore resize errors */ }
})

ipcMain.handle('pty:kill', async (e, id: string) => {
  const key = `${e.sender.id}:${id}`
  const instance = ptyInstances.get(key)
  if (instance) {
    instance.kill()
    ptyInstances.delete(key)
  }
})

// ── Overleaf Web Session (for comments) ─────────────────────────

let overleafSessionCookie = ''
let overleafCsrfToken = ''

// Persist cookie to disk
const cookiePath = join(app.getPath('userData'), 'overleaf-session.json')

async function saveOverleafSession(): Promise<void> {
  try {
    await writeFile(cookiePath, JSON.stringify({ cookie: overleafSessionCookie, csrf: overleafCsrfToken }))
  } catch { /* ignore */ }
}

let sessionLoadPromise: Promise<void> | null = null

async function loadOverleafSession(): Promise<void> {
  try {
    const raw = await readFile(cookiePath, 'utf-8')
    const data = JSON.parse(raw)
    if (data.cookie) {
      overleafSessionCookie = data.cookie
      overleafCsrfToken = data.csrf || ''
      console.log('[overleaf] loaded saved session, verifying...')
      // Verify it's still valid
      const result = await overleafFetch('/user/projects')
      if (!result.ok) {
        console.log('[overleaf] saved session expired (status:', result.status, ')')
        overleafSessionCookie = ''
        overleafCsrfToken = ''
      } else {
        console.log('[overleaf] saved session is valid')
      }
    }
  } catch { /* no saved session */ }
}

/**
 * Re-fetch the CSRF token from the projects page (it can rotate/expire).
 * Single-flight: concurrent 403s share one refresh. Validates the session
 * first — when the cookie itself is dead, the /project fetch would redirect
 * to the login page whose (anonymous) CSRF token must not be adopted.
 */
let csrfRefreshInFlight: Promise<boolean> | null = null

function refreshCsrfToken(): Promise<boolean> {
  if (csrfRefreshInFlight) return csrfRefreshInFlight
  csrfRefreshInFlight = (async () => {
    try {
      // Electron's net follows redirects, so an expired session may surface
      // as a 200 login page rather than a 401 — require a JSON body too.
      const session = await overleafFetchRaw('/user/projects')
      if (!session.ok || typeof session.data !== 'object' || session.data === null) {
        console.log('[overleaf] session expired — cannot refresh CSRF token')
        broadcast('auth:sessionExpired')
        return false
      }
      const result = await overleafFetchRaw('/project', { raw: true })
      if (!result.ok || typeof result.data !== 'string') return false
      const m = (result.data as string).match(/ol-csrfToken[^>]*content="([^"]+)"/)
      if (m) {
        overleafCsrfToken = m[1]
        saveOverleafSession()
        return true
      }
      return false
    } finally {
      csrfRefreshInFlight = null
    }
  })()
  return csrfRefreshInFlight
}

// Helper: make authenticated request to Overleaf web API.
// On 403 (stale CSRF token), refreshes the token and retries once.
async function overleafFetch(path: string, options: { method?: string; body?: string; raw?: boolean; cookie?: string } = {}): Promise<{ ok: boolean; status: number; data: unknown; setCookies: string[] }> {
  const result = await overleafFetchRaw(path, options)
  if (result.status === 403 && options.method && options.method !== 'GET') {
    console.log(`[overleaf] 403 on ${options.method} ${path} — refreshing CSRF token and retrying`)
    if (await refreshCsrfToken()) {
      return overleafFetchRaw(path, options)
    }
  }
  return result
}

async function overleafFetchRaw(path: string, options: { method?: string; body?: string; raw?: boolean; cookie?: string } = {}): Promise<{ ok: boolean; status: number; data: unknown; setCookies: string[] }> {
  return new Promise((resolve) => {
    const url = `https://www.overleaf.com${path}`
    const request = net.request({ url, method: options.method || 'GET' })
    request.setHeader('Cookie', options.cookie || overleafSessionCookie)
    request.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36')
    if (!options.raw) {
      request.setHeader('Accept', 'application/json')
    }
    if (options.body) {
      request.setHeader('Content-Type', options.raw ? 'text/plain; charset=UTF-8' : 'application/json')
    }
    if (overleafCsrfToken && options.method && options.method !== 'GET') {
      request.setHeader('x-csrf-token', overleafCsrfToken)
    }

    let body = ''
    request.on('response', (response) => {
      const sc = response.headers['set-cookie']
      const setCookies = Array.isArray(sc) ? sc : sc ? [sc] : []
      response.on('data', (chunk) => { body += chunk.toString() })
      response.on('end', () => {
        let data: unknown = body
        if (!options.raw) {
          try { data = JSON.parse(body) } catch { /* not json */ }
        }
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data, setCookies })
      })
    })
    request.on('error', (err) => {
      resolve({ ok: false, status: 0, data: err.message, setCookies: [] })
    })

    if (options.body) request.write(options.body)
    request.end()
  })
}

// Login via webview — opens Overleaf login page, captures session cookie
ipcMain.handle('overleaf:webLogin', async (e) => {
  // Sender may be a tab's WebContentsView (no owning BrowserWindow mapping)
  const parent = BrowserWindow.fromWebContents(e.sender) || mainWindow || undefined
  return new Promise<{ success: boolean }>((resolve) => {
    const loginWindow = new BrowserWindow({
      width: 900,
      height: 750,
      parent,
      modal: !!parent,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })

    loginWindow.loadURL('https://www.overleaf.com/login')

    // Inject a floating back button when navigated away from overleaf.com
    const injectBackButton = () => {
      loginWindow.webContents.executeJavaScript(`
        if (!document.getElementById('lattex-back-btn')) {
          const btn = document.createElement('div');
          btn.id = 'lattex-back-btn';
          btn.innerHTML = '← Back';
          btn.style.cssText = 'position:fixed;top:8px;left:8px;z-index:999999;padding:6px 14px;' +
            'background:#333;color:#fff;border-radius:6px;cursor:pointer;font:13px -apple-system,sans-serif;' +
            'box-shadow:0 2px 8px rgba(0,0,0,.3);user-select:none;-webkit-app-region:no-drag;';
          btn.addEventListener('click', () => history.back());
          btn.addEventListener('mouseenter', () => btn.style.background = '#555');
          btn.addEventListener('mouseleave', () => btn.style.background = '#333');
          document.body.appendChild(btn);
        }
      `).catch(() => {})
    }

    loginWindow.webContents.on('did-finish-load', injectBackButton)
    loginWindow.webContents.on('did-navigate-in-page', injectBackButton)

    // Verify cookie by calling Overleaf API — only succeed if we get 200
    const verifyAndCapture = async (): Promise<boolean> => {
      const cookies = await loginWindow.webContents.session.cookies.get({ domain: '.overleaf.com' })
      if (!cookies.find((c) => c.name === 'overleaf_session2')) return false

      const testCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
      // Test if this cookie is actually authenticated
      const ok = await new Promise<boolean>((res) => {
        const req = net.request({ url: 'https://www.overleaf.com/user/projects', method: 'GET' })
        req.setHeader('Cookie', testCookie)
        req.setHeader('Accept', 'application/json')
        req.on('response', (resp) => {
          resp.on('data', () => {})
          resp.on('end', () => res(resp.statusCode === 200))
        })
        req.on('error', () => res(false))
        req.end()
      })

      if (!ok) return false

      overleafSessionCookie = testCookie
      // Get CSRF from meta tag if we're on an Overleaf page
      try {
        const csrf = await loginWindow.webContents.executeJavaScript(
          `document.querySelector('meta[name="ol-csrfToken"]')?.content || ''`
        )
        if (csrf) overleafCsrfToken = csrf
      } catch { /* ignore */ }

      // If no CSRF from page, fetch from /project page
      if (!overleafCsrfToken) {
        await new Promise<void>((res) => {
          const req = net.request({ url: 'https://www.overleaf.com/project', method: 'GET' })
          req.setHeader('Cookie', overleafSessionCookie)
          let body = ''
          req.on('response', (resp) => {
            resp.on('data', (chunk) => { body += chunk.toString() })
            resp.on('end', () => {
              const m = body.match(/ol-csrfToken[^>]*content="([^"]+)"/)
              if (m) overleafCsrfToken = m[1]
              res()
            })
          })
          req.on('error', () => res())
          req.end()
        })
      }

      return true
    }

    let resolved = false
    const tryCapture = async () => {
      if (resolved) return
      const ok = await verifyAndCapture()
      if (ok && !resolved) {
        resolved = true
        saveOverleafSession()
        // Push fresh credentials into all live sync bridges (re-login mid-session)
        for (const s of sessions.values()) {
          s.fileSyncBridge?.updateAuth(overleafSessionCookie, overleafCsrfToken)
        }
        loginWindow.close()
        resolve({ success: true })
      }
    }

    loginWindow.webContents.on('did-navigate', () => { setTimeout(tryCapture, 2000) })
    loginWindow.webContents.on('did-navigate-in-page', () => { setTimeout(tryCapture, 2000) })

    loginWindow.on('closed', () => {
      if (!overleafSessionCookie) resolve({ success: false })
    })
  })
})

// Check if web session is active — wait for startup load to finish
ipcMain.handle('overleaf:hasWebSession', async () => {
  if (sessionLoadPromise) await sessionLoadPromise
  return { loggedIn: !!overleafSessionCookie }
})

// Sign out: drop stored credentials and close every project tab (each tab's
// 'destroyed' handler tears its session down)
ipcMain.handle('overleaf:logout', async () => {
  overleafSessionCookie = ''
  overleafCsrfToken = ''
  await saveOverleafSession()
  for (const t of [...projectTabs]) {
    closeTab(t.projectId)
  }
})

// Fetch all comment threads for a project
ipcMain.handle('overleaf:getThreads', async (_e, projectId: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/project/${projectId}/threads`)
  if (!result.ok) return { success: false, message: `HTTP ${result.status}` }
  return { success: true, threads: result.data }
})

// Reply to a thread
ipcMain.handle('overleaf:replyThread', async (_e, projectId: string, threadId: string, content: string) => {
  if (!overleafSessionCookie) return { success: false }
  const result = await overleafFetch(`/project/${projectId}/thread/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content })
  })
  return { success: result.ok, data: result.data }
})

// Resolve a thread
ipcMain.handle('overleaf:resolveThread', async (_e, projectId: string, threadId: string, docId?: string) => {
  if (!overleafSessionCookie) return { success: false }
  // docId is required in the URL path for resolve
  const docSegment = docId ? `/doc/${docId}` : ''
  const result = await overleafFetch(`/project/${projectId}${docSegment}/thread/${threadId}/resolve`, {
    method: 'POST',
    body: '{}'
  })
  if (!result.ok) console.log(`[resolveThread] failed: ${result.status}`, result.data)
  return { success: result.ok }
})

// Reopen a thread
ipcMain.handle('overleaf:reopenThread', async (_e, projectId: string, threadId: string, docId?: string) => {
  if (!overleafSessionCookie) return { success: false }
  const docSegment = docId ? `/doc/${docId}` : ''
  const result = await overleafFetch(`/project/${projectId}${docSegment}/thread/${threadId}/reopen`, {
    method: 'POST',
    body: '{}'
  })
  if (!result.ok) console.log(`[reopenThread] failed: ${result.status}`, result.data)
  return { success: result.ok }
})

// Delete a comment message
ipcMain.handle('overleaf:deleteMessage', async (_e, projectId: string, threadId: string, messageId: string) => {
  if (!overleafSessionCookie) return { success: false }
  const result = await overleafFetch(`/project/${projectId}/thread/${threadId}/messages/${messageId}`, {
    method: 'DELETE'
  })
  return { success: result.ok }
})

// Edit a comment message
ipcMain.handle('overleaf:editMessage', async (_e, projectId: string, threadId: string, messageId: string, content: string) => {
  if (!overleafSessionCookie) return { success: false }
  const result = await overleafFetch(`/project/${projectId}/thread/${threadId}/messages/${messageId}/edit`, {
    method: 'POST',
    body: JSON.stringify({ content })
  })
  return { success: result.ok }
})

// Delete entire thread
ipcMain.handle('overleaf:deleteThread', async (_e, projectId: string, docId: string, threadId: string) => {
  if (!overleafSessionCookie) return { success: false }
  const result = await overleafFetch(`/project/${projectId}/doc/${docId}/thread/${threadId}`, {
    method: 'DELETE'
  })
  return { success: result.ok }
})

// Add a new comment: create thread via REST then submit comment op via existing socket
async function addComment(
  s: ProjectSession,
  projectId: string,
  docId: string,
  pos: number,
  text: string,
  content: string
): Promise<{ success: boolean; threadId?: string; message?: string }> {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }

  // Generate a random threadId (24-char hex like Mongo ObjectId)
  const threadId = Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

  // Step 1: Create the thread message via REST
  const msgResult = await overleafFetch(`/project/${projectId}/thread/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content })
  })
  if (!msgResult.ok) return { success: false, message: `REST failed: ${msgResult.status}` }

  // Step 2: Submit the comment op via the existing socket connection
  try {
    // Join doc if not already joined, to get the current version
    const alreadyJoined = s.docEventHandlers.has(docId)
    const joinResult = await s.sock.joinDoc(docId)
    const version = joinResult.version

    // Send the comment op
    const commentOp = { c: text, p: pos, t: threadId }
    console.log('[addComment] submitting op:', JSON.stringify(commentOp), 'v:', version)

    await s.sock.applyOtUpdate(docId, [commentOp], version, '')
    console.log('[addComment] op applied successfully')

    // Leave doc if we joined it just for this
    if (!alreadyJoined) {
      await s.sock.leaveDoc(docId)
    }

    return { success: true, threadId }
  } catch (e) {
    console.log('[addComment] error:', e)
    return { success: false, message: String(e) }
  }
}

ipcMain.handle('overleaf:addComment', async (e, projectId: string, docId: string, pos: number, text: string, content: string) => {
  const s = getSession(e)
  if (!s) return { success: false, message: 'not_connected' }
  return addComment(s, projectId, docId, pos, text, content)
})

// ── OT / Socket Mode IPC ─────────────────────────────────────────

interface SocketFileNode {
  name: string
  path: string
  isDir: boolean
  children?: SocketFileNode[]
  docId?: string
  fileRefId?: string
  folderId?: string
}

function walkRootFolder(folders: RootFolder[]): {
  files: SocketFileNode[]
  docPathMap: Record<string, string>
  pathDocMap: Record<string, string>
  fileRefs: Array<{ id: string; path: string }>
  rootFolderId: string
} {
  const docPathMap: Record<string, string> = {}
  const pathDocMap: Record<string, string> = {}
  const fileRefs: Array<{ id: string; path: string }> = []

  function walkFolder(f: SubFolder | RootFolder, prefix: string): SocketFileNode[] {
    const nodes: SocketFileNode[] = []

    for (const doc of f.docs || []) {
      const relPath = prefix + doc.name
      docPathMap[doc._id] = relPath
      pathDocMap[relPath] = doc._id
      nodes.push({
        name: doc.name,
        path: relPath,
        isDir: false,
        docId: doc._id
      })
    }

    for (const ref of f.fileRefs || []) {
      const relPath = prefix + ref.name
      fileRefs.push({ id: ref._id, path: relPath })
      nodes.push({
        name: ref.name,
        path: relPath,
        isDir: false,
        fileRefId: ref._id
      })
    }

    for (const sub of f.folders || []) {
      const relPath = prefix + sub.name + '/'
      const children = walkFolder(sub, relPath)
      nodes.push({
        name: sub.name,
        path: relPath,
        isDir: true,
        children,
        folderId: sub._id
      })
    }

    return nodes
  }

  const files: SocketFileNode[] = []
  const rootFolderId = folders[0]?._id || ''
  for (const root of folders) {
    files.push(...walkFolder(root, ''))
  }

  return { files, docPathMap, pathDocMap, fileRefs, rootFolderId }
}

// One connect at a time per window: React StrictMode double-fires the
// renderer's auto-connect effect, and a reload can re-request while the
// first connect is still in flight — both get the same promise.
const connectsInFlight = new Map<number, Promise<unknown>>()

ipcMain.handle('ot:connect', async (e, projectId: string) => {
  const inFlight = connectsInFlight.get(e.sender.id)
  if (inFlight) return inFlight
  const p = otConnectImpl(e, projectId).finally(() => connectsInFlight.delete(e.sender.id))
  connectsInFlight.set(e.sender.id, p)
  return p
})

async function otConnectImpl(e: Electron.IpcMainInvokeEvent, projectId: string) {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }

  const contents = e.sender

  // Same project already open in another tab → activate it instead of
  // spinning up a second bridge on the same sync dir
  const other = sessionsByProject.get(projectId)
  if (other && other.webContentsId !== contents.id && !other.contents.isDestroyed()) {
    activateTab(projectId)
    return { success: false, message: 'already_open' }
  }

  // Reconnect from the same tab → tear the old session down first
  const stale = sessions.get(contents.id)
  if (stale) await destroySession(stale)

  // A just-closed session of this project may still be tearing down the
  // shared sync dir (bridge stop + rm -rf) — wait before writing into it
  const pendingTeardown = projectTeardowns.get(projectId)
  if (pendingTeardown) await pendingTeardown

  if (contents.isDestroyed()) return { success: false, message: 'window_closed' }
  // Re-check after the awaits: another tab may have claimed the project
  const claimed = sessionsByProject.get(projectId)
  if (claimed && claimed.webContentsId !== contents.id && !claimed.contents.isDestroyed()) {
    activateTab(projectId)
    return { success: false, message: 'already_open' }
  }

  const sock = new OverleafSocket()
  const compilation = new CompilationManager(projectId, overleafSessionCookie)
  const s: ProjectSession = {
    projectId,
    contents,
    webContentsId: contents.id,
    sock,
    compilationManager: compilation,
    fileSyncBridge: null,
    docEventHandlers: new Map(),
    mcpStateDir: '',
    mcpCommentContexts: {},
    mcpPathDocMap: {},
    mcpOnlineUsers: new Map(),
    mcpOnlineUsersWriteTimer: null,
    commentContextRefreshTimer: null,
    mcpCompileRequestPath: null,
    mcpCompileActive: false,
    compileInProgress: null
  }
  sessions.set(s.webContentsId, s)
  sessionsByProject.set(projectId, s)

  // True while this session is still the registered one and its tab lives.
  // The tab can close during any await below — 'destroyed' evicts the session,
  // and everything set up afterwards must be torn down by hand.
  const alive = () => sessions.get(s.webContentsId) === s && !contents.isDestroyed()

  try {
    // Relay events to renderer
    sock.on('connectionState', (state: string) => {
      sessionSend(s, 'ot:connectionState', state)
    })

    // otUpdateApplied: server acknowledges our op with a no-op update on
    // official Overleaf, but some deployments echo own-source ops instead.
    sock.on('serverEvent', (name: string, args: unknown[]) => {
      if (name === 'otUpdateApplied') {
        const update = args[0] as { doc?: string; op?: unknown[]; v?: number; meta?: { source?: string } } | undefined
        const isOwnSource = update?.meta?.source && update.meta.source === sock.publicId
        if (update?.doc && (!update.op || isOwnSource)) {
          sessionSend(s, 'ot:ack', { docId: update.doc })
        }
      } else if (name === 'otUpdateError') {
        console.log(`[ot:error] server rejected update:`, JSON.stringify(args).slice(0, 500))
      }
    })

    sock.on('docRejoined', (docId: string, result: JoinDocResult) => {
      sessionSend(s, 'ot:docRejoined', {
        docId,
        content: result.docLines.join('\n'),
        version: result.version
      })
    })

    // Relay collaborator cursor updates to renderer + track for MCP
    sock.on('serverEvent', (name: string, args: unknown[]) => {
      if (name === 'clientTracking.clientUpdated') {
        const u = args[0] as { id: string; user_id?: string; name?: string; email?: string }
        // Skip our own echo — the native caret already marks our position;
        // colored overlay cursors are for collaborators only (web behavior)
        if (!u.id || u.id !== sock.publicId) {
          sessionSend(s, 'cursor:remoteUpdate', args[0])
        }
        // Track online user for MCP (includes ourselves)
        if (u.id) {
          s.mcpOnlineUsers.set(u.id, { name: u.name || u.email?.split('@')[0] || 'User', email: u.email })
          writeMcpOnlineUsers(s)
        }
      } else if (name === 'clientTracking.clientDisconnected') {
        sessionSend(s, 'cursor:remoteDisconnected', args[0])
        const clientId = args[0] as string
        if (clientId) {
          s.mcpOnlineUsers.delete(clientId)
          writeMcpOnlineUsers(s)
        }
      } else if (name === 'new-chat-message') {
        sessionSend(s, 'chat:newMessage', args[0])
      } else if (
        name === 'new-comment' ||
        name === 'resolve-thread' ||
        name === 'reopen-thread' ||
        name === 'delete-thread' ||
        name === 'edit-message' ||
        name === 'delete-message'
      ) {
        sessionSend(s, 'comments:event', { type: name, args })
        // Re-fetch comment contexts for MCP when comments change
        if (name === 'new-comment' || name === 'delete-thread') {
          scheduleCommentContextRefresh(s)
        }
      }
    })

    const projectResult = await sock.connect(projectId, overleafSessionCookie)
    if (!alive()) {
      // Window closed during the handshake — the 'closed' teardown could not
      // reach this socket yet, so disconnect it here
      try { sock.disconnect() } catch { /* ignore */ }
      return { success: false, message: 'window_closed' }
    }
    const { files, docPathMap, pathDocMap, fileRefs, rootFolderId } = walkRootFolder(projectResult.project.rootFolder)

    // Set up file sync bridge for bidirectional sync
    const tmpDir = compilation.dir
    s.fileSyncBridge = new FileSyncBridge(
      sock, tmpDir, docPathMap, pathDocMap, fileRefs, contents,
      projectId, overleafSessionCookie, overleafCsrfToken,
      async () => {
        // Re-fetch CSRF token (rotates over long sessions); cookie may also
        // have been refreshed by a re-login in the meantime.
        const ok = await refreshCsrfToken()
        return ok ? { cookie: overleafSessionCookie, csrfToken: overleafCsrfToken } : null
      }
    )
    await s.fileSyncBridge.start()
    if (!alive()) {
      try { await s.fileSyncBridge.stop() } catch { /* ignore */ }
      try { sock.disconnect() } catch { /* ignore */ }
      return { success: false, message: 'window_closed' }
    }

    // Start MCP compile watcher (detects compile requests from Claude Code)
    startMcpCompileWatcher(s, tmpDir)

    // Write MCP state + config for Claude Code integration
    s.mcpStateDir = tmpDir
    s.mcpPathDocMap = pathDocMap
    await writeMcpState(s)

    // Tab title comes from the renderer's document.title via 'page-title-updated'
    // Write .mcp.json so Claude Code auto-discovers the MCP server
    // Dev: use source file. Packaged: copy bundled server into the project
    // temp dir so .mcp.json never contains a stale App Translocation path.
    let mcpServerPath = ''
    try {
      mcpServerPath = await prepareMcpServerPath(tmpDir)
      await writeFile(join(tmpDir, '.mcp.json'), JSON.stringify({
        mcpServers: {
          lattex: {
            type: 'stdio',
            command: 'node',
            args: [mcpServerPath]
          }
        }
      }, null, 2))
      await clearDisabledLattexMcpServer(tmpDir)
    } catch (e) {
      console.log('[mcp] failed to write MCP config:', e)
    }
    // Clean up old root-level CLAUDE.md (was incorrectly placed there before)
    require('fs').unlink(join(tmpDir, 'CLAUDE.md'), () => {})
    // Create claude-workspace/ for Claude Code scratch space (not synced to Overleaf)
    mkdirAsync(join(tmpDir, 'claude-workspace'), { recursive: true }).catch(() => {})
    // Write .claude/ dir with CLAUDE.md + settings (dotfile dir = excluded from sync)
    mkdirAsync(join(tmpDir, '.claude'), { recursive: true }).then(async () => {
    const rootDocPath = docPathMap[projectResult.project.rootDoc_id] || 'main.tex'
    const texFiles = Object.values(docPathMap).filter((p: string) => p.endsWith('.tex'))
    const fileListStr = texFiles.map((p: string) => `- \`${p}\``).join('\n')

    // Fetch current user's name for CLAUDE.md
    let currentUserName = ''
    try {
      const userResult = await overleafFetch('/user/settings')
      if (userResult.ok && userResult.data) {
        const u = userResult.data as { first_name?: string; last_name?: string; email?: string }
        currentUserName = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || ''
      }
    } catch { /* non-fatal */ }
    const ownerName = [projectResult.project.owner.first_name, projectResult.project.owner.last_name].filter(Boolean).join(' ')

    // One guide, two consumers: .claude/CLAUDE.md (Claude Code's native
    // location) and AGENTS.md at the project root (the cross-tool standard
    // read by Codex, Cursor, Gemini CLI, etc.). AGENTS.md is excluded from
    // Overleaf sync alongside CLAUDE.md/.mcp.json.
    const agentGuide = `# ${projectResult.project.name} — Overleaf Project

> **IMPORTANT — MANDATORY FIRST STEPS (do this EVERY conversation before ANY edits):**
>
> 1. **Read \`${rootDocPath}\`** to discover the paper structure — identify every \\\\input{} and \\\\include{} file.
> 2. **Read EVERY file** found in step 1, one by one. This means reading the full content of each .tex file listed below. Do NOT skip any file. Do NOT skim. You need to understand the paper's argument, notation, macro usage, and conventions before touching anything.
> 3. **Run \`get_comments\`** to check for reviewer comments, TODOs, or ongoing discussions.
> 4. Only AFTER completing steps 1–3 may you proceed with the user's request.
>
> This is a live Overleaf project — your edits appear to collaborators in real-time. Careless changes to a document you haven't fully read WILL break things and waste collaborators' time.

This is a LaTeX project synced from Overleaf via LatteX. All files here are **bidirectionally synced** — your edits appear on Overleaf in real-time, and vice versa.
${currentUserName ? `\n**You are logged in as: ${currentUserName}** — this is the name that appears on comments and edits. The project owner is ${ownerName}.` : `\n**Project owner**: ${ownerName}`}

## Project Structure

- **Main file**: \`${rootDocPath}\` (this is the root document for compilation)
${fileListStr ? `- **TeX files**:\n${fileListStr}` : ''}

## Rules

- **NEVER edit without reading first.** You must understand what you are changing. Read the relevant file(s) fully before making any modification.
- **Match existing conventions.** Follow the notation, formatting, macro usage, and sectioning style already established in the document. Do NOT impose your own style.
- **Do NOT reorganize, rename labels, or refactor macros** unless explicitly asked.
- **Make targeted edits only.** Modify the specific parts that need changing. Do not rewrite surrounding paragraphs for style.
- **One logical change at a time.** Do not mix unrelated edits in a single pass.
- **Compile after changes.** Use \`compile_latex\` after every edit. If compilation fails, use \`get_compile_errors\` and fix immediately before proceeding.
- **Respond to comments.** When you address a comment, use \`reply_to_comment\` to explain what you changed, then \`resolve_comment\`. Never delete others' comments.

## MCP Tools

You have MCP tools to interact with Overleaf. Use them proactively.

### Comments
- **get_comments**: Read comments. Pass \`file\` to filter, \`include_resolved\` for all.
- **resolve_comment**: Resolve a comment by \`thread_id\`.
- **reopen_comment**: Reopen a resolved comment.
- **reply_to_comment**: Reply to a comment thread.
- **delete_comment**: Permanently delete a comment thread.

### Chat
- **get_chat_messages**: Read project chat history.
- **send_chat_message**: Send a message to project chat.

### Project
- **list_project_files**: List all files with sizes.
- **get_online_users**: See who is currently online in this project.

### Compilation
- **compile_latex**: Trigger LaTeX compilation on Overleaf server. Returns status + error summary.
- **get_compile_errors**: Get parsed errors from last compile (file, line, message).
- **get_compile_warnings**: Get parsed warnings from last compile.
- **get_compile_log**: Get full raw log. Pass \`tail: N\` for last N lines only.

### PDF
- **read_compiled_pdf**: Get the path to the compiled PDF. After calling this, use your **Read** tool on the returned path to visually inspect the PDF. Use the \`pages\` parameter (e.g. \`"1-3"\`) to read specific pages. This lets you verify formatting, figures, tables, and layout.

### Bibliography
- **search_citation**: Search academic papers by title, topic, or author (Semantic Scholar). Returns matching papers with ready-to-use BibTeX entries that can be pasted directly into a \`.bib\` file. **Note:** Without a Semantic Scholar API key configured in LatteX settings, requests will likely be rate-limited (HTTP 429). With a key, the rate limit is 1 request/second.
- **search_openalex**: Search scholarly works via OpenAlex (broader/faster-moving coverage, citation counts, venues). **Citation policy:** OpenAlex metadata lags, so BibTeX is cross-checked against Semantic Scholar — only entries marked "Semantic Scholar ✓" are authoritative. Entries marked "OpenAlex only ⚠" must be verified with a web search (publisher page / arXiv) before citing; very recent papers may be missing from both indexes.

### Workflows

#### Comment Workflow
1. Use \`get_comments\` to see what reviewers have flagged
2. Read the relevant sections to understand context
3. Edit the .tex files to address the feedback
4. Use \`reply_to_comment\` to explain what you changed
5. Use \`resolve_comment\` to mark it as done

#### Compile-Debug Workflow
1. Edit .tex files
2. Use \`compile_latex\` to compile
3. If errors: use \`get_compile_errors\` for details, fix them, recompile
4. If warnings: use \`get_compile_warnings\` to review
5. To check visual output: use \`read_compiled_pdf\`, then Read the returned path with \`pages: "1-3"\`

#### Bibliography Workflow
1. Use \`search_citation\` (Semantic Scholar) or \`search_openalex\` (broader coverage) to find references
2. If the entry is marked "OpenAlex only ⚠", verify it with a web search before using it
3. Copy the BibTeX entry into the \`.bib\` file
4. Use \`\\cite{key}\` in the \`.tex\` file
5. Compile to verify the citation renders correctly

## Workspace

The \`claude-workspace/\` directory is your private scratch space. It is **not synced to Overleaf** — use it freely for:
- **Notes and plans** — draft outlines, track TODOs, keep analysis notes
- **Experiments** — test LaTeX snippets, try alternative formulations, prototype figures
- **Scripts** — helper scripts for data processing, bibliography management, etc.

**Important**: Always ask the user before running experiments or creating files in \`claude-workspace/\`. This directory persists across sessions for the same project.

## Agent Setup (MCP)

The tools above come from LatteX's MCP server (standard stdio MCP — works with any MCP-capable agent):

- **Claude Code**: auto-configured. \`.mcp.json\` in this directory registers the \`lattex\` server and \`.claude/settings.json\` pre-approves its tools. Just run \`claude\`.
- **Codex CLI**: register the server once for this project:
  \`\`\`
  codex mcp add lattex -- node "${mcpServerPath}"
  \`\`\`
  The path is project-specific — re-run this when switching projects. Approve \`lattex\` tool calls when Codex prompts.
- **Any other MCP client**: stdio transport, command \`node "${mcpServerPath}"\`.
`
    await writeFile(join(tmpDir, '.claude', 'CLAUDE.md'), agentGuide)
    await writeFile(join(tmpDir, 'AGENTS.md'), agentGuide)
    await writeFile(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
        permissions: {
          allow: [
            'mcp__lattex__get_comments',
            'mcp__lattex__resolve_comment',
            'mcp__lattex__reopen_comment',
            'mcp__lattex__reply_to_comment',
            'mcp__lattex__delete_comment',
            'mcp__lattex__get_chat_messages',
            'mcp__lattex__send_chat_message',
            'mcp__lattex__list_project_files',
            'mcp__lattex__get_online_users',
            'mcp__lattex__compile_latex',
            'mcp__lattex__get_compile_errors',
            'mcp__lattex__get_compile_warnings',
            'mcp__lattex__get_compile_log',
            'mcp__lattex__read_compiled_pdf',
            'mcp__lattex__search_citation',
            'mcp__lattex__search_openalex'
          ]
        }
      }, null, 2))
    }).catch(() => {})

    // Fetch resolved thread IDs immediately (fast REST call) so editor highlights
    // don't flash resolved comments while waiting for background fetch
    overleafFetch(`/project/${projectId}/threads`).then((threadResult) => {
      if (threadResult.ok && threadResult.data) {
        const threads = threadResult.data as Record<string, { resolved?: boolean }>
        const resolvedIds: string[] = []
        for (const [tid, t] of Object.entries(threads)) {
          if (t.resolved) resolvedIds.push(tid)
        }
        sessionSend(s, 'comments:initThreads', { threads: threadResult.data, resolvedIds })
      }
    }).catch(() => {})

    // Fetch comment contexts from all docs in background (slower — joins each doc)
    setTimeout(async () => {
      if (sessions.get(s.webContentsId) !== s || !sock.projectData) return

      const { docPathMap: dp } = walkRootFolder(sock.projectData.project.rootFolder)
      const contexts: Record<string, { file: string; text: string; pos: number }> = {}
      for (const [did, rp] of Object.entries(dp)) {
        try {
          const result = await sock.joinDoc(did)
          if (result.ranges?.comments) {
            for (const c of result.ranges.comments) {
              if (c.op?.t) contexts[c.op.t] = { file: rp, text: c.op.c || '', pos: c.op.p || 0 }
            }
          }
          // Don't leaveDoc — bridge keeps all docs joined
        } catch { /* ignore */ }
      }
      s.mcpCommentContexts = contexts
      writeMcpState(s)
      sessionSend(s, 'comments:initContexts', { contexts })
    }, 3000)

    // Check for cached PDF from previous compile
    const buildDir = join(tmpDir, '.build')
    const cachedPdf = join(buildDir, 'output.pdf')
    let cachedPdfPath: string | undefined
    try {
      const stat = await require('fs').promises.stat(cachedPdf)
      if (stat.size > 0) cachedPdfPath = cachedPdf
    } catch { /* no cached PDF */ }

    return {
      success: true,
      files,
      project: {
        name: projectResult.project.name,
        rootDocId: projectResult.project.rootDoc_id
      },
      docPathMap,
      pathDocMap,
      fileRefs,
      rootFolderId,
      syncDir: tmpDir,
      cachedPdfPath
    }
  } catch (err) {
    console.log('[ot:connect] error:', err)
    // Tear down only OUR session — if the window was closed (or reconnected)
    // mid-flight, the registered session belongs to someone else now
    if (sessions.get(s.webContentsId) === s) {
      await destroySession(s)
    } else {
      try { await s.fileSyncBridge?.stop() } catch { /* ignore */ }
      try { sock.disconnect() } catch { /* ignore */ }
    }
    return { success: false, message: String(err) }
  }
}

ipcMain.handle('ot:disconnect', async (e) => {
  const s = getSession(e)
  if (s) await destroySession(s)
})

function attachRendererDoc(s: ProjectSession, docId: string): void {
  // Notify bridge that editor is taking over this doc
  s.fileSyncBridge?.addEditorDoc(docId)

  // Remove existing handler if re-attaching
  const existingHandler = s.docEventHandlers.get(docId)
  if (existingHandler) s.sock.removeListener('serverEvent', existingHandler)

  // Set up relay for remote ops on this doc
  const handler = (name: string, args: unknown[]) => {
    if (name === 'otUpdateApplied') {
      const update = args[0] as { doc?: string; op?: unknown[]; v?: number; meta?: { source?: string } } | undefined
      const isOwnSource = update?.meta?.source && update.meta.source === s.sock.publicId
      if (update?.doc === docId && update.op && !isOwnSource) {
        sessionSend(s, 'ot:remoteOp', {
          docId: update.doc,
          ops: update.op,
          version: update.v
        })
      }
    }
  }
  s.docEventHandlers.set(docId, handler)
  s.sock.on('serverEvent', handler)
}

ipcMain.handle('ot:joinDoc', async (e, docId: string) => {
  const s = getSession(e)
  if (!s) return { success: false, message: 'not_connected' }

  try {
    const result = await s.sock.joinDoc(docId)
    const content = (result.docLines || []).join('\n')
    // Update compilation manager with doc content
    if (s.sock.projectData) {
      const { docPathMap } = walkRootFolder(s.sock.projectData.project.rootFolder)
      const relPath = docPathMap[docId]
      if (relPath) {
        s.compilationManager.setDocContent(relPath, content)
      }
    }

    attachRendererDoc(s, docId)

    return {
      success: true,
      content,
      version: result.version,
      ranges: result.ranges
    }
  } catch (err) {
    console.log('[ot:joinDoc] error:', err)
    return { success: false, message: String(err) }
  }
})

ipcMain.handle('ot:attachDoc', async (e, docId: string) => {
  const s = getSession(e)
  if (s) attachRendererDoc(s, docId)
})

ipcMain.handle('ot:leaveDoc', async (e, docId: string) => {
  const s = getSession(e)
  if (!s) return
  try {
    // Remove event handler for this doc
    const handler = s.docEventHandlers.get(docId)
    if (handler) {
      s.sock.removeListener('serverEvent', handler)
      s.docEventHandlers.delete(docId)
    }
    // Bridge takes back OT ownership — do NOT leaveDoc on the socket,
    // the bridge keeps the doc joined for sync
    s.fileSyncBridge?.removeEditorDoc(docId)
  } catch (err) {
    console.log('[ot:leaveDoc] error:', err)
  }
})

ipcMain.handle('ot:sendOp', async (e, docId: string, ops: unknown[], version: number, hash: string) => {
  const s = getSession(e)
  if (!s) return
  try {
    await s.sock.applyOtUpdate(docId, ops, version, hash)
  } catch (err) {
    console.log('[ot:sendOp] error:', err)
  }
})

// Renderer → bridge: editor content changed (for disk sync)
ipcMain.handle('sync:contentChanged', async (e, docId: string, content: string) => {
  getSession(e)?.fileSyncBridge?.onEditorContentChanged(docId, content)
})

// Renderer ← bridge: all synced doc contents (for project-wide autocomplete)
ipcMain.handle('sync:getAllDocContents', async (e) => {
  const s = getSession(e)
  return s?.fileSyncBridge ? s.fileSyncBridge.getAllDocContents() : []
})

// Official metadata endpoint: labels + package command snippets per doc
ipcMain.handle('overleaf:getMetadata', async (_e, projectId: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/project/${projectId}/metadata`)
  if (!result.ok) return { success: false, message: `HTTP ${result.status}` }
  return { success: true, data: result.data }
})

// ── Cursor Tracking ────────────────────────────────────────────

ipcMain.handle('cursor:update', async (e, docId: string, row: number, column: number) => {
  getSession(e)?.sock.updateCursorPosition(docId, row, column)
})

ipcMain.handle('cursor:getConnectedUsers', async (e) => {
  const s = getSession(e)
  if (!s) return []
  try {
    const users = await s.sock.getConnectedUsers()
    // Seed MCP online users map (includes ourselves)
    s.mcpOnlineUsers.clear()
    for (const raw of users) {
      const u = raw as { client_id?: string; first_name?: string; last_name?: string; email?: string }
      if (u.client_id) {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email?.split('@')[0] || 'User'
        s.mcpOnlineUsers.set(u.client_id, { name, email: u.email })
      }
    }
    writeMcpOnlineUsers(s)
    // Exclude our own client — no colored overlay cursor for ourselves
    return users.filter((raw) => {
      const u = raw as { client_id?: string }
      return !u.client_id || u.client_id !== s.sock.publicId
    })
  } catch (err) {
    console.log('[cursor:getConnectedUsers] error:', err)
    return []
  }
})

// ── Chat ───────────────────────────────────────────────────────

ipcMain.handle('chat:getMessages', async (_e, projectId: string, limit?: number) => {
  if (!overleafSessionCookie) return { success: false, messages: [] }
  const result = await overleafFetch(`/project/${projectId}/messages?limit=${limit || 50}`)
  if (!result.ok) return { success: false, messages: [] }
  return { success: true, messages: result.data }
})

ipcMain.handle('chat:sendMessage', async (_e, projectId: string, content: string) => {
  if (!overleafSessionCookie) return { success: false }
  const result = await overleafFetch(`/project/${projectId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content })
  })
  return { success: result.ok }
})

ipcMain.handle('overleaf:listProjects', async () => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }

  // POST /api/project returns full project data (lastUpdated, owner, etc.)
  const result = await overleafFetch('/api/project', {
    method: 'POST',
    body: JSON.stringify({
      filters: {},
      page: { size: 200 },
      sort: { by: 'lastUpdated', order: 'desc' }
    })
  })
  if (!result.ok) return { success: false, message: `HTTP ${result.status}` }

  const data = result.data as { totalSize?: number; projects?: unknown[] }
  const projects = (data.projects || []) as Array<{
    id?: string; _id?: string; name: string; lastUpdated: string
    owner?: { firstName: string; lastName: string; email?: string }
    lastUpdatedBy?: { firstName: string; lastName: string; email?: string } | null
    accessLevel?: string
    source?: string
    archived?: boolean
    trashed?: boolean
  }>

  return {
    success: true,
    projects: projects.map((p) => ({
      id: p.id || p._id || '',
      name: p.name,
      lastUpdated: p.lastUpdated,
      owner: p.owner ? { firstName: p.owner.firstName, lastName: p.owner.lastName, email: p.owner.email } : undefined,
      lastUpdatedBy: p.lastUpdatedBy ? { firstName: p.lastUpdatedBy.firstName, lastName: p.lastUpdatedBy.lastName } : null,
      accessLevel: p.accessLevel || 'unknown',
      source: p.source || '',
      archived: !!p.archived,
      trashed: !!p.trashed
    }))
  }
})

ipcMain.handle('overleaf:createProject', async (_e, name: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch('/project/new', {
    method: 'POST',
    body: JSON.stringify({ projectName: name })
  })
  if (!result.ok) return { success: false, message: `HTTP ${result.status}` }
  const data = result.data as { project_id?: string; _id?: string }
  return { success: true, projectId: data.project_id || data._id }
})

ipcMain.handle('overleaf:uploadProject', async () => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }

  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Upload Project (.zip)',
    filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return { success: false, message: 'cancelled' }

  const zipPath = filePaths[0]
  const zipData = await readFile(zipPath)
  const fileName = basename(zipPath)

  // Multipart upload
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="qqfile"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`
  const footer = `\r\n--${boundary}--\r\n`
  const headerBuf = Buffer.from(header)
  const footerBuf = Buffer.from(footer)
  const body = Buffer.concat([headerBuf, zipData, footerBuf])

  return new Promise((resolve) => {
    const req = net.request({
      method: 'POST',
      url: 'https://www.overleaf.com/project/new/upload'
    })
    req.setHeader('Cookie', overleafSessionCookie)
    req.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
    req.setHeader('User-Agent', 'Mozilla/5.0')
    if (overleafCsrfToken) req.setHeader('x-csrf-token', overleafCsrfToken)

    let resBody = ''
    req.on('response', (res) => {
      res.on('data', (chunk) => { resBody += chunk.toString() })
      res.on('end', () => {
        try {
          const data = JSON.parse(resBody) as { success?: boolean; project_id?: string }
          if (data.success !== false && data.project_id) {
            resolve({ success: true, projectId: data.project_id })
          } else {
            resolve({ success: false, message: 'Upload failed' })
          }
        } catch {
          resolve({ success: false, message: 'Invalid response' })
        }
      })
    })
    req.on('error', (e) => resolve({ success: false, message: String(e) }))
    req.write(body)
    req.end()
  })
})

// ── Project Dashboard Operations (official Overleaf endpoints) ──
//
// Endpoints mirror services/web/frontend/js/features/project-list/util/api.ts
// in the Overleaf source (the web dashboard's own API client).

ipcMain.handle('overleaf:getTags', async () => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch('/tag')
  if (!result.ok) return { success: false, message: `HTTP ${result.status}` }
  return { success: true, tags: result.data }
})

ipcMain.handle('overleaf:createTag', async (_e, name: string, color?: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch('/tag', {
    method: 'POST',
    body: JSON.stringify({ name, color })
  })
  if (!result.ok) return { success: false, message: `HTTP ${result.status}` }
  return { success: true, tag: result.data }
})

ipcMain.handle('overleaf:editTag', async (_e, tagId: string, name: string, color?: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/tag/${tagId}/edit`, {
    method: 'POST',
    body: JSON.stringify({ name, color })
  })
  return { success: result.ok, message: result.ok ? '' : `HTTP ${result.status}` }
})

ipcMain.handle('overleaf:deleteTag', async (_e, tagId: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/tag/${tagId}`, { method: 'DELETE' })
  return { success: result.ok, message: result.ok ? '' : `HTTP ${result.status}` }
})

ipcMain.handle('overleaf:addProjectsToTag', async (_e, tagId: string, projectIds: string[]) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/tag/${tagId}/projects`, {
    method: 'POST',
    body: JSON.stringify({ projectIds })
  })
  return { success: result.ok, message: result.ok ? '' : `HTTP ${result.status}` }
})

ipcMain.handle('overleaf:removeProjectsFromTag', async (_e, tagId: string, projectIds: string[]) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/tag/${tagId}/projects/remove`, {
    method: 'POST',
    body: JSON.stringify({ projectIds })
  })
  return { success: result.ok, message: result.ok ? '' : `HTTP ${result.status}` }
})

// Archive / trash state transitions. Paths match the official router
// (case-sensitive: /Project/:id/archive vs /project/:id/trash).
ipcMain.handle('overleaf:setProjectState', async (_e, projectId: string, action: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }

  const routes: Record<string, { method: string; path: string }> = {
    archive: { method: 'POST', path: `/project/${projectId}/archive` },
    unarchive: { method: 'DELETE', path: `/project/${projectId}/archive` },
    trash: { method: 'POST', path: `/project/${projectId}/trash` },
    untrash: { method: 'DELETE', path: `/project/${projectId}/trash` },
    delete: { method: 'DELETE', path: `/project/${projectId}` },
    leave: { method: 'POST', path: `/project/${projectId}/leave` }
  }
  const route = routes[action]
  if (!route) return { success: false, message: `unknown action: ${action}` }

  const result = await overleafFetch(route.path, { method: route.method, body: '{}' })
  return { success: result.ok, message: result.ok ? '' : `HTTP ${result.status}` }
})

ipcMain.handle('overleaf:renameProject', async (_e, projectId: string, newName: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/project/${projectId}/rename`, {
    method: 'POST',
    body: JSON.stringify({ newProjectName: newName })
  })
  return { success: result.ok, message: result.ok ? '' : `HTTP ${result.status}` }
})

ipcMain.handle('overleaf:cloneProject', async (_e, projectId: string, projectName: string, tags?: string[]) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/project/${projectId}/clone`, {
    method: 'POST',
    body: JSON.stringify({ projectName, tags: (tags || []).map((id) => ({ id })) })
  })
  if (!result.ok) return { success: false, message: `HTTP ${result.status}` }
  const data = result.data as { project_id?: string }
  return { success: true, projectId: data.project_id }
})

ipcMain.handle('overleaf:downloadProjectZip', async (_e, projectIds: string[], suggestedName: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  if (projectIds.length === 0) return { success: false, message: 'no projects' }

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Download Project',
    defaultPath: `${suggestedName || 'projects'}.zip`,
    filters: [{ name: 'ZIP Archives', extensions: ['zip'] }]
  })
  if (canceled || !filePath) return { success: false, message: 'cancelled' }

  // Official download routes: single /project/:id/download/zip,
  // multi /project/download/zip?project_ids=a,b
  const url = projectIds.length === 1
    ? `https://www.overleaf.com/project/${projectIds[0]}/download/zip`
    : `https://www.overleaf.com/project/download/zip?project_ids=${projectIds.join(',')}`

  try {
    const data = await fetchBinary(url, overleafSessionCookie)
    await writeFile(filePath, Buffer.from(data))
    return { success: true, path: filePath }
  } catch (e) {
    return { success: false, message: String(e) }
  }
})

// ── File Operations via Overleaf REST API ──────────────────────

ipcMain.handle('overleaf:renameEntity', async (_e, projectId: string, entityType: string, entityId: string, newName: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/project/${projectId}/${entityType}/${entityId}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name: newName })
  })
  return { success: result.ok, message: result.ok ? '' : `HTTP ${result.status}` }
})

ipcMain.handle('overleaf:deleteEntity', async (_e, projectId: string, entityType: string, entityId: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/project/${projectId}/${entityType}/${entityId}`, {
    method: 'DELETE'
  })
  return { success: result.ok, message: result.ok ? '' : `HTTP ${result.status}` }
})

ipcMain.handle('overleaf:createDoc', async (_e, projectId: string, parentFolderId: string, name: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/project/${projectId}/doc`, {
    method: 'POST',
    body: JSON.stringify({ name, parent_folder_id: parentFolderId })
  })
  return { success: result.ok, data: result.data, message: result.ok ? '' : `HTTP ${result.status}` }
})

ipcMain.handle('overleaf:createFolder', async (_e, projectId: string, parentFolderId: string, name: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  const result = await overleafFetch(`/project/${projectId}/folder`, {
    method: 'POST',
    body: JSON.stringify({ name, parent_folder_id: parentFolderId })
  })
  return { success: result.ok, data: result.data, message: result.ok ? '' : `HTTP ${result.status}` }
})

// ── Upload file to project (binary or text) ───────────────────
ipcMain.handle('project:uploadFile', async (_e, projectId: string, folderId: string, filePath: string, fileName: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }

  try {
    const fileData = await readFile(filePath)
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      svg: 'image/svg+xml', pdf: 'application/pdf', eps: 'application/postscript',
      zip: 'application/zip', bmp: 'image/bmp', tiff: 'image/tiff',
      tex: 'text/x-tex', bib: 'text/x-bibtex', txt: 'text/plain', csv: 'text/csv',
      sty: 'text/x-tex', cls: 'text/x-tex', md: 'text/markdown',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)

    // Build multipart body matching Overleaf's expected format:
    // 1. "name" text field (required — server reads filename from req.body.name)
    // 2. "type" text field
    // 3. "qqfile" file field (fieldName must be "qqfile" for multer)
    const parts: Buffer[] = []
    // name field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${fileName}\r\n`))
    // type field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mime}\r\n`))
    // qqfile field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="qqfile"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    return new Promise<{ success: boolean; message?: string }>((resolve) => {
      const req = net.request({
        method: 'POST',
        url: `https://www.overleaf.com/project/${projectId}/upload?folder_id=${folderId}`
      })
      req.setHeader('Cookie', overleafSessionCookie)
      req.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
      req.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
      req.setHeader('Accept', 'application/json')
      req.setHeader('Referer', `https://www.overleaf.com/project/${projectId}`)
      req.setHeader('Origin', 'https://www.overleaf.com')
      if (overleafCsrfToken) req.setHeader('x-csrf-token', overleafCsrfToken)

      let resBody = ''
      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) => { resBody += chunk.toString() })
        res.on('end', () => {
          console.log('[upload] status:', res.statusCode, 'body:', resBody.slice(0, 300))
          try {
            const data = JSON.parse(resBody)
            if (data.success !== false && !data.error) {
              resolve({ success: true })
            } else {
              resolve({ success: false, message: data.error || 'Upload failed' })
            }
          } catch {
            resolve({ success: false, message: `HTTP ${res.statusCode}: ${resBody.slice(0, 200)}` })
          }
        })
      })
      req.on('error', (e) => resolve({ success: false, message: String(e) }))
      req.write(body)
      req.end()
    })
  } catch (e) {
    return { success: false, message: String(e) }
  }
})

// Fetch comment ranges from ALL docs (for ReviewPanel)
ipcMain.handle('ot:fetchAllCommentContexts', async (e) => {
  const s = getSession(e)
  if (!s?.sock.projectData) return { success: false }

  const { docPathMap } = walkRootFolder(s.sock.projectData.project.rootFolder)
  const contexts: Record<string, { file: string; text: string; pos: number }> = {}

  for (const [docId, relPath] of Object.entries(docPathMap)) {
    try {
      const alreadyJoined = s.docEventHandlers.has(docId)
      const result = await s.sock.joinDoc(docId)
      if (result.ranges?.comments) {
        for (const c of result.ranges.comments) {
          if (c.op?.t) {
            contexts[c.op.t] = { file: relPath, text: c.op.c || '', pos: c.op.p || 0 }
          }
        }
      }
      if (!alreadyJoined) {
        await s.sock.leaveDoc(docId)
      }
    } catch (err) {
      console.log(`[fetchCommentContexts] failed for ${relPath}:`, err)
    }
  }

  // Update MCP state with fresh comment contexts
  s.mcpCommentContexts = contexts
  writeMcpState(s)

  return { success: true, contexts }
})

ipcMain.handle('overleaf:socketCompile', async (e, mainTexRelPath: string) => {
  const s = getSession(e)
  if (!s?.sock.projectData) {
    return { success: false, log: 'No compilation manager or not connected', pdfPath: '' }
  }
  const compilation = s.compilationManager

  // latexmk writes its output into the synced dir root (-outdir) — tell the
  // bridge so the produced PDF is never uploaded to Overleaf as content.
  s.fileSyncBridge?.addCompileOutput(basename(mainTexRelPath, '.tex') + '.pdf')

  // Bridge already keeps all docs synced to disk. Sync content to compilation manager.
  if (s.fileSyncBridge) {
    for (const { path, content } of s.fileSyncBridge.getAllDocContents()) {
      compilation.setDocContent(path, content)
    }
  } else {
    // Fallback: fetch docs from socket if bridge isn't available
    const { docPathMap } = walkRootFolder(s.sock.projectData.project.rootFolder)
    const allDocIds = Object.keys(docPathMap)
    for (const docId of allDocIds) {
      const relPath = docPathMap[docId]
      if (s.docEventHandlers.has(docId) && compilation.hasDoc(relPath)) continue
      try {
        const alreadyJoined = s.docEventHandlers.has(docId)
        const result = await s.sock.joinDoc(docId)
        const content = (result.docLines || []).join('\n')
        compilation.setDocContent(relPath, content)
        if (!alreadyJoined) {
          await s.sock.leaveDoc(docId)
        }
      } catch (err) {
        console.log(`[socketCompile] failed to fetch doc ${relPath}:`, err)
      }
    }
  }

  // Download all binary files (images, .bst, etc.)
  const fileRefs = s.fileSyncBridge
    ? s.fileSyncBridge.getFileRefs()
    : walkRootFolder(s.sock.projectData.project.rootFolder).fileRefs
  await compilation.syncBinaries(fileRefs)

  return compilation.compile(mainTexRelPath, (data) => {
    sessionSend(s, 'latex:log', data)
  })
})

// Server-side compile via Overleaf's CLSI (shared by IPC handler + MCP compile watcher)

async function doServerCompile(s: ProjectSession, rootDocId?: string): Promise<{ success: boolean; log: string; pdfPath: string }> {
  // Prevent concurrent compiles — wait for existing one if already in progress
  if (s.compileInProgress) {
    console.log('[compile] compile already in progress, waiting...')
    return s.compileInProgress
  }

  const promise = doServerCompileImpl(s, rootDocId)
  s.compileInProgress = promise
  try {
    return await promise
  } finally {
    s.compileInProgress = null
  }
}

async function doServerCompileImpl(s: ProjectSession, rootDocId?: string): Promise<{ success: boolean; log: string; pdfPath: string }> {
  if (!overleafSessionCookie || !s.sock.projectData) {
    return { success: false, log: 'Not connected', pdfPath: '' }
  }

  const projectId = s.sock.projectData.project._id
  const effectiveRootDocId = rootDocId || s.sock.projectData.project.rootDoc_id || null

  // Resolve rootResourcePath (file path of root doc) — matches Overleaf web client
  let rootResourcePath: string | undefined
  if (effectiveRootDocId) {
    const { docPathMap } = walkRootFolder(s.sock.projectData.project.rootFolder)
    rootResourcePath = docPathMap[effectiveRootDocId]
  }

  try {
    sessionSend(s, 'latex:log', 'Compiling on Overleaf server...\n')

    // Flush in-memory OT changes to database so CLSI sees latest content
    try {
      await overleafFetch(`/project/${projectId}/flush`, { method: 'POST' })
    } catch (e) {
      console.log('[compile] flush failed (non-fatal):', e)
    }

    const compileBody = JSON.stringify({
      rootDoc_id: effectiveRootDocId,
      ...(rootResourcePath && { rootResourcePath }),
      draft: false,
      check: 'silent',
      incrementalCompilesEnabled: true,
      stopOnFirstError: false
    })

    console.log(`[compile] starting server compile for project ${projectId}`)
    const compileResult = await overleafFetch(
      `/project/${projectId}/compile?auto_compile=false`,
      { method: 'POST', body: compileBody }
    )
    console.log(`[compile] compile response: ok=${compileResult.ok} status=${compileResult.status}`)

    if (!compileResult.ok) {
      sessionSend(s, 'latex:log', `Compile failed: HTTP ${compileResult.status}\n`)
      return { success: false, log: '', pdfPath: '' }
    }

    const data = compileResult.data as any

    // Diagnostic: log compile status and available output files
    const outputPaths = (data.outputFiles || []).map((f: any) => f.path)
    sessionSend(s, 'latex:log', `[CLSI status=${data.status}, outputFiles=[${outputPaths.join(', ')}]]\n`)

    // Build query params for fetching output files (matches Overleaf web client)
    const params = new URLSearchParams()
    if (data.compileGroup) params.set('compileGroup', data.compileGroup)
    if (data.clsiServerId) params.set('clsiserverid', data.clsiServerId)

    const buildOutputUrl = (file: { url: string; build?: string }) => {
      const base = (file.build && data.pdfDownloadDomain)
        ? `${data.pdfDownloadDomain}${file.url}`
        : `https://www.overleaf.com${file.url}`
      return `${base}?${params}`
    }

    // Build output dir — separate from synced project dir to avoid re-uploading artifacts
    const syncDir = s.compilationManager.dir
    const buildDir = join(syncDir, '.build')
    await mkdirAsync(buildDir, { recursive: true })

    // Fetch compile log
    const logFile = (data.outputFiles || []).find((f: any) => f.path === 'output.log')
    if (logFile) {
      try {
        const logContent = await fetchBinary(buildOutputUrl(logFile), overleafSessionCookie)
        const logText = Buffer.from(logContent).toString('utf-8')
        sessionSend(s, 'latex:log', logText)
        // Write log for MCP server to read (avoids redundant compile API call)
        writeFile(join(syncDir, '.lattex-compile-log'), logText).catch(() => {})
      } catch (e) {
        sessionSend(s, 'latex:log', `[log fetch failed: ${e}]\n`)
      }
    }

    // Grab synctex.gz (needed for PDF↔source navigation)
    const synctexFile = (data.outputFiles || []).find((f: any) => f.path === 'output.synctex.gz')
    if (synctexFile) {
      // CDN returns 503 for non-PDF files; use Overleaf web proxy instead
      const synctexUrl = `https://www.overleaf.com${synctexFile.url}?${params}`
      try {
        const d = await fetchBinary(synctexUrl, overleafSessionCookie)
        await writeFile(join(buildDir, 'output.synctex.gz'), Buffer.from(d))
        console.log(`[compile] synctex.gz saved (${d.byteLength} bytes)`)
      } catch (e) {
        console.log(`[compile] synctex.gz download failed: ${e}`)
      }
    } else {
      console.log('[compile] no synctex.gz in compile output')
    }

    // Download PDF — first check outputFiles, then try direct URL from build ID
    let pdfPath = ''
    const pdfFile = (data.outputFiles || []).find((f: any) => f.path === 'output.pdf')
    if (pdfFile) {
      try {
        const pdfUrl = buildOutputUrl(pdfFile)
        console.log(`[compile] downloading PDF from ${pdfUrl.slice(0, 100)}...`)
        const pdfData = await fetchBinary(pdfUrl, overleafSessionCookie)
        console.log(`[compile] PDF downloaded (${pdfData.byteLength} bytes)`)
        const pdfDest = join(buildDir, 'output.pdf')
        await writeFile(pdfDest, Buffer.from(pdfData))
        pdfPath = pdfDest
      } catch (e) {
        console.log(`[compile] PDF direct download failed: ${e}`)
        sessionSend(s, 'latex:log', `\n[PDF download failed: ${e}]\n`)
      }
    }

    // If output.pdf not in outputFiles, try constructing URL from another file's build ID
    // (CLSI may have produced the PDF but not listed it — output.pdfxref proves this)
    if (!pdfPath && data.outputFiles?.length > 0) {
      const refFile = data.outputFiles.find((f: any) => f.build)
      if (refFile) {
        const pdfUrl = refFile.url.replace(/\/output\/[^/]+$/, '/output/output.pdf')
        try {
          const pdfData = await fetchBinary(buildOutputUrl({ url: pdfUrl, build: refFile.build }), overleafSessionCookie)
          if (pdfData.byteLength > 0) {
            const pdfDest = join(buildDir, 'output.pdf')
            await writeFile(pdfDest, Buffer.from(pdfData))
            pdfPath = pdfDest
            sessionSend(s, 'latex:log', `\n[PDF retrieved via direct URL (${(pdfData.byteLength / 1024).toFixed(0)} KB)]\n`)
          }
        } catch {
          // PDF truly not available on CLSI
        }
      }
    }

    if (!pdfPath && data.status !== 'success') {
      sessionSend(s, 'latex:log', `\n[Compile status: ${data.status} — PDF not available]\n`)
    }

    return { success: data.status === 'success', log: '', pdfPath }
  } catch (e) {
    const msg = `Server compile error: ${e}`
    sessionSend(s, 'latex:log', msg + '\n')
    return { success: false, log: msg, pdfPath: '' }
  }
}

ipcMain.handle('overleaf:serverCompile', async (e, rootDocId?: string) => {
  const s = getSession(e)
  if (!s) return { success: false, log: 'Not connected', pdfPath: '' }
  return doServerCompile(s, rootDocId)
})

// Watch for MCP compile requests (file-based signal from MCP server process)

function startMcpCompileWatcher(s: ProjectSession, syncDir: string) {
  const requestPath = join(syncDir, '.lattex-compile-request')
  const resultPath = join(syncDir, '.lattex-compile-result')

  // Poll for the request file every 300ms
  const { watchFile } = require('fs')
  watchFile(requestPath, { interval: 300 }, async (curr: { size: number }) => {
    if (curr.size === 0 || s.mcpCompileActive) return
    s.mcpCompileActive = true

    try {
      const reqData = JSON.parse(await readFile(requestPath, 'utf-8'))
      await unlink(requestPath).catch(() => {})

      console.log('[mcp-compile] compile request received:', reqData.requestId)

      // Notify renderer: compile started
      sessionSend(s, 'compile:mcpStarted', null)

      // Resolve main_file to rootDocId if provided
      let rootDocId: string | undefined
      if (reqData.mainFile && s.mcpPathDocMap[reqData.mainFile]) {
        rootDocId = s.mcpPathDocMap[reqData.mainFile]
      }

      const result = await doServerCompile(s, rootDocId)

      // Notify renderer: compile finished (renderer will update PDF + compiling state)
      sessionSend(s, 'compile:mcpFinished', {
        success: result.success,
        pdfPath: result.pdfPath
      })

      // Write result for MCP server to read
      await writeFile(resultPath, JSON.stringify({
        requestId: reqData.requestId,
        success: result.success,
        pdfPath: result.pdfPath,
        status: result.success ? 'success' : 'failure'
      }))
      console.log('[mcp-compile] compile result written:', result.success)
    } catch (e) {
      console.log('[mcp-compile] error handling compile request:', e)
      // Write error result so MCP doesn't hang
      await writeFile(resultPath, JSON.stringify({
        success: false,
        status: 'error',
        error: String(e)
      })).catch(() => {})
      sessionSend(s, 'compile:mcpFinished', { success: false, pdfPath: '' })
    } finally {
      s.mcpCompileActive = false
    }
  })

  s.mcpCompileRequestPath = requestPath
  console.log('[mcp-compile] watcher started for', requestPath)
}

function stopMcpCompileWatcher(s: ProjectSession) {
  if (s.mcpCompileRequestPath) {
    const { unwatchFile } = require('fs')
    unwatchFile(s.mcpCompileRequestPath)
    s.mcpCompileRequestPath = null
  }
}

/** Fetch a binary resource. Cookie is optional — CDN URLs use build ID for auth. */
function fetchBinary(url: string, cookie?: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const req = net.request(url)
    if (cookie) req.setHeader('Cookie', cookie)

    const chunks: Buffer[] = []
    req.on('response', (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      res.on('data', (chunk) => chunks.push(chunk as Buffer))
      res.on('end', () => resolve(Buffer.concat(chunks).buffer))
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Update check (GitHub Releases) ──────────────────────────────
//
// The app is unsigned, so electron-updater's silent auto-update is not an
// option on macOS. Instead: check the latest GitHub release on launch, and
// let the user one-click download the right installer for their platform.

const GITHUB_RELEASES_API = 'https://api.github.com/repos/YurenHao0426/lattex/releases/latest'

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

ipcMain.handle('update:check', async () => {
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = net.request(GITHUB_RELEASES_API)
      req.setHeader('User-Agent', 'LatteX-Updater')
      req.setHeader('Accept', 'application/vnd.github+json')
      let data = ''
      req.on('response', (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        res.on('data', (c) => { data += c.toString() })
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
      req.end()
    })

    const release = JSON.parse(body) as {
      tag_name?: string
      body?: string
      html_url?: string
      assets?: Array<{ name: string; browser_download_url: string; size: number }>
    }
    const latest = (release.tag_name || '').replace(/^v/, '')
    const current = app.getVersion()
    if (!latest || compareVersions(latest, current) <= 0) {
      return { available: false, current }
    }

    const wanted = process.platform === 'darwin' ? /-arm64\.dmg$/ : /-win-x64\.exe$/
    const asset = (release.assets || []).find((a) => wanted.test(a.name))
    return {
      available: true,
      current,
      version: latest,
      notes: (release.body || '').slice(0, 2000),
      releaseUrl: release.html_url || 'https://github.com/YurenHao0426/lattex/releases',
      assetName: asset?.name,
      assetUrl: asset?.browser_download_url,
      assetSize: asset?.size
    }
  } catch (e) {
    // Offline / rate-limited — stay quiet, this is a background convenience
    return { available: false, current: app.getVersion(), error: String(e) }
  }
})

// Download the installer to ~/Downloads and open it (mounts the DMG /
// launches the NSIS installer) — the user takes it from there.
ipcMain.handle('update:download', async (_e, url: string, name: string) => {
  // Only accept release assets of this repo — the URL originates from our
  // own update:check, but the IPC boundary shouldn't trust the renderer
  if (!/^https:\/\/github\.com\/YurenHao0426\/lattex\/releases\/download\//.test(url)) {
    return { success: false, message: 'invalid url' }
  }
  const dest = join(app.getPath('downloads'), basename(name))
  try {
    await new Promise<void>((resolve, reject) => {
      const req = net.request(url)   // net follows the S3 redirect
      req.setHeader('User-Agent', 'LatteX-Updater')
      req.on('response', (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const out = createWriteStream(dest)
        res.on('data', (c) => out.write(c))
        res.on('end', () => out.end(() => resolve()))
        res.on('error', reject)
        out.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
    await shell.openPath(dest)
    return { success: true, path: dest }
  } catch (e) {
    unlink(dest).catch(() => {})
    return { success: false, message: String(e) }
  }
})

/// ── Shell: open external ─────────────────────────────────────────

ipcMain.handle('shell:openExternal', async (_e, url: string) => {
  await shell.openExternal(url)
})

ipcMain.handle('shell:openPath', async (_e, targetPath: string) => {
  return shell.openPath(targetPath)
})

ipcMain.handle('shell:showInFinder', async (_e, path: string) => {
  shell.showItemInFolder(path)
})

ipcMain.handle('shell:savePdf', async (_e, sourcePath: string) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save PDF',
    defaultPath: basename(sourcePath),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (canceled || !filePath) return { success: false }
  const { copyFile } = await import('fs/promises')
  await copyFile(sourcePath, filePath)
  return { success: true, path: filePath }
})

// ── App Lifecycle ────────────────────────────────────────────────

app.whenReady().then(async () => {
  createListWindow()
  sessionLoadPromise = loadOverleafSession()

})

app.on('window-all-closed', () => {
  mainWindow = null
  for (const s of sessions.values()) destroySession(s)
  for (const inst of ptyInstances.values()) inst.kill()
  ptyInstances.clear()
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createListWindow()
  }
})
