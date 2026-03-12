/**
 * CodeMirror extension: "Add comment" tooltip on text selection.
 * Inspired by Overleaf's review-tooltip.ts.
 */
import {
  EditorView,
  showTooltip,
  type Tooltip,
} from '@codemirror/view'
import {
  StateField,
  type EditorState,
} from '@codemirror/state'

export type AddCommentCallback = (from: number, to: number, text: string) => void

let _addCommentCallback: AddCommentCallback | null = null

export function setAddCommentCallback(cb: AddCommentCallback | null) {
  _addCommentCallback = cb
}

function buildTooltip(state: EditorState): Tooltip | null {
  const sel = state.selection.main
  if (sel.empty) return null

  return {
    pos: sel.head,
    above: sel.head < sel.anchor,
    create() {
      const dom = document.createElement('div')
      dom.className = 'cm-add-comment-tooltip'

      const btn = document.createElement('button')
      btn.className = 'cm-add-comment-btn'
      btn.textContent = '+ Comment'
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault()  // prevent editor losing focus/selection
      })
      btn.addEventListener('click', () => {
        if (_addCommentCallback) {
          const from = Math.min(sel.from, sel.to)
          const to = Math.max(sel.from, sel.to)
          const text = state.sliceDoc(from, to)
          _addCommentCallback(from, to, text)
        }
      })

      dom.appendChild(btn)
      return { dom, overlap: true, offset: { x: 0, y: 4 } }
    },
  }
}

const addCommentTooltipField = StateField.define<Tooltip | null>({
  create(state) {
    return buildTooltip(state)
  },
  update(tooltip, tr) {
    if (!tr.docChanged && !tr.selection) return tooltip
    return buildTooltip(tr.state)
  },
  provide: (field) => showTooltip.from(field),
})

const addCommentTooltipTheme = EditorView.baseTheme({
  '.cm-add-comment-tooltip.cm-tooltip': {
    backgroundColor: 'transparent',
    border: 'none',
    zIndex: '10',
  },
  '.cm-add-comment-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 10px',
    fontSize: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: '600',
    color: '#5B4A28',
    backgroundColor: '#FFF8E7',
    border: '1px solid #D6CEBC',
    borderRadius: '6px',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    transition: 'background 0.15s',
  },
  '.cm-add-comment-btn:hover': {
    backgroundColor: '#F5EDD6',
    borderColor: '#B8A070',
  },
})

export const addCommentTooltip = () => [
  addCommentTooltipField,
  addCommentTooltipTheme,
]
