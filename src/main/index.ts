import { app, BrowserWindow, ipcMain, dialog, shell, net } from 'electron'
import { join, basename, extname, dirname } from 'path'
import { readdir, readFile, writeFile, stat, mkdir, rename, unlink, rm } from 'fs/promises'
import { spawn, type ChildProcess } from 'child_process'
import { watch } from 'chokidar'
import * as pty from 'node-pty'

let mainWindow: BrowserWindow | null = null
let ptyInstance: pty.IPty | null = null
let fileWatcher: ReturnType<typeof watch> | null = null
let compileProcess: ChildProcess | null = null

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

// ── File System IPC ──────────────────────────────────────────────

interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

async function readDirRecursive(dirPath: string, depth = 0): Promise<FileNode[]> {
  if (depth > 5) return []
  const entries = await readdir(dirPath, { withFileTypes: true })
  const nodes: FileNode[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'out') continue

    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      const children = await readDirRecursive(fullPath, depth + 1)
      nodes.push({ name: entry.name, path: fullPath, isDir: true, children })
    } else {
      const ext = extname(entry.name).toLowerCase()
      if (['.tex', '.bib', '.cls', '.sty', '.bst', '.txt', '.md', '.log', '.aux', '.pdf', '.png', '.jpg', '.jpeg', '.svg'].includes(ext)) {
        nodes.push({ name: entry.name, path: fullPath, isDir: false })
      }
    }
  }

  return nodes.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1
    if (!a.isDir && b.isDir) return 1
    return a.name.localeCompare(b.name)
  })
}

ipcMain.handle('dialog:openProject', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Open LaTeX Project'
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

ipcMain.handle('dialog:selectSaveDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose where to clone the project'
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

ipcMain.handle('fs:readDir', async (_e, dirPath: string) => {
  return readDirRecursive(dirPath)
})

ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
  return readFile(filePath, 'utf-8')
})

// Find the main .tex file (contains \documentclass) in a project
ipcMain.handle('fs:findMainTex', async (_e, dirPath: string) => {
  async function search(dir: string, depth: number): Promise<string | null> {
    if (depth > 3) return null
    const entries = await readdir(dir, { withFileTypes: true })
    const texFiles: string[] = []
    const dirs: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'out') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) dirs.push(full)
      else if (entry.name.endsWith('.tex')) texFiles.push(full)
    }
    for (const f of texFiles) {
      try {
        const content = await readFile(f, 'utf-8')
        if (/\\documentclass/.test(content)) return f
      } catch { /* skip */ }
    }
    for (const d of dirs) {
      const found = await search(d, depth + 1)
      if (found) return found
    }
    return null
  }
  return search(dirPath, 0)
})

ipcMain.handle('fs:readBinary', async (_e, filePath: string) => {
  const buffer = await readFile(filePath)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
})

ipcMain.handle('fs:writeFile', async (_e, filePath: string, content: string) => {
  await writeFile(filePath, content, 'utf-8')
})

ipcMain.handle('fs:createFile', async (_e, dirPath: string, fileName: string) => {
  const fullPath = join(dirPath, fileName)
  await writeFile(fullPath, '', 'utf-8')
  return fullPath
})

ipcMain.handle('fs:createDir', async (_e, dirPath: string, dirName: string) => {
  const fullPath = join(dirPath, dirName)
  await mkdir(fullPath, { recursive: true })
  return fullPath
})

ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string) => {
  await rename(oldPath, newPath)
})

ipcMain.handle('fs:delete', async (_e, filePath: string) => {
  const s = await stat(filePath)
  if (s.isDirectory()) {
    await rm(filePath, { recursive: true })
  } else {
    await unlink(filePath)
  }
})

ipcMain.handle('fs:stat', async (_e, filePath: string) => {
  const s = await stat(filePath)
  return { isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs }
})

// ── File Watcher ─────────────────────────────────────────────────

