// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// Bidirectional conversion: CM6 ChangeSet <-> Overleaf OT ops
import type { ChangeSet, Text, ChangeSpec } from '@codemirror/state'
import type { OtOp, InsertOp, DeleteOp } from './types'
import { isInsert, isDelete } from './types'

/**
 * Convert a CM6 ChangeSet into Overleaf OT ops.
 * Iterates through the changes and produces insert/delete ops
 * with positions relative to the old document.
 */
export function changeSetToOtOps(changes: ChangeSet, oldDoc: Text): OtOp[] {
  const ops: OtOp[] = []
  let posAdjust = 0 // tracks position shift from previous ops

  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const origFrom = fromA
    const deletedLen = toA - fromA
    const insertedText = inserted.toString()

    // Delete first (at original position in the old doc)
    if (deletedLen > 0) {
      const deletedText = oldDoc.sliceString(fromA, toA)
      ops.push({ d: deletedText, p: origFrom + posAdjust })
      // After deleting, subsequent positions shift back
    }

    // Then insert
    if (insertedText.length > 0) {
      ops.push({ i: insertedText, p: origFrom + posAdjust })
      posAdjust += insertedText.length
    }

    if (deletedLen > 0) {
      posAdjust -= deletedLen
    }
  })

  return ops
}

/**
 * Convert Overleaf OT ops into CM6 ChangeSpec array.
 * These can be dispatched to an EditorView.
 */
export function otOpsToChangeSpec(ops: OtOp[]): ChangeSpec[] {
  const specs: ChangeSpec[] = []

  // Overleaf/ShareJS text ops are sequential: every component position is
  // relative to the document after previous components in the same op.
  for (const op of ops) {
    if (isInsert(op)) {
      specs.push({ from: op.p, insert: op.i })
    } else if (isDelete(op)) {
      specs.push({ from: op.p, to: op.p + op.d.length })
    }
  }

  return specs
}
