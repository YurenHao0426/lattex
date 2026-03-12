// Bidirectional file sync bridge: temp dir ↔ Overleaf via OT
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { createHash } from 'crypto'
import * as chokidar from 'chokidar'
import { diff_match_patch } from 'diff-match-patch'
import type { BrowserWindow } from 'electron'
import type { OverleafSocket } from './overleafSocket'
import { OtClient } from './otClient'
import type { OtOp } from './otTypes'
import { isInsert, isDelete } from './otTypes'

const dmp = new diff_match_patch()

export class FileSyncBridge {
  private lastKnownContent = new Map<string, string>()   // relPath → content
  private writesInProgress = new Set<string>()            // relPaths being written by bridge
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private otClients = new Map<string, OtClient>()         // docId → OtClient (non-editor docs)
  private editorDocs = new Set<string>()                  // docIds owned by renderer
  private watcher: chokidar.FSWatcher | null = null

  private socket: OverleafSocket
  private tmpDir: string
  private docPathMap: Record<string, string>    // docId → relPath
  private pathDocMap: Record<string, string>    // relPath → docId
  private mainWindow: BrowserWindow

  private serverEventHandler: ((name: string, args: unknown[]) => void) | null = null
  private stopped = false

  constructor(
    socket: OverleafSocket,
    tmpDir: string,
    docPathMap: Record<string, string>,
    pathDocMap: Record<string, string>,
    mainWindow: BrowserWindow
  ) {
    this.socket = socket
    this.tmpDir = tmpDir
    this.docPathMap = docPathMap
    this.pathDocMap = pathDocMap
    this.mainWindow = mainWindow
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

    // Listen for server events (remote ops on non-editor docs)
    this.serverEventHandler = (name: string, args: unknown[]) => {
      if (name === 'otUpdateApplied') {
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
    }
    this.socket.on('serverEvent', this.serverEventHandler)

    // Start watching the temp dir
    this.watcher = chokidar.watch(this.tmpDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      ignored: [
        /(^|[/\\])\../, // dotfiles
        /\.(aux|log|pdf|fls|fdb_latexmk|synctex\.gz|bbl|blg|out|toc|lof|lot|nav|snm|vrb)$/ // LaTeX output files
      ]
    })

    this.watcher.on('change', (absPath: string) => {
      const relPath = absPath.replace(this.tmpDir + '/', '')
      this.onFileChanged(relPath)
    })

    this.watcher.on('add', (absPath: string) => {
      const relPath = absPath.replace(this.tmpDir + '/', '')
      // Only process if it's a known doc
      if (this.pathDocMap[relPath]) {
        this.onFileChanged(relPath)
      }
    })

    console.log(`[FileSyncBridge] started, watching ${this.tmpDir}, ${docIds.length} docs synced`)
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
    this.writesInProgress.clear()
    this.editorDocs.clear()

    console.log('[FileSyncBridge] stopped')
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

    const docId = this.pathDocMap[relPath]
    if (!docId) return

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
    // Bridge's OtClient for this doc is no longer used (renderer has its own)
    // But we keep the doc joined in the socket
  }

  /** Renderer closed this doc from the editor — bridge takes over OT */
  removeEditorDoc(docId: string): void {
    this.editorDocs.delete(docId)

    // Re-join the doc to get fresh version, since renderer's OtClient was tracking it
    const relPath = this.docPathMap[docId]
    if (!relPath) return

    this.socket.joinDoc(docId).then((result) => {
      const content = (result.docLines || []).join('\n')
      this.lastKnownContent.set(relPath, content)

      // Create fresh OtClient with current version
      const otClient = new OtClient(
        result.version,
        (ops, version) => this.sendOps(docId, ops, version),
        (ops) => this.onRemoteApply(docId, ops)
      )
      this.otClients.set(docId, otClient)

      // Write latest content to disk
      this.writeToDisk(relPath, content)
    }).catch((e) => {
      console.log(`[FileSyncBridge] failed to re-join doc ${relPath}:`, e)
    })
  }

  // ── Helpers ──────────────────────────────────────────────────

  private async writeToDisk(relPath: string, content: string): Promise<void> {
    const fullPath = join(this.tmpDir, relPath)
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))

    // Set write guard
    this.writesInProgress.add(relPath)

    try {
      await mkdir(dir, { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
    } catch (e) {
      console.log(`[FileSyncBridge] write error for ${relPath}:`, e)
    }

    // Clear write guard after 150ms (chokidar needs time to fire & be ignored)
    setTimeout(() => {
      this.writesInProgress.delete(relPath)
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
        // Don't advance pos — deletion doesn't move cursor forward
        break
    }
  }

  return ops
}

/** Apply OT ops to a text string */
function applyOpsToText(text: string, ops: OtOp[]): string {
  // Sort ops by position descending so we can apply without position shifting
  const sortedOps = [...ops].sort((a, b) => b.p - a.p)

  for (const op of sortedOps) {
    if (isInsert(op)) {
      text = text.slice(0, op.p) + op.i + text.slice(op.p)
    } else if (isDelete(op)) {
      text = text.slice(0, op.p) + text.slice(op.p + op.d.length)
    }
    // Comment ops don't modify text
  }

  return text
}
