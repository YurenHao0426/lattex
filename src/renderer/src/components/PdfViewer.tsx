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
  const pendingPdfGoTo = useAppStore((s) => s.pendingPdfGoTo)
  const containerRef = useRef<HTMLDivElement>(null)  // scroll viewport
  const wrapperRef = useRef<HTMLDivElement>(null)    // inner wrapper (CSS transform target)
  const [scale, setScale] = useState(1.0)
  const [renderScale, setRenderScale] = useState(1.0)   // target scale for next render
  const [renderedScale, setRenderedScale] = useState(1.0) // scale at which canvases were actually rendered
  const renderScaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scaleRef = useRef(1.0)  // mutable ref for wheel handler
  const renderedScaleRef = useRef(1.0)
  const [numPages, setNumPages] = useState(0)
  const [tab, setTab] = useState<'pdf' | 'log'>('pdf')
  const [logFilter, setLogFilter] = useState<LogFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const prevCompilingRef = useRef(false)
  const renderingRef = useRef(false)

  // PDF text search state
  const [pdfSearchQuery, setPdfSearchQuery] = useState('')
  const [pdfSearchVisible, setPdfSearchVisible] = useState(false)
  const [pdfSearchResults, setPdfSearchResults] = useState<Array<{ page: number; index: number }>>([])
  const [pdfSearchCurrent, setPdfSearchCurrent] = useState(-1)
  const pdfTextCache = useRef<Map<number, string>>(new Map())
  const pdfSearchInputRef = useRef<HTMLInputElement>(null)
  const pdfDocRef = useRef<any>(null)

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
  const handleEntryClick = async (entry: LogEntry) => {
    if (!entry.line) return
    const store = useAppStore.getState()

    // If no file specified, fall back to the main document's relative path
    let entryFile = entry.file || null
    if (!entryFile) {
      const rootDocId = store.mainDocument || store.overleafProject?.rootDocId
      if (rootDocId) {
        entryFile = store.docPathMap[rootDocId] || null
      }
    }
    if (!entryFile) return

    // Build candidate paths (with and without leading ./)
    const candidates = [entryFile]
    if (entryFile.startsWith('./')) candidates.push(entryFile.slice(2))
    else candidates.push('./' + entryFile)

    // Try to find the file — either already open or needs to be joined
    for (const path of candidates) {
      // Already loaded in editor
      if (store.fileContents[path]) {
        store.openFile(path, path.split('/').pop() || path)
        store.setPendingGoTo({ file: path, line: entry.line! })
        return
      }

      // Not yet loaded — look up the docId and join it via socket
      const docId = store.pathDocMap[path]
      if (docId) {
        try {
          const result = await window.api.otJoinDoc(docId)
          if (result.success && result.content !== undefined) {
            useAppStore.getState().setFileContent(path, result.content)
            if (result.version !== undefined) {
              useAppStore.getState().setDocVersion(docId, result.version)
            }
            useAppStore.getState().openFile(path, path.split('/').pop() || path)
            useAppStore.getState().setPendingGoTo({ file: path, line: entry.line! })
          }
        } catch { /* failed to join doc */ }
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
    e.preventDefault()
    e.stopPropagation()
    if (!pdfPath) { console.log('[synctex-ui] no pdfPath'); return }
    const canvas = (e.target as HTMLElement).closest('canvas.pdf-page') as HTMLCanvasElement | null
    if (!canvas) { console.log('[synctex-ui] no canvas target, target was:', (e.target as HTMLElement).tagName, (e.target as HTMLElement).className); return }

    const wrapper = wrapperRef.current
    if (!wrapper) return

    // Determine which page was clicked
    const canvases = Array.from(wrapper.querySelectorAll('canvas.pdf-page'))
    const pageIndex = canvases.indexOf(canvas)
    if (pageIndex < 0) return
    const pageNum = pageIndex + 1

    // Get click position relative to canvas (in CSS pixels)
    const rect = canvas.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top

    // Convert to PDF points (72 DPI coordinate system, origin bottom-left)
    const vpInfo = pageViewportsRef.current.get(pageNum)
    if (!vpInfo) { console.log('[synctex-ui] no viewport info for page', pageNum); return }
    const pdfX = (clickX / rect.width) * vpInfo.width
    const pdfY = vpInfo.height - (clickY / rect.height) * vpInfo.height

    console.log(`[synctex-ui] dblclick page=${pageNum} pdfX=${pdfX.toFixed(1)} pdfY=${pdfY.toFixed(1)} path=${pdfPath}`)
    const result = await window.api.synctexEdit(pdfPath, pageNum, pdfX, pdfY)
    if (!result) { console.log('[synctex-ui] synctex returned null'); return }
    console.log(`[synctex-ui] result: file=${result.file} line=${result.line}`)

    // Navigate to source — synctex returns relative path (e.g. "latex/main.tex")
    const store = useAppStore.getState()
    const relPath = result.file

    // If already loaded in editor, just navigate
    if (store.fileContents[relPath]) {
      store.openFile(relPath, relPath.split('/').pop() || relPath)
      store.setPendingGoTo({ file: relPath, line: result.line })
      return
    }

    // Not loaded — join via socket
    const docId = store.pathDocMap[relPath]
    if (docId) {
      try {
        const joinResult = await window.api.otJoinDoc(docId)
        if (joinResult.success && joinResult.content !== undefined) {
          useAppStore.getState().setFileContent(relPath, joinResult.content)
          if (joinResult.version !== undefined) {
            useAppStore.getState().setDocVersion(docId, joinResult.version)
          }
          useAppStore.getState().openFile(relPath, relPath.split('/').pop() || relPath)
          useAppStore.getState().setPendingGoTo({ file: relPath, line: result.line })
        }
      } catch { /* failed to join doc */ }
    }
  }, [pdfPath])

  // Keep mutable refs in sync
  useEffect(() => { scaleRef.current = scale }, [scale])
  useEffect(() => { renderedScaleRef.current = renderedScale }, [renderedScale])

  // Render PDF canvases at renderScale (expensive — only on pdfPath change or debounced scale)
  const renderPdf = useCallback(async () => {
    if (!pdfPath || !containerRef.current || !wrapperRef.current || tab !== 'pdf') return
    if (renderingRef.current) return
    renderingRef.current = true

    setError(null)
    try {
      const arrayBuffer = await window.api.readBinary(pdfPath)
      const data = new Uint8Array(arrayBuffer)
      const pdf = await pdfjsLib.getDocument({ data }).promise
      pdfDocRef.current = pdf
      pdfTextCache.current.clear()
      setNumPages(pdf.numPages)

      const wrapper = wrapperRef.current
      if (!wrapper) { renderingRef.current = false; return }

      // Render new canvases into a fragment (old canvases stay visible)
      const frag = document.createDocumentFragment()
      pageViewportsRef.current.clear()

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const viewport = page.getViewport({ scale: renderScale })
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
        frag.appendChild(canvas)
        await page.render({ canvasContext: context, viewport }).promise
      }

      // Atomic swap: remove old canvases, insert new ones
      wrapper.innerHTML = ''
      wrapper.appendChild(frag)
      // Now canvases match renderScale — update renderedScale so CSS transform adjusts
      setRenderedScale(renderScale)
    } catch (err) {
      setError(`Failed to load PDF: ${err}`)
    } finally {
      renderingRef.current = false
    }
  }, [pdfPath, renderScale, tab])

  // Apply CSS transform on wrapper for instant visual zoom
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const cssScale = scale / renderedScale
    if (Math.abs(cssScale - 1) < 0.001) {
      wrapper.style.transform = ''
      wrapper.style.transformOrigin = ''
    } else {
      wrapper.style.transform = `scale(${cssScale})`
      wrapper.style.transformOrigin = 'top center'
    }
  }, [scale, renderedScale])

  // Debounce: commit renderScale after user stops zooming (300ms)
  useEffect(() => {
    if (Math.abs(scale - renderScale) < 0.001) return
    if (renderScaleTimerRef.current) clearTimeout(renderScaleTimerRef.current)
    renderScaleTimerRef.current = setTimeout(() => {
      setRenderScale(scale)
    }, 300)
    return () => { if (renderScaleTimerRef.current) clearTimeout(renderScaleTimerRef.current) }
  }, [scale, renderScale])

  // Scroll wheel zoom on PDF container — zoom-to-cursor
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()

      const oldScale = scaleRef.current
      const delta = Math.max(-0.2, Math.min(0.2, -e.deltaY * 0.005))
      const newScale = Math.min(3, Math.max(0.25, +(oldScale + delta).toFixed(2)))
      if (newScale === oldScale) return

      // Zoom-to-cursor: keep the content point under the cursor stationary
      const rect = container.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      const cursorY = e.clientY - rect.top

      // Content point under cursor (in base PDF coordinates)
      const oldCssScale = oldScale / renderedScaleRef.current
      const contentX = (container.scrollLeft + cursorX) / oldCssScale
      const contentY = (container.scrollTop + cursorY) / oldCssScale

      // Update scale (triggers CSS transform via effect)
      scaleRef.current = newScale
      setScale(newScale)

      // Adjust scroll so same content point stays under cursor
      const newCssScale = newScale / renderedScaleRef.current
      requestAnimationFrame(() => {
        container.scrollLeft = contentX * newCssScale - cursorX
        container.scrollTop = contentY * newCssScale - cursorY
      })
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

  // PDF search: Cmd+F when on PDF tab opens search bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && tab === 'pdf') {
        // Only if focus is in the PDF area (not editor)
        const active = document.activeElement
        const inEditor = active?.closest('.cm-editor')
        if (inEditor) return
        e.preventDefault()
        setPdfSearchVisible(true)
        setTimeout(() => pdfSearchInputRef.current?.focus(), 50)
      }
      if (e.key === 'Escape' && pdfSearchVisible) {
        setPdfSearchVisible(false)
        setPdfSearchQuery('')
        setPdfSearchResults([])
        setPdfSearchCurrent(-1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [tab, pdfSearchVisible])

  // PDF search: extract text and find matches
  useEffect(() => {
    if (!pdfSearchQuery.trim() || !pdfDocRef.current) {
      setPdfSearchResults([])
      setPdfSearchCurrent(-1)
      return
    }

    const search = async () => {
      const pdf = pdfDocRef.current
      if (!pdf) return
      const q = pdfSearchQuery.toLowerCase()
      const results: Array<{ page: number; index: number }> = []

      for (let i = 1; i <= pdf.numPages; i++) {
        let text = pdfTextCache.current.get(i)
        if (!text) {
          try {
            const page = await pdf.getPage(i)
            const tc = await page.getTextContent()
            text = tc.items.map((item: any) => item.str).join(' ')
            pdfTextCache.current.set(i, text)
          } catch {
            continue
          }
        }
        const lower = text.toLowerCase()
        let pos = 0
        while ((pos = lower.indexOf(q, pos)) !== -1) {
          results.push({ page: i, index: pos })
          pos += q.length
          if (results.length >= 500) break
        }
        if (results.length >= 500) break
      }

      setPdfSearchResults(results)
      setPdfSearchCurrent(results.length > 0 ? 0 : -1)
    }

    const timer = setTimeout(search, 200)
    return () => clearTimeout(timer)
  }, [pdfSearchQuery])

  // PDF search: scroll to current result
  useEffect(() => {
    if (pdfSearchCurrent < 0 || pdfSearchCurrent >= pdfSearchResults.length) return
    const result = pdfSearchResults[pdfSearchCurrent]
    if (!result || !wrapperRef.current || !containerRef.current) return

    const canvases = wrapperRef.current.querySelectorAll('canvas.pdf-page')
    const canvas = canvases[result.page - 1] as HTMLCanvasElement | undefined
    if (!canvas) return

    const container = containerRef.current
    const containerRect = container.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    const offsetInContainer = canvasRect.top - containerRect.top + container.scrollTop

    // Scroll to roughly the right area of the page
    container.scrollTo({ top: Math.max(0, offsetInContainer - containerRect.height / 3), behavior: 'smooth' })
  }, [pdfSearchCurrent, pdfSearchResults])

  const pdfSearchNext = () => {
    if (pdfSearchResults.length === 0) return
    setPdfSearchCurrent((c) => (c + 1) % pdfSearchResults.length)
  }

  const pdfSearchPrev = () => {
    if (pdfSearchResults.length === 0) return
    setPdfSearchCurrent((c) => (c - 1 + pdfSearchResults.length) % pdfSearchResults.length)
  }

  // Handle forward SyncTeX navigation (scroll PDF to page+position)
  useEffect(() => {
    if (!pendingPdfGoTo || !wrapperRef.current || !containerRef.current) return
    const { page, y } = pendingPdfGoTo
    useAppStore.getState().setPendingPdfGoTo(null)

    // Switch to PDF tab
    setTab('pdf')

    // Wait a frame for tab switch / render
    requestAnimationFrame(() => {
      const wrapper = wrapperRef.current
      const container = containerRef.current
      if (!wrapper || !container) return

      const canvases = wrapper.querySelectorAll('canvas.pdf-page')
      const targetCanvas = canvases[page - 1] as HTMLCanvasElement | undefined
      if (!targetCanvas) return

      const vpInfo = pageViewportsRef.current.get(page)
      if (!vpInfo) return

      // y is in PDF points from top; convert to fraction of page height
      const yFrac = y / vpInfo.height
      const cssScale = scaleRef.current / renderedScaleRef.current

      // Calculate scroll position
      const canvasRect = targetCanvas.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      const offsetInContainer = canvasRect.top - containerRect.top + container.scrollTop
      const targetY = offsetInContainer + yFrac * canvasRect.height - containerRect.height / 3

      container.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' })

      // Flash highlight on the line
      const highlight = document.createElement('div')
      highlight.style.cssText = `
        position: absolute; left: 0; right: 0;
        height: ${14 * cssScale}px;
        top: ${canvasRect.top - containerRect.top + container.scrollTop + yFrac * canvasRect.height}px;
        background: rgba(74, 111, 165, 0.3);
        pointer-events: none; z-index: 10;
        transition: opacity 1.5s ease-out;
      `
      container.style.position = 'relative'
      container.appendChild(highlight)
      setTimeout(() => { highlight.style.opacity = '0' }, 500)
      setTimeout(() => { highlight.remove() }, 2000)
    })
  }, [pendingPdfGoTo])

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
            <button
              className={`toolbar-btn ${pdfSearchVisible ? 'active' : ''}`}
              onClick={() => {
                setPdfSearchVisible(!pdfSearchVisible)
                if (!pdfSearchVisible) setTimeout(() => pdfSearchInputRef.current?.focus(), 50)
                else { setPdfSearchQuery(''); setPdfSearchResults([]); setPdfSearchCurrent(-1) }
              }}
              title="Search in PDF (Cmd+F)"
            >
              &#x2315;
            </button>
            {pdfPath && (
              <button className="toolbar-btn" onClick={() => window.api.savePdf(pdfPath)} title="Download PDF">
                ↓
              </button>
            )}
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

      {/* PDF search bar */}
      {pdfSearchVisible && tab === 'pdf' && (
        <div className="pdf-search-bar">
          <input
            ref={pdfSearchInputRef}
            className="pdf-search-input"
            type="text"
            placeholder="Search in PDF..."
            value={pdfSearchQuery}
            onChange={(e) => setPdfSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) pdfSearchPrev()
              else if (e.key === 'Enter') pdfSearchNext()
              else if (e.key === 'Escape') {
                setPdfSearchVisible(false)
                setPdfSearchQuery('')
                setPdfSearchResults([])
                setPdfSearchCurrent(-1)
              }
            }}
          />
          <span className="pdf-search-count">
            {pdfSearchResults.length > 0
              ? `${pdfSearchCurrent + 1}/${pdfSearchResults.length}`
              : pdfSearchQuery ? 'No results' : ''}
          </span>
          <button className="toolbar-btn" onClick={pdfSearchPrev} disabled={pdfSearchResults.length === 0} title="Previous (Shift+Enter)">&#x2191;</button>
          <button className="toolbar-btn" onClick={pdfSearchNext} disabled={pdfSearchResults.length === 0} title="Next (Enter)">&#x2193;</button>
          <button className="toolbar-btn" onClick={() => {
            setPdfSearchVisible(false)
            setPdfSearchQuery('')
            setPdfSearchResults([])
            setPdfSearchCurrent(-1)
          }} title="Close">&#x2715;</button>
        </div>
      )}

      {/* PDF view — always mounted, hidden when log is shown */}
      <div className="pdf-container" ref={containerRef} style={{ display: tab === 'pdf' ? undefined : 'none' }}>
        <div className="pdf-wrapper" ref={wrapperRef} />
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
