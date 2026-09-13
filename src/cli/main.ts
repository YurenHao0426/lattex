#!/usr/bin/env node
// lattex-cli: headless CLI for Overleaf project management
// Designed for AI agents — short output, JSON mode, meaningful exit codes

import { join, resolve, basename, dirname } from 'path'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import https from 'https'
import { OverleafApi } from './overleafApi'
import { walkRootFolder, type FileTreeResult } from './fileTree'
import { saveCookie, loadCookie, loadState, saveState, hasState, type CloneState } from './localState'
import { computeDiff, hashFile, walkDir, isTextFile, type FileChange } from './diff'
import { parseCompileLog, formatEntry } from './logParser'
import { parseArgs } from './args'

// ── Exit codes ──
const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_AUTH = 2
const EXIT_CONFLICT = 3
const EXIT_USAGE = 64

// ── Output helpers ──
let jsonMode = false

function out(text: string): void {
  process.stdout.write(text + '\n')
}

function err(text: string): void {
  process.stderr.write(text + '\n')
}

function jsonOut(data: unknown): void {
  out(JSON.stringify(data, null, 2))
}

function exitWith(code: number, message?: string): never {
  if (message) {
    if (jsonMode) {
      jsonOut({ error: message })
    } else {
      err(message)
    }
  }
  process.exit(code)
}

// ── Auth ──

async function resolveAuth(flags: Record<string, string | boolean>): Promise<string> {
  // 1. --cookie flag
  if (typeof flags.cookie === 'string' && flags.cookie) {
    return flags.cookie
  }
  // 2. LATTEX_COOKIE env
  if (process.env.LATTEX_COOKIE) {
    return process.env.LATTEX_COOKIE
  }
  // 3. --from-cdp (Chrome DevTools Protocol)
  if (typeof flags['from-cdp'] === 'string' && flags['from-cdp']) {
    return await getCookieFromCDP(flags['from-cdp'])
  }
  // 4. Stored cookie
  const stored = await loadCookie()
  if (stored) return stored

  exitWith(EXIT_AUTH, 'No auth found. Use: lattex-cli auth --cookie "..." or set LATTEX_COOKIE')
}

async function getCookieFromCDP(endpoint: string): Promise<string> {
  // Fetch cookies from a Chromium browser via CDP
  const url = endpoint.replace(/\/$/, '')

  // First get the websocket debugger URL
  const targetsUrl = `${url}/json`
  const targets: any[] = await new Promise((resolve, reject) => {
    const mod = targetsUrl.startsWith('https') ? https : require('http')
    mod.get(targetsUrl, (res: any) => {
      let body = ''
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { reject(new Error('Invalid CDP response')) }
      })
    }).on('error', reject)
  })

  // Find an Overleaf page or use the first target
  const target = targets.find((t: any) =>
    t.url?.includes('overleaf.com')
  ) || targets[0]

  if (!target?.webSocketDebuggerUrl) {
    throw new Error('No debuggable target found')
  }

  // Connect via WebSocket to get cookies
  const { default: WebSocket } = await import('ws')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const timeout = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')) }, 10000)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Network.getCookies',
        params: { urls: ['https://www.overleaf.com'] }
      }))
    })

    ws.on('message', (data: Buffer) => {
      clearTimeout(timeout)
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === 1 && msg.result?.cookies) {
          const cookies = msg.result.cookies
            .filter((c: any) => c.domain?.includes('overleaf.com'))
            .map((c: any) => `${c.name}=${c.value}`)
            .join('; ')
          ws.close()
          if (!cookies) reject(new Error('No Overleaf cookies found in browser'))
          else resolve(cookies)
        }
      } catch (e) {
        ws.close()
        reject(e)
      }
    })

    ws.on('error', (e) => { clearTimeout(timeout); reject(e) })
  })
}

// ── Commands ──

