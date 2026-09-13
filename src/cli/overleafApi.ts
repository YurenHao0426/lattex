// Headless Overleaf API client using Node.js https (no Electron dependency)
import https from 'https'
import http from 'http'
import { URL } from 'url'

export interface OverleafProject {
  id: string
  name: string
  owner: { _id: string; first_name: string; last_name: string; email: string }
  lastUpdated: string
  accessLevel: string
}

export interface OverleafApiResult {
  ok: boolean
  status: number
  data: unknown
  setCookies: string[]
}

export class OverleafApi {
  private cookie: string
  private csrfToken: string = ''

  constructor(cookie: string) {
    this.cookie = cookie
  }

  getCookie(): string {
    return this.cookie
  }

  getCsrfToken(): string {
    return this.csrfToken
  }

  /** Fetch CSRF token from the Overleaf project page HTML */
  async refreshCsrf(): Promise<void> {
    const result = await this.request('GET', '/project', { raw: true })
    if (!result.ok || typeof result.data !== 'string') {
      throw new Error(`Failed to fetch CSRF token: HTTP ${result.status}`)
    }
    const m = (result.data as string).match(/ol-csrfToken[^>]*content="([^"]+)"/)
    if (!m) {
      throw new Error('CSRF token not found in page — session may be expired')
    }
    this.csrfToken = m[1]
    // Also merge any set-cookie from that response
    this.mergeCookies(result.setCookies)
  }

  /** Verify that the stored cookie is valid */
  async verifySession(): Promise<boolean> {
    const result = await this.request('GET', '/user/projects')
    return result.ok && typeof result.data === 'object' && result.data !== null
  }

  /** List all projects */
  async listProjects(): Promise<OverleafProject[]> {
    const result = await this.request('GET', '/user/projects')
    if (!result.ok) {
      throw new Error(`Failed to list projects: HTTP ${result.status}`)
    }
    const data = result.data as { projects?: unknown[] }
    if (!data.projects || !Array.isArray(data.projects)) {
      throw new Error('Unexpected response format from /user/projects')
    }
    return data.projects.map((p: any) => ({
      id: p._id || p.id,
      name: p.name,
      owner: p.owner || { _id: '', first_name: '', last_name: '', email: '' },
      lastUpdated: p.lastUpdated || '',
      accessLevel: p.accessLevel || p.privileges || ''
    }))
  }

  /** Get project metadata by connecting via Socket.IO handshake + joinProject.
   *  Returns full file tree. Uses the WebSocket protocol from overleafSocket.ts
   *  but reimplemented with plain Node.js WebSocket. */
  async getProjectData(projectId: string): Promise<{
    project: {
      _id: string
      name: string
      rootDoc_id: string
      rootFolder: any[]
      owner: any
    }
    publicId: string
    permissionsLevel: string
  }> {
    // Use overleafSocket-compatible handshake + ws
    const { default: WebSocket } = await import('ws')
    const { parseSocketMessage, encodeEvent } = await import('../main/overleafProtocol')

    // Step 1: HTTP handshake to get SID
    const hsResult = await this.httpGet(
      `https://www.overleaf.com/socket.io/1/?t=${Date.now()}&projectId=${projectId}`
    )
    if (!hsResult.ok) {
      throw new Error(`Socket handshake failed: HTTP ${hsResult.status}`)
    }
    const sid = (hsResult.data as string).split(':')[0]
    if (!sid) throw new Error('No SID in handshake response')

    // Merge handshake cookies
    this.mergeCookies(hsResult.setCookies)

    // Step 2: WebSocket connection
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://www.overleaf.com/socket.io/1/websocket/${sid}`
      const ws = new WebSocket(wsUrl, { headers: { Cookie: this.cookie } })

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connection timeout'))
      }, 30000)

      let waitingForJoinResponse = false
      const handleJoinResponse = (args: unknown[]) => {
        for (const arg of args) {
          if (arg && typeof arg === 'object' && 'project' in (arg as object)) {
            clearTimeout(timeout)
            ws.close()
            resolve(arg as any)
            return
          }
        }
        clearTimeout(timeout)
        ws.close()
        reject(new Error('No project data in joinProject response'))
      }

      ws.on('message', (data: Buffer) => {
        const raw = data.toString()
        const msg = parseSocketMessage(raw)
        if (!msg) return

        switch (msg.type) {
          case 'connect':
            // Send joinProject
            ws.send(encodeEvent('joinProject', [{ project_id: projectId }]))
            waitingForJoinResponse = true
            break
          case 'heartbeat':
            ws.send('2::')
            break
          case 'event':
            if (msg.name === 'joinProjectResponse' && waitingForJoinResponse) {
              handleJoinResponse(msg.args || [])
            }
            break
        }
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  /** Join a doc and get its content via WebSocket */
  async getDocContent(projectId: string, docId: string): Promise<{
    lines: string[]
    version: number
  }> {
    const { default: WebSocket } = await import('ws')
    const {
      parseSocketMessage,
      encodeEvent,
      encodeEventWithAck,
      encodeHeartbeat
    } = await import('../main/overleafProtocol')

    // Handshake
    const hsResult = await this.httpGet(
      `https://www.overleaf.com/socket.io/1/?t=${Date.now()}&projectId=${projectId}`
    )
    if (!hsResult.ok) throw new Error(`Handshake failed: HTTP ${hsResult.status}`)
    const sid = (hsResult.data as string).split(':')[0]
    if (!sid) throw new Error('No SID in handshake')
    this.mergeCookies(hsResult.setCookies)

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `wss://www.overleaf.com/socket.io/1/websocket/${sid}`,
        { headers: { Cookie: this.cookie } }
      )
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')) }, 30000)
      let joinedProject = false
      let ackId = 0

      ws.on('message', (data: Buffer) => {
        const raw = data.toString()
        const msg = parseSocketMessage(raw)
        if (!msg) return

        if (msg.type === 'connect') {
          ws.send(encodeEvent('joinProject', [{ project_id: projectId }]))
        } else if (msg.type === 'heartbeat') {
          ws.send(encodeHeartbeat())
        } else if (msg.type === 'event' && msg.name === 'joinProjectResponse') {
          joinedProject = true
          ackId++
          ws.send(encodeEventWithAck(ackId, 'joinDoc', [docId, { encodeRanges: true }]))
        } else if (msg.type === 'ack' && joinedProject) {
          clearTimeout(timeout)
          const result = msg.data as unknown[]
          const err = result[0]
          if (err) { ws.close(); reject(new Error(`joinDoc failed: ${JSON.stringify(err)}`)); return }
          const rawLines = (result[1] as string[]) || []
          const lines = rawLines.map(line => {
            try { return decodeURIComponent(escape(line)) } catch { return line }
          })
          const version = (result[2] as number) || 0
          ws.close()
          resolve({ lines, version })
        }
      })

      ws.on('error', (err) => { clearTimeout(timeout); reject(err) })
    })
  }

  /** Download a binary file from Overleaf */
  async downloadFile(projectId: string, fileRefId: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = `https://www.overleaf.com/project/${projectId}/file/${fileRefId}`
      const req = https.request(url, {
        method: 'GET',
        headers: {
          Cookie: this.cookie,
          'User-Agent': 'Mozilla/5.0'
        }
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect
          const location = res.headers.location
          if (location) {
            this.fetchBinaryUrl(location).then(resolve, reject)
            return
          }
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      req.on('error', reject)
      req.end()
    })
  }

  private fetchBinaryUrl(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const mod = parsed.protocol === 'https:' ? https : http
      mod.get(url, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      }).on('error', reject)
    })
  }

  /** Upload a file to Overleaf (multipart form) */
  async uploadFile(
    projectId: string,
    folderId: string,
    fileName: string,
    fileData: Buffer,
    mimeType: string = 'application/octet-stream'
  ): Promise<{ entityId?: string; error?: string }> {
    if (!this.csrfToken) await this.refreshCsrf()

    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${fileName}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mimeType}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="qqfile"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'www.overleaf.com',
        path: `/project/${projectId}/upload?folder_id=${folderId}`,
        method: 'POST',
        headers: {
          Cookie: this.cookie,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
          'x-csrf-token': this.csrfToken
        }
      }, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => {
          try {
            const data = JSON.parse(body)
            if (data.success !== false && !data.error) {
              const entityId = data.entity_id || data.entityId || data.fileRef?._id || data.file?._id
              resolve({ entityId })
            } else {
              resolve({ error: data.error || 'Upload failed' })
            }
          } catch {
            resolve({ error: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` })
          }
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  /** Create a text doc on Overleaf */
  async createDoc(projectId: string, folderId: string, name: string): Promise<string> {
    const result = await this.requestWithCsrf('POST', `/project/${projectId}/doc`, {
      name,
      parent_folder_id: folderId
    })
    if (!result.ok || !(result.data as any)?._id) {
      throw new Error(`Create doc failed: HTTP ${result.status}`)
    }
    return (result.data as any)._id
  }

  /** Create a folder on Overleaf */
  async createFolder(projectId: string, parentFolderId: string, name: string): Promise<string> {
    const result = await this.requestWithCsrf('POST', `/project/${projectId}/folder`, {
      name,
      parent_folder_id: parentFolderId
    })
    if (!result.ok || !(result.data as any)?._id) {
      throw new Error(`Create folder failed: HTTP ${result.status}`)
    }
    return (result.data as any)._id
  }

  /** Delete an entity */
  async deleteEntity(projectId: string, entityType: 'doc' | 'file' | 'folder', entityId: string): Promise<void> {
    const result = await this.requestWithCsrf('DELETE', `/project/${projectId}/${entityType}/${entityId}`)
    if (!result.ok) {
      throw new Error(`Delete ${entityType} failed: HTTP ${result.status}`)
    }
  }

  /** Flush project (ensure OT changes are saved to database) */
  async flushProject(projectId: string): Promise<void> {
    await this.requestWithCsrf('POST', `/project/${projectId}/flush`)
  }

  /** Trigger Overleaf server-side compile */
  async compile(projectId: string, rootDocId?: string): Promise<{
    status: string
    outputFiles: Array<{ path: string; url: string; type: string; build?: string }>
    compileGroup?: string
    clsiServerId?: string
    pdfDownloadDomain?: string
  }> {
    await this.flushProject(projectId)

    const body: any = {
      check: 'silent',
      draft: false,
      incrementalCompilesEnabled: true,
      rootDoc_id: rootDocId || null,
      stopOnFirstError: false
    }

    const result = await this.requestWithCsrf(
      'POST',
      `/project/${projectId}/compile?auto_compile=false`,
      body
    )
    if (!result.ok) {
      throw new Error(`Compile request failed: HTTP ${result.status}`)
    }

    const data = result.data as any
    return {
      status: data.status || 'unknown',
      outputFiles: data.outputFiles || [],
      compileGroup: data.compileGroup,
      clsiServerId: data.clsiServerId,
      pdfDownloadDomain: data.pdfDownloadDomain
    }
  }

  /** Download an output file from the compile result */
  async downloadOutputFile(
    file: { url: string; build?: string },
    compileData: { pdfDownloadDomain?: string; compileGroup?: string; clsiServerId?: string }
  ): Promise<Buffer> {
    const params = new URLSearchParams()
    if (compileData.compileGroup) params.set('compileGroup', compileData.compileGroup)
    if (compileData.clsiServerId) params.set('clsiserverid', compileData.clsiServerId)
    const base = (file.build && compileData.pdfDownloadDomain)
      ? `${compileData.pdfDownloadDomain}${file.url}`
      : `https://www.overleaf.com${file.url}`
    const url = `${base}?${params}`

    return this.fetchBinaryUrl(url)
  }

  /** Fetch text from a URL (for compile logs) */
  async fetchText(url: string): Promise<string> {
    const buf = await this.fetchBinaryUrl(url)
    return buf.toString('utf-8')
  }

  // ── Private helpers ──

  private async requestWithCsrf(method: string, path: string, body?: object): Promise<OverleafApiResult> {
    if (!this.csrfToken) await this.refreshCsrf()
    const result = await this.request(method, path, { body })
    if (result.status === 403) {
      await this.refreshCsrf()
      return this.request(method, path, { body })
    }
    return result
  }

  private request(
    method: string,
    path: string,
    options: { body?: object; raw?: boolean } = {}
  ): Promise<OverleafApiResult> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {
        Cookie: this.cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
      if (!options.raw) headers.Accept = 'application/json'
      if (options.body) headers['Content-Type'] = 'application/json'
      if (this.csrfToken && method !== 'GET') headers['x-csrf-token'] = this.csrfToken

      const req = https.request({
        hostname: 'www.overleaf.com',
        path,
        method,
        headers
      }, (res) => {
        const setCookies: string[] = []
        const rawSc = res.headers['set-cookie']
        if (rawSc) setCookies.push(...(Array.isArray(rawSc) ? rawSc : [rawSc]))

        let body = ''
        res.on('data', (chunk) => { body += chunk.toString() })
        res.on('end', () => {
          let data: unknown = body
          if (!options.raw) {
            try { data = JSON.parse(body) } catch { /* not json */ }
          }
          resolve({
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            status: res.statusCode || 0,
            data,
            setCookies
          })
        })
      })

      req.on('error', (err) => {
        resolve({ ok: false, status: 0, data: err.message, setCookies: [] })
      })

      if (options.body) req.write(JSON.stringify(options.body))
      req.end()
    })
  }

  private httpGet(url: string): Promise<OverleafApiResult> {
    return new Promise((resolve) => {
      const parsed = new URL(url)
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          Cookie: this.cookie,
          'User-Agent': 'Mozilla/5.0'
        }
      }, (res) => {
        const setCookies: string[] = []
        const rawSc = res.headers['set-cookie']
        if (rawSc) setCookies.push(...(Array.isArray(rawSc) ? rawSc : [rawSc]))

        let body = ''
        res.on('data', (chunk) => { body += chunk.toString() })
        res.on('end', () => {
          resolve({
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            status: res.statusCode || 0,
            data: body,
            setCookies
          })
        })
      })
      req.on('error', (err) => {
        resolve({ ok: false, status: 0, data: err.message, setCookies: [] })
      })
      req.end()
    })
  }

  private mergeCookies(setCookies: string[]): void {
    for (const sc of setCookies) {
      const part = sc.split(';')[0]
      if (part && !this.cookie.includes(part)) {
        this.cookie += '; ' + part
      }
    }
  }
}