ipcMain.handle('watcher:start', async (_e, dirPath: string) => {
  if (fileWatcher) {
    await fileWatcher.close()
  }
  fileWatcher = watch(dirPath, {
    ignored: /(^|[/\\])(\.|node_modules|out|\.aux|\.log|\.fls|\.fdb_latexmk|\.synctex)/,
    persistent: true,
    depth: 5
  })
  fileWatcher.on('all', (event, path) => {
    mainWindow?.webContents.send('watcher:change', { event, path })
  })
})

ipcMain.handle('watcher:stop', async () => {
  if (fileWatcher) {
    await fileWatcher.close()
    fileWatcher = null
  }
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

// Parse missing packages from compile log
function parseMissingPackages(log: string): string[] {
  const missing = new Set<string>()
  // Match "File `xxx.sty' not found"
  const styRegex = /File `([^']+\.sty)' not found/g
  let m: RegExpExecArray | null
  while ((m = styRegex.exec(log)) !== null) {
    missing.add(m[1].replace(/\.sty$/, ''))
  }
  // Match "Metric (TFM) file not found" for fonts
  const tfmRegex = /Font [^=]+=(\w+) .* not loadable: Metric/g
  while ((m = tfmRegex.exec(log)) !== null) {
    missing.add(m[1])
  }
  return [...missing]
}

// Find which tlmgr packages provide the missing files
async function findTlmgrPackages(names: string[]): Promise<string[]> {
  const packages = new Set<string>()
  for (const name of names) {
    const result = await new Promise<string>((resolve) => {
      let out = ''
      const proc = spawn('tlmgr', ['search', '--file', `${name}.sty`], { env: process.env })
      proc.stdout?.on('data', (d) => { out += d.toString() })
      proc.stderr?.on('data', (d) => { out += d.toString() })
      proc.on('close', () => resolve(out))
      proc.on('error', () => resolve(''))
    })
    // tlmgr search output: "package_name:\n    texmf-dist/..."
    const pkgMatch = result.match(/^(\S+):$/m)
    if (pkgMatch) {
      packages.add(pkgMatch[1])
    } else {
      // Fallback: use the name itself as package name
      packages.add(name)
    }
  }
  return [...packages]
}

ipcMain.handle('latex:compile', async (_e, filePath: string) => {
  if (compileProcess) {
    compileProcess.kill()
  }

  const dir = dirname(filePath)
  const file = basename(filePath)

  return new Promise<{ success: boolean; log: string; missingPackages?: string[] }>((resolve) => {
    let log = ''
    compileProcess = spawn('latexmk', ['-pdf', '-f', '-g', '-bibtex', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', file], {
      cwd: dir,
      env: process.env
    })

    compileProcess.stdout?.on('data', (data) => {
      log += data.toString()
      mainWindow?.webContents.send('latex:log', data.toString())
    })
    compileProcess.stderr?.on('data', (data) => {
      log += data.toString()
      mainWindow?.webContents.send('latex:log', data.toString())
    })
    compileProcess.on('close', async (code) => {
      compileProcess = null
      if (code !== 0) {
        const missing = parseMissingPackages(log)
        if (missing.length > 0) {
          const packages = await findTlmgrPackages(missing)
          resolve({ success: false, log, missingPackages: packages })
          return
        }
      }
      resolve({ success: code === 0, log })
    })
    compileProcess.on('error', (err) => {
      compileProcess = null
      resolve({ success: false, log: err.message })
    })
  })
})

// Install TeX packages via tlmgr (runs in PTY so sudo can prompt for password)
ipcMain.handle('latex:installPackages', async (_e, packages: string[]) => {
  if (!packages.length) return { success: false, message: 'No packages specified' }

  // Try without sudo first
  const tryDirect = await new Promise<{ success: boolean; message: string }>((resolve) => {
    let out = ''
    const proc = spawn('tlmgr', ['install', ...packages], { env: process.env })
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.stderr?.on('data', (d) => { out += d.toString() })
    proc.on('close', (code) => resolve({ success: code === 0, message: out }))
    proc.on('error', (err) => resolve({ success: false, message: err.message }))
  })

  if (tryDirect.success) return tryDirect

  // Need sudo — run in PTY terminal so user can enter password
  return { success: false, message: 'need_sudo', packages }
})

ipcMain.handle('latex:getPdfPath', async (_e, texPath: string) => {
  return texPath.replace(/\.tex$/, '.pdf')
})

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

// SyncTeX: source file:line → PDF page + position (forward search)
ipcMain.handle('synctex:viewFromSource', async (_e, texPath: string, line: number, pdfPath: string) => {
  return new Promise<{ page: number; x: number; y: number } | null>((resolve) => {
    const proc = spawn('synctex', ['view', '-i', `${line}:0:${texPath}`, '-o', pdfPath], {
      env: process.env
    })
    let out = ''
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.stderr?.on('data', (d) => { out += d.toString() })
    proc.on('close', () => {
      const pageMatch = out.match(/Page:(\d+)/)
      const xMatch = out.match(/x:([0-9.]+)/)
      const yMatch = out.match(/y:([0-9.]+)/)
      if (pageMatch) {
        resolve({
          page: parseInt(pageMatch[1]),
          x: xMatch ? parseFloat(xMatch[1]) : 0,
          y: yMatch ? parseFloat(yMatch[1]) : 0
        })
      } else {
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

// ── Overleaf / Git Sync ──────────────────────────────────────────

// Helper: run git with explicit credentials via a temp credential helper script
function gitWithCreds(args: string[], email: string, password: string, cwd?: string): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    // Use inline credential helper that echoes stored creds
    const helper = `!f() { echo "username=${email}"; echo "password=${password}"; }; f`
    const fullArgs = ['-c', `credential.helper=${helper}`, ...args]
    console.log('[git]', args[0], args.slice(1).join(' ').replace(password, '***'))
    const proc = spawn('git', fullArgs, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    let output = ''
    proc.stdout?.on('data', (d) => { output += d.toString() })
    proc.stderr?.on('data', (d) => { output += d.toString() })
    proc.on('close', (code) => {
      console.log('[git] exit code:', code, 'output:', output.slice(0, 300))
      resolve({ success: code === 0, message: output })
    })
    proc.on('error', (err) => {
      console.log('[git] error:', err.message)
      resolve({ success: false, message: err.message })
    })
  })
}

// Helper: run git with osxkeychain (for after credentials are stored)
function gitSpawn(args: string[], cwd?: string): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const fullArgs = ['-c', 'credential.helper=osxkeychain', ...args]
    const proc = spawn('git', fullArgs, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    let output = ''
    proc.stdout?.on('data', (d) => { output += d.toString() })
    proc.stderr?.on('data', (d) => { output += d.toString() })
    proc.on('close', (code) => {
      resolve({ success: code === 0, message: output })
    })
    proc.on('error', (err) => {
      resolve({ success: false, message: err.message })
    })
  })
}

// Store credentials in macOS Keychain (no verification — that happens in overleaf:cloneWithAuth)
function storeCredentials(email: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Erase old first
    const erase = spawn('git', ['credential-osxkeychain', 'erase'])
    erase.stdin?.write(`protocol=https\nhost=git.overleaf.com\n\n`)
    erase.stdin?.end()
    erase.on('close', () => {
      const store = spawn('git', ['credential-osxkeychain', 'store'])
      store.stdin?.write(`protocol=https\nhost=git.overleaf.com\nusername=${email}\npassword=${password}\n\n`)
      store.stdin?.end()
      store.on('close', (code) => resolve(code === 0))
    })
  })
}

// Verify credentials + project access using git ls-remote, then clone
// Overleaf git auth: username is always literal "git", password is the token
ipcMain.handle('overleaf:cloneWithAuth', async (_e, projectId: string, dest: string, token: string, remember: boolean) => {
  const repoUrl = `https://git.overleaf.com/${projectId}`
  console.log('[overleaf:cloneWithAuth] Verifying access to:', projectId)

  // Step 1: ls-remote to verify both auth and project access
  // Username must be "git" (not email), password is the olp_ token
  const verify = await gitWithCreds(['ls-remote', '--heads', repoUrl], 'git', token)

  if (!verify.success) {
    const msg = verify.message
    console.log('[overleaf:cloneWithAuth] ls-remote failed:', msg)
    if (msg.includes('only supports Git authentication tokens') || msg.includes('token')) {
      return { success: false, message: 'need_token', detail: 'Overleaf requires a Git Authentication Token (not your password).\n\n1. Go to Overleaf → Account Settings\n2. Find "Git Integration"\n3. Generate a token and paste it here.' }
    }
    if (msg.includes('Authentication failed') || msg.includes('401') || msg.includes('403') || msg.includes('could not read')) {
      return { success: false, message: 'auth_failed', detail: 'Authentication failed. Make sure you are using a Git Authentication Token, not your Overleaf password.' }
    }
    if (msg.includes('not found') || msg.includes('does not appear to be a git repository')) {
      return { success: false, message: 'not_found', detail: 'Project not found. Check the URL and ensure you have access.' }
    }
    return { success: false, message: 'error', detail: msg }
  }

  console.log('[overleaf:cloneWithAuth] Auth verified. Storing credentials and cloning...')

  // Step 2: Credentials work — store in keychain if requested
  if (remember) {
    await storeCredentials('git', token)
    console.log('[overleaf:cloneWithAuth] Token saved to Keychain')
  }

  // Step 3: Clone using keychain credentials
  const result = await gitSpawn(['clone', repoUrl, dest])
  if (result.success) {
    return { success: true, message: 'ok', detail: '' }
  } else {
    return { success: false, message: 'clone_failed', detail: result.message }
  }
})

// Check if credentials exist in Keychain
ipcMain.handle('overleaf:check', async () => {
  return new Promise<{ loggedIn: boolean; email: string }>((resolve) => {
    const proc = spawn('git', ['credential-osxkeychain', 'get'])
    let out = ''
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.stdin?.write(`protocol=https\nhost=git.overleaf.com\n\n`)
    proc.stdin?.end()
    proc.on('close', (code) => {
      if (code === 0 && out.includes('username=')) {
        const match = out.match(/username=(.+)/)
        resolve({ loggedIn: true, email: match?.[1]?.trim() ?? '' })
      } else {
        resolve({ loggedIn: false, email: '' })
      }
    })
    proc.on('error', () => {
      resolve({ loggedIn: false, email: '' })
    })
  })
})

// Remove credentials from Keychain
ipcMain.handle('overleaf:logout', async () => {
  return new Promise<void>((resolve) => {
    const proc = spawn('git', ['credential-osxkeychain', 'erase'])
    proc.stdin?.write(`protocol=https\nhost=git.overleaf.com\n\n`)
    proc.stdin?.end()
    proc.on('close', () => resolve())
  })
})

// Git operations for existing repos — use osxkeychain
ipcMain.handle('git:pull', async (_e, cwd: string) => {
  return gitSpawn(['pull'], cwd)
})

ipcMain.handle('git:push', async (_e, cwd: string) => {
  const add = await gitSpawn(['add', '-A'], cwd)
  if (!add.success) return add
  await gitSpawn(['commit', '-m', `Sync from ClaudeTeX ${new Date().toISOString()}`], cwd)
  return gitSpawn(['push'], cwd)
})

ipcMain.handle('git:status', async (_e, cwd: string) => {
  const result = await gitSpawn(['status', '--porcelain'], cwd)
  return { isGit: result.success, status: result.message }
})

// ── Shell: open external ─────────────────────────────────────────

ipcMain.handle('shell:openExternal', async (_e, url: string) => {
  await shell.openExternal(url)
})

ipcMain.handle('shell:showInFinder', async (_e, path: string) => {
  shell.showItemInFolder(path)
})

// ── App Lifecycle ────────────────────────────────────────────────

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  ptyInstance?.kill()
  fileWatcher?.close()
  compileProcess?.kill()
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