async function cmdAuth(flags: Record<string, string | boolean>): Promise<void> {
  let cookie: string

  if (typeof flags.cookie === 'string') {
    cookie = flags.cookie
  } else if (process.env.LATTEX_COOKIE) {
    cookie = process.env.LATTEX_COOKIE
  } else if (typeof flags['from-cdp'] === 'string') {
    cookie = await getCookieFromCDP(flags['from-cdp'])
  } else {
    exitWith(EXIT_USAGE, 'Usage: lattex-cli auth --cookie "..." | --from-cdp URL | env LATTEX_COOKIE')
  }

  const api = new OverleafApi(cookie!)
  const valid = await api.verifySession()
  if (!valid) {
    exitWith(EXIT_AUTH, 'Session cookie is invalid or expired')
  }

  await saveCookie(cookie!)

  if (jsonMode) {
    jsonOut({ ok: true })
  } else {
    out('Auth saved to ~/.config/lattex/auth.json')
  }
}

async function cmdProjects(flags: Record<string, string | boolean>): Promise<void> {
  const cookie = await resolveAuth(flags)
  const api = new OverleafApi(cookie)

  const projects = await api.listProjects()
  if (jsonMode) {
    jsonOut(projects.map(p => ({
      id: p.id,
      name: p.name,
      lastUpdated: p.lastUpdated,
      accessLevel: p.accessLevel
    })))
  } else {
    if (projects.length === 0) {
      out('No projects found.')
      return
    }
    for (const p of projects) {
      const date = p.lastUpdated ? new Date(p.lastUpdated).toISOString().slice(0, 10) : ''
      out(`${p.id}  ${p.name}  ${date}  ${p.accessLevel}`)
    }
  }
}

async function cmdClone(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const projectRef = positional[0]
  const targetDir = positional[1]
  if (!projectRef || !targetDir) {
    exitWith(EXIT_USAGE, 'Usage: lattex-cli clone <project-id|name> <dir>')
  }

  const cookie = await resolveAuth(flags)
  const api = new OverleafApi(cookie)
  const dir = resolve(targetDir)

  // Resolve project ID from name if needed
  let projectId = projectRef
  if (!projectRef.match(/^[0-9a-f]{24}$/)) {
    const projects = await api.listProjects()
    const match = projects.find(p => p.name === projectRef)
    if (!match) {
      exitWith(EXIT_ERROR, `Project not found: ${projectRef}`)
    }
    projectId = match!.id
  }

  // Get project data via WebSocket
  err(`Connecting to project ${projectId}...`)
  const projectData = await api.getProjectData(projectId)
  const tree = walkRootFolder(projectData.project.rootFolder)

  // Create directory
  await mkdir(dir, { recursive: true })

  // Download all docs
  const fileHashes: Record<string, string> = {}
  let docCount = 0
  let fileCount = 0

  for (const [docId, relPath] of Object.entries(tree.docPathMap)) {
    err(`  doc: ${relPath}`)
    const doc = await api.getDocContent(projectId, docId)
    const content = doc.lines.join('\n')
    const absPath = join(dir, relPath)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, content, 'utf-8')
    fileHashes[relPath] = createHash('sha256').update(content).digest('hex')
    docCount++
  }

  // Download all binary files
  for (const ref of tree.fileRefs) {
    err(`  file: ${ref.path}`)
    const data = await api.downloadFile(projectId, ref.id)
    const absPath = join(dir, ref.path)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, data)
    fileHashes[ref.path] = createHash('sha256').update(data).digest('hex')
    fileCount++
  }

  // Build reverse maps
  const fileRefPathMap: Record<string, string> = {}
  const pathFileRefMap: Record<string, string> = {}
  for (const ref of tree.fileRefs) {
    fileRefPathMap[ref.id] = ref.path
    pathFileRefMap[ref.path] = ref.id
  }

  // Save state
  const state: CloneState = {
    projectId,
    projectName: projectData.project.name,
    docPathMap: tree.docPathMap,
    pathDocMap: tree.pathDocMap,
    fileRefPathMap,
    pathFileRefMap,
    folderMap: tree.folderMap,
    pathFolderMap: tree.pathFolderMap,
    rootFolderId: tree.rootFolderId,
    rootDocId: projectData.project.rootDoc_id,
    lastPull: new Date().toISOString(),
    fileHashes
  }
  await saveState(dir, state)

  if (jsonMode) {
    jsonOut({ ok: true, projectId, projectName: projectData.project.name, docs: docCount, files: fileCount })
  } else {
    out(`Cloned "${projectData.project.name}" → ${dir} (${docCount} docs, ${fileCount} files)`)
  }
}

