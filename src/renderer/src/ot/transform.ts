// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// OT transform functions for Overleaf's text operation format
import type { OtOp } from './types'
import { isInsert, isDelete, isComment } from './types'

/**
 * Transform two lists of operations against each other.
 * Returns { left, right } where:
 *   - left = ops1 transformed against ops2 (apply after ops2)
 *   - right = ops2 transformed against ops1 (apply after ops1)
 */
export function transformOps(
  ops1: OtOp[],
  ops2: OtOp[]
): { left: OtOp[]; right: OtOp[] } {
  let left = ops1
  let right = ops2

  // Transform each op in left against all ops in right, and vice versa
  const newLeft: OtOp[] = []
  for (const op1 of left) {
    let transformed = op1
    const newRight: OtOp[] = []
    for (const op2 of right) {
      const { left: tl, right: tr } = transformOp(transformed, op2)
      transformed = tl
      newRight.push(tr)
    }
    newLeft.push(transformed)
    right = newRight
  }

  return { left: newLeft, right }
}

/** Transform a single op against another single op */
function transformOp(op1: OtOp, op2: OtOp): { left: OtOp; right: OtOp } {
  // Insert vs Insert
  if (isInsert(op1) && isInsert(op2)) {
    if (op1.p <= op2.p) {
      return {
        left: op1,
        right: { ...op2, p: op2.p + op1.i.length }
      }
    } else {
      return {
        left: { ...op1, p: op1.p + op2.i.length },
        right: op2
      }
    }
  }

  // Insert vs Delete
  if (isInsert(op1) && isDelete(op2)) {
    if (op1.p <= op2.p) {
      return {
        left: op1,
        right: { ...op2, p: op2.p + op1.i.length }
      }
    } else if (op1.p >= op2.p + op2.d.length) {
      return {
        left: { ...op1, p: op1.p - op2.d.length },
        right: op2
      }
    } else {
      // Insert inside deleted region — place at delete position
      return {
        left: { ...op1, p: op2.p },
        right: op2
      }
    }
  }

  // Delete vs Insert
  if (isDelete(op1) && isInsert(op2)) {
    if (op2.p <= op1.p) {
      return {
        left: { ...op1, p: op1.p + op2.i.length },
        right: op2
      }
    } else if (op2.p >= op1.p + op1.d.length) {
      return {
        left: op1,
        right: { ...op2, p: op2.p - op1.d.length }
      }
    } else {
      // Insert inside our deleted region
      return {
        left: op1,
        right: { ...op2, p: op2.p - op1.d.length }
      }
    }
  }

  // Delete vs Delete
  if (isDelete(op1) && isDelete(op2)) {
    if (op1.p >= op2.p + op2.d.length) {
      return {
        left: { ...op1, p: op1.p - op2.d.length },
        right: { ...op2, p: op2.p }
      }
    } else if (op2.p >= op1.p + op1.d.length) {
      return {
        left: op1,
        right: { ...op2, p: op2.p - op1.d.length }
      }
    } else {
      // Overlapping deletes — both become no-ops for the overlapping part
      const start = Math.max(op1.p, op2.p)
      const end1 = op1.p + op1.d.length
      const end2 = op2.p + op2.d.length

      // op1 after removing overlap with op2
      let newOp1Text = op1.d
      const overlapStart = Math.max(0, op2.p - op1.p)
      const overlapEnd = Math.min(op1.d.length, op2.p + op2.d.length - op1.p)
      if (overlapEnd > overlapStart) {
        newOp1Text = op1.d.slice(0, overlapStart) + op1.d.slice(overlapEnd)
      }

      let newOp2Text = op2.d
      const overlapStart2 = Math.max(0, op1.p - op2.p)
      const overlapEnd2 = Math.min(op2.d.length, op1.p + op1.d.length - op2.p)
      if (overlapEnd2 > overlapStart2) {
        newOp2Text = op2.d.slice(0, overlapStart2) + op2.d.slice(overlapEnd2)
      }

      const newP1 = op1.p <= op2.p ? op1.p : op1.p - (overlapEnd2 - overlapStart2)
      const newP2 = op2.p <= op1.p ? op2.p : op2.p - (overlapEnd - overlapStart)

      return {
        left: newOp1Text ? { d: newOp1Text, p: Math.max(0, newP1) } : { d: '', p: 0 },
        right: newOp2Text ? { d: newOp2Text, p: Math.max(0, newP2) } : { d: '', p: 0 }
      }
    }
  }

  // Comment ops: treat like inserts of zero length at their position for transform purposes
  if (isComment(op1) || isComment(op2)) {
    // Comments don't modify the document text, so they just need position adjustment
    let p1 = isComment(op1) ? op1.p : ('p' in op1 ? op1.p : 0)
    let p2 = isComment(op2) ? op2.p : ('p' in op2 ? op2.p : 0)

    if (isInsert(op2) && !isComment(op1)) {
      // handled above
    }

    // For comments, adjust position based on the other op
    if (isComment(op1)) {
      if (isInsert(op2) && op2.p <= op1.p) {
        return { left: { ...op1, p: op1.p + op2.i.length }, right: op2 }
      }
      if (isDelete(op2) && op2.p < op1.p) {
        const shift = Math.min(op2.d.length, op1.p - op2.p)
        return { left: { ...op1, p: op1.p - shift }, right: op2 }
      }
    }

    if (isComment(op2)) {
      if (isInsert(op1) && op1.p <= op2.p) {
        return { left: op1, right: { ...op2, p: op2.p + op1.i.length } }
      }
      if (isDelete(op1) && op1.p < op2.p) {
        const shift = Math.min(op1.d.length, op2.p - op1.p)
        return { left: op1, right: { ...op2, p: op2.p - shift } }
      }
    }

    // Both comments or no positional conflict
    return { left: op1, right: op2 }
  }

  // Fallback: no transform needed
  return { left: op1, right: op2 }
}
