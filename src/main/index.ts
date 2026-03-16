// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { app, BrowserWindow, ipcMain, dialog, shell, net } from 'electron'
import { join, basename, relative, extname } from 'path'
import { readFile, writeFile, mkdir as mkdirAsync, unlink, readdir, stat } from 'fs/promises'
import { spawn } from 'child_process'
import * as pty from 'node-pty'
import { OverleafSocket, type RootFolder, type SubFolder, type JoinDocResult } from './overleafSocket'
import { CompilationManager } from './compilationManager'
import { FileSyncBridge } from './fileSyncBridge'

// Prevent EPIPE crashes when stdout/stderr is closed (e.g. Electron launched from Finder)
process.stdout?.on('error', () => {})
process.stderr?.on('error', () => {})

let mainWindow: BrowserWindow | null = null
const ptyInstances = new Map<string, pty.IPty>()
let overleafSock: OverleafSocket | null = null
let compilationManager: CompilationManager | null = null
let fileSyncBridge: FileSyncBridge | null = null
let mcpStateDir = ''           // syncDir for .lattex-mcp.json
let mcpProjectId = ''
let mcpCommentContexts: Record<string, { file: string; text: string; pos: number }> = {}
let mcpPathDocMap: Record<string, string> = {}  // relPath → docId for MCP
const mcpOnlineUsers = new Map<string, { name: string; email?: string }>()
let mcpOnlineUsersWriteTimer: ReturnType<typeof setTimeout> | null = null

async function writeMcpState(): Promise<void> {
  if (!mcpStateDir || !mcpProjectId) return
  try {
    const state = {
      projectId: mcpProjectId,
      cookie: overleafSessionCookie,
      csrf: overleafCsrfToken,
      commentContexts: mcpCommentContexts,
      pathDocMap: mcpPathDocMap
    }
    await writeFile(join(mcpStateDir, '.lattex-mcp.json'), JSON.stringify(state, null, 2))
  } catch { /* ignore */ }
}

function writeMcpOnlineUsers(): void {
  if (!mcpStateDir) return
  if (mcpOnlineUsersWriteTimer) clearTimeout(mcpOnlineUsersWriteTimer)
  mcpOnlineUsersWriteTimer = setTimeout(() => {
    const users = Array.from(mcpOnlineUsers.entries()).map(([id, u]) => ({ id, ...u }))
    writeFile(join(mcpStateDir, '.lattex-online-users.json'), JSON.stringify(users)).catch(() => {})
  }, 500)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Disable Electron's built-in pinch/Ctrl+wheel zoom so editor can handle it
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Safely send IPC to renderer — no-op if window is gone */
function sendToRenderer(channel: string, ...args: unknown[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}


ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
  return readFile(filePath, 'utf-8')
})

ipcMain.handle('fs:readBinary', async (_e, filePath: string) => {
  const buffer = await readFile(filePath)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
})

// ── LaTeX Compilation ────────────────────────────────────────────

// Ensure TeX binaries are in PATH (Electron launched from Finder may miss them)
const texPaths = ['/Library/TeX/texbin', '/usr/local/texlive/2024/bin/universal-darwin', '/usr/texbin', '/opt/homebrew/bin']
const currentPath = process.env.PATH || ''
for (const p of texPaths) {
  if (!currentPath.includes(p)) {
    process.env.PATH = `${p}:${process.env.PATH}`
  }
}

