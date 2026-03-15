// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useEffect, useRef, useState, useCallback } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput, StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { tags } from '@lezer/highlight'
import { useAppStore } from '../stores/appStore'
import {
  commentHighlights,
  commentRangesField,
  setCommentRangesEffect,
  highlightThreadEffect,
  type CommentRange,
} from '../extensions/commentHighlights'
import { addCommentTooltip, setAddCommentCallback } from '../extensions/addCommentTooltip'
import { otSyncExtension, remoteUpdateAnnotation } from '../extensions/otSyncExtension'
import { remoteCursorsExtension, setRemoteCursorsEffect, type RemoteCursor } from '../extensions/remoteCursors'
import { latexAutocomplete } from '../extensions/latexAutocomplete'
import { latexFolding } from '../extensions/latexFolding'
import { latexClosing } from '../extensions/latexClosing'
import { mathPreview } from '../extensions/mathPreview'
import { mathHighlight } from '../extensions/mathHighlight'
import { OverleafDocSync } from '../ot/overleafSync'
import { activeDocSyncs, remoteCursors } from '../App'

const cosmicLatteTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px', backgroundColor: '#FFF8E7' },
  '.cm-content': {
    caretColor: '#3B3228',
    fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
    color: '#3B3228', padding: '8px 0'
  },
  '.cm-cursor': { borderLeftColor: '#3B3228' },
  '.cm-activeLine': { backgroundColor: 'rgba(214, 206, 188, 0.3)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(214, 206, 188, 0.3)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(120, 170, 210, 0.45) !important' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(120, 170, 210, 0.45) !important' },
  '.cm-gutters': {
    backgroundColor: '#F5EDD6', color: '#A09880', border: 'none',
    borderRight: '1px solid #D6CEBC', paddingRight: '8px'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px' },
  '.cm-foldGutter': { width: '16px' },
  '.cm-matchingBracket': { backgroundColor: '#D4C9A8', outline: 'none' },
}, { dark: false })

const cosmicLatteHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#8B2252', fontWeight: '600' },          // \commands
  { tag: tags.tagName, color: '#8B2252', fontWeight: '600' },          // \begin \end
  { tag: tags.atom, color: '#B8860B' },                                 // special symbols
  { tag: tags.number, color: '#B8860B' },                               // numbers
  { tag: tags.string, color: '#5B8A3C' },                               // arguments in braces
  { tag: tags.comment, color: '#A09880', fontStyle: 'italic' },         // % comments
  { tag: tags.bracket, color: '#4A6FA5' },                              // { } [ ] ( )
  { tag: tags.paren, color: '#4A6FA5' },
  { tag: tags.squareBracket, color: '#4A6FA5' },
  { tag: tags.brace, color: '#4A6FA5' },
  { tag: tags.meta, color: '#C75643' },                                 // $ math delimiters
  { tag: tags.standard(tags.name), color: '#6B5B3E' },                  // builtins
  { tag: tags.variableName, color: '#4A6FA5' },                         // variables
  { tag: tags.definition(tags.variableName), color: '#6B5B3E' },        // definitions
  { tag: tags.operator, color: '#8B6B8B' },                             // operators
  { tag: tags.heading, color: '#8B2252', fontWeight: '700' },           // headings
  { tag: tags.contentSeparator, color: '#D6CEBC' },                     // horizontal rules
  { tag: tags.url, color: '#4A6FA5', textDecoration: 'underline' },     // URLs
  { tag: tags.invalid, color: '#C75643', textDecoration: 'underline' }, // errors
])

