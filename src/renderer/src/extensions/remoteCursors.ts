// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// CM6 extension for rendering remote collaborator cursors.
//
// Ported from Overleaf's cursor-highlights extension
// (services/web/frontend/js/features/source-editor/extensions/cursor-highlights.ts,
// AGPL-3.0): cursors are drawn in a separate layer() above the text so they
// never participate in text layout — no extra DOM in the contenteditable
// content, no line-wrap opportunities, no IME interference.
import {
  MapMode,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type Text,
  type TransactionSpec,
} from '@codemirror/state'
import {
  Direction,
  EditorView,
  hoverTooltip,
  layer,
  RectangleMarker,
  type Rect,
  type Tooltip,
} from '@codemirror/view'
import { remoteUpdateAnnotation } from './otSyncExtension'

export interface RemoteCursor {
  userId: string
  name: string
  color: string // kept for API compat; layer rendering derives hue from userId
  row: number    // 0-based
  column: number // 0-based
}

/** Effect to update all remote cursors for the current doc */
export const setRemoteCursorsEffect = StateEffect.define<RemoteCursor[]>()

export const setRemoteCursors = (cursors: RemoteCursor[]): TransactionSpec => ({
  effects: setRemoteCursorsEffect.of(cursors),
})

// ── Hue assignment (port of Overleaf's shared/utils/colors.ts) ────────
//
// Overleaf hashes the user id and maps it onto 0–360, avoiding the band
// around the local user's own hue (OWN_HUE) so remote carets are never
// confused with your own.

const OWN_HUE = 200
const OWN_HUE_BLOCKED_SIZE = 20
const TOTAL_HUES = 360

export function hashString(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function getHueForUserId(userId: string): number {
  let hue = hashString(userId) % TOTAL_HUES
  if (hue > OWN_HUE - OWN_HUE_BLOCKED_SIZE && hue < OWN_HUE + OWN_HUE_BLOCKED_SIZE) {
    hue = hue - OWN_HUE
    hue = hue + TOTAL_HUES - OWN_HUE_BLOCKED_SIZE
  }
  return hue
}

/** Legacy helper kept for callers that want a concrete CSS color */
export function colorForUser(userId: string): string {
  return `hsl(${getHueForUserId(userId)}, 70%, 50%)`
}

// ── Position helpers (port of Overleaf's utils/position.ts + utils/layer.ts) ──

/** Clamp a (1-based line, 0-based column) to a valid doc position */
export function findValidPosition(doc: Text, lineNumber: number, columnNumber = 0): number {
  if (lineNumber < 1) return 0
  if (lineNumber > doc.lines) return doc.length
  const line = doc.line(lineNumber)
  return Math.min(line.from + columnNumber, line.to)
}

function getBase(view: EditorView) {
  const rect = view.scrollDOM.getBoundingClientRect()
  const left =
    view.textDirection === Direction.LTR
      ? rect.left
      : rect.right - view.scrollDOM.clientWidth
  return {
    left: left - view.scrollDOM.scrollLeft,
    top: rect.top - view.scrollDOM.scrollTop,
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

// Like coordsAtPos, but top/bottom span the full height of the visual line
// (assumes uniform line heights — true in source mode).
function fullHeightCoordsAtPos(view: EditorView, pos: number): Rect | null {
  const coords = view.coordsAtPos(pos)
  if (!coords) return null

  const halfLeading = (view.defaultLineHeight - (coords.bottom - coords.top)) / 2

  return {
    left: coords.left,
    right: coords.right,
    top: round2(coords.top - halfLeading),
    bottom: round2(coords.bottom + halfLeading),
  }
}

// ── State ─────────────────────────────────────────────────────────────

interface CursorHighlight {
  userId: string
  label: string
  hue: number
}

class HighlightRangeValue extends RangeValue {
  mapMode = MapMode.Simple

  constructor(public highlight: CursorHighlight) {
    super()
  }

  eq(other: HighlightRangeValue): boolean {
    return (
      other.highlight.userId === this.highlight.userId &&
      other.highlight.label === this.highlight.label &&
      other.highlight.hue === this.highlight.hue
    )
  }
}

const remoteCursorsField = StateField.define<RangeSet<HighlightRangeValue>>({
  create() {
    return RangeSet.empty
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCursorsEffect)) {
        const ranges = []
        for (const c of effect.value) {
          try {
            const pos = findValidPosition(tr.state.doc, c.row + 1, c.column)
            ranges.push(
              new HighlightRangeValue({
                userId: c.userId,
                label: c.name,
                hue: getHueForUserId(c.userId),
              }).range(pos)
            )
          } catch {
            // ignore invalid positions
          }
        }
        return RangeSet.of(ranges, true)
      }
    }

    // Map through local changes only. Remote changes come with a fresh
    // clientTracking update from the server, matching Overleaf's behavior.
    if (tr.docChanged && !tr.annotation(remoteUpdateAnnotation)) {
      value = value.map(tr.changes)
    }

    return value
  },
})

