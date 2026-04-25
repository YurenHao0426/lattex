// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// Bidirectional file sync bridge: temp dir ↔ Overleaf via OT (text) + REST (binary)
import { join, dirname } from 'path'
import { readFile, writeFile, mkdir, unlink, rename as fsRename, appendFile, readdir, rm } from 'fs/promises'
import { createHash } from 'crypto'
import * as chokidar from 'chokidar'
import { diff_match_patch } from 'diff-match-patch'
import { net } from 'electron'
import type { BrowserWindow } from 'electron'
import type { OverleafSocket } from './overleafSocket'
import { OtClient } from './otClient'
import type { OtOp } from './otTypes'
import { isInsert, isDelete } from './otTypes'

const dmp = new diff_match_patch()
const LOG_FILE = '/tmp/lattex-bridge.log'
function bridgeLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  appendFile(LOG_FILE, line + '\n').catch(() => {})
}

const TEXT_EXTENSIONS = new Set([
  'tex', 'bib', 'bst', 'cls', 'sty', 'dtx', 'ins', 'fd', 'def', 'cfg',
  'lbx', 'cbx', 'bbx', 'clo', 'lco', 'tikz', 'txt', 'md', 'py', 'r',
  'm', 'lua', 'sh', 'yml', 'yaml', 'json', 'xml', 'csv', 'tsv', 'html',
  'css', 'js', 'ts', 'c', 'cpp', 'h', 'hpp', 'java', 'rb', 'pl', 'mk', 'bbl'
])

function isTextExtension(relPath: string): boolean {
  const name = relPath.split('/').pop()?.toLowerCase() || ''
  if (name === 'makefile' || name === 'latexmkrc') return true
  const ext = name.split('.').pop() || ''
  return TEXT_EXTENSIONS.has(ext)
}

export class FileSyncBridge {
  private lastKnownContent = new Map<string, string>()   // relPath → content (text docs)
  private binaryHashes = new Map<string, string>()        // relPath → sha1 hash (binary files)
  private writesInProgress = new Set<string>()            // relPaths being written by bridge
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private otClients = new Map<string, OtClient>()         // docId → OtClient (non-editor docs)
  private editorDocs = new Set<string>()                  // docIds owned by renderer
  private pendingCreates = new Set<string>()              // relPaths being created on Overleaf
  private createdFolders = new Map<string, string>()      // dirPath → folderId cache
  private watcher: chokidar.FSWatcher | null = null

  private socket: OverleafSocket
  private tmpDir: string
  private docPathMap: Record<string, string>    // docId → relPath
  private pathDocMap: Record<string, string>    // relPath → docId
  private fileRefPathMap: Record<string, string> // fileRefId → relPath
  private pathFileRefMap: Record<string, string> // relPath → fileRefId
  private folderPathMap: Record<string, string>  // folderId → relDirPath (no trailing slash)
  private pathFolderMap: Record<string, string>  // relDirPath (no trailing slash) → folderId
  private mainWindow: BrowserWindow
  private projectId: string
  private cookie: string
  private csrfToken: string

  private serverEventHandler: ((name: string, args: unknown[]) => void) | null = null
  private docRejoinedHandler: ((docId: string, result: { docLines: string[]; version: number }) => void) | null = null
  private stopped = false

  constructor(
    socket: OverleafSocket,
    tmpDir: string,
    docPathMap: Record<string, string>,
    pathDocMap: Record<string, string>,
    fileRefs: Array<{ id: string; path: string }>,
    mainWindow: BrowserWindow,
    projectId: string,
    cookie: string,
    csrfToken: string
  ) {
    this.socket = socket
    this.tmpDir = tmpDir
    this.docPathMap = docPathMap
    this.pathDocMap = pathDocMap
    this.mainWindow = mainWindow
    this.projectId = projectId
    this.cookie = cookie
    this.csrfToken = csrfToken

    // Build fileRef maps
    this.fileRefPathMap = {}
    this.pathFileRefMap = {}
    for (const ref of fileRefs) {
      this.fileRefPathMap[ref.id] = ref.path
      this.pathFileRefMap[ref.path] = ref.id
    }

    this.folderPathMap = {}
    this.pathFolderMap = {}
    this.rebuildFolderMaps()
  }

  async start(): Promise<void> {
    // Join ALL docs, fetch content, write to disk
    await mkdir(this.tmpDir, { recursive: true })

    const docIds = Object.keys(this.docPathMap)
    for (const docId of docIds) {
      const relPath = this.docPathMap[docId]
      await this.joinAndSyncDoc(docId, relPath, 3)
    }

    // Download all binary files
    const fileRefIds = Object.keys(this.fileRefPathMap)
    for (const fileRefId of fileRefIds) {
      const relPath = this.fileRefPathMap[fileRefId]
      try {
        await this.downloadBinary(fileRefId, relPath)
      } catch (e) {
        bridgeLog(`[FileSyncBridge] failed to download ${relPath}:`, e)
      }
    }

    // Listen for server events
    this.serverEventHandler = (name: string, args: unknown[]) => {
      if (name === 'otUpdateApplied') {
        this.handleOtUpdate(args)
      } else if (name === 'otUpdateError') {
        this.handleOtError(args)
      } else if (name === 'reciveNewFile') {
        this.handleNewFile(args)
      } else if (name === 'reciveNewDoc') {
        this.handleNewDoc(args)
      } else if (name === 'reciveNewFolder') {
        this.handleNewFolder(args)
      } else if (name === 'removeEntity') {
        this.handleRemoveEntity(args)
      } else if (name === 'reciveEntityRename') {
        this.handleEntityRename(args)
      } else if (name === 'reciveEntityMove') {
        this.handleEntityMove(args)
      }
    }
    this.socket.on('serverEvent', this.serverEventHandler)

    // Listen for doc rejoin events (after reconnect) — reset bridge OtClient for non-editor docs
    this.docRejoinedHandler = (docId: string, result: { docLines: string[]; version: number }) => {
      if (this.editorDocs.has(docId)) return // renderer handles editor docs
      const relPath = this.docPathMap[docId]
      if (!relPath) return

      const content = (result.docLines || []).join('\n')
      bridgeLog(`[FileSyncBridge] docRejoined: resetting ${relPath} to v${result.version}`)
      this.lastKnownContent.set(relPath, content)

      const otClient = new OtClient(
        result.version,
        (ops, version) => this.sendOps(docId, ops, version),
        (ops) => this.onRemoteApply(docId, ops)
      )
      this.otClients.set(docId, otClient)

      this.writeToDisk(relPath, content)
    }
    this.socket.on('docRejoined', this.docRejoinedHandler)

    // Start watching the temp dir
    // usePolling: FSEvents is unreliable in macOS temp dirs (/var/folders/...)
    // atomic: Claude Code and other editors use atomic writes (write temp + rename)
    //         which macOS FSEvents doesn't detect as 'change' by default
    this.watcher = chokidar.watch(this.tmpDir, {
      ignoreInitial: true,
      usePolling: true,
      interval: 500,
      atomic: true,
      ignored: [
        /(^|[/\\])\../, // dotfiles
        /\.(aux|log|fls|fdb_latexmk|synctex\.gz|bbl|blg|out|toc|lof|lot|nav|snm|vrb|pdf|pdfxref|stderr|stdout|chktex)$/, // LaTeX output files
        /(?:^|[/\\])(?:CLAUDE\.md|\.mcp\.json)$/, // App-generated config files
        /(?:^|[/\\])claude-workspace(?:[/\\]|$)/ // Claude Code scratch space (not synced)
      ]
    })

    this.watcher.on('ready', () => {
      bridgeLog(`[FileSyncBridge] chokidar ready, watching ${this.tmpDir}`)
      // Scan for files that exist on disk but not on Overleaf (e.g. from previous failed sync)
      this.scanForOrphanedFiles()
    })

    this.watcher.on('change', (absPath: string) => {
      const relPath = absPath.replace(this.tmpDir + '/', '')
      bridgeLog(`[FileSyncBridge] chokidar change: ${relPath}`)
      this.onFileChanged(relPath)
    })

    this.watcher.on('add', (absPath: string) => {
      const relPath = absPath.replace(this.tmpDir + '/', '')
      bridgeLog(`[FileSyncBridge] chokidar add: ${relPath}`)
      if (this.pathDocMap[relPath] || this.pathFileRefMap[relPath]) {
        // Known file — process as change
        this.onFileChanged(relPath)
      } else if (!this.pendingCreates.has(relPath)) {
        // New local file — create on Overleaf
        this.onNewLocalFile(relPath)
      }
    })

    this.watcher.on('unlink', (absPath: string) => {
      const relPath = absPath.replace(this.tmpDir + '/', '')
      bridgeLog(`[FileSyncBridge] chokidar unlink: ${relPath}`)
    })

    bridgeLog(`[FileSyncBridge] started, watching ${this.tmpDir}, ${docIds.length} docs + ${fileRefIds.length} files synced`)
  }

