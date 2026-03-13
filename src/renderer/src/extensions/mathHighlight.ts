// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

/**
 * CodeMirror 6 extension: background highlight for math regions.
 * Adds subtle background color to $...$ (inline) and $$...$$ / \[...\] (display) regions.
 */
import { ViewPlugin, Decoration, type DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

const inlineMathDeco = Decoration.mark({ class: 'cm-math-inline' })
const displayMathDeco = Decoration.mark({ class: 'cm-math-display' })

interface MathRegion {
  from: number
  to: number
  display: boolean
}

function findMathRegions(text: string): MathRegion[] {
  const regions: MathRegion[] = []
  let i = 0

  while (i < text.length) {
    // Skip escaped characters
    if (text[i] === '\\' && i + 1 < text.length) {
      // Check for \[ ... \] (display math)
      if (text[i + 1] === '[') {
        const start = i
        const closeIdx = text.indexOf('\\]', i + 2)
        if (closeIdx !== -1) {
          regions.push({ from: start, to: closeIdx + 2, display: true })
          i = closeIdx + 2
          continue
        }
      }
      // Check for \( ... \) (inline math)
      if (text[i + 1] === '(') {
        const start = i
        const closeIdx = text.indexOf('\\)', i + 2)
        if (closeIdx !== -1) {
          regions.push({ from: start, to: closeIdx + 2, display: false })
          i = closeIdx + 2
          continue
        }
      }
      // Skip other escape sequences
      i += 2
      continue
    }

    // Check for $$ (display math)
    if (text[i] === '$' && i + 1 < text.length && text[i + 1] === '$') {
      const start = i
      // Find closing $$
      let j = i + 2
      while (j < text.length - 1) {
        if (text[j] === '$' && text[j + 1] === '$' && text[j - 1] !== '\\') {
          regions.push({ from: start, to: j + 2, display: true })
          i = j + 2
          break
        }
        j++
      }
      if (j >= text.length - 1) {
        i = j + 1
      }
      continue
    }

    // Check for $ (inline math)
    if (text[i] === '$') {
      // Don't match if preceded by backslash
      if (i > 0 && text[i - 1] === '\\') {
        i++
        continue
      }
      const start = i
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '$' && text[j - 1] !== '\\') {
          // Make sure it's not $$
          if (j + 1 < text.length && text[j + 1] === '$') {
            j++
            continue
          }
          regions.push({ from: start, to: j + 1, display: false })
          i = j + 1
          break
        }
        // Inline math doesn't span paragraphs
        if (text[j] === '\n' && j + 1 < text.length && text[j + 1] === '\n') {
          i = j
          break
        }
        j++
      }
      if (j >= text.length) {
        i = j
      }
      continue
    }

    i++
  }

  return regions
}

function buildDecorations(view: EditorView): DecorationSet {
  const { from, to } = view.viewport
  // Extend a bit beyond viewport for smooth scrolling
  const extFrom = Math.max(0, from - 1000)
  const extTo = Math.min(view.state.doc.length, to + 1000)
  const text = view.state.doc.sliceString(extFrom, extTo)
  const regions = findMathRegions(text)

  const builder = new RangeSetBuilder<Decoration>()
  for (const r of regions) {
    const absFrom = extFrom + r.from
    const absTo = extFrom + r.to
    // Only add decorations that are at least partially in the viewport
    if (absTo < from || absFrom > to) continue
    const clampFrom = Math.max(absFrom, 0)
    const clampTo = Math.min(absTo, view.state.doc.length)
    if (clampFrom < clampTo) {
      builder.add(clampFrom, clampTo, r.display ? displayMathDeco : inlineMathDeco)
    }
  }
  return builder.finish()
}

export const mathHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)
