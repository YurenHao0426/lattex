// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// Bidirectional file sync bridge: temp dir ↔ Overleaf via OT (text) + REST (binary)
import { join, dirname } from 'path'
import { readFile, writeFile, mkdir, unlink, rename as fsRename } from 'fs/promises'
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

export class FileSyncBridge {
  private lastKnownContent = new Map<string, string>()   // relPath → content (text docs)
  private binaryHashes = new Map<string, string>()        // relPath → sha1 hash (binary files)
  private writesInProgress = new Set<string>()            // relPaths being written by bridge
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private otClients = new Map<string, OtClient>()         // docId → OtClient (non-editor docs)
  private editorDocs = new Set<string>()                  // docIds owned by renderer
  private watcher: chokidar.FSWatcher | null = null

  private socket: OverleafSocket
  private tmpDir: string
  private docPathMap: Record<string, string>    // docId → relPath
  private pathDocMap: Record<string, string>    // relPath → docId
  private fileRefPathMap: Record<string, string> // fileRefId → relPath
  private pathFileRefMap: Record<string, string> // relPath → fileRefId
  private mainWindow: BrowserWindow
  private projectId: string
  private cookie: string
  private csrfToken: string

  private serverEventHandler: ((name: string, args: unknown[]) => void) | null = null
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
  }

  async start(): Promise<void> {
    // Join ALL docs, fetch content, write to disk
    await mkdir(this.tmpDir, { recursive: true })

    const docIds = Object.keys(this.docPathMap)
    for (const docId of docIds) {
      const relPath = this.docPathMap[docId]
      try {
        const result = await this.socket.joinDoc(docId)
        const content = (result.docLines || []).join('\n')
        this.lastKnownContent.set(relPath, content)

        // Create OtClient for this doc (bridge owns it initially)
        const otClient = new OtClient(
          result.version,
          (ops, version) => this.sendOps(docId, ops, version),
          (ops) => this.onRemoteApply(docId, ops)
        )
        this.otClients.set(docId, otClient)

        // Write to disk
        await this.writeToDisk(relPath, content)
      } catch (e) {
        console.log(`[FileSyncBridge] failed to join doc ${relPath}:`, e)
      }
    }

    // Download all binary files
    const fileRefIds = Object.keys(this.fileRefPathMap)
    for (const fileRefId of fileRefIds) {
      const relPath = this.fileRefPathMap[fileRefId]
      try {
        await this.downloadBinary(fileRefId, relPath)
      } catch (e) {
        console.log(`[FileSyncBridge] failed to download ${relPath}:`, e)
      }
    }

    // Listen for server events
    this.serverEventHandler = (name: string, args: unknown[]) => {
      if (name === 'otUpdateApplied') {
        this.handleOtUpdate(args)
      } else if (name === 'reciveNewFile') {
        this.handleNewFile(args)
      } else if (name === 'reciveNewDoc') {
        this.handleNewDoc(args)
      } else if (name === 'removeEntity') {
        this.handleRemoveEntity(args)
      } else if (name === 'reciveEntityRename') {
        this.handleEntityRename(args)
      }
    }
    this.socket.on('serverEvent', this.serverEventHandler)

    // Start watching the temp dir
    this.watcher = chokidar.watch(this.tmpDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      ignored: [
        /(^|[/\\])\../, // dotfiles
        /\.(aux|log|fls|fdb_latexmk|synctex\.gz|bbl|blg|out|toc|lof|lot|nav|snm|vrb)$/ // LaTeX output files (not pdf!)
      ]
    })

    this.watcher.on('change', (absPath: string) => {
      const relPath = absPath.replace(this.tmpDir + '/', '')
      this.onFileChanged(relPath)
    })

    this.watcher.on('add', (absPath: string) => {
      const relPath = absPath.replace(this.tmpDir + '/', '')
      // Process if it's a known doc or fileRef
      if (this.pathDocMap[relPath] || this.pathFileRefMap[relPath]) {
        this.onFileChanged(relPath)
      }
    })

    console.log(`[FileSyncBridge] started, watching ${this.tmpDir}, ${docIds.length} docs + ${fileRefIds.length} files synced`)
  }

  async stop(): Promise<void> {
    this.stopped = true

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()

    // Remove server event handler
    if (this.serverEventHandler) {
      this.socket.removeListener('serverEvent', this.serverEventHandler)
      this.serverEventHandler = null
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

    console.log('[FileSyncBridge] stopped')
  }

  // ── OT update handler ─────────────────────────────────────

  private handleOtUpdate(args: unknown[]): void {
    const update = args[0] as { doc?: string; op?: OtOp[]; v?: number } | undefined
    if (!update?.doc) return
    const docId = update.doc

    // For non-editor docs, process remote ops through bridge's OtClient
    if (!this.editorDocs.has(docId) && update.op && update.v !== undefined) {
      const otClient = this.otClients.get(docId)
      if (otClient) {
        otClient.onRemoteOps(update.op, update.v)
      }
    }

    // For non-editor docs, handle ack (op with no ops array = ack for our own op)
    if (!this.editorDocs.has(docId) && !update.op) {
      const otClient = this.otClients.get(docId)
      if (otClient) {
        otClient.onAck()
      }
    }
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

    console.log(`[FileSyncBridge] remote new file: ${relPath} (${fileRef._id})`)

    // Register in maps
    this.fileRefPathMap[fileRef._id] = relPath
    this.pathFileRefMap[relPath] = fileRef._id

    // Download to disk
    this.downloadBinary(fileRef._id, relPath).catch((e) => {
      console.log(`[FileSyncBridge] failed to download new file ${relPath}:`, e)
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

    console.log(`[FileSyncBridge] remote new doc: ${relPath} (${doc._id})`)

    // Register in maps
    this.docPathMap[doc._id] = relPath
    this.pathDocMap[relPath] = doc._id

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
      console.log(`[FileSyncBridge] failed to join new doc ${relPath}:`, e)
    })
  }

  /** Remote: entity removed */
  private handleRemoveEntity(args: unknown[]): void {
    const entityId = args[0] as string
    if (!entityId) return

    // Check if it's a doc
    const docPath = this.docPathMap[entityId]
    if (docPath) {
      console.log(`[FileSyncBridge] remote remove doc: ${docPath}`)
      delete this.docPathMap[entityId]
      delete this.pathDocMap[docPath]
      this.lastKnownContent.delete(docPath)
      this.otClients.delete(entityId)
      this.deleteFromDisk(docPath)
      return
    }

    // Check if it's a fileRef
    const filePath = this.fileRefPathMap[entityId]
    if (filePath) {
      console.log(`[FileSyncBridge] remote remove file: ${filePath}`)
      delete this.fileRefPathMap[entityId]
      delete this.pathFileRefMap[filePath]
      this.binaryHashes.delete(filePath)
      this.deleteFromDisk(filePath)
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
      console.log(`[FileSyncBridge] remote rename doc: ${oldDocPath} → ${newPath}`)

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
      this.renameOnDisk(oldDocPath, newPath)
      return
    }

    // Check if it's a fileRef
    const oldFilePath = this.fileRefPathMap[entityId]
    if (oldFilePath) {
      const newPath = dirname(oldFilePath) === '.' ? newName : dirname(oldFilePath) + '/' + newName
      console.log(`[FileSyncBridge] remote rename file: ${oldFilePath} → ${newPath}`)

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
      this.renameOnDisk(oldFilePath, newPath)
    }
  }

  /** Find folder path prefix from folderId by looking at existing paths */
  private findFolderPath(folderId: string): string {
    // Check doc paths to find a doc in this folder
    for (const relPath of Object.values(this.docPathMap)) {
      // Not a reliable method — fall back to root
    }
    // Check fileRef paths
    for (const relPath of Object.values(this.fileRefPathMap)) {
      // Not reliable either
    }
    // For root folder, return empty
    // For subfolders, we'd need the folder tree — but we can look for folder paths
    // ending with the folderId in the socket's project data
    const projectData = this.socket.projectData
    if (projectData) {
      const path = this.findFolderPathInTree(projectData.project.rootFolder, folderId, '')
      if (path !== null) return path
    }
    return '' // default to root
  }

  private findFolderPathInTree(folders: Array<{ _id: string; name: string; folders?: unknown[] }>, targetId: string, prefix: string): string | null {
    for (const f of folders) {
      if (f._id === targetId) return prefix
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

    // Layer 1: Skip if bridge is currently writing this file
    if (this.writesInProgress.has(relPath)) return

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
    } catch {
      return // file deleted or unreadable
    }

    const lastKnown = this.lastKnownContent.get(relPath)

    // Layer 2: Content equality check
    if (newContent === lastKnown) return

    console.log(`[FileSyncBridge] disk change detected: ${relPath} (${(newContent.length)} chars)`)

    if (this.editorDocs.has(docId)) {
      // Doc is open in editor → send to renderer via IPC
      this.lastKnownContent.set(relPath, newContent)
      this.mainWindow.webContents.send('sync:externalEdit', { docId, content: newContent })
    } else {
      // Doc NOT open in editor → bridge handles OT directly
      const oldContent = lastKnown ?? ''
      this.lastKnownContent.set(relPath, newContent)

      const diffs = dmp.diff_main(oldContent, newContent)
      dmp.diff_cleanupEfficiency(diffs)
      const ops = diffsToOtOps(diffs)

      if (ops.length > 0) {
        const otClient = this.otClients.get(docId)
        if (otClient) {
          otClient.onLocalOps(ops)
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

    console.log(`[FileSyncBridge] binary change detected: ${relPath} (${fileData.length} bytes)`)
    this.binaryHashes.set(relPath, newHash)

    // Upload to Overleaf via REST API (this replaces the existing file)
    try {
      await this.uploadBinary(relPath, fileData)
    } catch (e) {
      console.log(`[FileSyncBridge] failed to upload binary ${relPath}:`, e)
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
            setTimeout(() => this.writesInProgress.delete(relPath), 150)

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

  private async uploadBinary(relPath: string, fileData: Buffer): Promise<void> {
    const fileName = relPath.includes('/') ? relPath.split('/').pop()! : relPath
    const folderId = this.findFolderIdForPath(relPath)

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
          console.log(`[FileSyncBridge] upload ${relPath}: ${res.statusCode} ${resBody.slice(0, 200)}`)
          try {
            const data = JSON.parse(resBody)
            if (data.success !== false && !data.error) {
              // Upload replaces the file — update our fileRef ID if it changed
              if (data.entity_id && data.entity_id !== this.pathFileRefMap[relPath]) {
                const oldId = this.pathFileRefMap[relPath]
                if (oldId) delete this.fileRefPathMap[oldId]
                this.fileRefPathMap[data.entity_id] = relPath
                this.pathFileRefMap[relPath] = data.entity_id
              }
              resolve()
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
    const dir = dirname(relPath)
    if (dir === '.') {
      // Root folder
      const projectData = this.socket.projectData
      return projectData?.project.rootFolder?.[0]?._id || ''
    }

    // Search project data for the folder
    const projectData = this.socket.projectData
    if (projectData) {
      const folderId = this.findFolderIdInTree(projectData.project.rootFolder, dir + '/', '')
      if (folderId) return folderId
    }

    // Fallback to root
    return projectData?.project.rootFolder?.[0]?._id || ''
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

  // ── Send OT ops to Overleaf (for non-editor docs) ───────────

  private sendOps(docId: string, ops: OtOp[], version: number): void {
    const relPath = this.docPathMap[docId]
    const content = relPath ? this.lastKnownContent.get(relPath) ?? '' : ''
    const hash = createHash('sha1').update(content).digest('hex')
    this.socket.applyOtUpdate(docId, ops, version, hash)
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

    this.socket.joinDoc(docId).then((result) => {
      const content = (result.docLines || []).join('\n')
      this.lastKnownContent.set(relPath, content)

      const otClient = new OtClient(
        result.version,
        (ops, version) => this.sendOps(docId, ops, version),
        (ops) => this.onRemoteApply(docId, ops)
      )
      this.otClients.set(docId, otClient)

      this.writeToDisk(relPath, content)
    }).catch((e) => {
      console.log(`[FileSyncBridge] failed to re-join doc ${relPath}:`, e)
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
      console.log(`[FileSyncBridge] write error for ${relPath}:`, e)
    }

    setTimeout(() => {
      this.writesInProgress.delete(relPath)
    }, 150)
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

  private async renameOnDisk(oldRelPath: string, newRelPath: string): Promise<void> {
    const oldFull = join(this.tmpDir, oldRelPath)
    const newFull = join(this.tmpDir, newRelPath)

    this.writesInProgress.add(oldRelPath)
    this.writesInProgress.add(newRelPath)

    try {
      await mkdir(dirname(newFull), { recursive: true })
      await fsRename(oldFull, newFull)
    } catch (e) {
      console.log(`[FileSyncBridge] rename error ${oldRelPath} → ${newRelPath}:`, e)
    }

    setTimeout(() => {
      this.writesInProgress.delete(oldRelPath)
      this.writesInProgress.delete(newRelPath)
    }, 150)
  }

  /** Get the temp dir path */
  get dir(): string {
    return this.tmpDir
  }

  /** Get content for a doc (used by compilation manager) */
  getDocContent(relPath: string): string | undefined {
    return this.lastKnownContent.get(relPath)
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
  const sortedOps = [...ops].sort((a, b) => b.p - a.p)

  for (const op of sortedOps) {
    if (isInsert(op)) {
      text = text.slice(0, op.p) + op.i + text.slice(op.p)
    } else if (isDelete(op)) {
      text = text.slice(0, op.p) + text.slice(op.p + op.d.length)
    }
  }

  return text
}