  async stop(): Promise<void> {
    this.stopped = true

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()

    // Remove event handlers
    if (this.serverEventHandler) {
      this.socket.removeListener('serverEvent', this.serverEventHandler)
      this.serverEventHandler = null
    }
    if (this.docRejoinedHandler) {
      this.socket.removeListener('docRejoined', this.docRejoinedHandler)
      this.docRejoinedHandler = null
    }

    // Close watcher
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }

    this.otClients.clear()
    this.lastKnownContent.clear()
    this.binaryHashes.clear()
    this.writesInProgress.clear()
    this.editorDocs.clear()
    this.pendingCreates.clear()
    this.createdFolders.clear()

    console.log('[FileSyncBridge] stopped')
  }

  /** Join a doc with retry logic for transient errors like joinLeaveEpoch mismatch */
  private async joinAndSyncDoc(docId: string, relPath: string, retries: number): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 300 * attempt))
        }
        const result = await this.socket.joinDoc(docId)
        const content = (result.docLines || []).join('\n')
        this.lastKnownContent.set(relPath, content)

        const otClient = new OtClient(
          result.version,
          (ops, version) => this.sendOps(docId, ops, version),
          (ops) => this.onRemoteApply(docId, ops)
        )
        this.otClients.set(docId, otClient)

        await this.writeToDisk(relPath, content)
        return
      } catch (e) {
        const msg = String(e)
        if (msg.includes('joinLeaveEpoch') && attempt < retries) {
          bridgeLog(`[FileSyncBridge] joinDoc retry ${attempt + 1}/${retries} for ${relPath}: ${msg}`)
          continue
        }
        bridgeLog(`[FileSyncBridge] failed to join doc ${relPath}:`, e)
      }
    }
  }

  // ── OT update handler ─────────────────────────────────────
  //
  // Modeled after Overleaf's ShareJS _onMessage (vendor/libs/sharejs.js):
  //
  //   ACK = msg.op === undefined          (explicit ack, no ops)
  //       | msg.meta.source === ourId     (echo of our own ops)
  //
  //   REMOTE = msg.op && msg.meta.source !== ourId
  //
  // The ACK path does NOT re-apply ops (they were applied optimistically).
  // The REMOTE path transforms against inflight/buffered ops before applying.
  // Stale messages (version < ours) are silently dropped by OtClient.

  private handleOtUpdate(args: unknown[]): void {
    const update = args[0] as { doc?: string; op?: OtOp[]; v?: number; meta?: { source?: string } } | undefined
    if (!update?.doc) return
    const docId = update.doc
    const relPath = this.docPathMap[docId] || docId

    // Skip editor docs — renderer handles their OT
    if (this.editorDocs.has(docId)) return

    const otClient = this.otClients.get(docId)
    if (!otClient) return

    const isOwnSource = this.isOwnSource(update.meta?.source)

    bridgeLog(`[FileSyncBridge] handleOtUpdate: ${relPath} v=${update.v} hasOp=${!!update.op} own=${isOwnSource} state=${otClient.stateName} ver=${otClient.version}`)

    if (!update.op || isOwnSource) {
      // ACK — either:
      //   1. No ops (explicit ack from server to sender)
      //   2. Echoed ops from our own source (server broadcast to all clients)
      // In both cases: acknowledge the inflight op. Do NOT re-apply ops.
      // OtClient.onAck() silently drops duplicate acks (synchronized state).
      bridgeLog(`[FileSyncBridge] handleOtUpdate: ACK for ${relPath} (${!update.op ? 'no-op' : 'own-echo'}), state=${otClient.stateName}`)
      otClient.onAck()
      bridgeLog(`[FileSyncBridge] handleOtUpdate: ACK done → state=${otClient.stateName} ver=${otClient.version}`)
    } else if (update.op && update.v !== undefined) {
      // REMOTE — genuine ops from another client
      bridgeLog(`[FileSyncBridge] handleOtUpdate: REMOTE ops for ${relPath} from ${update.meta?.source || 'unknown'}, state=${otClient.stateName}`)
      otClient.onRemoteOps(update.op, update.v)
    }
  }

  /** Check if an otUpdateApplied event originated from our own socket */
  private isOwnSource(metaSource?: string): boolean {
    // Primary: match meta.source against our publicId (same as Overleaf's inflightSubmittedIds check)
    if (metaSource && this.socket.publicId) {
      return metaSource === this.socket.publicId
    }
    // If meta.source is absent, we can't determine origin.
    // The open-source server sends ack without meta to the sender (no ops, no meta.source).
    // If we get ops WITHOUT meta.source, treat conservatively as remote.
    return false
  }

  // ── OT error handler ────────────────────────────────────────

  /** Server rejected our OT update — recover by re-joining the doc */
  private handleOtError(args: unknown[]): void {
    const error = args[0] as { doc?: string; message?: string } | undefined
    if (!error?.doc) return
    const docId = error.doc

    // Don't skip editor docs entirely — the bridge may have sent ops just before
    // addEditorDoc was called, and the error response arrives after. If we skip,
    // the bridge's OtClient stays stuck and the ops are silently lost.
    // Only skip if the bridge has no OtClient for this doc.
    if (this.editorDocs.has(docId) && !this.otClients.has(docId)) return

    const relPath = this.docPathMap[docId]
    if (!relPath) return

    bridgeLog(`[FileSyncBridge] OT_ERROR for ${relPath}: ${error.message || JSON.stringify(error)}`)

    // Re-join the doc to get fresh version and content, then re-apply disk content if different
    this.socket.joinDoc(docId).then(async (result) => {
      const serverContent = (result.docLines || []).join('\n')

      // Reset OtClient with fresh version
      const otClient = new OtClient(
        result.version,
        (ops, version) => this.sendOps(docId, ops, version),
        (ops) => this.onRemoteApply(docId, ops)
      )
      this.otClients.set(docId, otClient)

      // Check if disk has changes that need to be re-sent
      let diskContent: string | undefined
      try {
        diskContent = await readFile(join(this.tmpDir, relPath), 'utf-8')
      } catch { /* file may not exist */ }

      if (diskContent && diskContent !== serverContent) {
        // Re-apply disk changes with fresh OT state
        bridgeLog(`[FileSyncBridge] re-applying disk changes for ${relPath} after OT error`)
        this.lastKnownContent.set(relPath, serverContent)
        const diffs = dmp.diff_main(serverContent, diskContent)
        dmp.diff_cleanupEfficiency(diffs)
        const ops = diffsToOtOps(diffs)
        if (ops.length > 0) {
          this.lastKnownContent.set(relPath, diskContent)
          otClient.onLocalOps(ops)
        }
      } else {
        this.lastKnownContent.set(relPath, serverContent)
        this.writeToDisk(relPath, serverContent)
      }
    }).catch((e) => {
      bridgeLog(`[FileSyncBridge] failed to recover from OT error for ${relPath}:`, e)
    })
  }

  // ── Binary file event handlers (socket) ────────────────────

  /** Remote: new file added to project */
  private handleNewFile(args: unknown[]): void {
    // args: [folderId, fileRef, source, linkedFileData, userId]
    const folderId = args[0] as string
    const fileRef = args[1] as { _id: string; name: string } | undefined
    if (!fileRef?._id || !fileRef?.name) return

    // Determine relPath from folder
    const folderPath = this.findFolderPath(folderId)
    const relPath = folderPath + fileRef.name

    // Skip if we just created this file locally
    if (this.pendingCreates.has(relPath)) {
      bridgeLog(`[FileSyncBridge] skipping reciveNewFile for ${relPath} (we created it)`)
      return
    }

    bridgeLog(`[FileSyncBridge] remote new file: ${relPath} (${fileRef._id})`)

    // Register in maps
    this.fileRefPathMap[fileRef._id] = relPath
    this.pathFileRefMap[relPath] = fileRef._id
    this.notifyEntityCreated('file', fileRef._id, relPath, fileRef.name, folderId)

    // Download to disk
    this.downloadBinary(fileRef._id, relPath).catch((e) => {
      bridgeLog(`[FileSyncBridge] failed to download new file ${relPath}:`, e)
    })
  }

  /** Remote: new doc added to project */
  private handleNewDoc(args: unknown[]): void {
    // args: [folderId, doc, source, userId]
    const folderId = args[0] as string
    const doc = args[1] as { _id: string; name: string } | undefined
    if (!doc?._id || !doc?.name) return

    const folderPath = this.findFolderPath(folderId)
    const relPath = folderPath + doc.name

    // Skip if we just created this doc locally
    if (this.pendingCreates.has(relPath)) {
      bridgeLog(`[FileSyncBridge] skipping reciveNewDoc for ${relPath} (we created it)`)
      return
    }

    bridgeLog(`[FileSyncBridge] remote new doc: ${relPath} (${doc._id})`)

    // Register in maps
    this.docPathMap[doc._id] = relPath
    this.pathDocMap[relPath] = doc._id
    this.notifyEntityCreated('doc', doc._id, relPath, doc.name, folderId)

    // Join and sync the new doc
    this.socket.joinDoc(doc._id).then((result) => {
      const content = (result.docLines || []).join('\n')
      this.lastKnownContent.set(relPath, content)

      const otClient = new OtClient(
        result.version,
        (ops, version) => this.sendOps(doc._id, ops, version),
        (ops) => this.onRemoteApply(doc._id, ops)
      )
      this.otClients.set(doc._id, otClient)

      this.writeToDisk(relPath, content)
    }).catch((e) => {
      bridgeLog(`[FileSyncBridge] failed to join new doc ${relPath}:`, e)
    })
  }

  /** Remote: new folder added to project */
  private handleNewFolder(args: unknown[]): void {
    // args: [parentFolderId, folder, userId]
    const parentFolderId = args[0] as string
    const folder = args[1] as { _id: string; name: string } | undefined
    if (!folder?._id || !folder?.name) return

    const parentPath = this.folderPathMap[parentFolderId] ?? ''
    const relPath = parentPath ? `${parentPath}/${folder.name}` : folder.name

    bridgeLog(`[FileSyncBridge] remote new folder: ${relPath} (${folder._id})`)

    this.folderPathMap[folder._id] = relPath
    this.pathFolderMap[relPath] = folder._id
    this.createdFolders.set(relPath, folder._id)
    this.notifyEntityCreated('folder', folder._id, relPath, folder.name, parentFolderId)
  }

  /** Remote: entity removed */
  private handleRemoveEntity(args: unknown[]): void {
    const entityId = args[0] as string
    if (!entityId) return

    // Check if it's a doc
    const docPath = this.docPathMap[entityId]
    if (docPath) {
      bridgeLog(`[FileSyncBridge] remote remove doc: ${docPath}`)
      delete this.docPathMap[entityId]
      delete this.pathDocMap[docPath]
      this.lastKnownContent.delete(docPath)
      this.otClients.delete(entityId)
      this.notifyEntityRemoved('doc', entityId, docPath)
      this.deleteFromDisk(docPath)
      return
    }

    // Check if it's a fileRef
    const filePath = this.fileRefPathMap[entityId]
    if (filePath) {
      bridgeLog(`[FileSyncBridge] remote remove file: ${filePath}`)
      delete this.fileRefPathMap[entityId]
      delete this.pathFileRefMap[filePath]
      this.binaryHashes.delete(filePath)
      this.notifyEntityRemoved('file', entityId, filePath)
      this.deleteFromDisk(filePath)
      return
    }

    // Check if it's a folder
    const folderPath = this.folderPathMap[entityId]
    if (folderPath !== undefined) {
      bridgeLog(`[FileSyncBridge] remote remove folder: ${folderPath}`)
      this.removeFolderMappings(entityId)
      this.notifyEntityRemoved('folder', entityId, folderPath)
      this.deleteDirFromDisk(folderPath)
    }
  }

  /** Remote: entity renamed */
  private handleEntityRename(args: unknown[]): void {
    const entityId = args[0] as string
    const newName = args[1] as string
    if (!entityId || !newName) return

    // Check if it's a doc
    const oldDocPath = this.docPathMap[entityId]
    if (oldDocPath) {
      const newPath = dirname(oldDocPath) === '.' ? newName : dirname(oldDocPath) + '/' + newName
      bridgeLog(`[FileSyncBridge] remote rename doc: ${oldDocPath} → ${newPath}`)

      // Update maps
      this.docPathMap[entityId] = newPath
      delete this.pathDocMap[oldDocPath]
      this.pathDocMap[newPath] = entityId

      // Move content
      const content = this.lastKnownContent.get(oldDocPath)
      if (content !== undefined) {
        this.lastKnownContent.delete(oldDocPath)
        this.lastKnownContent.set(newPath, content)
      }

      // Rename on disk
      this.notifyEntityRenamed('doc', entityId, oldDocPath, newPath, newName)
      this.renameOnDisk(oldDocPath, newPath)
      return
    }

    // Check if it's a fileRef
    const oldFilePath = this.fileRefPathMap[entityId]
    if (oldFilePath) {
      const newPath = dirname(oldFilePath) === '.' ? newName : dirname(oldFilePath) + '/' + newName
      bridgeLog(`[FileSyncBridge] remote rename file: ${oldFilePath} → ${newPath}`)

      // Update maps
      this.fileRefPathMap[entityId] = newPath
      delete this.pathFileRefMap[oldFilePath]
      this.pathFileRefMap[newPath] = entityId

      // Move hash
      const hash = this.binaryHashes.get(oldFilePath)
      if (hash) {
        this.binaryHashes.delete(oldFilePath)
        this.binaryHashes.set(newPath, hash)
      }

      // Rename on disk
      this.notifyEntityRenamed('file', entityId, oldFilePath, newPath, newName)
      this.renameOnDisk(oldFilePath, newPath)
      return
    }

    // Check if it's a folder
    const oldFolderPath = this.folderPathMap[entityId]
    if (oldFolderPath !== undefined) {
      const parent = dirname(oldFolderPath)
      const newPath = parent === '.' ? newName : parent + '/' + newName
      bridgeLog(`[FileSyncBridge] remote rename folder: ${oldFolderPath} → ${newPath}`)

      this.rewriteFolderPath(entityId, newPath)
      this.notifyEntityRenamed('folder', entityId, oldFolderPath, newPath, newName)
      this.renameOnDisk(oldFolderPath, newPath)
    }
  }

  /** Remote: entity moved */
  private handleEntityMove(args: unknown[]): void {
    const entityId = args[0] as string
    const toFolderId = args[1] as string
    if (!entityId || !toFolderId) return

    const parentPath = this.folderPathMap[toFolderId] ?? ''
    const buildNewPath = (oldPath: string) => {
      const name = oldPath.split('/').filter(Boolean).pop() || oldPath
      return parentPath ? `${parentPath}/${name}` : name
    }

    const oldDocPath = this.docPathMap[entityId]
    if (oldDocPath) {
      const newPath = buildNewPath(oldDocPath)
      bridgeLog(`[FileSyncBridge] remote move doc: ${oldDocPath} → ${newPath}`)
      this.docPathMap[entityId] = newPath
      delete this.pathDocMap[oldDocPath]
      this.pathDocMap[newPath] = entityId
      const content = this.lastKnownContent.get(oldDocPath)
      if (content !== undefined) {
        this.lastKnownContent.delete(oldDocPath)
        this.lastKnownContent.set(newPath, content)
      }
      this.notifyEntityMoved('doc', entityId, oldDocPath, newPath, toFolderId)
      this.renameOnDisk(oldDocPath, newPath)
      return
    }

    const oldFilePath = this.fileRefPathMap[entityId]
    if (oldFilePath) {
      const newPath = buildNewPath(oldFilePath)
      bridgeLog(`[FileSyncBridge] remote move file: ${oldFilePath} → ${newPath}`)
      this.fileRefPathMap[entityId] = newPath
      delete this.pathFileRefMap[oldFilePath]
      this.pathFileRefMap[newPath] = entityId
      const hash = this.binaryHashes.get(oldFilePath)
      if (hash) {
        this.binaryHashes.delete(oldFilePath)
        this.binaryHashes.set(newPath, hash)
      }
      this.notifyEntityMoved('file', entityId, oldFilePath, newPath, toFolderId)
      this.renameOnDisk(oldFilePath, newPath)
      return
    }

    const oldFolderPath = this.folderPathMap[entityId]
    if (oldFolderPath !== undefined) {
      const newPath = buildNewPath(oldFolderPath)
      bridgeLog(`[FileSyncBridge] remote move folder: ${oldFolderPath} → ${newPath}`)
      this.rewriteFolderPath(entityId, newPath)
      this.notifyEntityMoved('folder', entityId, oldFolderPath, newPath, toFolderId)
      this.renameOnDisk(oldFolderPath, newPath)
    }
  }

  /** Find folder path prefix from folderId */
  private findFolderPath(folderId: string): string {
    if (folderId in this.folderPathMap) {
      const path = this.folderPathMap[folderId]
      return path ? `${path}/` : ''
    }

    const projectData = this.socket.projectData
    if (projectData) {
      const rootFolder = projectData.project.rootFolder?.[0]
      if (rootFolder) {
        // Root folder itself → empty prefix
        if (rootFolder._id === folderId) return ''
        // Search children (skip root folder name to match walkRootFolder behavior)
        const subFolders = rootFolder.folders as Array<{ _id: string; name: string; folders?: unknown[] }> | undefined
        if (subFolders) {
          const path = this.findFolderPathInTree(subFolders, folderId, '')
          if (path !== null) return path
        }
      }
    }
    return ''
  }

  private findFolderPathInTree(folders: Array<{ _id: string; name: string; folders?: unknown[] }>, targetId: string, prefix: string): string | null {
    for (const f of folders) {
      if (f._id === targetId) return prefix ? prefix + f.name + '/' : f.name + '/'
      const sub = f.folders as Array<{ _id: string; name: string; folders?: unknown[] }> | undefined
      if (sub) {
        const subPrefix = prefix ? prefix + f.name + '/' : f.name + '/'
        const result = this.findFolderPathInTree(sub, targetId, subPrefix)
        if (result !== null) return result
      }
    }
    return null
  }

  // ── Disk change handler ──────────────────────────────────────

  private onFileChanged(relPath: string): void {
    if (this.stopped) return

    // Skip app-generated config files and scratch space that should not be synced
    const basename = relPath.split('/').pop() || relPath
    if (basename === 'CLAUDE.md' || basename === '.mcp.json') return
    if (relPath.startsWith('claude-workspace/') || relPath === 'claude-workspace') return

    // Layer 1: Skip if bridge is currently writing this file
    if (this.writesInProgress.has(relPath)) {
      bridgeLog(`[FileSyncBridge] skipping ${relPath} (write in progress)`)
      return
    }

    bridgeLog(`[FileSyncBridge] onFileChanged: ${relPath}, isDoc=${!!this.pathDocMap[relPath]}, isFile=${!!this.pathFileRefMap[relPath]}, isEditorDoc=${this.editorDocs.has(this.pathDocMap[relPath] || '')}`)

    // Layer 3: Debounce 300ms per file
    const existing = this.debounceTimers.get(relPath)
    if (existing) clearTimeout(existing)

    this.debounceTimers.set(relPath, setTimeout(() => {
      this.debounceTimers.delete(relPath)
      this.processChange(relPath)
    }, 300))
  }

  private async processChange(relPath: string): Promise<void> {
    if (this.stopped) return

    // Text doc?
    const docId = this.pathDocMap[relPath]
    if (docId) {
      return this.processDocChange(relPath, docId)
    }

    // Binary fileRef?
    const fileRefId = this.pathFileRefMap[relPath]
    if (fileRefId) {
      return this.processBinaryChange(relPath, fileRefId)
    }
  }

  private async processDocChange(relPath: string, docId: string): Promise<void> {
    let newContent: string
    try {
      newContent = await readFile(join(this.tmpDir, relPath), 'utf-8')
    } catch (e) {
      bridgeLog(`[FileSyncBridge] read error for ${relPath}:`, e)
      return // file deleted or unreadable
    }

    const lastKnown = this.lastKnownContent.get(relPath)

    // Layer 2: Content equality check
    if (newContent === lastKnown) {
      bridgeLog(`[FileSyncBridge] content unchanged for ${relPath}, skipping`)
      return
    }

    bridgeLog(`[FileSyncBridge] disk change detected: ${relPath} (${newContent.length} chars, was ${lastKnown?.length ?? 'undefined'})`)

    if (this.editorDocs.has(docId)) {
      // Doc is open in editor → send to renderer via IPC.
      // Include baseContent so renderer can do a three-way merge: if remote edits
      // arrived during the debounce window, they'll be preserved alongside the disk edit.
      // Always update lastKnownContent to match disk — even if the renderer can't process
      // the edit (e.g. doc is an editor doc but not the active tab), we must not let
      // lastKnownContent go stale or we'll re-detect the same "change" indefinitely.
      this.lastKnownContent.set(relPath, newContent)
      bridgeLog(`[FileSyncBridge] → sending sync:externalEdit to renderer for ${relPath}`)
      this.mainWindow.webContents.send('sync:externalEdit', { docId, content: newContent, baseContent: lastKnown ?? '' })
    } else {
      // Doc NOT open in editor → bridge handles OT directly
      const oldContent = lastKnown ?? ''
      this.lastKnownContent.set(relPath, newContent)

      const diffs = dmp.diff_main(oldContent, newContent)
      dmp.diff_cleanupEfficiency(diffs)
      const ops = diffsToOtOps(diffs)

      bridgeLog(`[FileSyncBridge] → direct OT for ${relPath}: ${ops.length} ops`)

      if (ops.length > 0) {
        const otClient = this.otClients.get(docId)
        if (otClient) {
          otClient.onLocalOps(ops)
        } else {
          bridgeLog(`[FileSyncBridge] WARNING: no OtClient for docId ${docId}`)
        }
      }
    }
  }

  private async processBinaryChange(relPath: string, fileRefId: string): Promise<void> {
    const fullPath = join(this.tmpDir, relPath)

    let fileData: Buffer
    try {
      fileData = await readFile(fullPath)
    } catch {
      return // file deleted or unreadable
    }

    // Layer 2: Hash equality check
    const newHash = createHash('sha1').update(fileData).digest('hex')
    const oldHash = this.binaryHashes.get(relPath)
    if (newHash === oldHash) return

    bridgeLog(`[FileSyncBridge] binary change detected: ${relPath} (${fileData.length} bytes)`)
    this.binaryHashes.set(relPath, newHash)

    // Upload to Overleaf via REST API (this replaces the existing file)
    try {
      await this.uploadBinary(relPath, fileData)
    } catch (e) {
      bridgeLog(`[FileSyncBridge] failed to upload binary ${relPath}:`, e)
    }
  }

  // ── Binary file download/upload ────────────────────────────

  private async downloadBinary(fileRefId: string, relPath: string): Promise<void> {
    const fullPath = join(this.tmpDir, relPath)
    const dir = dirname(fullPath)
    await mkdir(dir, { recursive: true })

    return new Promise((resolve, reject) => {
      const url = `https://www.overleaf.com/project/${this.projectId}/file/${fileRefId}`
      const req = net.request(url)
      req.setHeader('Cookie', this.cookie)
      req.setHeader('User-Agent', 'Mozilla/5.0')

      const chunks: Buffer[] = []
      req.on('response', (res) => {
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', async () => {
          try {
            const data = Buffer.concat(chunks)
            // Set write guard before writing
            this.writesInProgress.add(relPath)
            await writeFile(fullPath, data)
            setTimeout(() => this.writesInProgress.delete(relPath), 1000)

            // Store hash
            this.binaryHashes.set(relPath, createHash('sha1').update(data).digest('hex'))
            resolve()
          } catch (e) {
            reject(e)
          }
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  private async uploadBinary(relPath: string, fileData: Buffer, overrideFolderId?: string): Promise<string | undefined> {
    const fileName = relPath.includes('/') ? relPath.split('/').pop()! : relPath
    const folderId = overrideFolderId || this.findFolderIdForPath(relPath)

    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      svg: 'image/svg+xml', pdf: 'application/pdf', eps: 'application/postscript',
      zip: 'application/zip', bmp: 'image/bmp', tiff: 'image/tiff',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)

    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${fileName}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mime}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="qqfile"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    return new Promise((resolve, reject) => {
      const req = net.request({
        method: 'POST',
        url: `https://www.overleaf.com/project/${this.projectId}/upload?folder_id=${folderId}`
      })
      req.setHeader('Cookie', this.cookie)
      req.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
      req.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
      req.setHeader('Accept', 'application/json')
      req.setHeader('Referer', `https://www.overleaf.com/project/${this.projectId}`)
      req.setHeader('Origin', 'https://www.overleaf.com')

      if (this.csrfToken) req.setHeader('x-csrf-token', this.csrfToken)

      let resBody = ''
      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) => { resBody += chunk.toString() })
        res.on('end', () => {
          bridgeLog(`[FileSyncBridge] upload ${relPath}: ${res.statusCode} ${resBody.slice(0, 200)}`)
          try {
            const data = JSON.parse(resBody)
            if (data.success !== false && !data.error) {
              // Upload replaces the file — update our fileRef ID if it changed
              const entityId = data.entity_id || data.entityId || data.fileRef?._id || data.file?._id
              if (entityId && entityId !== this.pathFileRefMap[relPath]) {
                const oldId = this.pathFileRefMap[relPath]
                if (oldId) delete this.fileRefPathMap[oldId]
                this.fileRefPathMap[entityId] = relPath
                this.pathFileRefMap[relPath] = entityId
              }
              resolve(entityId)
            } else {
              reject(new Error(data.error || 'Upload failed'))
            }
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${resBody.slice(0, 200)}`))
          }
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  /** Find the folder ID for a given relPath */
  private findFolderIdForPath(relPath: string): string {
    const projectData = this.socket.projectData
    const rootId = projectData?.project.rootFolder?.[0]?._id || ''
    const dir = dirname(relPath)
    const normalizedDir = dir === '.' ? '' : dir
    if (normalizedDir in this.pathFolderMap) return this.pathFolderMap[normalizedDir]
    const cached = this.createdFolders.get(normalizedDir)
    if (cached) return cached
    if (dir === '.') return rootId

    // Search inside root folder's children (skip root folder name)
    if (projectData) {
      const subFolders = projectData.project.rootFolder?.[0]?.folders as Array<{ _id: string; name: string; folders?: unknown[] }> | undefined
      if (subFolders) {
        const folderId = this.findFolderIdInTree(subFolders, dir + '/', '')
        if (folderId) return folderId
      }
    }

    return rootId
  }

  private findFolderIdInTree(folders: Array<{ _id: string; name: string; folders?: unknown[] }>, targetPath: string, prefix: string): string | null {
    for (const f of folders) {
      const currentPath = prefix ? prefix + f.name + '/' : f.name + '/'
      if (currentPath === targetPath) return f._id
      const sub = f.folders as Array<{ _id: string; name: string; folders?: unknown[] }> | undefined
      if (sub) {
        const result = this.findFolderIdInTree(sub, targetPath, currentPath)
        if (result) return result
      }
    }
    return null
  }

  private rebuildFolderMaps(): void {
    this.folderPathMap = {}
    this.pathFolderMap = {}

    const rootFolder = this.socket.projectData?.project.rootFolder?.[0]
    if (!rootFolder) return

    this.folderPathMap[rootFolder._id] = ''
    this.pathFolderMap[''] = rootFolder._id

    const walk = (folders: Array<{ _id: string; name: string; folders?: unknown[] }>, prefix: string) => {
      for (const folder of folders) {
        const relPath = prefix ? `${prefix}/${folder.name}` : folder.name
        this.folderPathMap[folder._id] = relPath
        this.pathFolderMap[relPath] = folder._id
        const children = folder.folders as Array<{ _id: string; name: string; folders?: unknown[] }> | undefined
        if (children) walk(children, relPath)
      }
    }

    const children = rootFolder.folders as Array<{ _id: string; name: string; folders?: unknown[] }> | undefined
    if (children) walk(children, '')
  }

  private removeFolderMappings(folderId: string): void {
    const folderPath = this.folderPathMap[folderId]
    if (folderPath === undefined) return
    const prefix = folderPath ? `${folderPath}/` : ''

    for (const [docId, relPath] of Object.entries(this.docPathMap)) {
      if (prefix && relPath.startsWith(prefix)) {
        delete this.docPathMap[docId]
        delete this.pathDocMap[relPath]
        this.lastKnownContent.delete(relPath)
        this.otClients.delete(docId)
      }
    }

    for (const [fileRefId, relPath] of Object.entries(this.fileRefPathMap)) {
      if (prefix && relPath.startsWith(prefix)) {
        delete this.fileRefPathMap[fileRefId]
        delete this.pathFileRefMap[relPath]
        this.binaryHashes.delete(relPath)
      }
    }

    for (const [id, relPath] of Object.entries(this.folderPathMap)) {
      if (id === folderId || (prefix && relPath.startsWith(prefix))) {
        delete this.folderPathMap[id]
        delete this.pathFolderMap[relPath]
        this.createdFolders.delete(relPath)
      }
    }
  }

  private rewriteFolderPath(folderId: string, newFolderPath: string): void {
    const oldFolderPath = this.folderPathMap[folderId]
    if (oldFolderPath === undefined) return

    const oldPrefix = oldFolderPath ? `${oldFolderPath}/` : ''
    const newPrefix = newFolderPath ? `${newFolderPath}/` : ''

    for (const [docId, relPath] of Object.entries(this.docPathMap)) {
      if (oldPrefix && relPath.startsWith(oldPrefix)) {
        const newPath = newPrefix + relPath.slice(oldPrefix.length)
        this.docPathMap[docId] = newPath
        delete this.pathDocMap[relPath]
        this.pathDocMap[newPath] = docId
        const content = this.lastKnownContent.get(relPath)
        if (content !== undefined) {
          this.lastKnownContent.delete(relPath)
          this.lastKnownContent.set(newPath, content)
        }
      }
    }

    for (const [fileRefId, relPath] of Object.entries(this.fileRefPathMap)) {
      if (oldPrefix && relPath.startsWith(oldPrefix)) {
        const newPath = newPrefix + relPath.slice(oldPrefix.length)
        this.fileRefPathMap[fileRefId] = newPath
        delete this.pathFileRefMap[relPath]
        this.pathFileRefMap[newPath] = fileRefId
        const hash = this.binaryHashes.get(relPath)
        if (hash) {
          this.binaryHashes.delete(relPath)
          this.binaryHashes.set(newPath, hash)
        }
      }
    }

    for (const [id, relPath] of Object.entries(this.folderPathMap)) {
      if (id === folderId || (oldPrefix && relPath.startsWith(oldPrefix))) {
        const nextPath = id === folderId
          ? newFolderPath
          : newPrefix + relPath.slice(oldPrefix.length)
        delete this.pathFolderMap[relPath]
        this.folderPathMap[id] = nextPath
        this.pathFolderMap[nextPath] = id
        this.createdFolders.delete(relPath)
        this.createdFolders.set(nextPath, id)
      }
    }
  }

  private notifyEntityCreated(
    kind: 'doc' | 'file' | 'folder',
    entityId: string,
    relPath: string,
    name: string,
    parentFolderId?: string
  ): void {
    this.mainWindow.webContents.send('sync:entityCreated', {
      kind,
      entityId,
      relPath,
      name,
      parentFolderId
    })
  }

  private notifyEntityRemoved(kind: 'doc' | 'file' | 'folder', entityId: string, relPath: string): void {
    this.mainWindow.webContents.send('sync:entityRemoved', { kind, entityId, relPath })
  }

  private notifyEntityRenamed(
    kind: 'doc' | 'file' | 'folder',
    entityId: string,
    oldPath: string,
    newPath: string,
    newName: string
  ): void {
    this.mainWindow.webContents.send('sync:entityRenamed', {
      kind,
      entityId,
      oldPath,
      newPath,
      newName
    })
  }

  private notifyEntityMoved(
    kind: 'doc' | 'file' | 'folder',
    entityId: string,
    oldPath: string,
    newPath: string,
    parentFolderId: string
  ): void {
    this.mainWindow.webContents.send('sync:entityMoved', {
      kind,
      entityId,
      oldPath,
      newPath,
      parentFolderId
    })
  }

  // ── Send OT ops to Overleaf (for non-editor docs) ───────────

  private sendOps(docId: string, ops: OtOp[], version: number): void {
    const relPath = this.docPathMap[docId]
    const content = relPath ? this.lastKnownContent.get(relPath) ?? '' : ''
    const hash = createHash('sha1').update(content).digest('hex')
    bridgeLog(`[FileSyncBridge] sendOps: ${relPath} v${version} ${ops.length} ops, hash=${hash.slice(0, 8)}`)
    this.socket.applyOtUpdate(docId, ops, version, hash).then(() => {
      bridgeLog(`[FileSyncBridge] sendOps: server accepted ${relPath}`)
      // Do NOT call onAck() here.
      // ACK comes via otUpdateApplied events processed in handleOtUpdate:
      //   - Echo (with ops, meta.source === ours) → treated as ACK
      //   - Explicit ack (without ops) → treated as ACK
      // OtClient.onAck() silently deduplicates if both arrive.
    }).catch((e) => {
      bridgeLog(`[FileSyncBridge] sendOps: REJECTED for ${relPath}: ${e?.message || e}`)
      this.handleOtError([{ doc: docId, message: e?.message || 'applyOtUpdate rejected' }])
    })
  }

  // ── Apply remote ops (for non-editor docs) ──────────────────

  private onRemoteApply(docId: string, ops: OtOp[]): void {
    const relPath = this.docPathMap[docId]
    if (!relPath) return

    const currentContent = this.lastKnownContent.get(relPath) ?? ''
    const newContent = applyOpsToText(currentContent, ops)
    this.lastKnownContent.set(relPath, newContent)
    this.writeToDisk(relPath, newContent)
  }

  // ── Called by main process when editor/remote changes content ─

  /** Called when renderer notifies bridge that editor content changed */
  onEditorContentChanged(docId: string, content: string): void {
    const relPath = this.docPathMap[docId]
    if (!relPath) return

    // If there's a pending debounce for this file, an external tool (e.g. Claude Code)
    // just wrote to disk and the change hasn't been processed yet. Don't overwrite the
    // disk file or update lastKnownContent — let processDocChange handle it.
    if (this.debounceTimers.has(relPath)) {
      bridgeLog(`[FileSyncBridge] onEditorContentChanged: skipping ${relPath} (pending disk change)`)
      return
    }

    // Update last known content
    this.lastKnownContent.set(relPath, content)

    // Write to disk so external tools can see the change
    this.writeToDisk(relPath, content)
  }

  // ── Editor doc tracking ──────────────────────────────────────

  /** Renderer opened this doc in the editor — bridge stops owning OT */
  addEditorDoc(docId: string): void {
    this.editorDocs.add(docId)
  }

  /** Renderer closed this doc from the editor — bridge takes over OT */
  removeEditorDoc(docId: string): void {
    this.editorDocs.delete(docId)

    const relPath = this.docPathMap[docId]
    if (!relPath) return

    this.socket.joinDoc(docId).then(async (result) => {
      const serverContent = (result.docLines || []).join('\n')

      const otClient = new OtClient(
        result.version,
        (ops, version) => this.sendOps(docId, ops, version),
        (ops) => this.onRemoteApply(docId, ops)
      )
      this.otClients.set(docId, otClient)

      // Read disk content — it may be newer than server if the renderer just
      // flushed OT ops that haven't been acknowledged yet (race condition).
      let diskContent: string | undefined
      try {
        diskContent = await readFile(join(this.tmpDir, relPath), 'utf-8')
      } catch { /* file may not exist */ }

      if (diskContent !== undefined && diskContent !== serverContent) {
        // Disk has changes server doesn't know about — re-send as OT ops
        bridgeLog(`[FileSyncBridge] removeEditorDoc: disk differs from server for ${relPath}, re-sending`)
        this.lastKnownContent.set(relPath, diskContent)
        const diffs = dmp.diff_main(serverContent, diskContent)
        dmp.diff_cleanupEfficiency(diffs)
        const ops = diffsToOtOps(diffs)
        if (ops.length > 0) {
          otClient.onLocalOps(ops)
        }
      } else {
        this.lastKnownContent.set(relPath, serverContent)
        if (diskContent !== serverContent) {
          this.writeToDisk(relPath, serverContent)
        }
      }
    }).catch((e) => {
      bridgeLog(`[FileSyncBridge] failed to re-join doc ${relPath}:`, e)
    })
  }

  // ── Helpers ──────────────────────────────────────────────────

  private async writeToDisk(relPath: string, content: string): Promise<void> {
    const fullPath = join(this.tmpDir, relPath)
    const dir = dirname(fullPath)

    this.writesInProgress.add(relPath)

    try {
      await mkdir(dir, { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
    } catch (e) {
      bridgeLog(`[FileSyncBridge] write error for ${relPath}:`, e)
    }

    setTimeout(() => {
      this.writesInProgress.delete(relPath)
    }, 800)  // Must exceed chokidar polling interval (500ms)
  }

  private async deleteFromDisk(relPath: string): Promise<void> {
    const fullPath = join(this.tmpDir, relPath)
    this.writesInProgress.add(relPath)
    try {
      await unlink(fullPath)
    } catch { /* file may not exist */ }
    setTimeout(() => {
      this.writesInProgress.delete(relPath)
    }, 150)
  }

  private async deleteDirFromDisk(relPath: string): Promise<void> {
    const fullPath = join(this.tmpDir, relPath)
    this.writesInProgress.add(relPath)
    try {
      await rm(fullPath, { recursive: true, force: true })
    } catch { /* directory may not exist */ }
    setTimeout(() => {
      this.writesInProgress.delete(relPath)
    }, 150)
  }

  private async renameOnDisk(oldRelPath: string, newRelPath: string): Promise<void> {
    const oldFull = join(this.tmpDir, oldRelPath)
    const newFull = join(this.tmpDir, newRelPath)

    this.writesInProgress.add(oldRelPath)
    this.writesInProgress.add(newRelPath)

    try {
      await mkdir(dirname(newFull), { recursive: true })
      await fsRename(oldFull, newFull)
    } catch (e) {
      bridgeLog(`[FileSyncBridge] rename error ${oldRelPath} → ${newRelPath}:`, e)
    }

    setTimeout(() => {
      this.writesInProgress.delete(oldRelPath)
      this.writesInProgress.delete(newRelPath)
    }, 150)
  }

  // ── New local file creation ──────────────────────────────────

  /** Scan temp dir for files not known to Overleaf (orphaned from previous sessions) */
  private async scanForOrphanedFiles(): Promise<void> {
    const walk = async (dir: string, prefix: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const results: string[] = []
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const relPath = prefix ? prefix + '/' + entry.name : entry.name
        if (entry.isDirectory()) {
          results.push(...await walk(join(dir, entry.name), relPath))
        } else {
          results.push(relPath)
        }
      }
      return results
    }

    const allFiles = await walk(this.tmpDir, '')
    let orphanCount = 0

    for (const relPath of allFiles) {
      if (this.pathDocMap[relPath] || this.pathFileRefMap[relPath]) continue
      // Skip LaTeX output files, app-generated config files, and scratch space
      if (/\.(aux|log|fls|fdb_latexmk|synctex\.gz|bbl|blg|out|toc|lof|lot|nav|snm|vrb|pdf|pdfxref|stderr|stdout|chktex|synctex)/.test(relPath)) continue
      if (/(^|[/\\])\./.test(relPath)) continue
      if (/(?:^|[/\\])(?:CLAUDE\.md|\.mcp\.json)$/.test(relPath)) continue
      if (relPath.startsWith('claude-workspace/') || relPath === 'claude-workspace') continue

      bridgeLog(`[FileSyncBridge] orphaned file found: ${relPath}`)
      this.onNewLocalFile(relPath)
      orphanCount++
    }

    if (orphanCount > 0) {
      bridgeLog(`[FileSyncBridge] found ${orphanCount} orphaned files to sync`)
    }
  }

  /** Debounce handler for new local files */
  private onNewLocalFile(relPath: string): void {
    if (this.stopped) return
    if (this.writesInProgress.has(relPath)) return

    // Skip LaTeX output files, dotfiles, app-generated config files, and scratch space
    if (/\.(aux|log|fls|fdb_latexmk|synctex\.gz|bbl|blg|out|toc|lof|lot|nav|snm|vrb|pdf|pdfxref|stderr|stdout|chktex)$/.test(relPath)) return
    if (/(^|[/\\])\./.test(relPath)) return
    if (/(?:^|[/\\])(?:CLAUDE\.md|\.mcp\.json)$/.test(relPath)) return
    if (relPath.startsWith('claude-workspace/') || relPath === 'claude-workspace') return

    // Debounce 1s to let the tool finish writing
    const key = 'new:' + relPath
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key)
      this.processNewFile(relPath)
    }, 1000))
  }

  private async processNewFile(relPath: string): Promise<void> {
    if (this.stopped) return
    // Double-check it's still unknown (might have been registered by a server event)
    if (this.pathDocMap[relPath] || this.pathFileRefMap[relPath]) return

    this.pendingCreates.add(relPath)

    try {
      if (isTextExtension(relPath)) {
        await this.createLocalDocOnOverleaf(relPath)
      } else {
        await this.uploadNewLocalBinary(relPath)
      }
    } catch (e) {
      bridgeLog(`[FileSyncBridge] failed to create ${relPath} on Overleaf: ${e}`)
    } finally {
      // Keep in pendingCreates briefly to avoid processing the echoed server event
      setTimeout(() => this.pendingCreates.delete(relPath), 5000)
    }
  }

  /** Create a text doc on Overleaf and sync its content */
  private async createLocalDocOnOverleaf(relPath: string): Promise<void> {
    const content = await readFile(join(this.tmpDir, relPath), 'utf-8')
    const dir = dirname(relPath)
    const fileName = relPath.split('/').pop()!

    // Ensure parent folder exists
    const folderId = await this.ensureFolderExists(dir === '.' ? '' : dir)

    // Create doc via REST API
    const result = await this.overleafPost(`/project/${this.projectId}/doc`, {
      name: fileName,
      parent_folder_id: folderId
    })

    if (!result.ok || !result.data?._id) {
      throw new Error(`Create doc failed: HTTP ${result.status} ${JSON.stringify(result.data)}`)
    }

    const docId = result.data._id as string
    bridgeLog(`[FileSyncBridge] created doc "${relPath}" (${docId}) on Overleaf`)

    // Update maps
    this.docPathMap[docId] = relPath
    this.pathDocMap[relPath] = docId

    // Join the doc
    const joinResult = await this.socket.joinDoc(docId)
    const serverContent = (joinResult.docLines || []).join('\n')

    // Create OT client
    const otClient = new OtClient(
      joinResult.version,
      (ops, version) => this.sendOps(docId, ops, version),
      (ops) => this.onRemoteApply(docId, ops)
    )
    this.otClients.set(docId, otClient)

    // Send content as OT ops (doc starts empty on server)
    if (content && content !== serverContent) {
      this.lastKnownContent.set(relPath, content)
      const diffs = dmp.diff_main(serverContent, content)
      dmp.diff_cleanupEfficiency(diffs)
      const ops = diffsToOtOps(diffs)

      if (ops.length > 0) {
        otClient.onLocalOps(ops)
      }
    } else {
      this.lastKnownContent.set(relPath, serverContent)
    }

    // Notify renderer about the new doc. The server will also echo
    // reciveNewDoc, but pendingCreates makes us skip that duplicate.
    this.notifyEntityCreated('doc', docId, relPath, fileName, folderId)
  }

  /** Upload a new binary file to Overleaf */
  private async uploadNewLocalBinary(relPath: string): Promise<void> {
    const fullPath = join(this.tmpDir, relPath)
    const fileData = await readFile(fullPath)
    const dir = dirname(relPath)

    const folderId = await this.ensureFolderExists(dir === '.' ? '' : dir)

    bridgeLog(`[FileSyncBridge] uploading new binary: ${relPath} (${fileData.length} bytes)`)
    const fileRefId = await this.uploadBinary(relPath, fileData, folderId)
    this.binaryHashes.set(relPath, createHash('sha1').update(fileData).digest('hex'))

    // Notify renderer
    if (fileRefId) {
      this.notifyEntityCreated('file', fileRefId, relPath, relPath.split('/').pop() || relPath, folderId)
    }
  }

  /** Ensure a folder path exists on Overleaf, creating intermediaries as needed */
  private async ensureFolderExists(dirPath: string): Promise<string> {
    dirPath = dirPath.replace(/\/+$/, '')

    if (!dirPath || dirPath === '.') {
      return this.socket.projectData?.project.rootFolder?.[0]?._id || ''
    }

    const known = this.pathFolderMap[dirPath]
    if (known) return known

    // Check cache
    const cached = this.createdFolders.get(dirPath)
    if (cached) return cached

    // Check project data — search inside root folder's children
    const projectData = this.socket.projectData
    if (projectData) {
      const subFolders = projectData.project.rootFolder?.[0]?.folders as Array<{ _id: string; name: string; folders?: unknown[] }> | undefined
      if (subFolders) {
        const folderId = this.findFolderIdInTree(subFolders, dirPath + '/', '')
        if (folderId) {
          this.createdFolders.set(dirPath, folderId)
          return folderId
        }
      }
    }

    // Create — ensure parent exists first
    const parts = dirPath.split('/')
    const parentDir = parts.slice(0, -1).join('/')
    const folderName = parts[parts.length - 1]

    const parentId = await this.ensureFolderExists(parentDir)

    const result = await this.overleafPost(`/project/${this.projectId}/folder`, {
      name: folderName,
      parent_folder_id: parentId
    })

    if (result.ok && result.data?._id) {
      const folderId = result.data._id as string
      this.createdFolders.set(dirPath, folderId)
      this.folderPathMap[folderId] = dirPath
      this.pathFolderMap[dirPath] = folderId
      bridgeLog(`[FileSyncBridge] created folder "${folderName}" (${folderId})`)
      return folderId
    }

    throw new Error(`Failed to create folder "${dirPath}": HTTP ${result.status}`)
  }

  /** POST to Overleaf REST API */
  private overleafPost(path: string, body: object): Promise<{ ok: boolean; data?: any; status: number }> {
    return new Promise((resolve, reject) => {
      const req = net.request({
        method: 'POST',
        url: `https://www.overleaf.com${path}`
      })
      req.setHeader('Cookie', this.cookie)
      req.setHeader('Content-Type', 'application/json')
      req.setHeader('Accept', 'application/json')
      if (this.csrfToken) req.setHeader('x-csrf-token', this.csrfToken)

      let resBody = ''
      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) => { resBody += chunk.toString() })
        res.on('end', () => {
          try {
            const data = JSON.parse(resBody)
            resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, data, status: res.statusCode || 0 })
          } catch {
            resolve({ ok: false, status: res.statusCode || 0 })
          }
        })
      })
      req.on('error', reject)
      req.write(JSON.stringify(body))
      req.end()
    })
  }

  // ── Public getters ─────────────────────────────────────────────

  /** Get the temp dir path */
  get dir(): string {
    return this.tmpDir
  }

  /** Get content for a doc (used by compilation manager) */
  getDocContent(relPath: string): string | undefined {
    return this.lastKnownContent.get(relPath)
  }

  /** Get all synced text docs (used by compilation manager) */
  getAllDocContents(): Array<{ path: string; content: string }> {
    return Array.from(this.lastKnownContent.entries()).map(([path, content]) => ({ path, content }))
  }

  /** Get all known binary file refs (used by compilation manager) */
  getFileRefs(): Array<{ id: string; path: string }> {
    return Object.entries(this.fileRefPathMap).map(([id, path]) => ({ id, path }))
  }

  /** Check if a doc's content is known */
  hasDoc(relPath: string): boolean {
    return this.lastKnownContent.has(relPath)
  }
}

// ── Utility functions ────────────────────────────────────────

/** Convert diff-match-patch diffs to OT ops */
function diffsToOtOps(diffs: [number, string][]): OtOp[] {
  const ops: OtOp[] = []
  let pos = 0

  for (const [type, text] of diffs) {
    switch (type) {
      case 0: // DIFF_EQUAL
        pos += text.length
        break
      case 1: // DIFF_INSERT
        ops.push({ i: text, p: pos })
        pos += text.length
        break
      case -1: // DIFF_DELETE
        ops.push({ d: text, p: pos })
        break
    }
  }

  return ops
}

/** Apply OT ops to a text string */
function applyOpsToText(text: string, ops: OtOp[]): string {
  // ShareJS text operation components are sequential. Each component's
  // position is relative to the document after earlier components ran.
  for (const op of ops) {
    if (isInsert(op)) {
      text = text.slice(0, op.p) + op.i + text.slice(op.p)
    } else if (isDelete(op)) {
      text = text.slice(0, op.p) + text.slice(op.p + op.d.length)
    }
  }

  return text
}