export default function Editor() {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const { activeTab, fileContents, openTabs, setFileContent, markModified } = useAppStore()

  const pendingGoTo = useAppStore((s) => s.pendingGoTo)
  const commentContexts = useAppStore((s) => s.commentContexts)
  const resolvedThreadIds = useAppStore((s) => s.resolvedThreadIds)
  const hoveredThreadId = useAppStore((s) => s.hoveredThreadId)
  const overleafProjectId = useAppStore((s) => s.overleafProjectId)
  const pathDocMap = useAppStore((s) => s.pathDocMap)
  const docVersions = useAppStore((s) => s.docVersions)
  const content = activeTab ? fileContents[activeTab] ?? '' : ''
  const docSyncRef = useRef<OverleafDocSync | null>(null)

  const cursorThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [editorFontSize, setEditorFontSize] = useState(13.5)

  // Add comment state
  const [newComment, setNewComment] = useState<{ from: number; to: number; text: string } | null>(null)
  const [commentInput, setCommentInput] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)

  // Get docId for current file
  const getDocIdForFile = useCallback(() => {
    if (!activeTab) return null
    return pathDocMap[activeTab] || null
  }, [activeTab, pathDocMap])

  // Set up the add-comment callback
  useEffect(() => {
    setAddCommentCallback((from, to, text) => {
      setNewComment({ from, to, text })
      setCommentInput('')
    })
    return () => setAddCommentCallback(null)
  }, [])

  const handleSubmitComment = useCallback(async () => {
    if (!newComment || !commentInput.trim() || !overleafProjectId) return
    const docId = getDocIdForFile()
    if (!docId) return
    setSubmittingComment(true)
    const result = await window.api.overleafAddComment(
      overleafProjectId, docId, newComment.from, newComment.text, commentInput.trim()
    )
    setSubmittingComment(false)
    if (result.success) {
      // Add context immediately so highlight + review panel update without re-fetch
      if (result.threadId && activeTab) {
        const store = useAppStore.getState()
        store.setCommentContexts({
          ...store.commentContexts,
          [result.threadId]: { file: activeTab, text: newComment.text, pos: newComment.from }
        })
      }
      setNewComment(null)
      setCommentInput('')
    }
  }, [newComment, commentInput, overleafProjectId, activeTab, getDocIdForFile])

  // Handle goTo when file is already open
  useEffect(() => {
    if (!pendingGoTo || !viewRef.current) return
    if (activeTab !== pendingGoTo.file) return

    const view = viewRef.current
    if (pendingGoTo.pos !== undefined) {
      const docLen = view.state.doc.length
      const from = Math.min(pendingGoTo.pos, docLen)
      const to = pendingGoTo.highlight
        ? Math.min(from + pendingGoTo.highlight.length, docLen)
        : from
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' })
      })
    } else if (pendingGoTo.line) {
      const lineNum = Math.min(pendingGoTo.line, view.state.doc.lines)
      const lineInfo = view.state.doc.line(lineNum)
      view.dispatch({
        selection: { anchor: lineInfo.from },
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' })
      })
    }
    view.focus()
    useAppStore.getState().setPendingGoTo(null)
  }, [pendingGoTo])

  // Create/update editor
  useEffect(() => {
    if (!editorRef.current) return

    if (viewRef.current) {
      viewRef.current.destroy()
    }

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && activeTab) {
        const isRemote = update.transactions.some(tr => tr.annotation(remoteUpdateAnnotation))
        const newContent = update.state.doc.toString()
        setFileContent(activeTab, newContent)
        if (!isRemote) {
          markModified(activeTab, true)
        }
        // Notify bridge of content change (both local and remote) for disk sync
        const docId = pathDocMap[activeTab]
        if (docId) {
          window.api.syncContentChanged(docId, newContent)
        }
      }
      if (update.selectionSet) {
        const ranges = update.state.field(commentRangesField)
        const cursorPos = update.state.selection.main.head
        let found: string | null = null
        for (const r of ranges) {
          if (cursorPos >= r.from && cursorPos <= r.to) {
            found = r.threadId
            break
          }
        }
        const store = useAppStore.getState()
        if (found !== store.focusedThreadId) {
          store.setFocusedThreadId(found)
        }

        // Send cursor position to Overleaf (throttled)
        const docId = pathDocMap[activeTab!]
        if (docId) {
          if (cursorThrottleRef.current) clearTimeout(cursorThrottleRef.current)
          cursorThrottleRef.current = setTimeout(() => {
            const line = update.state.doc.lineAt(cursorPos)
            const row = line.number - 1
            const column = cursorPos - line.from
            window.api.cursorUpdate(docId, row, column)
          }, 300)
        }
      }
    })

    // Set up OT sync
    let otExt: any[] = []
    if (activeTab) {
      const docId = pathDocMap[activeTab]
      const version = docId ? docVersions[docId] : undefined
      if (docId && version !== undefined) {
        const docSync = new OverleafDocSync(docId, version)
        docSyncRef.current = docSync
        activeDocSyncs.set(docId, docSync)
        otExt = [otSyncExtension(docSync)]
      }
    }

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        foldGutter(),
        history(),
        highlightSelectionMatches(),
        search({ top: true }),
        StreamLanguage.define(stex),
        syntaxHighlighting(cosmicLatteHighlight),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          indentWithTab
        ]),
        cosmicLatteTheme,
        updateListener,
        EditorView.lineWrapping,
        latexAutocomplete(),
        latexFolding(),
        latexClosing(),
        mathPreview(),
        mathHighlight,
        commentHighlights(),
        overleafProjectId ? addCommentTooltip() : [],
        ...otExt,
        remoteCursorsExtension(),
      ]
    })

    const view = new EditorView({ state, parent: editorRef.current })
    viewRef.current = view

    if (docSyncRef.current) {
      docSyncRef.current.setView(view)
    }

    // Apply pending navigation
    const goTo = useAppStore.getState().pendingGoTo
    if (goTo && goTo.file === activeTab && (goTo.line || goTo.pos !== undefined)) {
      requestAnimationFrame(() => {
        if (goTo.pos !== undefined) {
          const docLen = view.state.doc.length
          const from = Math.min(goTo.pos, docLen)
          const to = goTo.highlight ? Math.min(from + goTo.highlight.length, docLen) : from
          view.dispatch({
            selection: { anchor: from, head: to },
            effects: EditorView.scrollIntoView(from, { y: 'center' })
          })
        } else if (goTo.line) {
          const lineNum = Math.min(goTo.line, view.state.doc.lines)
          const lineInfo = view.state.doc.line(lineNum)
          view.dispatch({
            selection: { anchor: lineInfo.from },
            effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' })
          })
        }
        view.focus()
        useAppStore.getState().setPendingGoTo(null)
      })
    }

    return () => {
      if (docSyncRef.current) {
        const docId = pathDocMap[activeTab!]
        if (docId) activeDocSyncs.delete(docId)
        docSyncRef.current.destroy()
        docSyncRef.current = null
      }
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [activeTab])

  // Sync remote cursors to CodeMirror
  useEffect(() => {
    if (!viewRef.current || !activeTab) return
    const docId = pathDocMap[activeTab]
    if (!docId) return

    const refreshCursors = () => {
      if (!viewRef.current) return
      const cursorsForDoc: RemoteCursor[] = []
      for (const c of remoteCursors.values()) {
        if (c.docId === docId) {
          cursorsForDoc.push(c)
        }
      }
      viewRef.current.dispatch({ effects: setRemoteCursorsEffect.of(cursorsForDoc) })
    }

    // Refresh on event
    window.addEventListener('remoteCursorsChanged', refreshCursors)
    // Initial refresh
    refreshCursors()

    return () => {
      window.removeEventListener('remoteCursorsChanged', refreshCursors)
    }
  }, [activeTab, pathDocMap])

  // Sync comment ranges to CodeMirror (exclude resolved threads)
  // Skip until resolvedThreadIds has been loaded (non-null) to avoid flashing resolved highlights
  useEffect(() => {
    if (!viewRef.current || !activeTab || resolvedThreadIds === null) return
    const ranges: CommentRange[] = []
    for (const [threadId, ctx] of Object.entries(commentContexts)) {
      if (ctx.file === activeTab && ctx.text && !resolvedThreadIds.has(threadId)) {
        ranges.push({
          threadId,
          from: ctx.pos,
          to: ctx.pos + ctx.text.length,
          text: ctx.text,
        })
      }
    }
    viewRef.current.dispatch({ effects: setCommentRangesEffect.of(ranges) })
  }, [commentContexts, activeTab, resolvedThreadIds])

  // Sync hover state
  useEffect(() => {
    if (!viewRef.current) return
    viewRef.current.dispatch({ effects: highlightThreadEffect.of(hoveredThreadId) })
  }, [hoveredThreadId])

  // Ctrl+wheel / pinch zoom on editor (capture phase to beat CodeMirror)
  const fontSizeRef = useRef(13.5)
  const measureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      // Use continuous delta for smooth feel
      const delta = -e.deltaY * 0.02
      const newSize = Math.min(28, Math.max(8, +(fontSizeRef.current + delta).toFixed(1)))
      fontSizeRef.current = newSize
      // Apply font size immediately to DOM for smooth feel
      if (viewRef.current) {
        viewRef.current.dom.style.fontSize = `${newSize}px`
      }
      // Debounce the expensive requestMeasure
      if (measureTimerRef.current) clearTimeout(measureTimerRef.current)
      measureTimerRef.current = setTimeout(() => {
        if (viewRef.current) viewRef.current.requestMeasure()
        setEditorFontSize(fontSizeRef.current)
      }, 100)
    }
    el.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', handleWheel, { capture: true })
  }, [])

  if (!activeTab) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-content">
          <p>Open a file to start editing</p>
          <p className="shortcut-hint">Cmd+B Compile &middot; Cmd+` Terminal</p>
        </div>
      </div>
    )
  }

  return (
    <div className="editor-panel">
      <div className="tab-bar">
        {openTabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab ${tab.path === activeTab ? 'active' : ''}`}
            onClick={() => useAppStore.getState().setActiveTab(tab.path)}
          >
            <span className="tab-name">
              {tab.modified && <span className="tab-dot">●</span>}
              {tab.name}
            </span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation()
                useAppStore.getState().closeTab(tab.path)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div ref={editorRef} className="editor-content" />
      {newComment && (
        <div className="add-comment-overlay">
          <div className="add-comment-card">
            <div className="add-comment-quote">
              &ldquo;{newComment.text.length > 60 ? newComment.text.slice(0, 60) + '...' : newComment.text}&rdquo;
            </div>
            <textarea
              className="add-comment-input"
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              placeholder="Write a comment..."
              autoFocus
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmitComment() }
                if (e.key === 'Escape') setNewComment(null)
              }}
            />
            <div className="add-comment-actions">
              <button className="add-comment-cancel" onClick={() => setNewComment(null)}>Cancel</button>
              <button
                className="add-comment-submit"
                onClick={handleSubmitComment}
                disabled={!commentInput.trim() || submittingComment}
              >
                {submittingComment ? 'Sending...' : 'Comment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
