import { useEffect, useRef, useState, useCallback } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput, StreamLanguage } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { stex } from '@codemirror/legacy-modes/mode/stex'
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
import { OverleafDocSync } from '../ot/overleafSync'
import { activeDocSyncs } from '../App'

const cosmicLatteTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px', backgroundColor: '#FFF8E7' },
  '.cm-content': {
    caretColor: '#3B3228',
    fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
    color: '#3B3228', padding: '8px 0'
  },
  '.cm-cursor': { borderLeftColor: '#3B3228' },
  '.cm-activeLine': { backgroundColor: '#F5EDD6' },
  '.cm-activeLineGutter': { backgroundColor: '#F5EDD6' },
  '.cm-selectionBackground, ::selection': { backgroundColor: '#B8D4E3 !important' },
  '.cm-gutters': {
    backgroundColor: '#F5EDD6', color: '#A09880', border: 'none',
    borderRight: '1px solid #D6CEBC', paddingRight: '8px'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px' },
  '.cm-foldGutter': { width: '16px' },
  '.cm-matchingBracket': { backgroundColor: '#D4C9A8', outline: 'none' },
  '.cm-keyword': { color: '#8B2252' },
  '.cm-atom': { color: '#B8860B' },
  '.cm-string': { color: '#5B8A3C' },
  '.cm-comment': { color: '#A09880', fontStyle: 'italic' },
  '.cm-bracket': { color: '#4A6FA5' },
  '.cm-tag': { color: '#8B2252' },
  '.cm-builtin': { color: '#6B5B3E' },
  '.ͼ5': { color: '#8B2252' },
  '.ͼ6': { color: '#4A6FA5' },
  '.ͼ7': { color: '#5B8A3C' },
  '.ͼ8': { color: '#A09880' },
}, { dark: false })

export default function Editor() {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const { activeTab, fileContents, openTabs, setFileContent, markModified } = useAppStore()

  const pendingGoTo = useAppStore((s) => s.pendingGoTo)
  const commentContexts = useAppStore((s) => s.commentContexts)
  const hoveredThreadId = useAppStore((s) => s.hoveredThreadId)
  const overleafProjectId = useAppStore((s) => s.overleafProjectId)
  const pathDocMap = useAppStore((s) => s.pathDocMap)
  const docVersions = useAppStore((s) => s.docVersions)
  const content = activeTab ? fileContents[activeTab] ?? '' : ''
  const docSyncRef = useRef<OverleafDocSync | null>(null)

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
      setNewComment(null)
      setCommentInput('')
    }
  }, [newComment, commentInput, overleafProjectId, getDocIdForFile])

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
        StreamLanguage.define(stex),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...closeBracketsKeymap,
          ...searchKeymap,
          indentWithTab
        ]),
        cosmicLatteTheme,
        updateListener,
        EditorView.lineWrapping,
        commentHighlights(),
        overleafProjectId ? addCommentTooltip() : [],
        ...otExt,
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

  // Sync comment ranges to CodeMirror
  useEffect(() => {
    if (!viewRef.current || !activeTab) return
    const ranges: CommentRange[] = []
    for (const [threadId, ctx] of Object.entries(commentContexts)) {
      if (ctx.file === activeTab && ctx.text) {
        ranges.push({
          threadId,
          from: ctx.pos,
          to: ctx.pos + ctx.text.length,
          text: ctx.text,
        })
      }
    }
    viewRef.current.dispatch({ effects: setCommentRangesEffect.of(ranges) })
  }, [commentContexts, activeTab])

  // Sync hover state
  useEffect(() => {
    if (!viewRef.current) return
    viewRef.current.dispatch({ effects: highlightThreadEffect.of(hoveredThreadId) })
  }, [hoveredThreadId])

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
