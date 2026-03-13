// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// OT type definitions for main process (mirror of renderer types)

export interface InsertOp {
  i: string
  p: number
}

export interface DeleteOp {
  d: string
  p: number
}

export interface CommentOp {
  c: string
  p: number
  t: string
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
