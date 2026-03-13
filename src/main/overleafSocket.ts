// Persistent Socket.IO v0.9 client for real-time Overleaf collaboration
import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { net } from 'electron'
import {
  parseSocketMessage,
  encodeEvent,
  encodeEventWithAck,
  encodeHeartbeat
} from './overleafProtocol'

/** Decode WebSocket-encoded UTF-8 text (reverses server's unescape(encodeURIComponent(text))) */
function decodeUtf8(text: string): string {
  try {
    return decodeURIComponent(escape(text))
  } catch {
    return text // already decoded or pure ASCII
  }
}

export interface JoinProjectResult {
  publicId: string
  project: {
    _id: string
    name: string
    rootDoc_id: string
    rootFolder: RootFolder[]
    owner: { _id: string; first_name: string; last_name: string; email: string }
  }
  permissionsLevel: string
}

export interface RootFolder {
  _id: string
  name: string
  docs: DocRef[]
  fileRefs: FileRef[]
  folders: SubFolder[]
}

export interface SubFolder {
  _id: string
  name: string
  docs: DocRef[]
  fileRefs: FileRef[]
  folders: SubFolder[]
}

export interface DocRef {
  _id: string
  name: string
}

export interface FileRef {
  _id: string
  name: string
  linkedFileData?: unknown
  created: string
}

export interface CommentOp {
  c: string
  p: number
  t: string
}

export interface JoinDocResult {
  docLines: string[]
  version: number
  updates: unknown[]
  ranges: {
    comments: Array<{ id: string; op: CommentOp }>
    changes: unknown[]
  }
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export class OverleafSocket extends EventEmitter {
  private ws: WebSocket | null = null
  private cookie: string = ''
  private projectId: string = ''
  private sid: string = ''
  private ackId = 0
  private ackCallbacks = new Map<number, (data: unknown) => void>()
  private eventWaiters = new Map<string, (args: unknown[]) => void>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private maxReconnectDelay = 30000
  private joinedDocs = new Set<string>()
  private _state: ConnectionState = 'disconnected'
  private _projectData: JoinProjectResult | null = null
  private shouldReconnect = true

  get state(): ConnectionState {
    return this._state
  }

  get projectData(): JoinProjectResult | null {
    return this._projectData
  }

  get publicId(): string | null {
    return this._projectData?.publicId || null
  }

  private setState(s: ConnectionState) {
    this._state = s
    this.emit('connectionState', s)
  }

  async connect(projectId: string, cookie: string): Promise<JoinProjectResult> {
    this.projectId = projectId
    this.cookie = cookie
    this.shouldReconnect = true
    return this.doConnect()
  }

  private async doConnect(): Promise<JoinProjectResult> {
    this.setState('connecting')

    // Step 1: HTTP handshake to get SID
    const hsData = await this.handshake()
    this.sid = hsData.sid

    // Step 2: Open WebSocket
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://www.overleaf.com/socket.io/1/websocket/${this.sid}`
      this.ws = new WebSocket(wsUrl, {
        headers: { Cookie: this.cookie }
      })

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'))
        this.ws?.close()
      }, 30000)

      this.ws.on('open', () => {
        // Wait for connect message (1::) then joinProject
      })

      this.ws.on('message', (data: WebSocket.Data) => {
        const raw = data.toString()
        this.handleMessage(raw, resolve, reject, timeout)
      })

