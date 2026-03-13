// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  type Completion,
  snippetCompletion,
} from '@codemirror/autocomplete'
import { latexCommands } from '../data/latexCommands'
import { latexEnvironments } from '../data/latexEnvironments'
import { useAppStore } from '../stores/appStore'

// ── Helpers ──────────────────────────────────────────────────────────

/** Check if cursor is inside a \begin{...} or \end{...} brace */
function getEnvironmentContext(context: CompletionContext): { from: number; typed: string } | null {
  const line = context.state.doc.lineAt(context.pos)
  const textBefore = line.text.slice(0, context.pos - line.from)
  const match = textBefore.match(/\\(?:begin|end)\{([^}]*)$/)
  if (match) {
    return { from: context.pos - match[1].length, typed: match[1] }
  }
  return null
}

/** Check if cursor is inside a \ref-like{...} brace */
function getRefContext(context: CompletionContext): { from: number; typed: string } | null {
  const line = context.state.doc.lineAt(context.pos)
  const textBefore = line.text.slice(0, context.pos - line.from)
  const match = textBefore.match(/\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref)\{([^}]*)$/)
  if (match) {
    return { from: context.pos - match[1].length, typed: match[1] }
  }
  return null
}

/** Check if cursor is inside a \cite-like{...} brace (supports multiple keys: \cite{a,b,...}) */
function getCiteContext(context: CompletionContext): { from: number; typed: string } | null {
  const line = context.state.doc.lineAt(context.pos)
  const textBefore = line.text.slice(0, context.pos - line.from)
  // Match \cite{key1,key2,partial or \cite[note]{partial or \citep{partial etc.
  const match = textBefore.match(/\\(?:cite|citep|citet|citealt|citealp|citeauthor|citeyear|Cite|parencite|textcite|autocite|fullcite|footcite|nocite)(?:\[[^\]]*\])?\{([^}]*)$/)
  if (match) {
    const inside = match[1]
    // Find the last comma to support multi-key citations
    const lastComma = inside.lastIndexOf(',')
    const typed = lastComma >= 0 ? inside.slice(lastComma + 1).trimStart() : inside
    const from = lastComma >= 0
      ? context.pos - inside.length + lastComma + 1 + (inside.slice(lastComma + 1).length - inside.slice(lastComma + 1).trimStart().length)
      : context.pos - inside.length
    return { from, typed }
  }
  return null
}

/** Check if cursor is inside a file-include command brace */
function getFileContext(context: CompletionContext): { from: number; typed: string; isGraphics: boolean } | null {
  const line = context.state.doc.lineAt(context.pos)
  const textBefore = line.text.slice(0, context.pos - line.from)
  const match = textBefore.match(/\\(input|include|includegraphics|subfile|subfileinclude)(?:\[[^\]]*\])?\{([^}]*)$/)
  if (match) {
    const isGraphics = match[1] === 'includegraphics'
    return { from: context.pos - match[2].length, typed: match[2], isGraphics }
  }
  return null
}

// ── Scan documents for labels ────────────────────────────────────────

function scanLabels(): string[] {
  const { fileContents } = useAppStore.getState()
  const labels = new Set<string>()
  const labelRegex = /\\label\{([^}]+)\}/g
  for (const content of Object.values(fileContents)) {
    let m: RegExpExecArray | null
    while ((m = labelRegex.exec(content)) !== null) {
      labels.add(m[1])
    }
  }
  return Array.from(labels)
}

// ── Scan .bib files for citation keys ────────────────────────────────

