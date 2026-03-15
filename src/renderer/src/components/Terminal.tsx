// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../stores/appStore'

const XTERM_THEME = {
  background: '#2D2A24',
  foreground: '#E8DFC0',
  cursor: '#FFF8E7',
  selectionBackground: '#5C5040',
  black: '#2D2A24',
  red: '#C75643',
  green: '#5B8A3C',
  yellow: '#B8860B',
  blue: '#4A6FA5',
  magenta: '#8B6B8B',
  cyan: '#5B8A8A',
  white: '#E8DFC0',
  brightBlack: '#6B5B3E',
  brightRed: '#D46A58',
  brightGreen: '#6FA050',
  brightYellow: '#D4A020',
  brightBlue: '#5E84B8',
  brightMagenta: '#A080A0',
  brightCyan: '#6FA0A0',
  brightWhite: '#FFF8E7'
}

/** A single xterm + pty instance */
function TerminalInstance({ id, cwd, cmd, args, visible }: {
  id: string
  cwd: string
  cmd?: string
  args?: string[]
  visible: boolean
}) {
  const termRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const spawnedRef = useRef(false)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (!termRef.current || initializedRef.current) return
    initializedRef.current = true

    const xterm = new XTerm({
      theme: XTERM_THEME,
      fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      windowOptions: {
        getWinSizePixels: true,
        getCellSizePixels: true,
        getWinSizeChars: true,
        getWinPosition: true,
      }
    })

    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(termRef.current)

    setTimeout(() => fitAddon.fit(), 100)

    xtermRef.current = xterm
    fitAddonRef.current = fitAddon

    // Spawn pty
    window.api.ptySpawn(id, cwd, cmd, args)
    spawnedRef.current = true

    const unsubData = window.api.onPtyData(id, (data) => {
      xterm.write(data)
    })

    const unsubExit = window.api.onPtyExit(id, () => {
      xterm.writeln('\r\n[Process exited]')
      spawnedRef.current = false
    })

    xterm.onData((data) => {
      window.api.ptyWrite(id, data)
    })

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        if (spawnedRef.current) {
          window.api.ptyResize(id, xterm.cols, xterm.rows)
        }
      } catch { /* ignore */ }
    })
    resizeObserver.observe(termRef.current)

    return () => {
      initializedRef.current = false
      resizeObserver.disconnect()
      unsubData()
      unsubExit()
      window.api.ptyKill(id)
      xterm.dispose()
    }
  }, [id, cwd, cmd])

  // Re-fit when becoming visible
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 50)
    }
  }, [visible])

  return (
    <div
      ref={termRef}
      className="terminal-content"
      style={visible ? undefined : { display: 'none' }}
    />
  )
}

interface TabInfo {
  id: string
  name: string
}

let nextTabId = 0

export default function Terminal() {
  const [tabs, setTabs] = useState<TabInfo[]>(() => [
    { id: `term-${++nextTabId}`, name: 'Terminal' }
  ])
  const [activeTabId, setActiveTabId] = useState(() => `term-${nextTabId}`)
  const syncDir = useAppStore((s) => s.syncDir) || '/tmp'

  const addTab = useCallback(() => {
    const id = `term-${++nextTabId}`
    setTabs((prev) => {
      const name = `Terminal ${prev.length + 1}`
      return [...prev, { id, name }]
    })
    setActiveTabId(id)
  }, [])

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev
      const idx = prev.findIndex((t) => t.id === tabId)
      const next = prev.filter((t) => t.id !== tabId)
      // If closing the active tab, switch to adjacent
      if (tabId === activeTabId) {
        const newIdx = Math.min(idx, next.length - 1)
        setActiveTabId(next[newIdx].id)
      }
      return next
    })
  }, [activeTabId])

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <QuickActions ptyId={activeTabId} />
      </div>

      {tabs.map((tab) => (
        <TerminalInstance
          key={tab.id}
          id={tab.id}
          cwd={syncDir}
          visible={tab.id === activeTabId}
        />
      ))}

      <div className="terminal-tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-tab ${tab.id === activeTabId ? 'active' : ''}`}
            onClick={() => setActiveTabId(tab.id)}
          >
            <span className="terminal-tab-name">{tab.name}</span>
            {tabs.length > 1 && (
              <span
                className="terminal-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              >
                ×
              </span>
            )}
          </div>
        ))}
        <button className="terminal-tab-add" onClick={addTab}>+</button>
      </div>
    </div>
  )
}

