// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useMemo, useCallback, useState } from 'react'
import { useAppStore } from '../stores/appStore'

/** LaTeX sectioning commands in hierarchical order (lowest number = highest level). */
const SECTION_LEVELS: Record<string, number> = {
  '\\part': 0,
  '\\chapter': 1,
  '\\section': 2,
  '\\subsection': 3,
  '\\subsubsection': 4,
  '\\paragraph': 5,
}

/**
 * Regex to match LaTeX sectioning commands.
 * Captures: (1) the command name, (2) optional *, (3) the title inside braces.
 * Handles \section{Title}, \section*{Title}, etc.
 */
const SECTION_REGEX = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*\{([^}]*)\}/g

interface OutlineEntry {
  /** The sectioning command without backslash, e.g. "section" */
  command: string
  /** The hierarchy level (0 = part, 5 = paragraph) */
  level: number
  /** The title text from inside the braces */
  title: string
  /** 1-based line number in the document */
  line: number
}

/**
 * Parse LaTeX document content and extract sectioning commands.
 */
function parseOutline(content: string): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]
    // Skip commented lines
    const trimmed = lineText.trimStart()
    if (trimmed.startsWith('%')) continue

    // Reset regex lastIndex for each line
    SECTION_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SECTION_REGEX.exec(lineText)) !== null) {
      // Check that the command is not inside a comment (% before the match on the same line)
      const beforeMatch = lineText.slice(0, match.index)
      if (beforeMatch.includes('%')) continue

      const command = match[1]
      const fullCommand = '\\' + command
      const level = SECTION_LEVELS[fullCommand]
      if (level === undefined) continue

      entries.push({
        command,
        level,
        title: match[2].trim(),
        line: i + 1, // 1-based
      })
    }
  }

  return entries
}

/**
 * Compute the visual indentation depth for each entry.
 * Instead of using absolute levels (which would leave gaps, e.g. if
 * a document uses \section and \subsubsection but not \subsection),
 * we compute relative depth based on the set of levels actually present.
 */
function computeDepths(entries: OutlineEntry[]): number[] {
  if (entries.length === 0) return []

  // Collect distinct levels present, sorted ascending
  const presentLevels = [...new Set(entries.map((e) => e.level))].sort((a, b) => a - b)
  const levelToDepth = new Map<number, number>()
  presentLevels.forEach((lvl, idx) => levelToDepth.set(lvl, idx))

  return entries.map((e) => levelToDepth.get(e.level) ?? 0)
}

/** Icon for each section level */
function sectionIcon(level: number): string {
  switch (level) {
    case 0: return 'P'   // \part
    case 1: return 'C'   // \chapter
    case 2: return 'S'   // \section
    case 3: return 'Ss'  // \subsection
    case 4: return 'Sss' // \subsubsection
    case 5: return 'p'   // \paragraph
    default: return '#'
  }
}

interface OutlineItemProps {
  entry: OutlineEntry
  depth: number
  isActive: boolean
  onClick: () => void
}

function OutlineItem({ entry, depth, isActive, onClick }: OutlineItemProps) {
  return (
    <div
      className={`outline-item ${isActive ? 'active' : ''}`}
      style={{ paddingLeft: depth * 16 + 12 }}
      onClick={onClick}
      title={`\\${entry.command}{${entry.title}} — line ${entry.line}`}
    >
      <span className="outline-item-icon">{sectionIcon(entry.level)}</span>
      <span className="outline-item-title">{entry.title || '(untitled)'}</span>
      <span className="outline-item-line">{entry.line}</span>
    </div>
  )
}

export default function OutlineView() {
  const activeTab = useAppStore((s) => s.activeTab)
  const fileContents = useAppStore((s) => s.fileContents)
  const setPendingGoTo = useAppStore((s) => s.setPendingGoTo)

  const [collapsed, setCollapsed] = useState(false)
  const [activeLineIndex, setActiveLineIndex] = useState<number | null>(null)

  const content = activeTab ? fileContents[activeTab] ?? '' : ''

  // Parse outline entries from current document content.
  // This recomputes whenever content changes, providing real-time updates.
  const entries = useMemo(() => parseOutline(content), [content])
  const depths = useMemo(() => computeDepths(entries), [entries])

  const handleItemClick = useCallback(
    (entry: OutlineEntry, index: number) => {
      if (!activeTab) return
      setActiveLineIndex(index)
      // Use the pendingGoTo mechanism to scroll the editor to the line
      setPendingGoTo({ file: activeTab, line: entry.line })
    },
    [activeTab, setPendingGoTo]
  )

  const isTexFile = activeTab?.endsWith('.tex') || activeTab?.endsWith('.ltx') || activeTab?.endsWith('.sty') || activeTab?.endsWith('.cls')

  return (
    <div className="outline-view">
      <div className="outline-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="outline-toggle">{collapsed ? '>' : 'v'}</span>
        <span>OUTLINE</span>
        {entries.length > 0 && (
          <span className="outline-count">{entries.length}</span>
        )}
      </div>
      {!collapsed && (
        <div className="outline-content">
          {!activeTab && (
            <div className="outline-empty">No file open</div>
          )}
          {activeTab && !isTexFile && (
            <div className="outline-empty">Not a LaTeX file</div>
          )}
          {activeTab && isTexFile && entries.length === 0 && (
            <div className="outline-empty">No sections found</div>
          )}
          {entries.map((entry, i) => (
            <OutlineItem
              key={`${entry.line}-${entry.command}`}
              entry={entry}
              depth={depths[i]}
              isActive={activeLineIndex === i}
              onClick={() => handleItemClick(entry, i)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