function scanCitations(): { key: string; type: string; title?: string }[] {
  const { fileContents } = useAppStore.getState()
  const entries: { key: string; type: string; title?: string }[] = []
  const seen = new Set<string>()
  for (const [path, content] of Object.entries(fileContents)) {
    if (!path.endsWith('.bib')) continue
    // Match @type{key, patterns
    const entryRegex = /@(\w+)\s*\{([^,\s]+)/g
    let m: RegExpExecArray | null
    while ((m = entryRegex.exec(content)) !== null) {
      const type = m[1].toLowerCase()
      if (type === 'string' || type === 'comment' || type === 'preamble') continue
      const key = m[2].trim()
      if (!seen.has(key)) {
        seen.add(key)
        // Try to extract title
        const afterKey = content.slice(m.index)
        const titleMatch = afterKey.match(/title\s*=\s*[{"]([^}"]+)/i)
        entries.push({ key, type, title: titleMatch?.[1] })
      }
    }
  }
  return entries
}

// ── Get file paths from project tree ─────────────────────────────────

function getFilePaths(isGraphics: boolean): string[] {
  const { files } = useAppStore.getState()
  const paths: string[] = []

  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.gif', '.bmp', '.tiff'])
  const texExts = new Set(['.tex', '.sty', '.cls', '.bib', '.bbl'])

  function walk(nodes: typeof files, prefix: string) {
    for (const node of nodes) {
      if (node.isDir) {
        if (node.children) walk(node.children, prefix ? prefix + '/' + node.name : node.name)
      } else {
        const fullPath = prefix ? prefix + '/' + node.name : node.name
        if (isGraphics) {
          const ext = '.' + node.name.split('.').pop()?.toLowerCase()
          if (imageExts.has(ext)) {
            // For graphics, also offer path without extension
            paths.push(fullPath)
            const noExt = fullPath.replace(/\.[^.]+$/, '')
            if (noExt !== fullPath) paths.push(noExt)
          }
        } else {
          const ext = '.' + node.name.split('.').pop()?.toLowerCase()
          if (texExts.has(ext)) {
            paths.push(fullPath)
            // Also offer without .tex extension (common for \input)
            if (ext === '.tex') {
              paths.push(fullPath.replace(/\.tex$/, ''))
            }
          }
        }
      }
    }
  }
  walk(files, '')
  return paths
}

// ── Completion Sources ───────────────────────────────────────────────

/** Source 1: LaTeX commands — triggered by \ */
function commandSource(context: CompletionContext): CompletionResult | null {
  // Don't complete inside \begin{} or \end{} braces
  const envCtx = getEnvironmentContext(context)
  if (envCtx) return null

  // Don't complete inside \ref{}, \cite{}, etc.
  const refCtx = getRefContext(context)
  if (refCtx) return null
  const citeCtx = getCiteContext(context)
  if (citeCtx) return null
  const fileCtx = getFileContext(context)
  if (fileCtx) return null

  // Match \word at cursor
  const word = context.matchBefore(/\\[a-zA-Z*]*/)
  if (!word) return null
  // Need at least \ + 1 char, or explicit activation
  if (word.text.length < 2 && !context.explicit) return null

  const options: Completion[] = latexCommands.map((cmd) => {
    if (cmd.snippet) {
      return snippetCompletion(cmd.snippet, {
        label: cmd.label,
        detail: cmd.detail,
        type: 'function',
        boost: cmd.section === 'structure' || cmd.section === 'sectioning' ? 2 : 0,
      })
    }
    return {
      label: cmd.label,
      detail: cmd.detail,
      type: 'function',
    }
  })

  return {
    from: word.from,
    options,
    validFor: /^\\[a-zA-Z*]*$/,
  }
}

/** Source 2: Environment names inside \begin{} and \end{} */
function environmentSource(context: CompletionContext): CompletionResult | null {
  const envCtx = getEnvironmentContext(context)
  if (!envCtx) return null

  // For \end{}, try to match the most recent unclosed \begin{}
  const line = context.state.doc.lineAt(context.pos)
  const textBefore = line.text.slice(0, context.pos - line.from)
  const isEnd = /\\end\{[^}]*$/.test(textBefore)

  const options: Completion[] = []

  if (isEnd) {
    // Find the most recent unclosed \begin{} and suggest it first
    const docText = context.state.doc.sliceString(0, context.pos)
    const opens: string[] = []
    const beginRe = /\\begin\{([^}]+)\}/g
    const endRe = /\\end\{([^}]+)\}/g
    let m: RegExpExecArray | null
    while ((m = beginRe.exec(docText)) !== null) opens.push(m[1])
    while ((m = endRe.exec(docText)) !== null) {
      const idx = opens.lastIndexOf(m[1])
      if (idx >= 0) opens.splice(idx, 1)
    }
    if (opens.length > 0) {
      const last = opens[opens.length - 1]
      options.push({ label: last, detail: 'Close environment', type: 'keyword', boost: 100 })
    }
  }

  // Also add all known environments
  for (const env of latexEnvironments) {
    // For \begin{}, use snippet with body
    if (!isEnd && env.body) {
      // We can't use snippetCompletion here since we're only completing the name
      // The body will be handled by the \begin snippet in commands
      options.push({
        label: env.name,
        detail: env.detail,
        type: 'type',
      })
    } else {
      options.push({
        label: env.name,
        detail: env.detail,
        type: 'type',
      })
    }
  }

  // Also scan the document for custom environments (defined with \newenvironment or \newtheorem)
  const docText = context.state.doc.toString()
  const customEnvRe = /\\(?:newenvironment|newtheorem)\{([^}]+)\}/g
  let m: RegExpExecArray | null
  const seen = new Set(latexEnvironments.map((e) => e.name))
  while ((m = customEnvRe.exec(docText)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      options.push({ label: m[1], detail: 'Custom', type: 'type' })
    }
  }

  // Also scan all open files for custom environments
  const { fileContents } = useAppStore.getState()
  for (const content of Object.values(fileContents)) {
    const re = /\\(?:newenvironment|newtheorem)\{([^}]+)\}/g
    while ((m = re.exec(content)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1])
        options.push({ label: m[1], detail: 'Custom', type: 'type' })
      }
    }
  }

  return {
    from: envCtx.from,
    options,
    validFor: /^[a-zA-Z*]*$/,
  }
}

