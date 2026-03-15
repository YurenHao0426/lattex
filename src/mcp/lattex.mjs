#!/usr/bin/env node
// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// MCP Server: LatteX
// Provides tools for Claude Code to interact with the Overleaf project:
// comments, chat, file listing, compilation + debugging

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join, relative } from 'path'
import https from 'https'

// ── State ──────────────────────────────────────────────────────

function readState() {
  const cwd = process.cwd()
  const statePath = join(cwd, '.lattex-mcp.json')
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch {
    throw new Error(
      'Cannot read .lattex-mcp.json — is LatteX running and connected to an Overleaf project?'
    )
  }
}

// Last compile result — cached so get_compile_errors/warnings/log can access it
let lastCompileLog = null   // string
let lastCompileStatus = null // string

// ── HTTP helpers ──────────────────────────────────────────────

function overleafRequest(method, path, cookie, csrf, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.overleaf.com',
      path,
      method,
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    }
    if (body) {
      options.headers['Content-Type'] = 'application/json'
    }
    if (csrf && method !== 'GET') {
      options.headers['x-csrf-token'] = csrf
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          parsed = data
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          data: parsed
        })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

/** Fetch binary/text content from a full URL (for CDN downloads) */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    }

    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          data: buf.toString('utf-8')
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Log parsing ──────────────────────────────────────────────

