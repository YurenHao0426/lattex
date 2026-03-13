// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { app, BrowserWindow, ipcMain, dialog, shell, net } from 'electron'
import { join, basename } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import * as pty from 'node-pty'
import { OverleafSocket, type RootFolder, type SubFolder, type JoinDocResult } from './overleafSocket'
import { CompilationManager } from './compilationManager'
import { FileSyncBridge } from './fileSyncBridge'

let mainWindow: BrowserWindow | null = null
let ptyInstance: pty.IPty | null = null
let overleafSock: OverleafSocket | null = null
let compilationManager: CompilationManager | null = null
let fileSyncBridge: FileSyncBridge | null = null

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

ipcMain.handle('pty:spawn', async (_e, cwd: string) => {
  if (ptyInstance) {
    ptyInstance.kill()
  }

  const shellPath = process.env.SHELL || '/bin/zsh'
  ptyInstance = pty.spawn(shellPath, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>
  })

  ptyInstance.onData((data) => {
    mainWindow?.webContents.send('pty:data', data)
  })

  ptyInstance.onExit(() => {
    mainWindow?.webContents.send('pty:exit')
  })
})

ipcMain.handle('pty:write', async (_e, data: string) => {
  ptyInstance?.write(data)
})

ipcMain.handle('pty:resize', async (_e, cols: number, rows: number) => {
  try {
    ptyInstance?.resize(cols, rows)
  } catch { /* ignore resize errors */ }
})