// SyncTeX: PDF position → source file:line (inverse search)
ipcMain.handle('synctex:editFromPdf', async (_e, pdfPath: string, page: number, x: number, y: number) => {
  return new Promise<{ file: string; line: number } | null>((resolve) => {
    const pdfDir = pdfPath.substring(0, pdfPath.lastIndexOf('/'))
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
        const syncDir = compilationManager?.dir
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
ipcMain.handle('synctex:viewFromSource', async (_e, line: number, col: number, relPath: string) => {
  const syncDir = compilationManager?.dir
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

ipcMain.handle('search:files', async (_e, query: string, caseSensitive: boolean) => {
  const syncDir = compilationManager?.dir
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

ipcMain.handle('pty:spawn', async (_e, id: string, cwd: string, cmd?: string, args?: string[]) => {
  const existing = ptyInstances.get(id)
  if (existing) {
    existing.kill()
    ptyInstances.delete(id)
  }

  const shellPath = cmd || process.env.SHELL || '/bin/zsh'
  const shellArgs = args || ['-l']
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

  ptyInstances.set(id, instance)

  instance.onData((data) => {
    // Strip DEC 2026 synchronized output sequences — xterm.js may buffer indefinitely
    // if the begin/end markers are split across PTY chunks
    const cleaned = data.replace(/\x1b\[\?2026[hl]/g, '')
    if (cleaned) sendToRenderer(`pty:data:${id}`, cleaned)
  })

  instance.onExit(() => {
    // Only delete if this is still the current instance (avoid race with re-spawn)
    if (ptyInstances.get(id) === instance) {
      sendToRenderer(`pty:exit:${id}`)
      ptyInstances.delete(id)
    }
  })
})

ipcMain.handle('pty:write', async (_e, id: string, data: string) => {
  ptyInstances.get(id)?.write(data)
})

ipcMain.handle('pty:resize', async (_e, id: string, cols: number, rows: number) => {
  try {
    ptyInstances.get(id)?.resize(cols, rows)
  } catch { /* ignore resize errors */ }
})

ipcMain.handle('pty:kill', async (_e, id: string) => {
  const instance = ptyInstances.get(id)
  if (instance) {
    instance.kill()
    ptyInstances.delete(id)
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

// Helper: make authenticated request to Overleaf web API
async function overleafFetch(path: string, options: { method?: string; body?: string; raw?: boolean; cookie?: string } = {}): Promise<{ ok: boolean; status: number; data: unknown; setCookies: string[] }> {
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
ipcMain.handle('overleaf:webLogin', async () => {
  return new Promise<{ success: boolean }>((resolve) => {
    const loginWindow = new BrowserWindow({
      width: 900,
      height: 750,
      parent: mainWindow!,
      modal: true,
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
  projectId: string,
  docId: string,
  pos: number,
  text: string,
  content: string
): Promise<{ success: boolean; threadId?: string; message?: string }> {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }
  if (!overleafSock) return { success: false, message: 'not_connected' }

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
    const alreadyJoined = docEventHandlers.has(docId)
    const joinResult = await overleafSock.joinDoc(docId)
    const version = joinResult.version

    // Send the comment op
    const commentOp = { c: text, p: pos, t: threadId }
    console.log('[addComment] submitting op:', JSON.stringify(commentOp), 'v:', version)

    await overleafSock.applyOtUpdate(docId, [commentOp], version, '')
    console.log('[addComment] op applied successfully')

    // Leave doc if we joined it just for this
    if (!alreadyJoined) {
      await overleafSock.leaveDoc(docId)
    }

    return { success: true, threadId }
  } catch (e) {
    console.log('[addComment] error:', e)
    return { success: false, message: String(e) }
  }
}

ipcMain.handle('overleaf:addComment', async (_e, projectId: string, docId: string, pos: number, text: string, content: string) => {
  return addComment(projectId, docId, pos, text, content)
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

ipcMain.handle('ot:connect', async (_e, projectId: string) => {
  if (!overleafSessionCookie) return { success: false, message: 'not_logged_in' }

  try {
    overleafSock = new OverleafSocket()

    // Relay events to renderer
    overleafSock.on('connectionState', (state: string) => {
      sendToRenderer('ot:connectionState', state)
    })

    // otUpdateApplied: server acknowledges our op (ack signal for OT client)
    // Only ack when there's no 'op' field — presence of 'op' means it's a remote update, not our ack
    overleafSock.on('serverEvent', (name: string, args: unknown[]) => {
      if (name === 'otUpdateApplied') {
        const update = args[0] as { doc?: string; op?: unknown[]; v?: number } | undefined
        if (update?.doc && !update.op) {
          sendToRenderer('ot:ack', { docId: update.doc })
        }
      } else if (name === 'otUpdateError') {
        console.log(`[ot:error] server rejected update:`, JSON.stringify(args).slice(0, 500))
      }
    })

    overleafSock.on('docRejoined', (docId: string, result: JoinDocResult) => {
      sendToRenderer('ot:docRejoined', {
        docId,
        content: result.docLines.join('\n'),
        version: result.version
      })
    })

    // Relay collaborator cursor updates to renderer + track for MCP
    overleafSock.on('serverEvent', (name: string, args: unknown[]) => {
      if (name === 'clientTracking.clientUpdated') {
        sendToRenderer('cursor:remoteUpdate', args[0])
        // Track online user for MCP
        const u = args[0] as { id: string; user_id?: string; name?: string; email?: string }
        if (u.id) {
          mcpOnlineUsers.set(u.id, { name: u.name || u.email?.split('@')[0] || 'User', email: u.email })
          writeMcpOnlineUsers()
        }
      } else if (name === 'clientTracking.clientDisconnected') {
        sendToRenderer('cursor:remoteDisconnected', args[0])
        const clientId = args[0] as string
        if (clientId) {
          mcpOnlineUsers.delete(clientId)
          writeMcpOnlineUsers()
        }
      } else if (name === 'new-chat-message') {
        sendToRenderer('chat:newMessage', args[0])
      } else if (
        name === 'new-comment' ||
        name === 'resolve-thread' ||
        name === 'reopen-thread' ||
        name === 'delete-thread' ||
        name === 'edit-message' ||
        name === 'delete-message'
      ) {
        sendToRenderer('comments:event', { type: name, args })
      }
    })

    const projectResult = await overleafSock.connect(projectId, overleafSessionCookie)
    const { files, docPathMap, pathDocMap, fileRefs, rootFolderId } = walkRootFolder(projectResult.project.rootFolder)

    // Set up compilation manager
    compilationManager = new CompilationManager(projectId, overleafSessionCookie)

    // Set up file sync bridge for bidirectional sync
    const tmpDir = compilationManager.dir
    fileSyncBridge = new FileSyncBridge(overleafSock, tmpDir, docPathMap, pathDocMap, fileRefs, mainWindow!, projectId, overleafSessionCookie, overleafCsrfToken)
    await fileSyncBridge.start()

    // Start MCP compile watcher (detects compile requests from Claude Code)
    startMcpCompileWatcher(tmpDir)

    // Write MCP state + config for Claude Code integration
    mcpStateDir = tmpDir
    mcpProjectId = projectId
    mcpCommentContexts = {}
    mcpPathDocMap = pathDocMap
    writeMcpState()
    // Write .mcp.json so Claude Code auto-discovers the MCP server
    // Dev: use source file. Packaged: use bundled file in app.asar.unpacked/out/mcp/
    const mcpServerPath = app.isPackaged
      ? join(app.getAppPath() + '.unpacked', 'out', 'mcp', 'lattex.mjs')
      : join(__dirname, '..', '..', 'src', 'mcp', 'lattex.mjs')
    writeFile(join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        lattex: {
          command: 'node',
          args: [mcpServerPath]
        }
      }
    }, null, 2)).catch(() => {})
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

    await writeFile(join(tmpDir, '.claude', 'CLAUDE.md'), `# ${projectResult.project.name} — Overleaf Project

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

## Workspace

The \`claude-workspace/\` directory is your private scratch space. It is **not synced to Overleaf** — use it freely for:
- **Notes and plans** — draft outlines, track TODOs, keep analysis notes
- **Experiments** — test LaTeX snippets, try alternative formulations, prototype figures
- **Scripts** — helper scripts for data processing, bibliography management, etc.

**Important**: Always ask the user before running experiments or creating files in \`claude-workspace/\`. This directory persists across sessions for the same project.
`)
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
            'mcp__lattex__get_compile_log'
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
        sendToRenderer('comments:initThreads', { threads: threadResult.data, resolvedIds })
      }
    }).catch(() => {})

    // Fetch comment contexts from all docs in background (slower — joins each doc)
    setTimeout(async () => {
      if (!overleafSock?.projectData) return

      const { docPathMap: dp } = walkRootFolder(overleafSock.projectData.project.rootFolder)
      const contexts: Record<string, { file: string; text: string; pos: number }> = {}
      for (const [did, rp] of Object.entries(dp)) {
        try {
          const alreadyJoined = docEventHandlers.has(did)
          const result = await overleafSock.joinDoc(did)
          if (result.ranges?.comments) {
            for (const c of result.ranges.comments) {
              if (c.op?.t) contexts[c.op.t] = { file: rp, text: c.op.c || '', pos: c.op.p || 0 }
            }
          }
          if (!alreadyJoined) await overleafSock.leaveDoc(did)
        } catch { /* ignore */ }
      }
      mcpCommentContexts = contexts
      writeMcpState()
      sendToRenderer('comments:initContexts', { contexts })
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
  } catch (e) {
    console.log('[ot:connect] error:', e)
    return { success: false, message: String(e) }
  }
})

ipcMain.handle('ot:disconnect', async () => {
  // Clean up MCP state file + compile watcher
  stopMcpCompileWatcher()
  if (mcpStateDir) {
    unlink(join(mcpStateDir, '.lattex-mcp.json')).catch(() => {})
    unlink(join(mcpStateDir, '.lattex-online-users.json')).catch(() => {})
  }
  mcpStateDir = ''
  mcpProjectId = ''
  mcpCommentContexts = {}
  mcpOnlineUsers.clear()

  await fileSyncBridge?.stop()
  fileSyncBridge = null
  overleafSock?.disconnect()
  overleafSock = null
  await compilationManager?.cleanup()
  compilationManager = null
})

// Track per-doc event handlers for cleanup on leaveDoc
const docEventHandlers = new Map<string, (name: string, args: unknown[]) => void>()

ipcMain.handle('ot:joinDoc', async (_e, docId: string) => {
  if (!overleafSock) return { success: false, message: 'not_connected' }

  try {
    const result = await overleafSock.joinDoc(docId)
    const content = (result.docLines || []).join('\n')
    // Update compilation manager with doc content
    if (compilationManager && overleafSock.projectData) {
      const { docPathMap } = walkRootFolder(overleafSock.projectData.project.rootFolder)
      const relPath = docPathMap[docId]
      if (relPath) {
        compilationManager.setDocContent(relPath, content)
      }
    }

    // Notify bridge that editor is taking over this doc
    fileSyncBridge?.addEditorDoc(docId)

    // Remove existing handler if rejoining
    const existingHandler = docEventHandlers.get(docId)
    if (existingHandler) overleafSock.removeListener('serverEvent', existingHandler)

    // Set up relay for remote ops on this doc
    const handler = (name: string, args: unknown[]) => {
      if (name === 'otUpdateApplied') {
        const update = args[0] as { doc?: string; op?: unknown[]; v?: number } | undefined
        if (update?.doc === docId && update.op) {
          sendToRenderer('ot:remoteOp', {
            docId: update.doc,
            ops: update.op,
            version: update.v
          })
        }
      }
    }
    docEventHandlers.set(docId, handler)
    overleafSock.on('serverEvent', handler)

    return {
      success: true,
      content,
      version: result.version,
      ranges: result.ranges
    }
  } catch (e) {
    console.log('[ot:joinDoc] error:', e)
    return { success: false, message: String(e) }
  }
})

ipcMain.handle('ot:leaveDoc', async (_e, docId: string) => {
  if (!overleafSock) return
  try {
    // Remove event handler for this doc
    const handler = docEventHandlers.get(docId)
    if (handler) {
      overleafSock.removeListener('serverEvent', handler)
      docEventHandlers.delete(docId)
    }
    // Bridge takes back OT ownership — do NOT leaveDoc on the socket,
    // the bridge keeps the doc joined for sync
    fileSyncBridge?.removeEditorDoc(docId)
  } catch (e) {
    console.log('[ot:leaveDoc] error:', e)
  }
})

ipcMain.handle('ot:sendOp', async (_e, docId: string, ops: unknown[], version: number, hash: string) => {
  if (!overleafSock) return
  try {
    await overleafSock.applyOtUpdate(docId, ops, version, hash)
  } catch (e) {
    console.log('[ot:sendOp] error:', e)
  }
})

// Renderer → bridge: editor content changed (for disk sync)
ipcMain.handle('sync:contentChanged', async (_e, docId: string, content: string) => {
  fileSyncBridge?.onEditorContentChanged(docId, content)
})

// ── Cursor Tracking ────────────────────────────────────────────

ipcMain.handle('cursor:update', async (_e, docId: string, row: number, column: number) => {
  overleafSock?.updateCursorPosition(docId, row, column)
})

ipcMain.handle('cursor:getConnectedUsers', async () => {
  if (!overleafSock) return []
  try {
    const users = await overleafSock.getConnectedUsers()
    // Seed MCP online users map
    mcpOnlineUsers.clear()
    for (const raw of users) {
      const u = raw as { client_id?: string; first_name?: string; last_name?: string; email?: string }
      if (u.client_id) {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email?.split('@')[0] || 'User'
        mcpOnlineUsers.set(u.client_id, { name, email: u.email })
      }
    }
    writeMcpOnlineUsers()
    return users
  } catch (e) {
    console.log('[cursor:getConnectedUsers] error:', e)
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
      source: p.source || ''
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
ipcMain.handle('ot:fetchAllCommentContexts', async () => {
  if (!overleafSock?.projectData) return { success: false }

  const { docPathMap } = walkRootFolder(overleafSock.projectData.project.rootFolder)
  const contexts: Record<string, { file: string; text: string; pos: number }> = {}

  for (const [docId, relPath] of Object.entries(docPathMap)) {
    try {
      const alreadyJoined = docEventHandlers.has(docId)
      const result = await overleafSock.joinDoc(docId)
      if (result.ranges?.comments) {
        for (const c of result.ranges.comments) {
          if (c.op?.t) {
            contexts[c.op.t] = { file: relPath, text: c.op.c || '', pos: c.op.p || 0 }
          }
        }
      }
      if (!alreadyJoined) {
        await overleafSock.leaveDoc(docId)
      }
    } catch (e) {
      console.log(`[fetchCommentContexts] failed for ${relPath}:`, e)
    }
  }

  // Update MCP state with fresh comment contexts
  mcpCommentContexts = contexts
  writeMcpState()

  return { success: true, contexts }
})

ipcMain.handle('overleaf:socketCompile', async (_e, mainTexRelPath: string) => {
  if (!compilationManager || !overleafSock?.projectData) {
    return { success: false, log: 'No compilation manager or not connected', pdfPath: '' }
  }

  const { docPathMap, fileRefs } = walkRootFolder(overleafSock.projectData.project.rootFolder)

  // Bridge already keeps all docs synced to disk. Sync content to compilation manager.
  if (fileSyncBridge) {
    for (const [docId, relPath] of Object.entries(docPathMap)) {
      const content = fileSyncBridge.getDocContent(relPath)
      if (content !== undefined) {
        compilationManager.setDocContent(relPath, content)
      }
    }
  } else {
    // Fallback: fetch docs from socket if bridge isn't available
    const allDocIds = Object.keys(docPathMap)
    for (const docId of allDocIds) {
      const relPath = docPathMap[docId]
      if (docEventHandlers.has(docId) && compilationManager.hasDoc(relPath)) continue
      try {
        const alreadyJoined = docEventHandlers.has(docId)
        const result = await overleafSock.joinDoc(docId)
        const content = (result.docLines || []).join('\n')
        compilationManager.setDocContent(relPath, content)
        if (!alreadyJoined) {
          await overleafSock.leaveDoc(docId)
        }
      } catch (e) {
        console.log(`[socketCompile] failed to fetch doc ${relPath}:`, e)
      }
    }
  }

  // Download all binary files (images, .bst, etc.)
  await compilationManager.syncBinaries(fileRefs)

  return compilationManager.compile(mainTexRelPath, (data) => {
    sendToRenderer('latex:log', data)
  })
})

// Server-side compile via Overleaf's CLSI (shared by IPC handler + MCP compile watcher)
let compileInProgress: Promise<{ success: boolean; log: string; pdfPath: string }> | null = null

async function doServerCompile(rootDocId?: string): Promise<{ success: boolean; log: string; pdfPath: string }> {
  // Prevent concurrent compiles — wait for existing one if already in progress
  if (compileInProgress) {
    console.log('[compile] compile already in progress, waiting...')
    return compileInProgress
  }

  const promise = doServerCompileImpl(rootDocId)
  compileInProgress = promise
  try {
    return await promise
  } finally {
    compileInProgress = null
  }
}

async function doServerCompileImpl(rootDocId?: string): Promise<{ success: boolean; log: string; pdfPath: string }> {
  if (!overleafSessionCookie || !overleafSock?.projectData) {
    return { success: false, log: 'Not connected', pdfPath: '' }
  }

  const projectId = overleafSock.projectData.project._id
  const effectiveRootDocId = rootDocId || overleafSock.projectData.project.rootDoc_id || null

  // Resolve rootResourcePath (file path of root doc) — matches Overleaf web client
  let rootResourcePath: string | undefined
  if (effectiveRootDocId) {
    const { docPathMap } = walkRootFolder(overleafSock.projectData.project.rootFolder)
    rootResourcePath = docPathMap[effectiveRootDocId]
  }

  try {
    sendToRenderer('latex:log', 'Compiling on Overleaf server...\n')

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
      sendToRenderer('latex:log', `Compile failed: HTTP ${compileResult.status}\n`)
      return { success: false, log: '', pdfPath: '' }
    }

    const data = compileResult.data as any

    // Diagnostic: log compile status and available output files
    const outputPaths = (data.outputFiles || []).map((f: any) => f.path)
    sendToRenderer('latex:log', `[CLSI status=${data.status}, outputFiles=[${outputPaths.join(', ')}]]\n`)

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
    const syncDir = compilationManager?.dir || join(require('os').tmpdir(), `lattex-${projectId}`)
    const buildDir = join(syncDir, '.build')
    await mkdirAsync(buildDir, { recursive: true })

    // Fetch compile log
    const logFile = (data.outputFiles || []).find((f: any) => f.path === 'output.log')
    if (logFile) {
      try {
        const logContent = await fetchBinary(buildOutputUrl(logFile), overleafSessionCookie)
        const logText = Buffer.from(logContent).toString('utf-8')
        sendToRenderer('latex:log', logText)
        // Write log for MCP server to read (avoids redundant compile API call)
        writeFile(join(syncDir, '.lattex-compile-log'), logText).catch(() => {})
      } catch (e) {
        sendToRenderer('latex:log', `[log fetch failed: ${e}]\n`)
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
        sendToRenderer('latex:log', `\n[PDF download failed: ${e}]\n`)
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
            sendToRenderer('latex:log', `\n[PDF retrieved via direct URL (${(pdfData.byteLength / 1024).toFixed(0)} KB)]\n`)
          }
        } catch {
          // PDF truly not available on CLSI
        }
      }
    }

    if (!pdfPath && data.status !== 'success') {
      sendToRenderer('latex:log', `\n[Compile status: ${data.status} — PDF not available]\n`)
    }

    return { success: data.status === 'success', log: '', pdfPath }
  } catch (e) {
    const msg = `Server compile error: ${e}`
    sendToRenderer('latex:log', msg + '\n')
    return { success: false, log: msg, pdfPath: '' }
  }
}

ipcMain.handle('overleaf:serverCompile', async (_e, rootDocId?: string) => {
  return doServerCompile(rootDocId)
})

// Watch for MCP compile requests (file-based signal from MCP server process)
let mcpCompileWatcher: ReturnType<typeof import('fs').watchFile> | null = null
let mcpCompileActive = false

function startMcpCompileWatcher(syncDir: string) {
  const requestPath = join(syncDir, '.lattex-compile-request')
  const resultPath = join(syncDir, '.lattex-compile-result')

  // Poll for the request file every 300ms
  const { watchFile, unwatchFile } = require('fs')
  watchFile(requestPath, { interval: 300 }, async (curr: { size: number }) => {
    if (curr.size === 0 || mcpCompileActive) return
    mcpCompileActive = true

    try {
      const reqData = JSON.parse(await readFile(requestPath, 'utf-8'))
      await unlink(requestPath).catch(() => {})

      console.log('[mcp-compile] compile request received:', reqData.requestId)

      // Notify renderer: compile started
      sendToRenderer('compile:mcpStarted', null)

      // Resolve main_file to rootDocId if provided
      let rootDocId: string | undefined
      if (reqData.mainFile && mcpPathDocMap[reqData.mainFile]) {
        rootDocId = mcpPathDocMap[reqData.mainFile]
      }

      const result = await doServerCompile(rootDocId)

      // Notify renderer: compile finished (renderer will update PDF + compiling state)
      sendToRenderer('compile:mcpFinished', {
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
      sendToRenderer('compile:mcpFinished', { success: false, pdfPath: '' })
    } finally {
      mcpCompileActive = false
    }
  })

  mcpCompileWatcher = { requestPath } as any
  console.log('[mcp-compile] watcher started for', requestPath)
}

function stopMcpCompileWatcher() {
  if (mcpCompileWatcher) {
    const { unwatchFile } = require('fs')
    unwatchFile((mcpCompileWatcher as any).requestPath)
    mcpCompileWatcher = null
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

/// ── Shell: open external ─────────────────────────────────────────

ipcMain.handle('shell:openExternal', async (_e, url: string) => {
  await shell.openExternal(url)
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
  createWindow()
  sessionLoadPromise = loadOverleafSession()

})

app.on('window-all-closed', () => {
  mainWindow = null
  stopMcpCompileWatcher()
  for (const inst of ptyInstances.values()) inst.kill()
  ptyInstances.clear()
  fileSyncBridge?.stop()
  fileSyncBridge = null
  overleafSock?.disconnect()
  compilationManager?.cleanup()
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