/** Source 3: Label references inside \ref{}, \eqref{}, etc. */
function labelSource(context: CompletionContext): CompletionResult | null {
  const refCtx = getRefContext(context)
  if (!refCtx) return null

  const labels = scanLabels()
  const options: Completion[] = labels.map((label) => ({
    label,
    type: 'variable',
    detail: 'label',
  }))

  return {
    from: refCtx.from,
    options,
    validFor: /^[a-zA-Z0-9_:.-]*$/,
  }
}

/** Source 4: Citation keys inside \cite{}, \citep{}, etc. */
function citationSource(context: CompletionContext): CompletionResult | null {
  const citeCtx = getCiteContext(context)
  if (!citeCtx) return null

  const entries = scanCitations()
  const options: Completion[] = entries.map((entry) => ({
    label: entry.key,
    detail: `@${entry.type}`,
    info: entry.title,
    type: 'text',
  }))

  return {
    from: citeCtx.from,
    options,
    validFor: /^[a-zA-Z0-9_:.-]*$/,
  }
}

/** Source 5: File paths inside \input{}, \include{}, \includegraphics{} */
function filePathSource(context: CompletionContext): CompletionResult | null {
  const fileCtx = getFileContext(context)
  if (!fileCtx) return null

  const paths = getFilePaths(fileCtx.isGraphics)
  const options: Completion[] = paths.map((p) => ({
    label: p,
    type: 'text',
    detail: fileCtx.isGraphics ? 'image' : 'file',
  }))

  return {
    from: fileCtx.from,
    options,
    validFor: /^[a-zA-Z0-9_/.-]*$/,
  }
}

// ── Export extension ─────────────────────────────────────────────────

export function latexAutocomplete() {
  return autocompletion({
    override: [
      environmentSource,
      labelSource,
      citationSource,
      filePathSource,
      commandSource,
    ],
    defaultKeymap: true,
    icons: true,
    optionClass: () => 'cm-latex-completion',
    activateOnTyping: true,
  })
}
