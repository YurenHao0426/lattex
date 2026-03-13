// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { foldService } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

// ── Sectioning hierarchy ────────────────────────────────────────────

/** Lower number = higher level (folds more). */
const SECTION_LEVELS: Record<string, number> = {
  '\\part': 0,
  '\\chapter': 1,
  '\\section': 2,
  '\\subsection': 3,
  '\\subsubsection': 4,
  '\\paragraph': 5,
  '\\subparagraph': 6,
}

const SECTION_RE = /^[^%]*?(\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?)\s*(?:\[.*?\])?\s*\{/

// ── \begin / \end matching ──────────────────────────────────────────

const BEGIN_RE = /\\begin\{([^}]+)\}/
const END_RE = /\\end\{([^}]+)\}/

// ── \if... / \fi matching ───────────────────────────────────────────

const IF_RE = /\\if[a-zA-Z@]*/
const FI_RE = /\\fi(?:\b|$)/

// ── Comment section (% --- or %%) ───────────────────────────────────

const COMMENT_SECTION_RE = /^\s*(?:%\s*---|%%)/

// ── Helpers ─────────────────────────────────────────────────────────

/** Get the base command name (strip trailing *) for level lookup. */
function sectionLevel(cmd: string): number {
  const base = cmd.replace(/\*$/, '')
  return SECTION_LEVELS[base] ?? -1
}

/**
 * Find the position of the closing brace that matches an opening brace
 * at `openPos` in the document, respecting nesting.
 * Returns -1 if not found.
 */
function findMatchingBrace(state: EditorState, openPos: number): number {
  const doc = state.doc
  const len = doc.length
  let depth = 0
  for (let pos = openPos; pos < len; pos++) {
    const ch = doc.sliceString(pos, pos + 1)
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return pos
    }
  }
  return -1
}

// ── Fold: \begin{env} ... \end{env} ────────────────────────────────

function foldBeginEnd(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
  const lineText = state.doc.sliceString(lineStart, lineEnd)
  const m = BEGIN_RE.exec(lineText)
  if (!m) return null

  const envName = m[1]
  const doc = state.doc

  // Search forward for the matching \end{envName}, respecting nesting
  let depth = 1
  for (let i = state.doc.lineAt(lineStart).number + 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text

    // Count all \begin{envName} and \end{envName} on this line
    let searchPos = 0
    while (searchPos < text.length) {
      const beginIdx = text.indexOf(`\\begin{${envName}}`, searchPos)
      const endIdx = text.indexOf(`\\end{${envName}}`, searchPos)

      if (beginIdx === -1 && endIdx === -1) break

      if (beginIdx !== -1 && (endIdx === -1 || beginIdx < endIdx)) {
        depth++
        searchPos = beginIdx + 1
      } else if (endIdx !== -1) {
        depth--
        if (depth === 0) {
          // Fold from end of \begin line to start of \end line
          const foldFrom = lineEnd
          const foldTo = line.from
          if (foldTo > foldFrom) {
            return { from: foldFrom, to: foldTo }
          }
          return null
        }
        searchPos = endIdx + 1
      }
    }
  }
  return null
}

// ── Fold: sectioning commands ───────────────────────────────────────

function foldSection(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
  const lineText = state.doc.sliceString(lineStart, lineEnd)
  const m = SECTION_RE.exec(lineText)
  if (!m) return null

  const level = sectionLevel(m[1])
  if (level < 0) return null

  const doc = state.doc
  const startLineNum = doc.lineAt(lineStart).number

  // Scan forward: fold until we hit a heading at the same or higher (lower number) level, or end of doc
  for (let i = startLineNum + 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const sm = SECTION_RE.exec(line.text)
    if (sm) {
      const nextLevel = sectionLevel(sm[1])
      if (nextLevel >= 0 && nextLevel <= level) {
        // Fold from end of heading line to end of previous line
        const foldTo = line.from
        if (foldTo > lineEnd) {
          return { from: lineEnd, to: foldTo }
        }
        return null
      }
    }
  }

  // No same-or-higher heading found: fold to end of document
  const lastLine = doc.line(doc.lines)
  const foldTo = lastLine.to
  if (foldTo > lineEnd) {
    return { from: lineEnd, to: foldTo }
  }
  return null
}

// ── Fold: \if... \fi ────────────────────────────────────────────────