async function cmdPull(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const dir = resolve(positional[0] || '.')
  const state = await loadState(dir)
  if (!state) exitWith(EXIT_ERROR, `Not a lattex clone: ${dir}`)

  const cookie = await resolveAuth(flags)
  const api = new OverleafApi(cookie)

  err(`Pulling project ${state!.projectName}...`)
  const projectData = await api.getProjectData(state!.projectId)
  const tree = walkRootFolder(projectData.project.rootFolder)

  const fileHashes: Record<string, string> = {}
  let updated = 0

  // Update/create docs
  for (const [docId, relPath] of Object.entries(tree.docPathMap)) {
    const doc = await api.getDocContent(state!.projectId, docId)
    const content = doc.lines.join('\n')
    const newHash = createHash('sha256').update(content).digest('hex')

    if (newHash !== state!.fileHashes[relPath]) {
      err(`  updated: ${relPath}`)
      const absPath = join(dir, relPath)
      await mkdir(dirname(absPath), { recursive: true })
      await writeFile(absPath, content, 'utf-8')
      updated++
    }
    fileHashes[relPath] = newHash
  }

  // Update/create binary files
  const fileRefPathMap: Record<string, string> = {}
  const pathFileRefMap: Record<string, string> = {}
  for (const ref of tree.fileRefs) {
    fileRefPathMap[ref.id] = ref.path
    pathFileRefMap[ref.path] = ref.id

    const data = await api.downloadFile(state!.projectId, ref.id)
    const newHash = createHash('sha256').update(data).digest('hex')

    if (newHash !== state!.fileHashes[ref.path]) {
      err(`  updated: ${ref.path}`)
      const absPath = join(dir, ref.path)
      await mkdir(dirname(absPath), { recursive: true })
      await writeFile(absPath, data)
      updated++
    }
    fileHashes[ref.path] = newHash
  }

  // Remove local files that no longer exist remotely
  const remotePaths = new Set([
    ...Object.values(tree.docPathMap),
    ...tree.fileRefs.map(r => r.path)
  ])
  for (const relPath of Object.keys(state!.fileHashes)) {
    if (!remotePaths.has(relPath)) {
      const absPath = join(dir, relPath)
      try { await unlink(absPath) } catch { /* ok */ }
      err(`  removed: ${relPath}`)
      updated++
    }
  }

  // Update state
  const newState: CloneState = {
    ...state!,
    docPathMap: tree.docPathMap,
    pathDocMap: tree.pathDocMap,
    fileRefPathMap,
    pathFileRefMap,
    folderMap: tree.folderMap,
    pathFolderMap: tree.pathFolderMap,
    rootFolderId: tree.rootFolderId,
    rootDocId: projectData.project.rootDoc_id,
    projectName: projectData.project.name,
    lastPull: new Date().toISOString(),
    fileHashes
  }
  await saveState(dir, newState)

  if (jsonMode) {
    jsonOut({ ok: true, updated })
  } else {
    out(`Pull complete: ${updated} file(s) updated`)
  }
}

async function cmdStatus(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const dir = resolve(positional[0] || '.')
  const state = await loadState(dir)
  if (!state) exitWith(EXIT_ERROR, `Not a lattex clone: ${dir}`)

  const knownPaths = new Set([
    ...Object.values(state!.docPathMap),
    ...Object.values(state!.fileRefPathMap)
  ])

  const changes = await computeDiff(dir, state!.fileHashes, knownPaths)

  if (jsonMode) {
    jsonOut({
      projectId: state!.projectId,
      projectName: state!.projectName,
      lastPull: state!.lastPull,
      changes: changes.map(c => ({ path: c.path, type: c.type }))
    })
  } else {
    out(`Project: ${state!.projectName} (${state!.projectId})`)
    out(`Last pull: ${state!.lastPull}`)
    if (changes.length === 0) {
      out('No local changes.')
    } else {
      out(`${changes.length} change(s):`)
      for (const c of changes) {
        const prefix = c.type === 'added' ? 'A' : c.type === 'modified' ? 'M' : 'D'
        out(`  ${prefix} ${c.path}`)
      }
    }
  }
}

