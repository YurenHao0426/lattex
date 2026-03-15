// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { useState, useRef, useEffect, useCallback } from 'react'
import { useAppStore } from '../stores/appStore'

interface SearchResult {
  file: string
  line: number
  content: string
  col: number
}

export default function SearchPanel() {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const doSearch = useCallback(async (q: string, cs: boolean) => {
    if (!q.trim()) {
      setResults([])
      return
    }
    setSearching(true)
    const res = await window.api.searchFiles(q, cs)
    setResults(res)
    setSearching(false)
  }, [])

  const handleInputChange = (val: string) => {
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val, caseSensitive), 300)
  }

  const handleCaseSensitiveToggle = () => {
    const newCs = !caseSensitive
    setCaseSensitive(newCs)
    if (query.trim()) doSearch(query, newCs)
  }

  const handleResultClick = async (result: SearchResult) => {
    const store = useAppStore.getState()

    if (store.fileContents[result.file]) {
      store.openFile(result.file, result.file.split('/').pop() || result.file)
      store.setPendingGoTo({ file: result.file, line: result.line })
      return
    }

    const docId = store.pathDocMap[result.file]
    if (docId) {
      try {
        const joinResult = await window.api.otJoinDoc(docId)
        if (joinResult.success && joinResult.content !== undefined) {
          useAppStore.getState().setFileContent(result.file, joinResult.content)
          if (joinResult.version !== undefined) {
            useAppStore.getState().setDocVersion(docId, joinResult.version)
          }
          useAppStore.getState().openFile(result.file, result.file.split('/').pop() || result.file)
          useAppStore.getState().setPendingGoTo({ file: result.file, line: result.line })
        }
      } catch { /* failed to join doc */ }
    }
  }

  // Group results by file
  const grouped = new Map<string, SearchResult[]>()
  for (const r of results) {
    const list = grouped.get(r.file) || []
    list.push(r)
    grouped.set(r.file, list)
  }

  return (
    <div className="search-panel">
      <div className="search-panel-header">
        <div className="search-input-row">
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Search in files..."
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') useAppStore.getState().toggleSearch()
              if (e.key === 'Enter') doSearch(query, caseSensitive)
            }}
          />
          <button
            className={`search-case-btn ${caseSensitive ? 'active' : ''}`}
            onClick={handleCaseSensitiveToggle}
            title="Case sensitive"
          >
            Aa
          </button>
        </div>
        {query && (
          <div className="search-status">
            {searching ? 'Searching...' : `${results.length} result${results.length !== 1 ? 's' : ''} in ${grouped.size} file${grouped.size !== 1 ? 's' : ''}`}
            {results.length >= 200 && ' (limited)'}
          </div>
        )}
      </div>
      <div className="search-results">
        {[...grouped.entries()].map(([file, matches]) => (
          <div key={file} className="search-file-group">
            <div className="search-file-name">{file}</div>
            {matches.map((r, i) => (
              <div
                key={i}
                className="search-result-item"
                onClick={() => handleResultClick(r)}
              >
                <span className="search-result-line">{r.line}</span>
                <span className="search-result-content">{r.content}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
