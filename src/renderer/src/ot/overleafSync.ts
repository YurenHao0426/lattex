// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// Per-document orchestrator: ties CM6 adapter to OT client, IPC bridge
import type { EditorView } from '@codemirror/view'
import { ChangeSet, Transaction, type ChangeSpec, type Text } from '@codemirror/state'
import { diff_match_patch } from 'diff-match-patch'
import { OtClient } from './otClient'
import type { OtOp } from './types'
import { changeSetToOtOps, otOpsToChangeSpec } from './cmAdapter'
import { remoteUpdateAnnotation } from '../extensions/otSyncExtension'

function sha1(text: string): string {
  return window.api.sha1(text)
}

export class OverleafDocSync {
  private otClient: OtClient
  private view: EditorView | null = null
  private docId: string
  private pendingChanges: ChangeSet | null = null
  private pendingBaseDoc: Text | null = null // doc before pendingChanges
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private debounceMs = 150

  constructor(docId: string, version: number) {
    this.docId = docId
    this.otClient = new OtClient(
      version,
      this.handleSend.bind(this),
      this.handleApply.bind(this)
    )
  }

  get version(): number {
    return this.otClient.version
  }

  get editorView(): EditorView | null {
    return this.view
  }

  setView(view: EditorView) {
    this.view = view
  }

  /** Called by CM6 update listener for local changes */
  onLocalChange(changes: ChangeSet, oldDoc: Text) {
    // Compose into pending changes (buffer ChangeSets, convert to OT ops only at send time)
    if (this.pendingChanges) {
      this.pendingChanges = this.pendingChanges.compose(changes)
    } else {
      this.pendingChanges = changes
      this.pendingBaseDoc = oldDoc // save the base doc for correct OT op generation
    }

    // Debounce send
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flushLocalChanges(), this.debounceMs)
  }

  private flushLocalChanges() {
    if (!this.pendingChanges || !this.view || !this.pendingBaseDoc) return

    const ops = changeSetToOtOps(this.pendingChanges, this.pendingBaseDoc)
    this.pendingChanges = null
    this.pendingBaseDoc = null

    if (ops.length > 0) {
      this.otClient.onLocalOps(ops)
    }
  }

  /** Send ops to server via IPC */
  private handleSend(ops: OtOp[], version: number) {
    const docText = this.view?.state.doc.toString() || ''
    const hash = sha1(docText)
    window.api.otSendOp(this.docId, ops, version, hash)
  }

  /** Apply remote ops to CM6 editor */
  private handleApply(ops: OtOp[]) {
    if (!this.view) return

    const specs = otOpsToChangeSpec(ops)
    if (specs.length === 0) return

    for (const changes of specs) {
      this.view.dispatch({
        changes,
        annotations: [
          remoteUpdateAnnotation.of(true),
          Transaction.addToHistory.of(false)
        ]
      })
    }
  }

  /** Called when server acknowledges our ops */
  onAck() {
    this.otClient.onAck()
  }

  /** Called when server sends remote ops */
  onRemoteOps(ops: OtOp[], version: number) {
    this.otClient.onRemoteOps(ops, version)
  }

  /** Reset after reconnect with fresh doc state */
  reset(version: number, docContent: string) {
    this.otClient.reset(version)
    this.pendingChanges = null
    this.pendingBaseDoc = null
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    // Replace editor content with server state
    if (this.view) {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: docContent },
        annotations: [
          remoteUpdateAnnotation.of(true),
          Transaction.addToHistory.of(false)
        ]
      })
    }
  }

  /** Replace entire editor content with new content (external edit from disk).
   *  Computes a minimal diff from the current editor state to the new content
   *  and dispatches it as a local transaction (which the OT extension picks up). */
  replaceContent(newContent: string, _baseContent?: string) {
    if (!this.view) return

    const currentContent = this.view.state.doc.toString()
    if (currentContent === newContent) return

    // Direct two-way diff: always diff current editor state → new disk content.
    // We intentionally do NOT three-way merge with baseContent because the bridge's
    // lastKnownContent (used as baseContent) races with onEditorContentChanged and
    // frequently doesn't match the editor's actual state, causing patch_apply to
    // produce garbled text when it "succeeds" via fuzzy matching.
    const dmp = new diff_match_patch()
    const diffs = dmp.diff_main(currentContent, newContent)
    dmp.diff_cleanupEfficiency(diffs)

    const changes: ChangeSpec[] = []
    let pos = 0
    for (const [type, text] of diffs) {
      if (type === 0) { // EQUAL
        pos += text.length
      } else if (type === -1) { // DELETE
        changes.push({ from: pos, to: pos + text.length })
        pos += text.length
      } else if (type === 1) { // INSERT
        changes.push({ from: pos, to: pos, insert: text })
      }
    }

    if (changes.length > 0) {
      this.view.dispatch({ changes })
    }
  }

  destroy() {
    // Flush any debounced local changes before destroying, so OT ops are sent
    // to the server before the bridge takes back ownership of this doc.
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.pendingChanges && this.view && this.pendingBaseDoc) {
      this.flushLocalChanges()
    }
    this.view = null
    this.pendingChanges = null
    this.pendingBaseDoc = null
  }
}
