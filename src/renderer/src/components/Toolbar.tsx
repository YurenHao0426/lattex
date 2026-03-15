// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useState, useRef, useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { remoteCursors } from '../App'

interface ToolbarProps {
  onCompile: () => void
  onLocalCompile: () => void
  onBack: () => void
}

export default function Toolbar({ onCompile, onLocalCompile, onBack }: ToolbarProps) {
  const {
    compiling, toggleTerminal, toggleFileTree, showTerminal, showFileTree,
    showReviewPanel, toggleReviewPanel, showChat, toggleChat,
    showSearch, toggleSearch,
    connectionState, overleafProject, onlineUsersCount
  } = useAppStore()

  const [showCompileMenu, setShowCompileMenu] = useState(false)
  const [showUsersPopover, setShowUsersPopover] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const usersRef = useRef<HTMLDivElement>(null)

  // Close menus on outside click
  useEffect(() => {
    if (!showCompileMenu && !showUsersPopover) return
    const handler = (e: MouseEvent) => {
      if (showCompileMenu && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowCompileMenu(false)
      }
      if (showUsersPopover && usersRef.current && !usersRef.current.contains(e.target as Node)) {
        setShowUsersPopover(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCompileMenu, showUsersPopover])

  const projectName = overleafProject?.name || 'Project'

  const connectionDot = connectionState === 'connected' ? 'connection-dot-green'
    : connectionState === 'connecting' || connectionState === 'reconnecting' ? 'connection-dot-yellow'
    : 'connection-dot-red'

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <div className="drag-region" />
        <button className="toolbar-btn" onClick={onBack} title="Back to projects">
          &#8592;
        </button>
        <button className="toolbar-btn" onClick={toggleFileTree} title="Toggle file tree">
          {showFileTree ? '◧' : '☰'}
        </button>
        <button className={`toolbar-btn ${showSearch ? 'active' : ''}`} onClick={toggleSearch} title="Search in files (Cmd+Shift+F)">
          Search
        </button>
        <span className="project-name">
          <span className={`connection-dot ${connectionDot}`} title={connectionState} />
          {projectName}
        </span>
      </div>
      <div className="toolbar-center">
        <div className="compile-btn-group" ref={menuRef}>
          <button
            className={`toolbar-btn toolbar-btn-primary ${compiling ? 'compiling' : ''}`}
            onClick={onCompile}
            disabled={compiling}
            title="Compile on Overleaf server (Cmd+B)"
          >
            {compiling ? 'Compiling...' : 'Compile'}
          </button>
          <button
            className="toolbar-btn toolbar-btn-primary compile-dropdown-toggle"
            onClick={() => setShowCompileMenu(!showCompileMenu)}
            disabled={compiling}
            title="Compile options"
          >
            ▾
          </button>
          {showCompileMenu && (
            <div className="compile-dropdown-menu">
              <button className="compile-dropdown-item" onClick={() => { setShowCompileMenu(false); onCompile() }}>
                Server Compile
                <span className="compile-dropdown-hint">Cmd+B</span>
              </button>
              <button className="compile-dropdown-item" onClick={() => { setShowCompileMenu(false); onLocalCompile() }}>
                Local Compile
                <span className="compile-dropdown-hint">latexmk</span>
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="toolbar-right">
        {onlineUsersCount > 0 && (
          <div className="toolbar-users-wrap" ref={usersRef}>
            <button
              className="toolbar-users"
              onClick={() => setShowUsersPopover(!showUsersPopover)}
              title={`${onlineUsersCount} user${onlineUsersCount > 1 ? 's' : ''} online`}
            >
              {onlineUsersCount} online
            </button>
            {showUsersPopover && (
              <div className="users-popover">
                <div className="users-popover-title">Online Users</div>
                {Array.from(remoteCursors.values()).map((u) => (
                  <div key={u.userId} className="users-popover-item">
                    <span className="users-popover-dot" style={{ background: u.color }} />
                    <span className="users-popover-name">{u.name}</span>
                  </div>
                ))}
                {remoteCursors.size === 0 && (
                  <div className="users-popover-empty">No cursor data yet</div>
                )}
              </div>
            )}
          </div>
        )}
        <button className={`toolbar-btn ${showChat ? 'active' : ''}`} onClick={toggleChat} title="Toggle chat">
          Chat
        </button>
        <button className={`toolbar-btn ${showReviewPanel ? 'active' : ''}`} onClick={toggleReviewPanel} title="Toggle review panel">
          Review
        </button>
        <button className="toolbar-btn" onClick={toggleTerminal} title="Toggle terminal (Cmd+`)">
          {showTerminal ? 'Hide Terminal' : 'Terminal'}
        </button>
      </div>
    </div>
  )
}