// ── Layer rendering ───────────────────────────────────────────────────

class CursorMarker extends RectangleMarker {
  constructor(
    public highlight: CursorHighlight,
    className: string,
    left: number,
    top: number,
    width: number | null,
    height: number
  ) {
    super(className, left, top, width, height)
  }

  draw(): HTMLDivElement {
    const element = super.draw()
    element.style.setProperty('--hue', String(this.highlight.hue))
    return element
  }

  update(element: HTMLDivElement, prev: CursorMarker): boolean {
    if (!super.update(element, prev)) return false
    element.style.setProperty('--hue', String(this.highlight.hue))
    return true
  }

  eq(other: CursorMarker): boolean {
    return super.eq(other) && this.highlight.hue === other.highlight.hue
  }
}

// Draw the collaborator cursors in a separate layer, so they don't affect
// word wrapping (per Overleaf's cursor-highlights).
const remoteCursorsLayer = layer({
  above: true,
  class: 'cm-remoteCursorsLayer',
  update: update => {
    return (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.transactions.some(tr =>
        tr.effects.some(effect => effect.is(setRemoteCursorsEffect))
      )
    )
  },
  markers(view) {
    const markers: CursorMarker[] = []
    const highlightRanges = view.state.field(remoteCursorsField)
    const base = getBase(view)
    const { from, to } = view.viewport
    highlightRanges.between(from, to, (rangeFrom, _rangeTo, { highlight }) => {
      const pos = fullHeightCoordsAtPos(view, rangeFrom)
      if (pos) {
        markers.push(
          new CursorMarker(
            highlight,
            'cm-remoteCursor',
            pos.left - base.left,
            pos.top - base.top,
            null,
            pos.bottom - pos.top
          )
        )
      }
    })
    return markers
  },
})

// ── Hover tooltip with collaborator name(s) ───────────────────────────

const cursorTooltip = (view: EditorView, pos: number): Tooltip | null => {
  const highlights: CursorHighlight[] = []

  view.state.field(remoteCursorsField).between(pos, pos, (_from, _to, value) => {
    highlights.push(value.highlight)
  })

  if (highlights.length === 0) return null

  return {
    pos,
    end: pos,
    above: true,
    create: () => {
      const dom = document.createElement('div')
      dom.classList.add('cm-remoteCursorTooltip')
      for (const highlight of highlights) {
        const label = document.createElement('div')
        label.classList.add('cm-remoteCursorLabel')
        label.style.setProperty('--hue', String(highlight.hue))
        label.textContent = highlight.label
        dom.appendChild(label)
      }
      return { dom }
    },
  }
}

const remoteCursorsTheme = EditorView.theme({
  '.cm-remoteCursorsLayer': {
    zIndex: 100,
    contain: 'size style',
    pointerEvents: 'none',
  },
  '.cm-remoteCursor': {
    color: 'hsl(var(--hue), 70%, 50%)',
    borderLeft: '2px solid hsl(var(--hue), 70%, 50%)',
    display: 'inline-block',
    height: '1.6em',
    position: 'absolute',
    pointerEvents: 'none',
  },
  '.cm-remoteCursor:before': {
    content: "''",
    position: 'absolute',
    left: '-2px',
    top: '-5px',
    height: '5px',
    width: '5px',
    borderWidth: '3px 3px 2px 2px',
    borderStyle: 'solid',
    borderColor: 'inherit',
  },
  '.cm-tooltip.cm-tooltip-hover:has(.cm-remoteCursorTooltip)': {
    border: 'none',
    backgroundColor: 'transparent',
  },
  '.cm-remoteCursorTooltip': {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  '.cm-remoteCursorLabel': {
    lineHeight: 1,
    backgroundColor: 'hsl(var(--hue), 70%, 50%)',
    padding: '4px 6px',
    borderRadius: '3px',
    fontSize: '11px',
    fontFamily: 'var(--font-sans, sans-serif)',
    color: 'white',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  },
})

export function remoteCursorsExtension() {
  return [
    remoteCursorsField,
    remoteCursorsLayer,
    remoteCursorsTheme,
    hoverTooltip(cursorTooltip, { hoverTime: 1 }),
  ]
}