ipcMain.handle('pty:kill', async () => {
  ptyInstance?.kill()
  ptyInstance = null
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
ipcMain.handle('overleaf:resolveThread', async (_e, projectId: string, threadId: string) => {
  if (!overleafSessionCookie) return { success: false }
  const result = await overleafFetch(`/project/${projectId}/thread/${threadId}/resolve`, {
    method: 'POST',
    body: '{}'
  })
  return { success: result.ok }
})

// Reopen a thread
ipcMain.handle('overleaf:reopenThread', async (_e, projectId: string, threadId: string) => {
  if (!overleafSessionCookie) return { success: false }
  const result = await overleafFetch(`/project/${projectId}/thread/${threadId}/reopen`, {
    method: 'POST',
    body: '{}'
  })
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

// Add a new comment: create thread via REST then submit op via Socket.IO
async function addComment(
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

  // Step 2: Submit the comment op via Socket.IO WebSocket
  const hsRes = await overleafFetch(`/socket.io/1/?t=${Date.now()}&projectId=${projectId}`, { raw: true })
  if (!hsRes.ok) return { success: false, message: 'handshake failed' }
  const sid = (hsRes.data as string).split(':')[0]
  if (!sid) return { success: false, message: 'no sid' }

  const { session: electronSession } = await import('electron')
  const ses = electronSession.fromPartition('overleaf-sio-add-' + Date.now())

  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    delete headers['set-cookie']
    delete headers['Set-Cookie']
    callback({ responseHeaders: headers })
  })

  const allCookieParts = overleafSessionCookie.split('; ')
  for (const sc of hsRes.setCookies) {
    allCookieParts.push(sc.split(';')[0])
  }
  for (const pair of allCookieParts) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx < 0) continue
    try {
      await ses.cookies.set({
        url: 'https://www.overleaf.com',
        name: pair.substring(0, eqIdx),
        value: pair.substring(eqIdx + 1),
        domain: '.overleaf.com',
        path: '/',
        secure: true
      })
    } catch { /* ignore */ }
  }

  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: false, session: ses }
  })

  try {
    win.webContents.on('console-message', (_e, _level, msg) => {
      console.log('[overleaf-add-comment]', msg)
    })
    await win.loadURL('https://www.overleaf.com/login')

    const script = `
      new Promise(async (mainResolve) => {
        try {
          var ws = new WebSocket('wss://' + location.host + '/socket.io/1/websocket/${sid}');
          var ackId = 0, ackCbs = {}, evtCbs = {};

          ws.onmessage = function(e) {
            var d = e.data;
            if (d === '2::') { ws.send('2::'); return; }
            if (d === '1::') return;
            var am = d.match(/^6:::(\\d+)\\+([\\s\\S]*)/);
            if (am) {
              var cb = ackCbs[parseInt(am[1])];
              if (cb) { delete ackCbs[parseInt(am[1])]; try { cb(JSON.parse(am[2])); } catch(e2) { cb(null); } }
              return;
            }
            var em2 = d.match(/^5:::(\\{[\\s\\S]*\\})/);
            if (em2) {
              try {
                var evt = JSON.parse(em2[1]);
                var ecb = evtCbs[evt.name];
                if (ecb) { delete evtCbs[evt.name]; ecb(evt.args); }
              } catch(e3) {}
            }
          };

          function emitAck(name, args) {
            return new Promise(function(res) { ackId++; ackCbs[ackId] = res;
              ws.send('5:' + ackId + '+::' + JSON.stringify({ name: name, args: args })); });
          }
          function waitEvent(name) {
            return new Promise(function(res) { evtCbs[name] = res; });
          }

          ws.onerror = function() { mainResolve({ error: 'ws_error' }); };
          ws.onclose = function(ev) { console.log('ws closed: ' + ev.code); };

          ws.onopen = async function() {
            try {
              var jpPromise = waitEvent('joinProjectResponse');
              ws.send('5:::' + JSON.stringify({ name: 'joinProject', args: [{ project_id: '${projectId}' }] }));
              await jpPromise;

              // Join the doc to submit the op
              await emitAck('joinDoc', ['${docId}']);

              // Submit the comment op
              var commentOp = { c: ${JSON.stringify(text)}, p: ${pos}, t: '${threadId}' };
              console.log('submitting op: ' + JSON.stringify(commentOp));
              await emitAck('applyOtUpdate', ['${docId}', { doc: '${docId}', op: [commentOp], v: 0 }]);

              await emitAck('leaveDoc', ['${docId}']);
              ws.close();
              mainResolve({ success: true });
            } catch (e) { ws.close(); mainResolve({ error: e.message }); }
          };
          setTimeout(function() { ws.close(); mainResolve({ error: 'timeout' }); }, 30000);
        } catch (e) { mainResolve({ error: e.message }); }
      });
    `

    const result = await win.webContents.executeJavaScript(script)
    console.log('[overleaf] addComment result:', result)

    if (result?.error) return { success: false, message: result.error }
    return { success: true, threadId }
  } catch (e) {
    console.log('[overleaf] addComment error:', e)
    return { success: false, message: String(e) }
  } finally {
    win.close()
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
      mainWindow?.webContents.send('ot:connectionState', state)
    })

    // otUpdateApplied: server acknowledges our op (ack signal for OT client)
    overleafSock.on('serverEvent', (name: string, args: unknown[]) => {
      if (name === 'otUpdateApplied') {
        const update = args[0] as { doc?: string; v?: number } | undefined
        if (update?.doc) {
          mainWindow?.webContents.send('ot:ack', { docId: update.doc })
        }
      }
    })

    overleafSock.on('docRejoined', (docId: string, result: JoinDocResult) => {
      mainWindow?.webContents.send('ot:docRejoined', {
        docId,
        content: result.docLines.join('\n'),
        version: result.version
      })
    })

    // Relay collaborator cursor updates to renderer
    overleafSock.on('serverEvent', (name: string, args: unknown[]) => {
      if (name === 'clientTracking.clientUpdated') {
        mainWindow?.webContents.send('cursor:remoteUpdate', args[0])
      } else if (name === 'clientTracking.clientDisconnected') {
        mainWindow?.webContents.send('cursor:remoteDisconnected', args[0])
      } else if (name === 'new-chat-message') {
        mainWindow?.webContents.send('chat:newMessage', args[0])
      }
    })

    const projectResult = await overleafSock.connect(projectId, overleafSessionCookie)
    const { files, docPathMap, pathDocMap, fileRefs, rootFolderId } = walkRootFolder(projectResult.project.rootFolder)

    // Set up compilation manager
    compilationManager = new CompilationManager(projectId, overleafSessionCookie)

    // Set up file sync bridge for bidirectional sync
    const tmpDir = compilationManager.dir
    fileSyncBridge = new FileSyncBridge(overleafSock, tmpDir, docPathMap, pathDocMap, mainWindow!)
    fileSyncBridge.start().catch((e) => {
      console.log('[ot:connect] fileSyncBridge start error:', e)
    })

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
      rootFolderId
    }
  } catch (e) {
    console.log('[ot:connect] error:', e)
    return { success: false, message: String(e) }
  }
})

ipcMain.handle('ot:disconnect', async () => {
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
          mainWindow?.webContents.send('ot:remoteOp', {
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
  const result = await overleafFetch('/api/project/new', {
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
      url: 'https://www.overleaf.com/api/project/new/upload'
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
    mainWindow?.webContents.send('latex:log', data)
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
