// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { EditorView, keymap } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'

// ── Helpers ──────────────────────────────────────────────────────────

/** Pair definitions for surround/auto-close behavior */
const PAIRS: Record<string, string> = {
  '$': '$',
  '{': '}',
  '(': ')',
  '[': ']',
}

/**
 * Extract the environment name from a \begin{envname} that ends right
 * at or before `pos` on the same line.
 */
function getBeginEnvBefore(doc: string, pos: number): string | null {
  // Look backwards from pos to find the line
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const lineBefore = doc.slice(lineStart, pos)
  // Match \begin{envname} at the end (possibly with trailing whitespace)
  const m = lineBefore.match(/\\begin\{([^}]+)\}\s*$/)
  return m ? m[1] : null
}

// ── 1. Auto-close \begin{env} on Enter ──────────────────────────────

const beginEnvEnterKeymap = keymap.of([
  {
    key: 'Enter',
    run(view) {
      const { state } = view
      const { main } = state.selection

      // Only handle when there is no selection
      if (!main.empty) return false

      const pos = main.head
      const doc = state.doc.toString()
      const envName = getBeginEnvBefore(doc, pos)
      if (!envName) return false

      // Check that there is no existing \end{envName} on the next non-empty lines
      // that would indicate the environment is already closed nearby
      const afterCursor = doc.slice(pos)
      const closingTag = `\\end{${envName}}`

      // Look at the text right after cursor (same line remainder + next few lines)
      const nextChunk = afterCursor.slice(0, 200)
      const alreadyClosed = nextChunk.split('\n').some((line) => line.trim() === closingTag)
      if (alreadyClosed) return false

      // Determine the indentation of the \begin line
      const line = state.doc.lineAt(pos)
      const lineText = line.text
      const indentMatch = lineText.match(/^(\s*)/)
      const baseIndent = indentMatch ? indentMatch[1] : ''
      // Use two spaces (or tab) as inner indent — follow the existing indent style
      const innerIndent = baseIndent + '  '

      // Insert: \n<innerIndent>\n<baseIndent>\end{envName}
      const insert = `\n${innerIndent}\n${baseIndent}${closingTag}`
      const cursorPos = pos + 1 + innerIndent.length // after \n + innerIndent

      view.dispatch(
        state.update({
          changes: { from: pos, insert },
          selection: EditorSelection.cursor(cursorPos),
          scrollIntoView: true,
          userEvent: 'input',
        })
      )
      return true
    },
  },
])

// ── 2 & 3. Auto-close $ and surround selection ─────────────────────

/**
 * inputHandler for LaTeX-specific auto-close and surround.
 *
 * Handles:
 *  - `$`: auto-insert matching `$`, or surround selection with `$...$`
 *  - `{`, `(`, `[`: surround selection (auto-close for `{` is already
 *    handled by CM6's closeBrackets, so we only add surround behavior)
 *
 * Smart behavior:
 *  - Don't double-close if the character after cursor is already the
 *    closing counterpart.
 *  - For `$`, skip over a closing `$` instead of inserting a new one.
 */
const latexInputHandler = EditorView.inputHandler.of(
  (view, from, to, inserted) => {
    // We only care about single-character inserts that are in our pair map
    if (inserted.length !== 1) return false
    const close = PAIRS[inserted]
    if (!close) return false

    const { state } = view
    const doc = state.doc

    // ── Surround selection ──
    // If there is a selection (from !== to), wrap it
    if (from !== to) {
      // For all pair chars, wrap selection
      const selectedText = doc.sliceString(from, to)
      const wrapped = inserted + selectedText + close
      view.dispatch(
        state.update({
          changes: { from, to, insert: wrapped },
          // Place cursor after the closing char so the selection is visible
          selection: EditorSelection.range(from + 1, from + 1 + selectedText.length),
          userEvent: 'input',
        })
      )
      return true
    }

    // ── No selection: auto-close / skip logic ──

    const pos = from
    const charAfter = pos < doc.length ? doc.sliceString(pos, pos + 1) : ''

    // For `{`, `(`, `[`: CM6 closeBrackets handles these already.
    // We only handle surround (above). So skip auto-close for non-$ chars.
    if (inserted !== '$') return false

    // ── Dollar sign handling ──

    // If the next character is already `$`, skip over it (don't double)
    if (charAfter === '$') {
      // But only if it looks like we are at the end of an inline math:
      // count `$` before cursor; if odd, we're closing
      const textBefore = doc.sliceString(Math.max(0, pos - 200), pos)
      const dollarsBefore = (textBefore.match(/\$/g) || []).length
      if (dollarsBefore % 2 === 1) {
        // Odd number of $ before → this is a closing $, skip over it
        view.dispatch(
          state.update({
            selection: EditorSelection.cursor(pos + 1),
            scrollIntoView: true,
            userEvent: 'input',
          })
        )
        return true
      }
    }

    // Don't auto-close if the character before is a backslash (e.g. \$)
    if (pos > 0) {
      const charBefore = doc.sliceString(pos - 1, pos)
      if (charBefore === '\\') return false
    }

    // Don't auto-close if next char is already $ (and we didn't skip above,
    // meaning even count → we'd be starting a new pair, but $ is right there)
    if (charAfter === '$') return false

    // Don't auto-close if we're inside a word (letter/digit right before or after)
    if (charAfter && /[a-zA-Z0-9]/.test(charAfter)) return false

    // Insert $$ and place cursor in between
    view.dispatch(
      state.update({
        changes: { from: pos, insert: '$$' },
        selection: EditorSelection.cursor(pos + 1),
        scrollIntoView: true,
        userEvent: 'input',
      })
    )
    return true
  }
)

// ── Backspace: delete matching pair ─────────────────────────────────

const deletePairKeymap = keymap.of([
  {
    key: 'Backspace',
    run(view) {
      const { state } = view
      const { main } = state.selection
      if (!main.empty) return false

      const pos = main.head
      if (pos === 0 || pos >= state.doc.length) return false

      const before = state.doc.sliceString(pos - 1, pos)
      const after = state.doc.sliceString(pos, pos + 1)

      // Check if we're between a matching pair we inserted
      if (before === '$' && after === '$') {
        // Delete both
        view.dispatch(
          state.update({
            changes: { from: pos - 1, to: pos + 1 },
            userEvent: 'delete',
          })
        )
        return true
      }

      return false
    },
  },
])

// ── Export ────────────────────────────────────────────────────────────

/**
 * LaTeX-specific closing/surround extension for CodeMirror 6.
 *
 * Provides:
 * - Auto-close `\begin{env}` with `\end{env}` on Enter
 * - Auto-close `$...$` (smart, no double-close)
 * - Surround selection with `$`, `{`, `(`, `[`
 * - Backspace deletes matching `$` pair
 */
export function latexClosing() {
  return [
    beginEnvEnterKeymap,
    latexInputHandler,
    deletePairKeymap,
  ]
}