function QuickActions({ ptyId }: { ptyId: string }) {
  const { activeTab, fileContents } = useAppStore()

  const send = (prompt: string) => {
    window.api.ptyWrite(ptyId, prompt + '\n')
  }

  const copyComments = async () => {
    const store = useAppStore.getState()
    const projectId = store.overleafProjectId
    if (!projectId) return

    // Fetch threads and contexts in parallel
    const [threadResult, ctxResult] = await Promise.all([
      window.api.overleafGetThreads(projectId),
      window.api.otFetchAllCommentContexts()
    ])

    const threads = (threadResult.success ? threadResult.threads : {}) as Record<string, {
      messages: Array<{ content: string; timestamp?: number; user?: { first_name?: string; last_name?: string } }>
      resolved?: boolean
    }>
    const contexts = ctxResult.success && ctxResult.contexts ? ctxResult.contexts : store.commentContexts

    const lines: string[] = []
    for (const [threadId, thread] of Object.entries(threads)) {
      if (thread.resolved) continue
      const ctx = contexts[threadId]
      if (!ctx) continue
      if (ctx.file !== activeTab) continue

      const firstMsg = thread.messages?.[0]
      if (!firstMsg) continue

      // Compute line number and surrounding context from file content
      const content = store.fileContents[ctx.file] || ''
      let lineNum = 0
      let contextSnippet = ctx.text
      if (content) {
        const before = content.slice(0, ctx.pos)
        lineNum = (before.match(/\n/g) || []).length + 1
        // Get the full line(s) containing the comment for context
        const lineStart = before.lastIndexOf('\n') + 1
        const afterComment = content.indexOf('\n', ctx.pos + ctx.text.length)
        const lineEnd = afterComment === -1 ? content.length : afterComment
        const fullLine = content.slice(lineStart, lineEnd).trim()
        // Show full line with the commented text marked
        if (fullLine.length > ctx.text.length) {
          contextSnippet = fullLine.replace(ctx.text, `«${ctx.text}»`)
        }
      }

      const fmtTime = (ts?: number) => ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
      const author = firstMsg.user ? [firstMsg.user.first_name, firstMsg.user.last_name].filter(Boolean).join(' ') : ''
      const time = fmtTime(firstMsg.timestamp)
      const attribution = [author, time].filter(Boolean).join(', ')
      let line = `- ${ctx.file}:${lineNum}: ${contextSnippet}\n  → "${firstMsg.content}"${attribution ? ` — ${attribution}` : ''}`

      // Add replies
      for (let i = 1; i < thread.messages.length; i++) {
        const reply = thread.messages[i]
        const rAuthor = reply.user ? [reply.user.first_name, reply.user.last_name].filter(Boolean).join(' ') : ''
        const rTime = fmtTime(reply.timestamp)
        const rAttribution = [rAuthor, rTime].filter(Boolean).join(', ')
        line += `\n  → "${reply.content}"${rAttribution ? ` — ${rAttribution}` : ''}`
      }
      lines.push(line)
    }

    if (lines.length === 0) {
      navigator.clipboard.writeText('No unresolved comments.')
      return
    }

    const text = `Overleaf comments (${lines.length} unresolved):\n\n${lines.join('\n\n')}`
    navigator.clipboard.writeText(text)
  }

  const actions = [
    {
      label: 'Fix Errors',
      action: () => {
        const log = useAppStore.getState().compileLog
        if (log) {
          send(`Fix these LaTeX compilation errors:\n${log.slice(-2000)}`)
        }
      }
    },
    {
      label: 'Review',
      action: () => {
        if (activeTab && fileContents[activeTab]) {
          send(`Review this LaTeX file for issues and improvements: ${activeTab}`)
        }
      }
    },
    {
      label: 'Explain',
      action: () => {
        if (activeTab) {
          send(`Explain the structure and content of: ${activeTab}`)
        }
      }
    },
    {
      label: 'Copy Comments',
      action: copyComments
    }
  ]

  return (
    <div className="quick-actions">
      {actions.map((a) => (
        <button key={a.label} className="toolbar-btn quick-action-btn" onClick={a.action}>
          {a.label}
        </button>
      ))}
    </div>
  )
}
