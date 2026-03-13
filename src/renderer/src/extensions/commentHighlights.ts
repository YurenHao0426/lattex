// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

/**
 * CodeMirror extension for highlighting commented text ranges.
 * Inspired by Overleaf's ranges.ts — renders Decoration.mark for each comment
 * in the current file, with hover/focus highlighting linkage to the ReviewPanel.
 */
import {
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
} from '@codemirror/view'

// ── Types ──────────────────────────────────────────────────────

export interface CommentRange {
  threadId: string
  from: number    // character offset in the doc
  to: number      // from + text.length
  text: string
}

// ── Effects ────────────────────────────────────────────────────

/** Replace all comment ranges in the editor */
export const setCommentRangesEffect = StateEffect.define<CommentRange[]>()

/** Highlight a specific thread (from ReviewPanel hover) */
export const highlightThreadEffect = StateEffect.define<string | null>()

/** Focus a specific thread (from cursor position) — internal */
const focusThreadEffect = StateEffect.define<string | null>()

// ── State Fields ───────────────────────────────────────────────

/** Stores comment ranges data */
export const commentRangesField = StateField.define<CommentRange[]>({
  create() {
    return []
  },
  update(ranges, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCommentRangesEffect)) {
        return effect.value
      }
    }
    // Remap positions through document changes so they stay in sync
    if (tr.docChanged && ranges.length > 0) {
      const docLen = tr.newDoc.length
      return ranges.map(r => {
        const from = Math.min(tr.changes.mapPos(r.from, 1), docLen)
        const to = Math.min(tr.changes.mapPos(r.to, -1), docLen)
        return { ...r, from, to }
      }).filter(r => r.from < r.to)
    }
    return ranges
  },
})

/** Stores the currently highlighted thread ID (from panel hover) */
const highlightedThreadField = StateField.define<string | null>({
  create() {
    return null
  },
  update(current, tr) {
    for (const effect of tr.effects) {
      if (effect.is(highlightThreadEffect)) {
        return effect.value
      }
    }
    return current
  },
})

/** Stores the currently focused thread ID (from cursor position) */
const focusedThreadField = StateField.define<string | null>({
  create() {
    return null
  },
  update(current, tr) {
    for (const effect of tr.effects) {
      if (effect.is(focusThreadEffect)) {
        return effect.value
      }
    }
    return current
  },
})

// ── Decoration Builders ────────────────────────────────────────

function buildCommentDecorations(ranges: CommentRange[], docLen?: number): DecorationSet {
  if (ranges.length === 0) return Decoration.none

  const decorations = []
  for (const r of ranges) {
    const from = docLen !== undefined ? Math.min(r.from, docLen) : r.from
    const to = docLen !== undefined ? Math.min(r.to, docLen) : r.to
    if (from >= to || from < 0) continue
    decorations.push(
      Decoration.mark({
        class: 'cm-comment-highlight',
        attributes: { 'data-thread-id': r.threadId },
      }).range(from, to)
    )
  }
  // Must be sorted by from position
  decorations.sort((a, b) => a.from - b.from)
  return Decoration.set(decorations, true)
}

function buildHighlightDecoration(ranges: CommentRange[], threadId: string | null, docLen?: number): DecorationSet {
  if (!threadId) return Decoration.none
  const r = ranges.find(c => c.threadId === threadId)
  if (!r) return Decoration.none
  const from = docLen !== undefined ? Math.min(r.from, docLen) : r.from
  const to = docLen !== undefined ? Math.min(r.to, docLen) : r.to
  if (from >= to || from < 0) return Decoration.none
  return Decoration.set([
    Decoration.mark({ class: 'cm-comment-highlight-hover' }).range(from, to)
  ])
}

function buildFocusDecoration(ranges: CommentRange[], threadId: string | null, docLen?: number): DecorationSet {
  if (!threadId) return Decoration.none
  const r = ranges.find(c => c.threadId === threadId)
  if (!r) return Decoration.none
  const from = docLen !== undefined ? Math.min(r.from, docLen) : r.from
  const to = docLen !== undefined ? Math.min(r.to, docLen) : r.to
  if (from >= to || from < 0) return Decoration.none
  return Decoration.set([
    Decoration.mark({ class: 'cm-comment-highlight-focus' }).range(from, to)
  ])
}

// ── View Plugins ───────────────────────────────────────────────

/** Base comment decorations (yellow background) */
const commentDecorationsPlugin = ViewPlugin.define<PluginValue & { decorations: DecorationSet }>(
  () => ({
    decorations: Decoration.none,
    update(update) {
      for (const tr of update.transactions) {
        this.decorations = this.decorations.map(tr.changes)
        for (const effect of tr.effects) {
          if (effect.is(setCommentRangesEffect)) {
            this.decorations = buildCommentDecorations(effect.value, update.state.doc.length)
          }
        }
      }
    },
  }),
  { decorations: (v) => v.decorations }
)

/** Hover highlight decoration (stronger yellow, from ReviewPanel hover) */
const hoverHighlightPlugin = ViewPlugin.define<PluginValue & { decorations: DecorationSet }>(
  () => ({
    decorations: Decoration.none,
    update(update) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(highlightThreadEffect) || effect.is(setCommentRangesEffect)) {
            const ranges = update.state.field(commentRangesField)
            const threadId = update.state.field(highlightedThreadField)
            this.decorations = buildHighlightDecoration(ranges, threadId, update.state.doc.length)
            return
          }
        }
        this.decorations = this.decorations.map(tr.changes)
      }
    },
  }),
  { decorations: (v) => v.decorations }
)

/** Focus decoration (border, from cursor position in comment range) */
const focusHighlightPlugin = ViewPlugin.define<PluginValue & { decorations: DecorationSet }>(
  () => ({
    decorations: Decoration.none,
    update(update) {
      const needsRebuild = update.selectionSet ||
        update.transactions.some(tr =>
          tr.effects.some(e => e.is(setCommentRangesEffect))
        )

      if (!needsRebuild) {
        this.decorations = this.decorations.map(update.changes)
        return
      }

      const ranges = update.state.field(commentRangesField)
      const cursorPos = update.state.selection.main.head

      let foundThreadId: string | null = null
      for (const r of ranges) {
        if (cursorPos >= r.from && cursorPos <= r.to) {
          foundThreadId = r.threadId
          break
        }
      }

      this.decorations = buildFocusDecoration(ranges, foundThreadId, update.state.doc.length)
    },
  }),
  { decorations: (v) => v.decorations }
)

// ── Theme ──────────────────────────────────────────────────────

const commentHighlightTheme = EditorView.baseTheme({
  '.cm-comment-highlight': {
    backgroundColor: 'rgba(243, 177, 17, 0.25)',
    borderBottom: '2px solid rgba(243, 177, 17, 0.5)',
    padding: '1px 0',
    cursor: 'pointer',
  },
  '.cm-comment-highlight-hover': {
    backgroundColor: 'rgba(243, 177, 17, 0.45)',
    borderBottom: '2px solid rgba(243, 177, 17, 0.8)',
  },
  '.cm-comment-highlight-focus': {
    backgroundColor: 'rgba(243, 177, 17, 0.45)',
    borderBottom: '2px solid rgba(200, 140, 0, 1)',
    outline: '1px solid rgba(200, 140, 0, 0.3)',
    borderRadius: '2px',
  },
})

// ── Export Extension ───────────────────────────────────────────

export const commentHighlights = () => [
  commentRangesField,
  highlightedThreadField,
  focusedThreadField,
  commentDecorationsPlugin,
  hoverHighlightPlugin,
  focusHighlightPlugin,
  commentHighlightTheme,
]
