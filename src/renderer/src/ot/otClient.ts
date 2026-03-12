// OT state machine: Synchronized / AwaitingConfirm / AwaitingWithBuffer
import type { OtOp, OtState } from './types'
import { transformOps } from './transform'

export type SendFn = (ops: OtOp[], version: number) => void
export type ApplyFn = (ops: OtOp[]) => void

export class OtClient {
  private state: OtState
  private sendFn: SendFn
  private applyFn: ApplyFn

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
        // Unexpected ack in synchronized state, ignore
        console.warn('[OtClient] unexpected ack in synchronized state')
        break
    }
  }

  /** Called when server sends a remote operation */
  onRemoteOps(ops: OtOp[], newVersion: number) {
    switch (this.state.name) {
      case 'synchronized':
        // Apply directly
        this.state = { ...this.state, version: newVersion }
        this.applyFn(ops)
        break

      case 'awaitingConfirm': {
        // Transform: remote ops vs our inflight
        const { left: transformedRemote, right: transformedInflight } = transformOps(ops, this.state.inflight || [])
        this.state = {
          ...this.state,
          inflight: transformedInflight,
          version: newVersion
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
          version: newVersion
        }
        this.applyFn(remoteAfterBuffer)
        break
      }
    }
  }

  /** Reset to a known version (e.g. after reconnect) */
  reset(version: number) {
    this.state = { name: 'synchronized', inflight: null, buffer: null, version }
  }
}
