// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// OT state machine for main process (mirror of renderer otClient)
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
        console.warn('[OtClient:main] unexpected ack in synchronized state')
        break
    }
  }

  onRemoteOps(ops: OtOp[], newVersion: number) {
    switch (this.state.name) {
      case 'synchronized':
        this.state = { ...this.state, version: newVersion }
        this.applyFn(ops)
        break

      case 'awaitingConfirm': {
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

  reset(version: number) {
    this.state = { name: 'synchronized', inflight: null, buffer: null, version }
  }
}
