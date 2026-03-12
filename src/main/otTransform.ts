// OT transform functions for main process (mirror of renderer transform)
import type { OtOp } from './otTypes'
import { isInsert, isDelete, isComment } from './otTypes'

export function transformOps(
  ops1: OtOp[],
  ops2: OtOp[]
): { left: OtOp[]; right: OtOp[] } {
  let right = ops2

  const newLeft: OtOp[] = []
  for (const op1 of ops1) {
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

function transformOp(op1: OtOp, op2: OtOp): { left: OtOp; right: OtOp } {
  if (isInsert(op1) && isInsert(op2)) {
    if (op1.p <= op2.p) {
      return { left: op1, right: { ...op2, p: op2.p + op1.i.length } }
    } else {
      return { left: { ...op1, p: op1.p + op2.i.length }, right: op2 }
    }
  }

  if (isInsert(op1) && isDelete(op2)) {
    if (op1.p <= op2.p) {
      return { left: op1, right: { ...op2, p: op2.p + op1.i.length } }
    } else if (op1.p >= op2.p + op2.d.length) {
      return { left: { ...op1, p: op1.p - op2.d.length }, right: op2 }
    } else {
      return { left: { ...op1, p: op2.p }, right: op2 }
    }
  }

  if (isDelete(op1) && isInsert(op2)) {
    if (op2.p <= op1.p) {
      return { left: { ...op1, p: op1.p + op2.i.length }, right: op2 }
    } else if (op2.p >= op1.p + op1.d.length) {
      return { left: op1, right: { ...op2, p: op2.p - op1.d.length } }
    } else {
      return { left: op1, right: { ...op2, p: op2.p - op1.d.length } }
    }
  }

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
      const overlapStart = Math.max(0, op2.p - op1.p)
      const overlapEnd = Math.min(op1.d.length, op2.p + op2.d.length - op1.p)
      let newOp1Text = op1.d
      if (overlapEnd > overlapStart) {
        newOp1Text = op1.d.slice(0, overlapStart) + op1.d.slice(overlapEnd)
      }

      const overlapStart2 = Math.max(0, op1.p - op2.p)
      const overlapEnd2 = Math.min(op2.d.length, op1.p + op1.d.length - op2.p)
      let newOp2Text = op2.d
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

  if (isComment(op1) || isComment(op2)) {
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

    return { left: op1, right: op2 }
  }

  return { left: op1, right: op2 }
}