      this.ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })

      this.ws.on('close', () => {
        this.stopHeartbeat()
        if (this._state === 'connected' && this.shouldReconnect) {
          this.scheduleReconnect()
        }
      })
    })
  }

  private connectResolveFn: ((result: JoinProjectResult) => void) | null = null
  private connectRejectFn: ((err: Error) => void) | null = null
  private connectTimeout: ReturnType<typeof setTimeout> | null = null

  private handleMessage(
    raw: string,
    connectResolve?: (result: JoinProjectResult) => void,
    connectReject?: (err: Error) => void,
    connectTimeout?: ReturnType<typeof setTimeout>
  ) {
    const msg = parseSocketMessage(raw)
    if (!msg) return

    switch (msg.type) {
      case 'connect':
        // Server acknowledged connection, now joinProject
        this.sendJoinProject(connectResolve, connectReject, connectTimeout)
        break

      case 'heartbeat':
        this.ws?.send(encodeHeartbeat())
        break

      case 'ack':
        if (msg.id !== undefined) {
          const cb = this.ackCallbacks.get(msg.id)
          if (cb) {
            this.ackCallbacks.delete(msg.id)
            cb(msg.data)
          }
        }
        break

      case 'event':
        if (msg.name) {
          // Check if someone is waiting for this event name
          const waiter = this.eventWaiters.get(msg.name)
          if (waiter) {
            this.eventWaiters.delete(msg.name)
            waiter(msg.args || [])
          }
          // Relay real-time events to listeners
          this.emit('serverEvent', msg.name, msg.args || [])

          // Handle specific real-time events
          if (msg.name === 'otUpdateApplied') {
            this.emit('otAck', msg.args?.[0])
          } else if (msg.name === 'otUpdateError') {
            this.emit('otError', msg.args?.[0])
          }
        }
        break

      case 'disconnect':
        this.ws?.close()
        break
    }
  }

  private sendJoinProject(
    resolve?: (result: JoinProjectResult) => void,
    reject?: (err: Error) => void,
    timeout?: ReturnType<typeof setTimeout>
  ) {
    // joinProject uses a named event, response comes as joinProjectResponse event
    const jpPromise = this.waitForEvent('joinProjectResponse')

    this.ws?.send(encodeEvent('joinProject', [{ project_id: this.projectId }]))

    jpPromise.then((args) => {
      if (timeout) clearTimeout(timeout)

      // Find the project data in the response args
      let projectResult: JoinProjectResult | null = null
      for (const arg of args) {
        if (arg && typeof arg === 'object' && 'project' in (arg as object)) {
          projectResult = arg as JoinProjectResult
          break
        }
      }

      if (!projectResult) {
        reject?.(new Error('joinProject: no project data in response'))
        return
      }

      this._projectData = projectResult
      this.setState('connected')
      this.reconnectAttempt = 0
      this.startHeartbeat()
      resolve?.(projectResult)
    }).catch((err) => {
      if (timeout) clearTimeout(timeout)
      reject?.(err)
    })
  }

  async joinDoc(docId: string): Promise<JoinDocResult> {
    const result = await this.emitWithAck('joinDoc', [docId, { encodeRanges: true }]) as unknown[]
    this.joinedDocs.add(docId)

    // Ack response format: [error, docLines, version, updates, ranges, pathname]
    const err = result[0]
    if (err) throw new Error(`joinDoc failed: ${JSON.stringify(err)}`)

    // Server encodes lines + range text via unescape(encodeURIComponent(text))
    // for safe WebSocket transport. Decode with decodeURIComponent(escape(text)).
    const rawLines = (result[1] as string[]) || []
    const docLines = rawLines.map(line => decodeUtf8(line))
    const version = (result[2] as number) || 0
    const updates = (result[3] as unknown[]) || []
    const rawRanges = result[4] as JoinDocResult['ranges'] | undefined

    // Decode range text (op.c, op.i, op.d) — positions (op.p) stay as-is
    const ranges = rawRanges || { comments: [], changes: [] }
    if (ranges.comments) {
      for (const c of ranges.comments) {
        if (c.op?.c) c.op.c = decodeUtf8(c.op.c)
      }
    }
    if (ranges.changes) {
      for (const ch of ranges.changes as any[]) {
        if (ch.op?.i) ch.op.i = decodeUtf8(ch.op.i)
        if (ch.op?.d) ch.op.d = decodeUtf8(ch.op.d)
      }
    }

    return { docLines, version, updates, ranges }
  }

  async leaveDoc(docId: string): Promise<void> {
    await this.emitWithAck('leaveDoc', [docId])
    this.joinedDocs.delete(docId)
  }

  async applyOtUpdate(docId: string, ops: unknown[], version: number, hash: string): Promise<void> {
    // Fire-and-forget: server responds with otUpdateApplied or otUpdateError event
    this.ws?.send(encodeEvent('applyOtUpdate', [docId, { doc: docId, op: ops, v: version, hash, lastV: version }]))
  }

  /** Get list of connected users with their cursor positions */
  async getConnectedUsers(): Promise<unknown[]> {
    const result = await this.emitWithAck('clientTracking.getConnectedUsers', []) as unknown[]
    // result format: [error, usersArray]
    const err = result[0]
    if (err) throw new Error(`getConnectedUsers failed: ${JSON.stringify(err)}`)
    return (result[1] as unknown[]) || []
  }

  /** Send our cursor position */
  updateCursorPosition(docId: string, row: number, column: number): void {
    this.ws?.send(encodeEvent('clientTracking.updatePosition', [{ row, column, doc_id: docId }]))
  }

  disconnect() {
    this.shouldReconnect = false
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.joinedDocs.clear()
    this.ackCallbacks.clear()
    this.eventWaiters.clear()
    this.ws?.close()
    this.ws = null
    this._projectData = null
    this.setState('disconnected')
  }

  private async handshake(): Promise<{ sid: string; setCookies: string[] }> {
    return new Promise((resolve, reject) => {
      const url = `https://www.overleaf.com/socket.io/1/?t=${Date.now()}&projectId=${this.projectId}`
      const req = net.request(url)
      req.setHeader('Cookie', this.cookie)
      req.setHeader('User-Agent', 'Mozilla/5.0')

      let body = ''
      const setCookies: string[] = []

      req.on('response', (res) => {
        const rawHeaders = res.headers['set-cookie']
        if (rawHeaders) {
          if (Array.isArray(rawHeaders)) {
            setCookies.push(...rawHeaders)
          } else {
            setCookies.push(rawHeaders)
          }
        }
        res.on('data', (chunk) => { body += chunk.toString() })
        res.on('end', () => {
          const sid = body.split(':')[0]
          if (!sid) {
            reject(new Error('handshake: no SID in response'))
            return
          }
          // Merge GCLB cookies into our cookie string
          for (const sc of setCookies) {
            const part = sc.split(';')[0]
            if (part && !this.cookie.includes(part)) {
              this.cookie += '; ' + part
            }
          }
          resolve({ sid, setCookies })
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  private emitWithAck(name: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'))
        return
      }
      this.ackId++
      const id = this.ackId
      const timer = setTimeout(() => {
        this.ackCallbacks.delete(id)
        reject(new Error(`ack timeout for ${name}`))
      }, 30000)

      this.ackCallbacks.set(id, (data) => {
        clearTimeout(timer)
        resolve(data)
      })

      this.ws.send(encodeEventWithAck(id, name, args))
    })
  }

  private waitForEvent(name: string): Promise<unknown[]> {
    return new Promise((resolve) => {
      this.eventWaiters.set(name, resolve)
    })
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(encodeHeartbeat())
      }
    }, 25000)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private scheduleReconnect() {
    this.setState('reconnecting')
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), this.maxReconnectDelay)
    this.reconnectAttempt++

    console.log(`[OverleafSocket] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`)

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.doConnect()
        // Re-join docs
        for (const docId of this.joinedDocs) {
          try {
            const result = await this.joinDoc(docId)
            this.emit('docRejoined', docId, result)
          } catch (e) {
            console.log(`[OverleafSocket] failed to rejoin doc ${docId}:`, e)
          }
        }
      } catch (e) {
        console.log('[OverleafSocket] reconnect failed:', e)
        if (this.shouldReconnect) {
          this.scheduleReconnect()
        }
      }
    }, delay)
  }
}