function parseCompileLog(raw) {
  const entries = []
  const lines = raw.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]

    // LaTeX Error: ! ...
    if (/^!/.test(ln) || /LaTeX Error:/.test(ln)) {
      let msg = ln.replace(/^!\s*/, '')
      while (i + 1 < lines.length && lines[i + 1] && !lines[i + 1].startsWith('l.') && !lines[i + 1].startsWith('!')) {
        i++
        if (lines[i].trim()) msg += ' ' + lines[i].trim()
      }
      let lineNum = undefined
      if (i + 1 < lines.length && /^l\.(\d+)/.test(lines[i + 1])) {
        i++
        lineNum = parseInt(lines[i].match(/^l\.(\d+)/)[1])
      }
      entries.push({ level: 'error', message: msg.trim(), line: lineNum })
      continue
    }

    // file:line: error pattern
    const fileLineErr = ln.match(/^\.\/(.+?):(\d+):\s*(.+)/)
    if (fileLineErr) {
      const msg = fileLineErr[3]
      const isWarning = /warning/i.test(msg)
      entries.push({
        level: isWarning ? 'warning' : 'error',
        message: msg,
        file: fileLineErr[1],
        line: parseInt(fileLineErr[2])
      })
      continue
    }

    // Package ... Warning:
    const pkgWarn = ln.match(/Package (\S+) Warning:\s*(.*)/)
    if (pkgWarn) {
      let msg = `[${pkgWarn[1]}] ${pkgWarn[2]}`
      let warnLine = undefined
      while (i + 1 < lines.length && /^\(/.test(lines[i + 1])) {
        i++
        const contLine = lines[i]
        msg += ' ' + contLine.replace(/^\([^)]*\)\s*/, '').trim()
        const lineMatch = contLine.match(/on input line (\d+)/)
        if (lineMatch) warnLine = parseInt(lineMatch[1])
      }
      if (!warnLine) {
        const lineMatch = msg.match(/on input line (\d+)/)
        if (lineMatch) warnLine = parseInt(lineMatch[1])
      }
      entries.push({ level: 'warning', message: msg.trim(), line: warnLine })
      continue
    }

    // LaTeX Warning:
    const latexWarn = ln.match(/LaTeX Warning:\s*(.*)/)
    if (latexWarn) {
      let msg = latexWarn[1]
      while (i + 1 < lines.length && lines[i + 1] && !lines[i + 1].match(/^[(!.]/) && lines[i + 1].startsWith(' ')) {
        i++
        msg += ' ' + lines[i].trim()
      }
      const lineMatch = msg.match(/on input line (\d+)/)
      entries.push({ level: 'warning', message: msg.trim(), line: lineMatch ? parseInt(lineMatch[1]) : undefined })
      continue
    }

    // Overfull / Underfull
    const overunder = ln.match(/^(Overfull|Underfull) .* at lines (\d+)--(\d+)/)
    if (overunder) {
      entries.push({ level: 'warning', message: ln.trim(), line: parseInt(overunder[2]) })
      continue
    }
    if (/^(Overfull|Underfull)/.test(ln)) {
      const paraMatch = ln.match(/in paragraph at lines (\d+)--(\d+)/)
      entries.push({ level: 'warning', message: ln.trim(), line: paraMatch ? parseInt(paraMatch[1]) : undefined })
      continue
    }

    // Missing file
    if (/File .* not found/.test(ln)) {
      entries.push({ level: 'error', message: ln.trim() })
      continue
    }
  }

  // Deduplicate
  const seen = new Set()
  return entries.filter((e) => {
    const key = `${e.level}:${e.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function formatEntry(e) {
  const loc = [e.file, e.line].filter(Boolean).join(':')
  return `[${e.level.toUpperCase()}]${loc ? ` ${loc}:` : ''} ${e.message}`
}

// ── Helpers ────────────────────────────────────────────────────

function fmtTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function userName(user) {
  if (!user) return ''
  return [user.first_name, user.last_name].filter(Boolean).join(' ') ||
    user.email?.split('@')[0] || ''
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

// Walk a directory recursively and return relative paths
function walkDir(dir, base) {
  const results = []
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue
      const full = join(dir, entry)
      const rel = relative(base, full)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          results.push({ path: rel + '/', size: 0, isDir: true })
          results.push(...walkDir(full, base))
        } else {
          results.push({ path: rel, size: st.size, isDir: false })
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return results
}

/** Build CLSI output file URL from compile response data */
function buildOutputUrl(file, data) {
  const params = new URLSearchParams()
  if (data.compileGroup) params.set('compileGroup', data.compileGroup)
  if (data.clsiServerId) params.set('clsiserverid', data.clsiServerId)
  const base = (file.build && data.pdfDownloadDomain)
    ? `${data.pdfDownloadDomain}${file.url}`
    : `https://www.overleaf.com${file.url}`
  return `${base}?${params}`
}

// ── Compile + fetch log helper ──────────────────────────────

async function compileAndFetchLog(projectId, cookie, csrf, pathDocMap, mainFile) {
  // Flush in-memory OT changes to database so CLSI sees latest content
  try {
    await overleafRequest('POST', `/project/${projectId}/flush`, cookie, csrf)
  } catch {}

  const body = {
    check: 'silent',
    draft: false,
    incrementalCompilesEnabled: true,
    rootDoc_id: null,
    stopOnFirstError: false
  }

  if (mainFile && pathDocMap) {
    const docId = pathDocMap[mainFile]
    if (docId) body.rootDoc_id = docId
  }

  const result = await overleafRequest(
    'POST',
    `/project/${projectId}/compile?auto_compile=false`,
    cookie,
    csrf,
    body
  )

  if (!result.ok) {
    throw new Error(`Compilation request failed: HTTP ${result.status}`)
  }

  const compileData = result.data
  lastCompileStatus = compileData?.status || 'unknown'

  // Fetch the log via CDN URL
  const outputFiles = compileData?.outputFiles || []
  const logFile = outputFiles.find(f => f.path === 'output.log')
  if (logFile) {
    const logUrl = buildOutputUrl(logFile, compileData)
    const logResult = await fetchUrl(logUrl)
    if (logResult.ok) {
      lastCompileLog = logResult.data
    }
  }

  return { status: lastCompileStatus, hasLog: !!lastCompileLog }
}

// ── Tool definitions ───────────────────────────────────────────

const TOOLS = [
  // ── Comments ──
  {
    name: 'get_comments',
    description:
      'Get unresolved Overleaf comments. Optionally filter by file path. Returns comment text, position, author, time, and thread_id for each comment.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            'Optional file path to filter comments (e.g. "latex/main.tex"). If omitted, returns all unresolved comments.'
        },
        include_resolved: {
          type: 'boolean',
          description: 'If true, also include resolved comments. Default: false.'
        }
      }
    }
  },
  {
    name: 'resolve_comment',
    description: 'Resolve (close) an Overleaf comment thread by its thread_id.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'The thread_id of the comment to resolve.'
        }
      },
      required: ['thread_id']
    }
  },
  {
    name: 'reopen_comment',
    description: 'Reopen a previously resolved Overleaf comment thread.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'The thread_id of the comment to reopen.'
        }
      },
      required: ['thread_id']
    }
  },
  {
    name: 'reply_to_comment',
    description: 'Reply to an existing Overleaf comment thread.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'The thread_id to reply to.'
        },
        content: {
          type: 'string',
          description: 'The reply message content.'
        }
      },
      required: ['thread_id', 'content']
    }
  },
  {
    name: 'delete_comment',
    description: 'Delete an entire Overleaf comment thread and its highlight. This is permanent.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'The thread_id of the comment to delete.'
        }
      },
      required: ['thread_id']
    }
  },
  // ── Chat ──
  {
    name: 'get_chat_messages',
    description: 'Get recent chat messages from the Overleaf project.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max number of messages to return. Default: 50.'
        }
      }
    }
  },
  {
    name: 'send_chat_message',
    description: 'Send a message to the Overleaf project chat.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The message text to send.'
        }
      },
      required: ['content']
    }
  },
  // ── Project ──
  {
    name: 'list_project_files',
    description: 'List all files in the synced project directory with their paths and sizes.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // ── Compilation ──
  {
    name: 'compile_latex',
    description: 'Trigger LaTeX compilation on Overleaf server. Returns status and a summary of errors/warnings. Use get_compile_errors, get_compile_warnings, or get_compile_log for details.',
    inputSchema: {
      type: 'object',
      properties: {
        main_file: {
          type: 'string',
          description: 'Optional main .tex file path (e.g. "main.tex"). Uses project default if omitted.'
        }
      }
    }
  },
  {
    name: 'get_compile_errors',
    description: 'Get LaTeX errors from the last compilation. Returns parsed error messages with file paths and line numbers. Run compile_latex first.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_compile_warnings',
    description: 'Get LaTeX warnings from the last compilation. Returns parsed warnings with file paths and line numbers. Run compile_latex first.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_compile_log',
    description: 'Get the full raw LaTeX compilation log from the last compile. Run compile_latex first. Warning: can be very large.',
    inputSchema: {
      type: 'object',
      properties: {
        tail: {
          type: 'number',
          description: 'Only return the last N lines of the log. Useful for large logs. Default: return all.'
        }
      }
    }
  }
]

