// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

/**
 * CodeMirror 6 extension: hover preview for LaTeX math expressions.
 * Shows a rendered preview tooltip when hovering over $...$ or $$...$$ or \(...\) or \[...\].
 */
import { hoverTooltip, type Tooltip } from '@codemirror/view'

/** Find the math expression surrounding the given position */
function findMathAt(docText: string, pos: number): { from: number; to: number; tex: string; display: boolean } | null {
  // Search for display math first ($$...$$, \[...\])
  // Then inline math ($...$, \(...\))
  const patterns: Array<{ open: string; close: string; display: boolean }> = [
    { open: '$$', close: '$$', display: true },
    { open: '\\[', close: '\\]', display: true },
    { open: '$', close: '$', display: false },
    { open: '\\(', close: '\\)', display: false },
  ]

  for (const { open, close, display } of patterns) {
    // Search backward for opener
    const searchStart = Math.max(0, pos - 2000)
    const before = docText.slice(searchStart, pos + open.length)

    let openIdx = -1
    let searchFrom = before.length - 1
    while (searchFrom >= 0) {
      const idx = before.lastIndexOf(open, searchFrom)
      if (idx === -1) break
      // For $$, skip if it's actually a single $ at boundary
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

    // Search forward for closer
    const afterStart = openIdx + open.length
    const closeIdx = docText.indexOf(close, Math.max(afterStart, pos - close.length + 1))
    if (closeIdx === -1 || closeIdx < pos - close.length) continue

    const contentStart = openIdx + open.length
    const contentEnd = closeIdx
    if (contentEnd <= contentStart) continue

    // Check pos is within the math region
    if (pos < openIdx || pos > closeIdx + close.length) continue

    const tex = docText.slice(contentStart, contentEnd).trim()
    if (!tex) continue

    return { from: openIdx, to: closeIdx + close.length, tex, display }
  }

  return null
}

/** Render LaTeX to HTML using KaTeX-like approach via CSS */
function renderMathToHtml(tex: string, display: boolean): string {
  // Use a simple approach: create an img tag with a data URI from a math rendering service
  // Or use the browser's MathML support
  // For simplicity, we'll render using MathML basic support + fallback to raw TeX

  // Try MathML rendering for common patterns, fallback to formatted TeX display
  const escaped = tex
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const fontSize = display ? '1.2em' : '1em'
  return `<div style="font-size: ${fontSize}; font-family: 'Times New Roman', serif; padding: 8px 12px; max-width: 400px; overflow-x: auto; white-space: pre-wrap; line-height: 1.6; color: #3B3228;">
    <math xmlns="http://www.w3.org/1998/Math/MathML" ${display ? 'display="block"' : ''}>
      <mrow><mtext>${escaped}</mtext></mrow>
    </math>
    <div style="margin-top: 4px; font-family: 'SF Mono', monospace; font-size: 11px; color: #A09880; border-top: 1px solid #E8DFC0; padding-top: 4px;">${display ? '$$' : '$'}${escaped}${display ? '$$' : '$'}</div>
  </div>`
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
        dom.innerHTML = renderMathToHtml(result.tex, result.display)
        return { dom }
      }
    }
  }, { hoverTime: 300 })
}
