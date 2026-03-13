// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

/**
 * CodeMirror 6 extension: hover preview for LaTeX math expressions.
 * Uses KaTeX for beautiful rendered math when hovering over $...$ or $$...$$ or \(...\) or \[...\].
 */
import { hoverTooltip, type Tooltip } from '@codemirror/view'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/** Find the math expression surrounding the given position */
function findMathAt(docText: string, pos: number): { from: number; to: number; tex: string; display: boolean } | null {
  const patterns: Array<{ open: string; close: string; display: boolean }> = [
    { open: '$$', close: '$$', display: true },
    { open: '\\[', close: '\\]', display: true },
    { open: '$', close: '$', display: false },
    { open: '\\(', close: '\\)', display: false },
  ]

  for (const { open, close, display } of patterns) {
    const searchStart = Math.max(0, pos - 2000)
    const before = docText.slice(searchStart, pos + open.length)

    let openIdx = -1
    let searchFrom = before.length - 1
    while (searchFrom >= 0) {
      const idx = before.lastIndexOf(open, searchFrom)
      if (idx === -1) break
      if (open === '$$' && idx > 0 && docText[searchStart + idx - 1] === '$') {
        searchFrom = idx - 1
        continue
      }
      if (open === '$' && idx > 0 && docText[searchStart + idx - 1] === '$') {
        searchFrom = idx - 1
        continue
      }
      openIdx = searchStart + idx
      break
    }
    if (openIdx === -1 || openIdx > pos) continue

    const afterStart = openIdx + open.length
    const closeIdx = docText.indexOf(close, Math.max(afterStart, pos - close.length + 1))
    if (closeIdx === -1 || closeIdx < pos - close.length) continue

    const contentStart = openIdx + open.length
    const contentEnd = closeIdx
    if (contentEnd <= contentStart) continue

    if (pos < openIdx || pos > closeIdx + close.length) continue

    const tex = docText.slice(contentStart, contentEnd).trim()
    if (!tex) continue

    return { from: openIdx, to: closeIdx + close.length, tex, display }
  }

  return null
}

export function mathPreview() {
  return hoverTooltip((view, pos): Tooltip | null => {
    const docText = view.state.doc.toString()
    const result = findMathAt(docText, pos)
    if (!result) return null

    return {
      pos: result.from,
      end: result.to,
      above: true,
      create() {
        const dom = document.createElement('div')
        dom.className = 'cm-math-preview'
        try {
          const html = katex.renderToString(result.tex, {
            displayMode: result.display,
            throwOnError: false,
            errorColor: '#C75643',
            trust: true,
            strict: false,
            output: 'html',
          })
          dom.innerHTML = `<div style="padding: 10px 14px; max-width: 500px; overflow-x: auto;">${html}</div>`
        } catch {
          dom.innerHTML = `<div style="padding: 8px 12px; font-family: monospace; font-size: 12px; color: #C75643;">Error rendering: ${result.tex}</div>`
        }
        return { dom }
      }
    }
  }, { hoverTime: 300 })
}
