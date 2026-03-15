#!/usr/bin/env node
// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// MCP Server: LatteX
// Provides tools for Claude Code to interact with the Overleaf project:
// comments, chat, file listing, compilation

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, readdirSync, statSync } from 'fs'
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

// ── HTTP helper ────────────────────────────────────────────────

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
  {
    name: 'compile_latex',
    description: 'Trigger LaTeX compilation of the project. Returns compilation status and log output.',
    inputSchema: {
      type: 'object',
      properties: {
        main_file: {
          type: 'string',
          description: 'Optional main .tex file path (e.g. "main.tex"). Uses project default if omitted.'
        }
      }
    }
  }
]

// ── Server ─────────────────────────────────────────────────────

const server = new Server(
  { name: 'lattex', version: '2.0.0' },
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
          if (f.isDir) return `📁 ${f.path}`
          const sizeKb = (f.size / 1024).toFixed(1)
          return `   ${f.path} (${sizeKb} KB)`
        })

        return textResult(
          `${files.filter(f => !f.isDir).length} files in project:\n\n${lines.join('\n')}`
        )
      }

      case 'compile_latex': {
        // Compilation happens via the LatteX app's local LaTeX installation
        // We trigger it by writing a signal file that the app watches,
        // or we can call the Overleaf compile endpoint
        const mainFile = args?.main_file || null

        // Use Overleaf's server-side compilation
        const body = {
          check: 'silent',
          draft: false,
          incrementalCompilesEnabled: true,
          rootDoc_id: null,
          stopOnFirstError: false
        }

        // If a specific main file is given, find its docId
        if (mainFile && pathDocMap) {
          const docId = pathDocMap[mainFile]
          if (docId) body.rootDoc_id = docId
        }

        const result = await overleafRequest(
          'POST',
          `/project/${projectId}/compile`,
          cookie,
          csrf,
          body
        )

        if (!result.ok) {
          return errorResult(`Compilation request failed: HTTP ${result.status}`)
        }

        const compileData = result.data
        const status = compileData?.status || 'unknown'

        if (status === 'success') {
          return textResult('Compilation successful.')
        } else if (status === 'failure' || status === 'error') {
          // Try to extract error info from output files
          const outputFiles = compileData?.outputFiles || []
          const logFile = outputFiles.find(f => f.path === 'output.log')
          if (logFile) {
            // Fetch the log
            const logUrl = `/project/${projectId}/output/${logFile.path}?build=${logFile.build}`
            const logResult = await overleafRequest('GET', logUrl, cookie, csrf)
            if (logResult.ok && typeof logResult.data === 'string') {
              // Extract just the error lines
              const logLines = logResult.data.split('\n')
              const errorLines = logLines.filter(l =>
                l.startsWith('!') || l.includes('Error') || l.includes('error')
              ).slice(0, 20)

              return textResult(
                `Compilation failed.\n\nErrors:\n${errorLines.join('\n') || 'See full log for details.'}`
              )
            }
          }
          return textResult(`Compilation failed with status: ${status}`)
        } else {
          return textResult(`Compilation status: ${status}`)
        }
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