async function cmdPush(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const dir = resolve(positional[0] || '.')
  const state = await loadState(dir)
  if (!state) exitWith(EXIT_ERROR, `Not a lattex clone: ${dir}`)

  const dryRun = !!flags['dry-run']
  const allowDelete = !!flags['delete']
  const force = !!flags['force']

  const cookie = await resolveAuth(flags)
  const api = new OverleafApi(cookie)

  // Check for remote changes (unless --force)
  if (!force) {
    err('Checking for remote changes...')
    const projectData = await api.getProjectData(state!.projectId)
    const remoteTree = walkRootFolder(projectData.project.rootFolder)

    // Quick check: compare doc/file counts and paths
    const remotePaths = new Set([
      ...Object.values(remoteTree.docPathMap),
      ...remoteTree.fileRefs.map(r => r.path)
    ])
    const localKnownPaths = new Set([
      ...Object.values(state!.docPathMap),
      ...Object.values(state!.fileRefPathMap)
    ])

    // If remote has files we don't know about, it has changed
    for (const rp of remotePaths) {
      if (!localKnownPaths.has(rp) && !state!.fileHashes[rp]) {
        exitWith(EXIT_CONFLICT, `Remote has changed (new file: ${rp}). Pull first, or use --force.`)
      }
    }
  }

  // Compute local changes
  const knownPaths = new Set([
    ...Object.values(state!.docPathMap),
    ...Object.values(state!.fileRefPathMap)
  ])
  const changes = await computeDiff(dir, state!.fileHashes, knownPaths)

  if (changes.length === 0) {
    if (jsonMode) jsonOut({ ok: true, pushed: 0 })
    else out('Nothing to push.')
    return
  }

  // Filter out deletes unless --delete
  const toProcess = changes.filter(c => {
    if (c.type === 'deleted' && !allowDelete) {
      err(`  skip delete: ${c.path} (use --delete to remove remote files)`)
      return false
    }
    return true
  })

  if (dryRun) {
    if (jsonMode) {
      jsonOut({ dryRun: true, changes: toProcess.map(c => ({ path: c.path, type: c.type })) })
    } else {
      out(`Dry run — ${toProcess.length} change(s) would be pushed:`)
      for (const c of toProcess) {
        const prefix = c.type === 'added' ? 'A' : c.type === 'modified' ? 'M' : 'D'
        out(`  ${prefix} ${c.path}`)
      }
    }
    return
  }

  // Ensure CSRF token
  await api.refreshCsrf()

  let pushed = 0
  for (const change of toProcess) {
    const relPath = change.path
    const absPath = join(dir, relPath)

    if (change.type === 'deleted') {
      // Delete from remote
      const docId = state!.pathDocMap[relPath]
      if (docId) {
        err(`  delete doc: ${relPath}`)
        await api.deleteEntity(state!.projectId, 'doc', docId)
        delete state!.docPathMap[docId]
        delete state!.pathDocMap[relPath]
      }
      const fileRefId = state!.pathFileRefMap[relPath]
      if (fileRefId) {
        err(`  delete file: ${relPath}`)
        await api.deleteEntity(state!.projectId, 'file', fileRefId)
        delete state!.fileRefPathMap[fileRefId]
        delete state!.pathFileRefMap[relPath]
      }
      delete state!.fileHashes[relPath]
      pushed++
      continue
    }

    if (change.type === 'added') {
      // Ensure parent folder exists
      const parentDir = dirname(relPath)
      const folderId = await ensureFolder(api, state!, parentDir === '.' ? '' : parentDir)

      if (change.isText) {
        err(`  create doc: ${relPath}`)
        const content = await readFile(absPath, 'utf-8')
        const docId = await api.createDoc(state!.projectId, folderId, basename(relPath))

        // Set content via WebSocket OT
        const doc = await api.getDocContent(state!.projectId, docId)
        const serverContent = doc.lines.join('\n')
        if (content !== serverContent) {
          // Upload as a replacement — use the upload API which handles both new and existing
          const fileData = Buffer.from(content, 'utf-8')
          await api.uploadFile(state!.projectId, folderId, basename(relPath), fileData, 'text/plain')
        }

        state!.docPathMap[docId] = relPath
        state!.pathDocMap[relPath] = docId
        state!.fileHashes[relPath] = createHash('sha256').update(content).digest('hex')
      } else {
        err(`  upload file: ${relPath}`)
        const data = await readFile(absPath)
        const ext = basename(relPath).split('.').pop()?.toLowerCase() || ''
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
          svg: 'image/svg+xml', pdf: 'application/pdf', eps: 'application/postscript',
          zip: 'application/zip'
        }
        const result = await api.uploadFile(state!.projectId, folderId, basename(relPath), data, mimeMap[ext] || 'application/octet-stream')
        if (result.error) {
          err(`  ERROR: ${result.error}`)
          continue
        }
        if (result.entityId) {
          state!.fileRefPathMap[result.entityId] = relPath
          state!.pathFileRefMap[relPath] = result.entityId
        }
        state!.fileHashes[relPath] = createHash('sha256').update(data).digest('hex')
      }
      pushed++
      continue
    }

    if (change.type === 'modified') {
      if (change.isText) {
        // For text docs, upload via the upload API (replaces content)
        const docId = state!.pathDocMap[relPath]
        const parentDir = dirname(relPath)
        const folderId = state!.pathFolderMap[parentDir === '.' ? '' : parentDir] || state!.rootFolderId

        err(`  update doc: ${relPath}`)
        const content = await readFile(absPath, 'utf-8')
        const fileData = Buffer.from(content, 'utf-8')
        await api.uploadFile(state!.projectId, folderId, basename(relPath), fileData, 'text/plain')
        state!.fileHashes[relPath] = createHash('sha256').update(content).digest('hex')
      } else {
        // Binary file — upload replaces
        const parentDir = dirname(relPath)
        const folderId = state!.pathFolderMap[parentDir === '.' ? '' : parentDir] || state!.rootFolderId

        err(`  update file: ${relPath}`)
        const data = await readFile(absPath)
        const ext = basename(relPath).split('.').pop()?.toLowerCase() || ''
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          pdf: 'application/pdf', eps: 'application/postscript'
        }
        await api.uploadFile(state!.projectId, folderId, basename(relPath), data, mimeMap[ext] || 'application/octet-stream')
        state!.fileHashes[relPath] = createHash('sha256').update(data).digest('hex')
      }
      pushed++
    }
  }

  await saveState(dir, state!)

  if (jsonMode) {
    jsonOut({ ok: true, pushed })
  } else {
    out(`Pushed ${pushed} change(s)`)
  }
}

