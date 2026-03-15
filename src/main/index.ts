// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { app, BrowserWindow, ipcMain, dialog, shell, net } from 'electron'
import { join, basename } from 'path'
import { readFile, writeFile, mkdir as mkdirAsync, unlink } from 'fs/promises'
import { spawn } from 'child_process'
import * as pty from 'node-pty'
import { OverleafSocket, type RootFolder, type SubFolder, type JoinDocResult } from './overleafSocket'
import { CompilationManager } from './compilationManager'
import { FileSyncBridge } from './fileSyncBridge'

let mainWindow: BrowserWindow | null = null
const ptyInstances = new Map<string, pty.IPty>()
let overleafSock: OverleafSocket | null = null
let compilationManager: CompilationManager | null = null
let fileSyncBridge: FileSyncBridge | null = null
let mcpStateDir = ''           // syncDir for .lattex-mcp.json
let mcpProjectId = ''
let mcpCommentContexts: Record<string, { file: string; text: string; pos: number }> = {}
let mcpPathDocMap: Record<string, string> = {}  // relPath → docId for MCP

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
    const proc = spawn('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdfPath}`], {
      env: process.env
    })
    let out = ''
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.stderr?.on('data', (d) => { out += d.toString() })
    proc.on('close', () => {
      // Parse output: Input:filename\nLine:123\n...
      const fileMatch = out.match(/Input:(.+)/)
      const lineMatch = out.match(/Line:(\d+)/)
      if (fileMatch && lineMatch) {
        resolve({ file: fileMatch[1].trim(), line: parseInt(lineMatch[1]) })
      } else {
        console.log('[synctex] no result:', out.slice(0, 200))
        resolve(null)
      }
    })
    proc.on('error', () => resolve(null))
  })
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

    // Relay collaborator cursor updates to renderer
    overleafSock.on('serverEvent', (name: string, args: unknown[]) => {
      if (name === 'clientTracking.clientUpdated') {
        sendToRenderer('cursor:remoteUpdate', args[0])
      } else if (name === 'clientTracking.clientDisconnected') {
        sendToRenderer('cursor:remoteDisconnected', args[0])
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

    // Write MCP state + config for Claude Code integration
    mcpStateDir = tmpDir
    mcpProjectId = projectId
    mcpCommentContexts = {}
    mcpPathDocMap = pathDocMap
    writeMcpState()
    // Write .mcp.json so Claude Code auto-discovers the MCP server
    const appRoot = app.isPackaged ? join(app.getAppPath(), '..') : join(__dirname, '..', '..')
    const mcpServerPath = join(appRoot, 'src', 'mcp', 'lattex.mjs')
    writeFile(join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        lattex: {
          command: 'node',
          args: [mcpServerPath]
        }
      }
    }, null, 2)).catch(() => {})
    // Write CLAUDE.md with project context
    writeFile(join(tmpDir, 'CLAUDE.md'), `# LatteX Project — Overleaf Integration

This is a LaTeX project synced from Overleaf via LatteX. Files here are bidirectionally synced — edits you make will appear on Overleaf.

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
- **compile_latex**: Trigger LaTeX compilation. Pass \`main_file\` if needed.

### Comment Workflow
1. Use \`get_comments\` to see what reviewers have flagged
2. Edit the .tex files to address the feedback
3. Use \`reply_to_comment\` to explain what you changed
4. Use \`resolve_comment\` to mark it as done
`).catch(() => {})
    // Write .claude/settings.json to auto-allow MCP tools
    mkdirAsync(join(tmpDir, '.claude'), { recursive: true }).then(() =>
      writeFile(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
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
            'mcp__lattex__compile_latex'
          ]
        }
      }, null, 2))
    ).catch(() => {})

    // Fetch threads + comment contexts in background so editor highlights are correct from the start
    setTimeout(async () => {
      if (!overleafSock?.projectData) return

      // Fetch threads (fast REST call) to know which are resolved
      const threadResult = await overleafFetch(`/project/${projectId}/threads`)
      if (threadResult.ok && threadResult.data) {
        const threads = threadResult.data as Record<string, { resolved?: boolean }>
        const resolvedIds: string[] = []
        for (const [tid, t] of Object.entries(threads)) {
          if (t.resolved) resolvedIds.push(tid)
        }
        sendToRenderer('comments:initThreads', { threads: threadResult.data, resolvedIds })
      }

      // Fetch comment contexts from all docs
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
      syncDir: tmpDir
    }
  } catch (e) {
    console.log('[ot:connect] error:', e)
    return { success: false, message: String(e) }
  }
})

ipcMain.handle('ot:disconnect', async () => {
  // Clean up MCP state file
  if (mcpStateDir) {
    unlink(join(mcpStateDir, '.lattex-mcp.json')).catch(() => {})
  }
  mcpStateDir = ''
  mcpProjectId = ''
  mcpCommentContexts = {}

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
    return await overleafSock.getConnectedUsers()
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

/// ── Shell: open external ─────────────────────────────────────────

ipcMain.handle('shell:openExternal', async (_e, url: string) => {
  await shell.openExternal(url)
})

ipcMain.handle('shell:showInFinder', async (_e, path: string) => {
  shell.showItemInFolder(path)
})

// ── App Lifecycle ────────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow()
  sessionLoadPromise = loadOverleafSession()

})

app.on('window-all-closed', () => {
  mainWindow = null
  ptyInstance?.kill()
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
