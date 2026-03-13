// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../stores/appStore'

export default function Terminal() {
  const termRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [mode, setMode] = useState<'terminal' | 'claude'>('terminal')

  useEffect(() => {
    if (!termRef.current) return

    const xterm = new XTerm({
      theme: {
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
      },
      fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000
    })

    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(termRef.current)

    // Fit after a small delay to ensure container is sized
    setTimeout(() => fitAddon.fit(), 100)

    xtermRef.current = xterm
    fitAddonRef.current = fitAddon

    // Spawn shell
    window.api.ptySpawn('/tmp')

    // Pipe data
    const unsubData = window.api.onPtyData((data) => {
      xterm.write(data)
    })

    const unsubExit = window.api.onPtyExit(() => {
      xterm.writeln('\r\n[Process exited]')
    })

    // Send input
    xterm.onData((data) => {
      window.api.ptyWrite(data)
    })

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        window.api.ptyResize(xterm.cols, xterm.rows)
      } catch { /* ignore */ }
    })
    resizeObserver.observe(termRef.current)

    return () => {
      resizeObserver.disconnect()
      unsubData()
      unsubExit()
      window.api.ptyKill()
      xterm.dispose()
    }
  }, [])

  const launchClaude = () => {
    if (!xtermRef.current) return
    window.api.ptyWrite('claude\n')
    setMode('claude')
  }

  const sendToClaude = (prompt: string) => {
    if (!xtermRef.current) return
    window.api.ptyWrite(prompt + '\n')
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <button
          className={`pdf-tab ${mode === 'terminal' ? 'active' : ''}`}
          onClick={() => setMode('terminal')}
        >
          Terminal
        </button>
        <button
          className={`pdf-tab ${mode === 'claude' ? 'active' : ''}`}
          onClick={launchClaude}
        >
          Claude
        </button>
        <div className="pdf-toolbar-spacer" />
        <QuickActions onSend={sendToClaude} />
      </div>
      <div ref={termRef} className="terminal-content" />
    </div>
  )
}

function QuickActions({ onSend }: { onSend: (cmd: string) => void }) {
  const { activeTab, fileContents } = useAppStore()

  const actions = [
    {
      label: 'Fix Errors',
      action: () => {
        const log = useAppStore.getState().compileLog
        if (log) {
          onSend(`Fix these LaTeX compilation errors:\n${log.slice(-2000)}`)
        }
      }
    },
    {
      label: 'Review',
      action: () => {
        if (activeTab && fileContents[activeTab]) {
          onSend(`Review this LaTeX file for issues and improvements: ${activeTab}`)
        }
      }
    },
    {
      label: 'Explain',
      action: () => {
        if (activeTab) {
          onSend(`Explain the structure and content of: ${activeTab}`)
        }
      }
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
