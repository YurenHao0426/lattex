import { useEffect, useRef, useCallback } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput, StreamLanguage } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { useAppStore } from '../stores/appStore'

// Cosmic Latte light theme
const cosmicLatteTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13.5px',
    backgroundColor: '#FFF8E7'
  },
  '.cm-content': {
    caretColor: '#3B3228',
    fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
    color: '#3B3228',
    padding: '8px 0'
  },
  '.cm-cursor': { borderLeftColor: '#3B3228' },
  '.cm-activeLine': { backgroundColor: '#F5EDD6' },
  '.cm-activeLineGutter': { backgroundColor: '#F5EDD6' },
  '.cm-selectionBackground, ::selection': { backgroundColor: '#B8D4E3 !important' },
  '.cm-gutters': {
    backgroundColor: '#F5EDD6',
    color: '#A09880',
    border: 'none',
    borderRight: '1px solid #D6CEBC',
    paddingRight: '8px'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px' },
  '.cm-foldGutter': { width: '16px' },
  '.cm-matchingBracket': { backgroundColor: '#D4C9A8', outline: 'none' },
  // LaTeX syntax colors — warm earthy palette on Cosmic Latte
  '.cm-keyword': { color: '#8B2252' },      // commands: \begin, \section
  '.cm-atom': { color: '#B8860B' },          // constants
  '.cm-string': { color: '#5B8A3C' },        // strings / text args
  '.cm-comment': { color: '#A09880', fontStyle: 'italic' },  // % comments
  '.cm-bracket': { color: '#4A6FA5' },       // braces {}
  '.cm-tag': { color: '#8B2252' },           // LaTeX tags
  '.cm-builtin': { color: '#6B5B3E' },       // builtins
  '.ͼ5': { color: '#8B2252' },   // keywords like \begin
  '.ͼ6': { color: '#4A6FA5' },   // braces/brackets
  '.ͼ7': { color: '#5B8A3C' },   // strings
  '.ͼ8': { color: '#A09880' },   // comments
}, { dark: false })

export default function Editor() {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const { activeTab, fileContents, openTabs, setFileContent, markModified } = useAppStore()

  const pendingGoTo = useAppStore((s) => s.pendingGoTo)
  const content = activeTab ? fileContents[activeTab] ?? '' : ''

  // Handle goTo when file is already open (no editor recreation needed)
  useEffect(() => {
    if (!pendingGoTo || !viewRef.current) return
    if (activeTab !== pendingGoTo.file) return

    const view = viewRef.current
    const lineNum = Math.min(pendingGoTo.line, view.state.doc.lines)
    const lineInfo = view.state.doc.line(lineNum)
    view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' })
    })
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
        const newContent = update.state.doc.toString()
        setFileContent(activeTab, newContent)
        markModified(activeTab, true)
      }
    })

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
        EditorView.lineWrapping
      ]
    })

    const view = new EditorView({
      state,
      parent: editorRef.current
    })
    viewRef.current = view

    // Apply pending navigation (from log click)
    const goTo = useAppStore.getState().pendingGoTo
    if (goTo && goTo.file === activeTab && goTo.line) {
      requestAnimationFrame(() => {
        const lineNum = Math.min(goTo.line, view.state.doc.lines)
        const lineInfo = view.state.doc.line(lineNum)
        view.dispatch({
          selection: { anchor: lineInfo.from },
          effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' })
        })
        view.focus()
        useAppStore.getState().setPendingGoTo(null)
      })
    }

    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [activeTab]) // Re-create when tab changes

  if (!activeTab) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-content">
          <p>Open a file to start editing</p>
          <p className="shortcut-hint">
            Cmd+S Save &middot; Cmd+B Compile &middot; Cmd+` Terminal
          </p>
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
    </div>
  )
}
