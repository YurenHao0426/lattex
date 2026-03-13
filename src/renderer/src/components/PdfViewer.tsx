// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useEffect, useRef, useState, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { useAppStore } from '../stores/appStore'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

// ── Log parsing (Overleaf-style) ──────────────────────────────────

interface LogEntry {
  level: 'error' | 'warning' | 'info'
  message: string
  file?: string
  line?: number
}

function parseCompileLog(raw: string): LogEntry[] {
  const entries: LogEntry[] = []
  const lines = raw.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]

    // LaTeX Error: ...
    if (/^!/.test(ln) || /LaTeX Error:/.test(ln)) {
      let msg = ln.replace(/^!\s*/, '')
      // Collect continuation lines
      while (i + 1 < lines.length && lines[i + 1] && !lines[i + 1].startsWith('l.') && !lines[i + 1].startsWith('!')) {
        i++
        if (lines[i].trim()) msg += ' ' + lines[i].trim()
      }
      // Try to get line number from "l.123" line
      let lineNum: number | undefined
      if (i + 1 < lines.length && /^l\.(\d+)/.test(lines[i + 1])) {
        i++
        lineNum = parseInt(lines[i].match(/^l\.(\d+)/)![1])
      }
      entries.push({ level: 'error', message: msg.trim(), line: lineNum })
      continue
    }

    // file:line: error pattern (file-line-error mode)
    const fileLineErr = ln.match(/^\.\/(.+?):(\d+):\s*(.+)/)
    if (fileLineErr) {
      const msg = fileLineErr[3]
      const isWarning = /warning/i.test(msg)
      entries.push({
        level: isWarning ? 'warning' : 'error',
        message: msg,
        file: fileLineErr[1],
        line: parseInt(fileLineErr[2])
      })
      continue
    }

    // Package ... Warning:
    const pkgWarn = ln.match(/Package (\S+) Warning:\s*(.*)/)
    if (pkgWarn) {
      let msg = `[${pkgWarn[1]}] ${pkgWarn[2]}`
      let warnLine: number | undefined
      // Collect continuation lines starting with (pkgname)
      while (i + 1 < lines.length && /^\(/.test(lines[i + 1])) {
        i++
        const contLine = lines[i]
        msg += ' ' + contLine.replace(/^\([^)]*\)\s*/, '').trim()
        const lineMatch = contLine.match(/on input line (\d+)/)
        if (lineMatch) warnLine = parseInt(lineMatch[1])
      }
      // Also check the initial line for "on input line N"
      if (!warnLine) {
        const lineMatch = msg.match(/on input line (\d+)/)
        if (lineMatch) warnLine = parseInt(lineMatch[1])
      }
      entries.push({ level: 'warning', message: msg.trim(), line: warnLine })
      continue
    }

    // LaTeX Warning:
    const latexWarn = ln.match(/LaTeX Warning:\s*(.*)/)
    if (latexWarn) {
      let msg = latexWarn[1]
      while (i + 1 < lines.length && lines[i + 1] && !lines[i + 1].match(/^[(!.]/) && lines[i + 1].startsWith(' ')) {
        i++
        msg += ' ' + lines[i].trim()
      }
      const lineMatch = msg.match(/on input line (\d+)/)
      entries.push({ level: 'warning', message: msg.trim(), line: lineMatch ? parseInt(lineMatch[1]) : undefined })
      continue
    }

    // Overfull / Underfull
    const overunder = ln.match(/^(Overfull|Underfull) .* at lines (\d+)--(\d+)/)
    if (overunder) {
      entries.push({ level: 'warning', message: ln.trim(), line: parseInt(overunder[2]) })
      continue
    }
    if (/^(Overfull|Underfull)/.test(ln)) {
      const paraMatch = ln.match(/in paragraph at lines (\d+)--(\d+)/)
      entries.push({ level: 'warning', message: ln.trim(), line: paraMatch ? parseInt(paraMatch[1]) : undefined })
      continue
    }

    // Missing file
    if (/File .* not found/.test(ln)) {
      entries.push({ level: 'error', message: ln.trim() })
      continue
    }
  }

  // Deduplicate
  const seen = new Set<string>()
  return entries.filter((e) => {
    const key = `${e.level}:${e.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── Component ─────────────────────────────────────────────────────

type LogFilter = 'all' | 'error' | 'warning'

export default function PdfViewer() {
  const { pdfPath, compileLog, compiling } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1.0)
  const [numPages, setNumPages] = useState(0)
  const [tab, setTab] = useState<'pdf' | 'log'>('pdf')
  const [logFilter, setLogFilter] = useState<LogFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const prevCompilingRef = useRef(false)
  const renderingRef = useRef(false)

  // Parse and sort log entries (errors first, then warnings)
  const logEntries = compileLog ? parseCompileLog(compileLog) : []
  const levelOrder = { error: 0, warning: 1, info: 2 }
  logEntries.sort((a, b) => levelOrder[a.level] - levelOrder[b.level])

  const errorCount = logEntries.filter((e) => e.level === 'error').length
  const warningCount = logEntries.filter((e) => e.level === 'warning').length

  const filteredEntries = logFilter === 'all'
    ? logEntries
    : logEntries.filter((e) => e.level === logFilter)

  // Navigate to file:line in editor
  const handleEntryClick = (entry: LogEntry) => {
    if (!entry.line) return
    const store = useAppStore.getState()

    // If no file specified, try to use the main document's path
    const entryFile = entry.file || null
    if (!entryFile) return

    // In socket mode, files are keyed by relative path in fileContents
    // Try to find a matching open file
    const candidates = [entryFile]
    // Also try without leading ./ or path prefix
    if (entryFile.startsWith('./')) candidates.push(entryFile.slice(2))

    for (const path of candidates) {
      if (store.fileContents[path]) {
        store.openFile(path, path.split('/').pop() || path)
        store.setPendingGoTo({ file: path, line: entry.line! })
        return
      }
    }
  }

  // Auto-switch tab after compilation finishes
  useEffect(() => {
    if (prevCompilingRef.current && !compiling) {
      if (pdfPath) {
        setTab('pdf')
      } else if (compileLog) {
        setTab('log')
      }
    }
    prevCompilingRef.current = compiling
  }, [compiling, pdfPath, compileLog])

  // Store page viewports for synctex coordinate conversion
  const pageViewportsRef = useRef<Map<number, { width: number; height: number }>>(new Map())

  // SyncTeX: double-click PDF → jump to source
  const handlePdfDoubleClick = useCallback(async (e: MouseEvent) => {
    if (!pdfPath) return
    const canvas = (e.target as HTMLElement).closest('canvas.pdf-page') as HTMLCanvasElement | null
    if (!canvas) return

    const container = containerRef.current
    if (!container) return

    // Determine which page was clicked
    const canvases = Array.from(container.querySelectorAll('canvas.pdf-page'))
    const pageIndex = canvases.indexOf(canvas)
    if (pageIndex < 0) return
    const pageNum = pageIndex + 1

    // Get click position relative to canvas (in CSS pixels)
    const rect = canvas.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top

    // Convert to PDF points (72 DPI coordinate system, origin bottom-left)
    const vpInfo = pageViewportsRef.current.get(pageNum)
    if (!vpInfo) return
    const pdfX = (clickX / rect.width) * vpInfo.width
    const pdfY = vpInfo.height - (clickY / rect.height) * vpInfo.height

    const result = await window.api.synctexEdit(pdfPath, pageNum, pdfX, pdfY)
    if (!result) return

    // Navigate to the source file:line
    try {
      const content = await window.api.readFile(result.file)
      useAppStore.getState().setFileContent(result.file, content)
      useAppStore.getState().openFile(result.file, result.file.split('/').pop() || result.file)
      useAppStore.getState().setPendingGoTo({ file: result.file, line: result.line })
    } catch { /* file not found */ }
  }, [pdfPath])

  // Render PDF (with lock to prevent double-render)
  const renderPdf = useCallback(async () => {
    if (!pdfPath || !containerRef.current || tab !== 'pdf') return
    if (renderingRef.current) return
    renderingRef.current = true

    setError(null)
    try {
      const arrayBuffer = await window.api.readBinary(pdfPath)
      const data = new Uint8Array(arrayBuffer)
      const pdf = await pdfjsLib.getDocument({ data }).promise
      setNumPages(pdf.numPages)

      const container = containerRef.current
      if (!container) { renderingRef.current = false; return }
      container.innerHTML = ''
      pageViewportsRef.current.clear()

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const viewport = page.getViewport({ scale })

        const baseViewport = page.getViewport({ scale: 1 })
        pageViewportsRef.current.set(i, { width: baseViewport.width, height: baseViewport.height })

        const canvas = document.createElement('canvas')
        canvas.className = 'pdf-page'
        const context = canvas.getContext('2d')!
        canvas.width = viewport.width * window.devicePixelRatio
        canvas.height = viewport.height * window.devicePixelRatio
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        context.scale(window.devicePixelRatio, window.devicePixelRatio)
        container.appendChild(canvas)
        await page.render({ canvasContext: context, viewport }).promise
      }
    } catch (err) {
      setError(`Failed to load PDF: ${err}`)
    } finally {
      renderingRef.current = false
    }
  }, [pdfPath, scale, tab])

  // Scroll wheel zoom on PDF container
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      // Proportional delta clamped — smooth for trackpad pinch, reasonable for mouse wheel
      const delta = Math.max(-0.2, Math.min(0.2, -e.deltaY * 0.005))
      setScale((s) => Math.min(3, Math.max(0.25, +(s + delta).toFixed(2))))
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [])

  // Attach double-click listener to PDF container
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('dblclick', handlePdfDoubleClick)
    return () => container.removeEventListener('dblclick', handlePdfDoubleClick)
  }, [handlePdfDoubleClick])

  useEffect(() => {
    renderPdf()
  }, [renderPdf])

  // Empty state
  if (!pdfPath && !compileLog) {
    return (
      <div className="pdf-empty">
        <div className="pdf-empty-content">
          <p>No PDF to display</p>
          <p className="shortcut-hint">Compile a .tex file with Cmd+B</p>
        </div>
      </div>
    )
  }

  return (
    <div className="pdf-panel">
      <div className="pdf-toolbar">
        <button
          className={`pdf-tab ${tab === 'pdf' ? 'active' : ''}`}
          onClick={() => setTab('pdf')}
        >
          PDF {numPages > 0 && `(${numPages}p)`}
        </button>
        <button
          className={`pdf-tab ${tab === 'log' ? 'active' : ''}`}
          onClick={() => setTab('log')}
        >
          Log
          {errorCount > 0 && <span className="log-badge log-badge-error">{errorCount}</span>}
          {warningCount > 0 && <span className="log-badge log-badge-warning">{warningCount}</span>}
        </button>
        <div className="pdf-toolbar-spacer" />
        {tab === 'pdf' && (
          <>
            <button className="toolbar-btn" onClick={() => setScale((s) => Math.max(0.25, s - 0.25))}>-</button>
            <span className="pdf-scale">{Math.round(scale * 100)}%</span>
            <button className="toolbar-btn" onClick={() => setScale((s) => Math.min(3, s + 0.25))}>+</button>
            <button className="toolbar-btn" onClick={() => setScale(1.0)}>Fit</button>
          </>
        )}
        {tab === 'log' && (
          <div className="log-filters">
            <button className={`log-filter-btn ${logFilter === 'all' ? 'active' : ''}`} onClick={() => setLogFilter('all')}>
              All ({logEntries.length})
            </button>
            <button className={`log-filter-btn ${logFilter === 'error' ? 'active' : ''}`} onClick={() => setLogFilter('error')}>
              Errors ({errorCount})
            </button>
            <button className={`log-filter-btn ${logFilter === 'warning' ? 'active' : ''}`} onClick={() => setLogFilter('warning')}>
              Warnings ({warningCount})
            </button>
          </div>
        )}
      </div>

      {/* PDF view — always mounted, hidden when log is shown */}
      <div className="pdf-container" ref={containerRef} style={{ display: tab === 'pdf' ? undefined : 'none' }}>
        {error && <div className="pdf-error">{error}</div>}
      </div>

      {/* Log view */}
      {tab === 'log' && (
        <div className="compile-log">
          {filteredEntries.length > 0 ? (
            <div className="log-entries">
              {filteredEntries.map((entry, i) => (
                <div
                  key={i}
                  className={`log-entry log-entry-${entry.level} ${entry.line ? 'log-entry-clickable' : ''}`}
                  onClick={() => handleEntryClick(entry)}
                >
                  <div className="log-entry-header">
                    <span className={`log-level-badge level-${entry.level}`}>
                      {entry.level === 'error' ? 'Error' : entry.level === 'warning' ? 'Warning' : 'Info'}
                    </span>
                    {entry.file && (
                      <span className="log-entry-file">
                        {entry.file}{entry.line ? `:${entry.line}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="log-entry-message">{entry.message}</div>
                </div>
              ))}
            </div>
          ) : compileLog ? (
            <div className="log-entries">
              <div className="log-entry log-entry-info">
                <div className="log-entry-header">
                  <span className="log-level-badge level-info">Info</span>
                </div>
                <div className="log-entry-message">No errors or warnings found.</div>
              </div>
            </div>
          ) : (
            <div className="log-empty">No compile log yet.</div>
          )}
          {/* Raw log toggle */}
          <details className="log-raw">
            <summary>Raw log output</summary>
            <pre>{compileLog}</pre>
          </details>
        </div>
      )}
    </div>
  )
}
