import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../stores/appStore'

interface ChatMessage {
  id: string
  content: string
  timestamp: number
  user: {
    id: string
    first_name: string
    last_name?: string
    email?: string
  }
}

export default function ChatPanel() {
  const overleafProjectId = useAppStore((s) => s.overleafProjectId)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Load initial messages
  useEffect(() => {
    if (!overleafProjectId) return
    setLoading(true)
    window.api.chatGetMessages(overleafProjectId, 50).then((result) => {
      if (result.success) {
        // Messages come newest-first from API, reverse for display
        const msgs = (result.messages as ChatMessage[]).reverse()
        setMessages(msgs)
      }
      setLoading(false)
    })
  }, [overleafProjectId])

  // Listen for new messages via Socket.IO
  useEffect(() => {
    const unsub = window.api.onChatMessage((raw) => {
      const msg = raw as ChatMessage
      setMessages((prev) => {
        // Deduplicate by id
        if (prev.some((m) => m.id === msg.id)) return prev
        return [...prev, msg]
      })
    })
    return unsub
  }, [])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = useCallback(async () => {
    if (!input.trim() || !overleafProjectId || sending) return
    const content = input.trim()
    setInput('')
    setSending(true)
    await window.api.chatSendMessage(overleafProjectId, content)
    setSending(false)
  }, [input, overleafProjectId, sending])

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    if (isToday) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const getInitial = (user: ChatMessage['user']) => {
    return (user.first_name?.[0] || user.email?.[0] || '?').toUpperCase()
  }

  const getColor = (userId: string) => {
    const colors = ['#E06C75', '#61AFEF', '#98C379', '#E5C07B', '#C678DD', '#56B6C2', '#BE5046', '#D19A66']
    let hash = 0
    for (let i = 0; i < userId.length; i++) {
      hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0
    }
    return colors[Math.abs(hash) % colors.length]
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>Chat</span>
      </div>
      <div className="chat-messages" ref={containerRef}>
        {loading && <div className="chat-loading">Loading messages...</div>}
        {!loading && messages.length === 0 && (
          <div className="chat-empty">No messages yet</div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="chat-message">
            <div
              className="chat-avatar"
              style={{ backgroundColor: getColor(msg.user.id) }}
            >
              {getInitial(msg.user)}
            </div>
            <div className="chat-message-body">
              <div className="chat-message-header">
                <span className="chat-user-name">
                  {msg.user.first_name}{msg.user.last_name ? ' ' + msg.user.last_name : ''}
                </span>
                <span className="chat-time">{formatTime(msg.timestamp)}</span>
              </div>
              <div className="chat-message-content">{msg.content}</div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a message..."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          disabled={sending}
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || sending}
        >
          Send
        </button>
      </div>
    </div>
  )
}
