// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// OT state machine for main process
// Modeled after Overleaf's ShareJS client (vendor/libs/sharejs.js)
//
// States:
//   synchronized     — no pending ops, version matches server
//   awaitingConfirm  — one inflight op awaiting server ack
//   awaitingWithBuffer — inflight + buffered local ops
//
// Key invariant: at most ONE inflight op at a time.
// Version increments by 1 on each ack or remote op.

import type { OtOp } from './otTypes'
import { transformOps } from './otTransform'

export type SendFn = (ops: OtOp[], version: number) => void
export type ApplyFn = (ops: OtOp[]) => void

interface OtState {
  name: 'synchronized' | 'awaitingConfirm' | 'awaitingWithBuffer'
  inflight: OtOp[] | null
  buffer: OtOp[] | null
  version: number
}

interface QueuedRemoteUpdate {
  ops: OtOp[]
  version: number
}

export class OtClient {
  private state: OtState
  private sendFn: SendFn
  private applyFn: ApplyFn
  private queuedRemoteUpdates: QueuedRemoteUpdate[] = []

  constructor(version: number, sendFn: SendFn, applyFn: ApplyFn) {
    this.state = { name: 'synchronized', inflight: null, buffer: null, version }
    this.sendFn = sendFn
    this.applyFn = applyFn
  }

  get version(): number {
    return this.state.version
  }

  get stateName(): string {
    return this.state.name
  }

  onLocalOps(ops: OtOp[]) {
    if (ops.length === 0) return

    switch (this.state.name) {
      case 'synchronized':
        this.state = {
          name: 'awaitingConfirm',
          inflight: ops,
          buffer: null,
          version: this.state.version
        }
        this.sendFn(ops, this.state.version)
        break

      case 'awaitingConfirm':
        this.state = {
          name: 'awaitingWithBuffer',
          inflight: this.state.inflight,
          buffer: ops,
          version: this.state.version
        }
        break

      case 'awaitingWithBuffer':
        this.state = {
          ...this.state,
          buffer: [...(this.state.buffer || []), ...ops]
        }
        break
    }
  }

  /**
   * Server acknowledged our inflight op.
   * Matches Overleaf's ShareJS: both "ack without ops" and "echoed ops from
   * our own source" are treated as acks. The echoed ops are NOT re-applied
   * because they were already applied optimistically when submitted.
   *
   * In synchronized state, silently drops (duplicate ack — common when server
   * sends both an echo and a separate ack event).
   */
  onAck() {
    switch (this.state.name) {
      case 'awaitingConfirm':
        this.state = {
          name: 'synchronized',
          inflight: null,
          buffer: null,
          version: this.state.version + 1
        }
        break

      case 'awaitingWithBuffer': {
        const bufferOps = this.state.buffer || []
        this.state = {
          name: 'awaitingConfirm',
          inflight: bufferOps,
          buffer: null,
          version: this.state.version + 1
        }
        this.sendFn(bufferOps, this.state.version)
        break
      }

      case 'synchronized':
        // Duplicate ack — silently drop.
        // This is expected: server may send both an echoed op (with meta.source)
        // and a separate ack event (without ops). The first one transitions us
        // to synchronized, the second arrives when we're already there.
        break
    }

    this.processQueuedRemoteUpdates()
  }

  /**
   * Server sent a remote op from another client.
   * Transform against inflight/buffered ops before applying.
   */
  onRemoteOps(ops: OtOp[], newVersion: number) {
    // ShareJS update.v is the document version before the op is applied.
    // Drop duplicates and queue out-of-order messages until their base version
    // catches up, matching Overleaf's in-order processing.
    if (newVersion < this.state.version) {
      return
    }
    if (newVersion > this.state.version) {
      this.queueRemoteUpdate(ops, newVersion)
      return
    }

    this.applyRemoteOps(ops, newVersion)
    this.processQueuedRemoteUpdates()
  }

  private applyRemoteOps(ops: OtOp[], newVersion: number) {
    const nextVersion = newVersion + 1

    switch (this.state.name) {
      case 'synchronized':
        this.state = { ...this.state, version: nextVersion }
        this.applyFn(ops)
        break

      case 'awaitingConfirm': {
        const { left: transformedRemote, right: transformedInflight } = transformOps(ops, this.state.inflight || [])
        this.state = {
          ...this.state,
          inflight: transformedInflight,
          version: nextVersion
        }
        this.applyFn(transformedRemote)
        break
      }

      case 'awaitingWithBuffer': {
        const { left: remoteAfterInflight, right: inflightAfterRemote } = transformOps(ops, this.state.inflight || [])
        const { left: remoteAfterBuffer, right: bufferAfterRemote } = transformOps(remoteAfterInflight, this.state.buffer || [])
        this.state = {
          ...this.state,
          inflight: inflightAfterRemote,
          buffer: bufferAfterRemote,
          version: nextVersion
        }
        this.applyFn(remoteAfterBuffer)
        break
      }
    }
  }

  private queueRemoteUpdate(ops: OtOp[], version: number) {
    if (this.queuedRemoteUpdates.some((update) => update.version === version)) return
    this.queuedRemoteUpdates.push({ ops, version })
    this.queuedRemoteUpdates.sort((a, b) => a.version - b.version)
  }

  private processQueuedRemoteUpdates() {
    let nextIndex = this.queuedRemoteUpdates.findIndex((update) => update.version === this.state.version)
    while (nextIndex !== -1) {
      const [next] = this.queuedRemoteUpdates.splice(nextIndex, 1)
      this.applyRemoteOps(next.ops, next.version)
      nextIndex = this.queuedRemoteUpdates.findIndex((update) => update.version === this.state.version)
    }
  }

  reset(version: number) {
    this.state = { name: 'synchronized', inflight: null, buffer: null, version }
    this.queuedRemoteUpdates = []
  }
}
