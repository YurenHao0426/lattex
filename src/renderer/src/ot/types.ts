// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// OT type definitions for Overleaf's text operation format

/** Insert text at position p */
export interface InsertOp {
  i: string
  p: number
}

/** Delete text at position p */
export interface DeleteOp {
  d: string
  p: number
}

/** Comment operation (mark text at position p) */
export interface CommentOp {
  c: string
  p: number
  t: string // threadId
}

export type OtOp = InsertOp | DeleteOp | CommentOp

export function isInsert(op: OtOp): op is InsertOp {
  return 'i' in op
}

export function isDelete(op: OtOp): op is DeleteOp {
  return 'd' in op
}

export function isComment(op: OtOp): op is CommentOp {
  return 'c' in op
}

/** A versioned OT update */
export interface OtUpdate {
  doc: string
  op: OtOp[]
  v: number
  hash?: string
  lastV?: number
}

/** Possible states of the OT client */
export type OtStateName = 'synchronized' | 'awaitingConfirm' | 'awaitingWithBuffer'

export interface OtState {
  name: OtStateName
  inflight: OtOp[] | null   // ops sent, awaiting ack
  buffer: OtOp[] | null     // ops queued while awaiting
  version: number
}
