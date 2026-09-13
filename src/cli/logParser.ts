// LaTeX compile log parser (extracted from src/mcp/lattex.mjs)

export interface LogEntry {
  level: 'error' | 'warning'
  message: string
  file?: string
  line?: number
}

export function parseCompileLog(raw: string): LogEntry[] {
  const entries: LogEntry[] = []
  const lines = raw.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]

    if (/^!/.test(ln) || /LaTeX Error:/.test(ln)) {
      let msg = ln.replace(/^!\s*/, '')
      while (i + 1 < lines.length && lines[i + 1] && !lines[i + 1].startsWith('l.') && !lines[i + 1].startsWith('!')) {
        i++
        if (lines[i].trim()) msg += ' ' + lines[i].trim()
      }
      let lineNum: number | undefined
      if (i + 1 < lines.length && /^l\.(\d+)/.test(lines[i + 1])) {
        i++
        lineNum = parseInt(lines[i].match(/^l\.(\d+)/)![1])
      }
      entries.push({ level: 'error', message: msg.trim(), line: lineNum })
      continue
    }

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

    const pkgWarn = ln.match(/Package (\S+) Warning:\s*(.*)/)
    if (pkgWarn) {
      let msg = `[${pkgWarn[1]}] ${pkgWarn[2]}`
      let warnLine: number | undefined
      while (i + 1 < lines.length && /^\(/.test(lines[i + 1])) {
        i++
        msg += ' ' + lines[i].replace(/^\([^)]*\)\s*/, '').trim()
        const lineMatch = lines[i].match(/on input line (\d+)/)
        if (lineMatch) warnLine = parseInt(lineMatch[1])
      }
      if (!warnLine) {
        const lineMatch = msg.match(/on input line (\d+)/)
        if (lineMatch) warnLine = parseInt(lineMatch[1])
      }
      entries.push({ level: 'warning', message: msg.trim(), line: warnLine })
      continue
    }

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

    if (/^(Overfull|Underfull)/.test(ln)) {
      const paraMatch = ln.match(/at lines (\d+)--(\d+)/) || ln.match(/in paragraph at lines (\d+)--(\d+)/)
      entries.push({ level: 'warning', message: ln.trim(), line: paraMatch ? parseInt(paraMatch[1]) : undefined })
      continue
    }

    if (/File .* not found/.test(ln)) {
      entries.push({ level: 'error', message: ln.trim() })
    }
  }

  // Deduplicate
  const seen = new Set<string>()
  return entries.filter((e) => {
    const key = `${e.level}:${e.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function formatEntry(e: LogEntry): string {
  const loc = [e.file, e.line].filter(Boolean).join(':')
  return `[${e.level.toUpperCase()}]${loc ? ` ${loc}:` : ''} ${e.message}`
}
