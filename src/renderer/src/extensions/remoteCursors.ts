// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// CM6 extension for rendering remote collaborator cursors
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

export interface RemoteCursor {
  userId: string
  name: string
  color: string
  row: number    // 0-based
  column: number // 0-based
}

/** Effect to update all remote cursors for the current doc */
export const setRemoteCursorsEffect = StateEffect.define<RemoteCursor[]>()

const CURSOR_COLORS = [
  '#E06C75', '#61AFEF', '#98C379', '#E5C07B',
  '#C678DD', '#56B6C2', '#BE5046', '#D19A66'
]

export function colorForUser(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]
}

class CursorWidget extends WidgetType {
  constructor(private name: string, private color: string, private id: string) {
    super()
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span')
    wrapper.className = 'cm-remote-cursor'
    wrapper.setAttribute('data-cursor-id', this.id)

    const line = document.createElement('span')
    line.className = 'cm-remote-cursor-line'
    line.style.borderLeftColor = this.color
    wrapper.appendChild(line)

    const label = document.createElement('span')
    label.className = 'cm-remote-cursor-label'
    label.style.backgroundColor = this.color
    label.textContent = this.name.split(' ')[0] // first name only
    wrapper.appendChild(label)

    // Fade label after 2s
    setTimeout(() => label.classList.add('faded'), 2000)

    return wrapper
  }

  eq(other: CursorWidget): boolean {
    return this.name === other.name && this.color === other.color && this.id === other.id
  }

  get estimatedHeight(): number { return 0 }

  ignoreEvent(): boolean { return true }
}

const remoteCursorsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCursorsEffect)) {
        const cursors = effect.value
        const decorations: { pos: number; widget: CursorWidget }[] = []

        for (const c of cursors) {
          const lineNum = c.row + 1 // CM6 is 1-based
          if (lineNum < 1 || lineNum > tr.state.doc.lines) continue
          const line = tr.state.doc.line(lineNum)
          const pos = line.from + Math.min(c.column, line.length)
          decorations.push({
            pos,
            widget: new CursorWidget(c.name, c.color, c.userId)
          })
        }

        // Sort by position
        decorations.sort((a, b) => a.pos - b.pos)

        return Decoration.set(
          decorations.map(d =>
            Decoration.widget({ widget: d.widget, side: 1 }).range(d.pos)
          )
        )
      }
    }

    // Map through document changes
    if (tr.docChanged) {
      value = value.map(tr.changes)
    }

    return value
  },

  provide: f => EditorView.decorations.from(f)
})

export function remoteCursorsExtension() {
  return [remoteCursorsField]
}