async function ensureFolder(api: OverleafApi, state: CloneState, dirPath: string): Promise<string> {
  if (!dirPath || dirPath === '.') return state.rootFolderId

  const existing = state.pathFolderMap[dirPath]
  if (existing) return existing

  // Create parent first
  const parts = dirPath.split('/')
  const parentDir = parts.slice(0, -1).join('/')
  const parentId = await ensureFolder(api, state, parentDir || '')

  const name = parts[parts.length - 1]
  const folderId = await api.createFolder(state.projectId, parentId, name)
  state.folderMap[folderId] = dirPath
  state.pathFolderMap[dirPath] = folderId
  return folderId
}

async function cmdCompile(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const dir = resolve(positional[0] || '.')
  const state = await loadState(dir)
  if (!state) exitWith(EXIT_ERROR, `Not a lattex clone: ${dir}`)

  const cookie = await resolveAuth(flags)
  const api = new OverleafApi(cookie)
  const outFile = typeof flags.out === 'string' ? flags.out : undefined

  err('Compiling...')

  // Compile on Overleaf server
  const compileResult = await api.compile(state!.projectId, state!.rootDocId)

  // Fetch log
  let logText = ''
  const logFile = compileResult.outputFiles.find(f => f.path === 'output.log')
  if (logFile) {
    const logUrl = buildOutputUrl(logFile, compileResult)
    logText = await api.fetchText(logUrl)
  }

  // Download PDF
  const pdfFile = compileResult.outputFiles.find(f => f.path === 'output.pdf')
  if (pdfFile && compileResult.status === 'success') {
    const pdfUrl = buildOutputUrl(pdfFile, compileResult)
    const pdfData = await api.downloadOutputFile(pdfFile, compileResult)
    const pdfPath = outFile || join(dir, 'output.pdf')
    await writeFile(pdfPath, pdfData)
    err(`  PDF saved: ${pdfPath}`)
  }

  // Parse log
  const entries = parseCompileLog(logText)
  const errors = entries.filter(e => e.level === 'error')
  const warnings = entries.filter(e => e.level === 'warning')

  if (jsonMode) {
    jsonOut({
      status: compileResult.status,
      errors: errors.map(e => ({ message: e.message, file: e.file, line: e.line })),
      warnings: warnings.length,
      pdfPath: pdfFile ? (outFile || join(dir, 'output.pdf')) : null
    })
  } else {
    if (compileResult.status === 'success') {
      out(`Compile OK${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)
    } else {
      out(`Compile FAILED (${compileResult.status})`)
    }
    if (errors.length > 0) {
      for (const e of errors.slice(0, 10)) {
        out(`  ${formatEntry(e)}`)
      }
      if (errors.length > 10) out(`  ... and ${errors.length - 10} more`)
    }
    if (warnings.length > 0 && warnings.length <= 5) {
      for (const w of warnings) {
        out(`  ${formatEntry(w)}`)
      }
    }
  }

  process.exit(compileResult.status === 'success' ? EXIT_OK : EXIT_ERROR)
}

function buildOutputUrl(
  file: { url: string; build?: string },
  data: { pdfDownloadDomain?: string; compileGroup?: string; clsiServerId?: string }
): string {
  const params = new URLSearchParams()
  if (data.compileGroup) params.set('compileGroup', data.compileGroup)
  if (data.clsiServerId) params.set('clsiserverid', data.clsiServerId)
  const base = (file.build && data.pdfDownloadDomain)
    ? `${data.pdfDownloadDomain}${file.url}`
    : `https://www.overleaf.com${file.url}`
  return `${params.toString() ? `${base}?${params}` : base}`
}

// ── Main ──

const HELP = `lattex-cli — headless Overleaf client for AI agents

Commands:
  auth                  Store Overleaf session cookie
    --cookie "..."      Cookie string
    --from-cdp URL      Read from Chromium DevTools Protocol
    env LATTEX_COOKIE   Alternative to --cookie

  projects [--json]     List Overleaf projects

  clone <id|name> <dir> Download project to local directory
  pull <dir>            Update local dir from Overleaf
  status <dir>          Show local changes

  push <dir>            Upload local changes to Overleaf
    --dry-run           Show what would be pushed
    --delete            Allow deleting remote files
    --force             Push even if remote changed

  compile <dir>         Trigger Overleaf compile, download PDF
    --out file.pdf      Save PDF to specific path

Global:
  --json                JSON output on all commands
  --help                Show this help`

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv)
  jsonMode = !!parsed.flags.json

  if (parsed.flags.help || parsed.command === 'help' || !parsed.command) {
    out(HELP)
    process.exit(parsed.command ? EXIT_OK : EXIT_USAGE)
  }

  try {
    switch (parsed.command) {
      case 'auth':
        await cmdAuth(parsed.flags)
        break
      case 'projects':
        await cmdProjects(parsed.flags)
        break
      case 'clone':
        await cmdClone(parsed.positional, parsed.flags)
        break
      case 'pull':
        await cmdPull(parsed.positional, parsed.flags)
        break
      case 'status':
        await cmdStatus(parsed.positional, parsed.flags)
        break
      case 'push':
        await cmdPush(parsed.positional, parsed.flags)
        break
      case 'compile':
        await cmdCompile(parsed.positional, parsed.flags)
        break
      default:
        exitWith(EXIT_USAGE, `Unknown command: ${parsed.command}. Run lattex-cli --help`)
    }
  } catch (e: any) {
    exitWith(EXIT_ERROR, e.message || String(e))
  }
}

main()
