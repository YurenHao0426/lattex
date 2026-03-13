// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../stores/appStore'

interface User {
  id: string
  first_name?: string
  last_name?: string
  email?: string
}

interface Message {
  id: string
  content: string
  timestamp: number
  user_id: string
  user?: User
}

interface Thread {
  messages: Message[]
  resolved?: boolean
  resolved_at?: string
  resolved_by_user_id?: string
  resolved_by_user?: User
}

type ThreadMap = Record<string, Thread>

export default function ReviewPanel() {
  const contexts = useAppStore((s) => s.commentContexts)
  const activeTab = useAppStore((s) => s.activeTab)
  const hoveredThreadId = useAppStore((s) => s.hoveredThreadId)
  const focusedThreadId = useAppStore((s) => s.focusedThreadId)
  const overleafProjectId = useAppStore((s) => s.overleafProjectId)
  const [threads, setThreads] = useState<ThreadMap>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showResolved, setShowResolved] = useState(false)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [editingMsg, setEditingMsg] = useState<{ threadId: string; messageId: string } | null>(null)
  const [editText, setEditText] = useState('')
  const threadRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const fetchThreads = useCallback(async () => {
    if (!overleafProjectId) return
    setLoading(true)
    setError('')

    const [threadResult, ctxResult] = await Promise.all([
      window.api.overleafGetThreads(overleafProjectId),
      window.api.otFetchAllCommentContexts()
    ])

    setLoading(false)
    if (threadResult.success && threadResult.threads) {
      setThreads(threadResult.threads as ThreadMap)
    } else {
      setError(threadResult.message || 'Failed to fetch comments')
    }
    if (ctxResult.success && ctxResult.contexts) {
      useAppStore.getState().setCommentContexts(ctxResult.contexts)
    }
  }, [overleafProjectId])

  useEffect(() => {
    fetchThreads()
  }, [fetchThreads])

  useEffect(() => {
    if (!focusedThreadId) return
    const el = threadRefs.current[focusedThreadId]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [focusedThreadId])

  const handleReply = async (threadId: string) => {
    if (!replyText.trim() || !overleafProjectId) return
    const result = await window.api.overleafReplyThread(overleafProjectId, threadId, replyText.trim())
    if (result.success) {
      setReplyText('')
      setReplyingTo(null)
      fetchThreads()
    }
  }

  const handleResolve = async (threadId: string) => {
    if (!overleafProjectId) return
    await window.api.overleafResolveThread(overleafProjectId, threadId)
    fetchThreads()
  }

  const handleReopen = async (threadId: string) => {
    if (!overleafProjectId) return
    await window.api.overleafReopenThread(overleafProjectId, threadId)
    fetchThreads()
  }

  const handleDeleteMessage = async (threadId: string, messageId: string) => {
    if (!overleafProjectId) return
    await window.api.overleafDeleteMessage(overleafProjectId, threadId, messageId)
    fetchThreads()
  }

  const handleStartEdit = (threadId: string, msg: Message) => {
    setEditingMsg({ threadId, messageId: msg.id })
    setEditText(msg.content)
  }

  const handleSaveEdit = async () => {
    if (!editingMsg || !editText.trim() || !overleafProjectId) return
    await window.api.overleafEditMessage(overleafProjectId, editingMsg.threadId, editingMsg.messageId, editText.trim())
    setEditingMsg(null)
    setEditText('')
    fetchThreads()
  }

  const handleDeleteThread = async (threadId: string) => {
    if (!overleafProjectId) return
    const ctx = contexts[threadId]
    const store = useAppStore.getState()
    if (ctx) {
      const docId = store.pathDocMap[ctx.file]
      if (docId) {
        await window.api.overleafDeleteThread(overleafProjectId, docId, threadId)
        fetchThreads()
        return
      }
    }
    fetchThreads()
  }

  const getUserName = (msg: Message) => {
    if (msg.user?.first_name) {
      return msg.user.last_name ? `${msg.user.first_name} ${msg.user.last_name}` : msg.user.first_name
    }
    if (msg.user?.email) return msg.user.email.split('@')[0]
    return msg.user_id.slice(-6)
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 7) return `${diffDays}d ago`
    return d.toLocaleDateString()
  }

  // Navigate to comment position — always works for current file since it's already open
  const handleClickContext = (threadId: string) => {
    const ctx = contexts[threadId]
    if (!ctx) return
    const store = useAppStore.getState()
    // File should already be open since we only show current file's comments
    store.setPendingGoTo({ file: ctx.file, pos: ctx.pos, highlight: ctx.text })
  }

  if (!overleafProjectId) {
    return (
      <div className="review-panel">
        <div className="review-header"><span>Review</span></div>
        <div className="review-empty">Not connected</div>
      </div>
    )
  }

  // Filter threads to only show ones belonging to the current file
  const threadEntries = Object.entries(threads)
  const fileThreads = activeTab
    ? threadEntries.filter(([threadId]) => {
        const ctx = contexts[threadId]
        return ctx && ctx.file === activeTab
      })
    : []
  const activeThreads = fileThreads.filter(([, t]) => !t.resolved)
  const resolvedThreads = fileThreads.filter(([, t]) => t.resolved)

  const handleThreadHover = (threadId: string | null) => {
    useAppStore.getState().setHoveredThreadId(threadId)
  }

  const renderThread = (threadId: string, thread: Thread, isResolved: boolean) => {
    const ctx = contexts[threadId]
    const isHighlighted = hoveredThreadId === threadId || focusedThreadId === threadId
    return (
      <div
        key={threadId}
        ref={(el) => { threadRefs.current[threadId] = el }}
        className={`review-thread ${isResolved ? 'review-thread-resolved' : ''} ${isHighlighted ? 'review-thread-highlighted' : ''}`}
        onMouseEnter={() => handleThreadHover(threadId)}
        onMouseLeave={() => handleThreadHover(null)}
      >
        {ctx && ctx.text && (
          <div className="review-context" onClick={() => handleClickContext(threadId)} title="Jump to position">
            <span className="review-context-text">
              &ldquo;{ctx.text.length > 80 ? ctx.text.slice(0, 80) + '...' : ctx.text}&rdquo;
            </span>
          </div>
        )}
        {thread.messages.map((msg, i) => {
          const isEditing = editingMsg?.threadId === threadId && editingMsg?.messageId === msg.id
          return (
            <div key={msg.id || i} className={`review-message ${i === 0 ? 'review-message-first' : ''}`}>
              <div className="review-message-header">
                <span className="review-user">{getUserName(msg)}</span>
                <div className="review-message-actions-inline">
                  <span className="review-time">{formatTime(msg.timestamp)}</span>
                  <button className="review-msg-action" onClick={() => handleStartEdit(threadId, msg)} title="Edit">&#9998;</button>
                  <button className="review-msg-action review-msg-delete" onClick={() => handleDeleteMessage(threadId, msg.id)} title="Delete">&times;</button>
                </div>
              </div>
              {isEditing ? (
                <div className="review-edit-inline">
                  <input
                    className="review-reply-input"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveEdit()
                      if (e.key === 'Escape') setEditingMsg(null)
                    }}
                  />
                  <button className="review-reply-send" onClick={handleSaveEdit}>Save</button>
                </div>
              ) : (
                <div className="review-message-content">{msg.content}</div>
              )}
            </div>
          )
        })}
        <div className="review-thread-actions">
          {!isResolved ? (
            <>
              <button className="review-action-btn" onClick={() => setReplyingTo(replyingTo === threadId ? null : threadId)}>Reply</button>
              <button className="review-action-btn" onClick={() => handleResolve(threadId)}>Resolve</button>
              <button className="review-action-btn review-action-delete" onClick={() => handleDeleteThread(threadId)}>Delete</button>
            </>
          ) : (
            <>
              <button className="review-action-btn" onClick={() => handleReopen(threadId)}>Reopen</button>
              <button className="review-action-btn review-action-delete" onClick={() => handleDeleteThread(threadId)}>Delete</button>
            </>
          )}
        </div>
        {replyingTo === threadId && (
          <div className="review-reply">
            <input
              className="review-reply-input"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Reply..."
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleReply(threadId) }}
            />
            <button className="review-reply-send" onClick={() => handleReply(threadId)}>Send</button>
          </div>
        )}
      </div>
    )
  }

  const fileName = activeTab?.split('/').pop() || ''

  return (
    <div className="review-panel">
      <div className="review-header">
        <span>{fileName ? `Review: ${fileName}` : 'Review'} ({activeThreads.length})</span>
        <div className="review-header-actions">
          <button className="toolbar-btn" onClick={fetchThreads} title="Refresh">
            {loading ? '...' : '↻'}
          </button>
          {resolvedThreads.length > 0 && (
            <button
              className={`toolbar-btn ${showResolved ? 'active' : ''}`}
              onClick={() => setShowResolved(!showResolved)}
              title="Show resolved"
            >
              ✓ {resolvedThreads.length}
            </button>
          )}
        </div>
      </div>

      {error && <div className="review-error">{error}</div>}

      <div className="review-threads">
        {!activeTab && (
          <div className="review-empty">Open a file to see its comments</div>
        )}
        {activeTab && activeThreads.length === 0 && !loading && (
          <div className="review-empty">No comments in this file</div>
        )}
        {activeThreads.map(([threadId, thread]) => renderThread(threadId, thread, false))}
        {showResolved && resolvedThreads.length > 0 && (
          <>
            <div className="review-section-title">Resolved</div>
            {resolvedThreads.map(([threadId, thread]) => renderThread(threadId, thread, true))}
          </>
        )}
      </div>
    </div>
  )
}