function foldIfFi(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
  const lineText = state.doc.sliceString(lineStart, lineEnd)
  if (!IF_RE.test(lineText)) return null
  // Make sure it's not a \fi on the same line only
  if (FI_RE.test(lineText) && !IF_RE.test(lineText.replace(FI_RE, ''))) return null

  const doc = state.doc
  const startLineNum = doc.lineAt(lineStart).number
  let depth = 1

  for (let i = startLineNum + 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text

    // Count nested \if... and \fi on each line
    // Process from left to right to handle multiple on one line
    const tokens: { pos: number; type: 'if' | 'fi' }[] = []

    let ifMatch: RegExpExecArray | null
    const ifRe = /\\if[a-zA-Z@]*/g
    while ((ifMatch = ifRe.exec(text)) !== null) {
      tokens.push({ pos: ifMatch.index, type: 'if' })
    }

    const fiRe = /\\fi(?:\b|$)/g
    let fiMatch: RegExpExecArray | null
    while ((fiMatch = fiRe.exec(text)) !== null) {
      tokens.push({ pos: fiMatch.index, type: 'fi' })
    }

    tokens.sort((a, b) => a.pos - b.pos)

    for (const tok of tokens) {
      if (tok.type === 'if') {
        depth++
      } else {
        depth--
        if (depth === 0) {
          const foldFrom = lineEnd
          const foldTo = line.from
          if (foldTo > foldFrom) {
            return { from: foldFrom, to: foldTo }
          }
          return null
        }
      }
    }
  }
  return null
}

// ── Fold: comment sections ──────────────────────────────────────────

function foldCommentSection(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
  const lineText = state.doc.sliceString(lineStart, lineEnd)
  if (!COMMENT_SECTION_RE.test(lineText)) return null

  const doc = state.doc
  const startLineNum = doc.lineAt(lineStart).number

  // Check that this is the first line of a comment block (previous line is not a comment)
  if (startLineNum > 1) {
    const prevLine = doc.line(startLineNum - 1)
    if (/^\s*%/.test(prevLine.text)) return null
  }

  // Find the last consecutive comment line
  let lastCommentLine = startLineNum
  for (let i = startLineNum + 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    if (/^\s*%/.test(line.text)) {
      lastCommentLine = i
    } else {
      break
    }
  }

  // Need at least 2 lines to fold
  if (lastCommentLine <= startLineNum) return null

  const endLine = doc.line(lastCommentLine)
  return { from: lineEnd, to: endLine.to }
}

// ── Fold: multi-line curly brace blocks ─────────────────────────────

function foldCurlyBraces(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
  const lineText = state.doc.sliceString(lineStart, lineEnd)

  // Don't fold \begin{} or \end{} lines here (handled by foldBeginEnd)
  if (BEGIN_RE.test(lineText) || END_RE.test(lineText)) return null
  // Don't fold section headings here (handled by foldSection)
  if (SECTION_RE.test(lineText)) return null

  // Find an opening brace on this line that isn't closed on the same line
  let depth = 0
  let lastOpenPos = -1

  for (let i = 0; i < lineText.length; i++) {
    const ch = lineText[i]
    if (ch === '{') {
      if (depth === 0) lastOpenPos = i
      depth++
    } else if (ch === '}') {
      depth--
    }
  }

  // If we have unclosed braces on this line, fold from end of line to the matching close brace
  if (depth > 0 && lastOpenPos >= 0) {
    // Find the absolute position of the first unclosed brace
    let unclosedDepth = 0
    let firstUnclosedPos = -1
    for (let i = 0; i < lineText.length; i++) {
      const ch = lineText[i]
      if (ch === '{') {
        unclosedDepth++
        if (firstUnclosedPos === -1) firstUnclosedPos = i
      } else if (ch === '}') {
        unclosedDepth--
        if (unclosedDepth === 0) firstUnclosedPos = -1
      }
    }

    if (firstUnclosedPos === -1) return null

    const absOpenPos = lineStart + firstUnclosedPos
    const closePos = findMatchingBrace(state, absOpenPos)
    if (closePos === -1) return null

    // Only fold if the closing brace is on a different line
    const closeLine = state.doc.lineAt(closePos)
    const openLine = state.doc.lineAt(absOpenPos)
    if (closeLine.number <= openLine.number) return null

    // Fold from after the opening brace to the closing brace position
    const foldFrom = lineEnd
    const foldTo = closeLine.from
    if (foldTo > foldFrom) {
      return { from: foldFrom, to: foldTo }
    }
  }

  return null
}

// ── Combined fold service ───────────────────────────────────────────

const latexFoldService = foldService.of((state, lineStart, lineEnd) => {
  // Try each folder in priority order
  return foldBeginEnd(state, lineStart, lineEnd)
    ?? foldSection(state, lineStart, lineEnd)
    ?? foldIfFi(state, lineStart, lineEnd)
    ?? foldCommentSection(state, lineStart, lineEnd)
    ?? foldCurlyBraces(state, lineStart, lineEnd)
    ?? null
})

// ── Export ───────────────────────────────────────────────────────────

export function latexFolding() {
  return [latexFoldService]
}