// ── Server ─────────────────────────────────────────────────────

const server = new Server(
  { name: 'lattex', version: '3.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    const state = readState()
    const { projectId, cookie, csrf, commentContexts, pathDocMap } = state

    switch (name) {
      // ── Comments ──────────────────────────────────

      case 'get_comments': {
        const filterFile = args?.file || null
        const includeResolved = args?.include_resolved || false

        const result = await overleafRequest(
          'GET',
          `/project/${projectId}/threads`,
          cookie,
          csrf
        )
        if (!result.ok) {
          return errorResult(`Failed to fetch comments: HTTP ${result.status}`)
        }

        const threads = result.data
        const lines = []

        for (const [threadId, thread] of Object.entries(threads)) {
          if (!includeResolved && thread.resolved) continue
          const ctx = commentContexts?.[threadId]
          if (!ctx) continue
          if (filterFile && ctx.file !== filterFile) continue

          const firstMsg = thread.messages?.[0]
          if (!firstMsg) continue

          const author = userName(firstMsg.user)
          const time = fmtTime(firstMsg.timestamp)
          const attribution = [author, time].filter(Boolean).join(', ')
          const status = thread.resolved ? ' [RESOLVED]' : ''

          let entry = `Thread ${threadId}${status}:\n  File: ${ctx.file}\n  Position: ${ctx.pos}\n  Highlighted text: "${ctx.text}"\n  Comment: "${firstMsg.content}"${attribution ? ` — ${attribution}` : ''}`

          for (let i = 1; i < thread.messages.length; i++) {
            const reply = thread.messages[i]
            const rAuthor = userName(reply.user)
            const rTime = fmtTime(reply.timestamp)
            const rAttr = [rAuthor, rTime].filter(Boolean).join(', ')
            entry += `\n  Reply: "${reply.content}"${rAttr ? ` — ${rAttr}` : ''}`
          }

          lines.push(entry)
        }

        if (lines.length === 0) {
          return textResult(
            filterFile
              ? `No ${includeResolved ? '' : 'unresolved '}comments in ${filterFile}.`
              : `No ${includeResolved ? '' : 'unresolved '}comments.`
          )
        }

        return textResult(
          `${lines.length} comment(s):\n\n${lines.join('\n\n')}`
        )
      }

      case 'resolve_comment': {
        const threadId = args.thread_id
        const ctx = commentContexts?.[threadId]
        const docId = ctx ? pathDocMap?.[ctx.file] : null
        const docSegment = docId ? `/doc/${docId}` : ''
        const result = await overleafRequest(
          'POST',
          `/project/${projectId}${docSegment}/thread/${threadId}/resolve`,
          cookie,
          csrf,
          {}
        )
        return textResult(
          result.ok
            ? `Comment ${threadId} resolved.`
            : `Failed to resolve: HTTP ${result.status}`
        )
      }

      case 'reopen_comment': {
        const threadId = args.thread_id
        const ctx = commentContexts?.[threadId]
        const docId = ctx ? pathDocMap?.[ctx.file] : null
        const docSegment = docId ? `/doc/${docId}` : ''
        const result = await overleafRequest(
          'POST',
          `/project/${projectId}${docSegment}/thread/${threadId}/reopen`,
          cookie,
          csrf,
          {}
        )
        return textResult(
          result.ok
            ? `Comment ${threadId} reopened.`
            : `Failed to reopen: HTTP ${result.status}`
        )
      }

      case 'reply_to_comment': {
        const { thread_id: threadId, content } = args
        const result = await overleafRequest(
          'POST',
          `/project/${projectId}/thread/${threadId}/messages`,
          cookie,
          csrf,
          { content }
        )
        return textResult(
          result.ok
            ? `Replied to thread ${threadId}.`
            : `Failed to reply: HTTP ${result.status}`
        )
      }

      case 'delete_comment': {
        const threadId = args.thread_id
        const ctx = commentContexts?.[threadId]
        const docId = ctx ? pathDocMap?.[ctx.file] : null
        if (!docId) {
          return errorResult(`Cannot delete: no doc found for thread ${threadId}`)
        }
        const result = await overleafRequest(
          'DELETE',
          `/project/${projectId}/doc/${docId}/thread/${threadId}`,
          cookie,
          csrf
        )
        return textResult(
          result.ok
            ? `Comment ${threadId} deleted.`
            : `Failed to delete: HTTP ${result.status}`
        )
      }

      // ── Chat ──────────────────────────────────────

      case 'get_chat_messages': {
        const limit = args?.limit || 50
        const result = await overleafRequest(
          'GET',
          `/project/${projectId}/messages?limit=${limit}`,
          cookie,
          csrf
        )
        if (!result.ok) {
          return errorResult(`Failed to fetch chat: HTTP ${result.status}`)
        }

        const messages = result.data
        if (!Array.isArray(messages) || messages.length === 0) {
          return textResult('No chat messages.')
        }

        const lines = messages.map((msg) => {
          const author = userName(msg.user)
          const time = fmtTime(msg.timestamp)
          const attr = [author, time].filter(Boolean).join(', ')
          return `${attr ? `[${attr}] ` : ''}${msg.content}`
        })

        // Messages come newest-first from API, reverse for chronological
        lines.reverse()

        return textResult(
          `${messages.length} chat message(s):\n\n${lines.join('\n')}`
        )
      }

      case 'send_chat_message': {
        const { content } = args
        const result = await overleafRequest(
          'POST',
          `/project/${projectId}/messages`,
          cookie,
          csrf,
          { content }
        )
        return textResult(
          result.ok
            ? 'Message sent.'
            : `Failed to send: HTTP ${result.status}`
        )
      }

      // ── Project ───────────────────────────────────

      case 'list_project_files': {
        const cwd = process.cwd()
        const files = walkDir(cwd, cwd)
          .filter(f => !f.path.startsWith('.'))

        if (files.length === 0) {
          return textResult('No files found in project directory.')
        }

        const lines = files.map(f => {
          if (f.isDir) return `  ${f.path}`
          const sizeKb = (f.size / 1024).toFixed(1)
          return `  ${f.path} (${sizeKb} KB)`
        })

        return textResult(
          `${files.filter(f => !f.isDir).length} files in project:\n\n${lines.join('\n')}`
        )
      }

      // ── Compilation ───────────────────────────────

      case 'compile_latex': {
        const mainFile = args?.main_file || null
        const cwd = process.cwd()
        const requestPath = join(cwd, '.lattex-compile-request')
        const resultPath = join(cwd, '.lattex-compile-result')

        // Clean up any stale result file
        try { unlinkSync(resultPath) } catch {}

        // Write compile request for the main process to pick up
        const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        writeFileSync(requestPath, JSON.stringify({
          requestId,
          mainFile,
          timestamp: Date.now()
        }))

        // Poll for result (main process compiles + downloads PDF + updates UI)
        const timeout = 120000 // 2 minutes max
        const pollInterval = 500
        const start = Date.now()
        let result = null

        while (Date.now() - start < timeout) {
          await new Promise(r => setTimeout(r, pollInterval))
          try {
            if (existsSync(resultPath)) {
              result = JSON.parse(readFileSync(resultPath, 'utf-8'))
              unlinkSync(resultPath)
              break
            }
          } catch {}
        }

        if (!result) {
          // Timeout — fall back to direct compile
          try { unlinkSync(requestPath) } catch {}
          const { status } = await compileAndFetchLog(projectId, cookie, csrf, pathDocMap, mainFile)
          lastCompileStatus = status
          if (status === 'success') {
            return textResult('Compilation successful (direct, UI may not have updated).')
          }
          return textResult(`Compilation failed (status: ${status}). Use get_compile_log for details.`)
        }

        // Read compile log written by main process (avoids redundant compile API call)
        lastCompileStatus = result.status || (result.success ? 'success' : 'failure')
        const logPath = join(cwd, '.lattex-compile-log')
        try {
          lastCompileLog = readFileSync(logPath, 'utf-8')
        } catch {
          lastCompileLog = null
        }

        if (result.success) {
          if (lastCompileLog) {
            const entries = parseCompileLog(lastCompileLog)
            const warnings = entries.filter(e => e.level === 'warning')
            if (warnings.length > 0) {
              return textResult(
                `Compilation successful with ${warnings.length} warning(s). Use get_compile_warnings for details.`
              )
            }
          }
          return textResult('Compilation successful. No errors or warnings.')
        }

        // Failed — parse and summarize
        if (lastCompileLog) {
          const entries = parseCompileLog(lastCompileLog)
          const errors = entries.filter(e => e.level === 'error')
          const warnings = entries.filter(e => e.level === 'warning')

          const summary = [`Compilation failed (status: ${result.status || 'failure'}).`]
          if (errors.length > 0) {
            summary.push(`\n${errors.length} error(s):`)
            for (const e of errors.slice(0, 10)) {
              summary.push(`  ${formatEntry(e)}`)
            }
            if (errors.length > 10) summary.push(`  ... and ${errors.length - 10} more`)
          }
          if (warnings.length > 0) {
            summary.push(`\n${warnings.length} warning(s) — use get_compile_warnings for details.`)
          }
          if (errors.length === 0) {
            summary.push('\nNo LaTeX errors found in log. Use get_compile_log to inspect the raw output.')
          }
          return textResult(summary.join('\n'))
        }

        return textResult(`Compilation failed (status: ${result.status || 'failure'}). No log available.`)
      }

      case 'get_compile_errors': {
        if (!lastCompileLog) {
          return textResult('No compile log available. Run compile_latex first.')
        }

        const entries = parseCompileLog(lastCompileLog)
        const errors = entries.filter(e => e.level === 'error')

        if (errors.length === 0) {
          return textResult(`Last compile status: ${lastCompileStatus}. No errors found in log.`)
        }

        const lines = errors.map(formatEntry)
        return textResult(
          `${errors.length} error(s) (last compile: ${lastCompileStatus}):\n\n${lines.join('\n')}`
        )
      }

      case 'get_compile_warnings': {
        if (!lastCompileLog) {
          return textResult('No compile log available. Run compile_latex first.')
        }

        const entries = parseCompileLog(lastCompileLog)
        const warnings = entries.filter(e => e.level === 'warning')

        if (warnings.length === 0) {
          return textResult(`Last compile status: ${lastCompileStatus}. No warnings found in log.`)
        }

        const lines = warnings.map(formatEntry)
        return textResult(
          `${warnings.length} warning(s) (last compile: ${lastCompileStatus}):\n\n${lines.join('\n')}`
        )
      }

      case 'get_compile_log': {
        if (!lastCompileLog) {
          return textResult('No compile log available. Run compile_latex first.')
        }

        let log = lastCompileLog
        const tail = args?.tail
        if (tail && tail > 0) {
          const lines = log.split('\n')
          log = lines.slice(-tail).join('\n')
        }

        return textResult(
          `Compile log (status: ${lastCompileStatus}):\n\n${log}`
        )
      }

      default:
        return errorResult(`Unknown tool: ${name}`)
    }
  } catch (e) {
    return errorResult(`Error: ${e.message}`)
  }
})

// ── Start ──────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
