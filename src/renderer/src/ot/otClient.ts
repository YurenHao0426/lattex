// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// OT state machine: Synchronized / AwaitingConfirm / AwaitingWithBuffer
import type { OtOp, OtState } from './types'
import { transformOps } from './transform'

export type SendFn = (ops: OtOp[], version: number) => void
export type ApplyFn = (ops: OtOp[]) => void

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

  /** Called when local user makes changes */
  onLocalOps(ops: OtOp[]) {
    if (ops.length === 0) return

    switch (this.state.name) {
      case 'synchronized':
        // Send immediately, transition to awaiting
        this.state = {
          name: 'awaitingConfirm',
          inflight: ops,
          buffer: null,
          version: this.state.version
        }
        this.sendFn(ops, this.state.version)
        break

      case 'awaitingConfirm':
        // Buffer the ops
        this.state = {
          name: 'awaitingWithBuffer',
          inflight: this.state.inflight,
          buffer: ops,
          version: this.state.version
        }
        break

      case 'awaitingWithBuffer':
        // Compose into existing buffer
        this.state = {
          ...this.state,
          buffer: [...(this.state.buffer || []), ...ops]
        }
        break
    }
  }

  /** Called when server acknowledges our inflight ops */
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

      case 'awaitingWithBuffer':
        // Send the buffer, move to awaitingConfirm
        const bufferOps = this.state.buffer || []
        this.state = {
          name: 'awaitingConfirm',
          inflight: bufferOps,
          buffer: null,
          version: this.state.version + 1
        }
        this.sendFn(bufferOps, this.state.version)
        break

      case 'synchronized':
        // Duplicate ack. The server can send both own-source echoes and
        // explicit no-op acks depending on deployment/version.
        break
    }

    this.processQueuedRemoteUpdates()
  }

  /** Called when server sends a remote operation */
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
        // Apply directly
        this.state = { ...this.state, version: nextVersion }
        this.applyFn(ops)
        break

      case 'awaitingConfirm': {
        // Transform: remote ops vs our inflight
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
        // Transform remote vs inflight, then remote' vs buffer
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

  /** Reset to a known version (e.g. after reconnect) */
  reset(version: number) {
    this.state = { name: 'synchronized', inflight: null, buffer: null, version }
    this.queuedRemoteUpdates = []
  }
}
