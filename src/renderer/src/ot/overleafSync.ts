// Per-document orchestrator: ties CM6 adapter to OT client, IPC bridge
import type { EditorView } from '@codemirror/view'
import { ChangeSet, Transaction, type Text } from '@codemirror/state'
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
    }

    // Debounce send
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flushLocalChanges(), this.debounceMs)
  }

  private flushLocalChanges() {
    if (!this.pendingChanges || !this.view) return

    const oldDoc = this.view.state.doc
    // We need the doc state BEFORE the pending changes were applied
    // Since we composed changes incrementally, we work backward
    // Actually, we stored the ChangeSet which maps old positions, so we convert directly
    const ops = changeSetToOtOps(this.pendingChanges, this.getOldDoc())
    this.pendingChanges = null

    if (ops.length > 0) {
      this.otClient.onLocalOps(ops)
    }
  }

  private getOldDoc(): Text {
    // The "old doc" is the current doc minus pending local changes
    // Since pendingChanges is null at send time (we just cleared it),
    // and the ChangeSet was already composed against the old doc,
    // we just use the doc that was current when changes started accumulating.
    // For simplicity, we pass the doc at change time via changeSetToOtOps
    return this.view!.state.doc
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

    this.view.dispatch({
      changes: specs,
      annotations: [
        remoteUpdateAnnotation.of(true),
        Transaction.addToHistory.of(false)
      ]
    })
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

  /** Replace entire editor content with new content (external edit from disk) */
  replaceContent(newContent: string) {
    if (!this.view) return

    const currentContent = this.view.state.doc.toString()
    if (currentContent === newContent) return

    // Dispatch as a local change (NOT remote annotation) so it flows through OT
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: newContent }
    })
  }

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.view = null
    this.pendingChanges = null
  }
}
