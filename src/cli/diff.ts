// Diff logic for comparing local files against the last-pulled snapshot

import { join, relative, sep } from 'path'
import { readFile, readdir, stat } from 'fs/promises'
import { createHash } from 'crypto'

export type ChangeType = 'added' | 'modified' | 'deleted'

export interface FileChange {
  path: string        // relative path
  type: ChangeType
  isText: boolean
}

// Text extensions matching Overleaf's set (from fileSyncBridge.ts)
const TEXT_EXTENSIONS = new Set([
  'tex', 'latex', 'sty', 'cls', 'bst', 'bib', 'bibtex', 'txt', 'tikz',
  'mtx', 'rtex', 'md', 'asy', 'lbx', 'bbx', 'cbx', 'm', 'lco', 'dtx',
  'ins', 'ist', 'def', 'clo', 'ldf', 'rmd', 'qmd', 'lua', 'py', 'gv',
  'mf', 'yml', 'yaml', 'lhs', 'lean', 'lean4', 'hs', 'mk', 'xmpdata',
  'cfg', 'rnw', 'ltx', 'inc',
  'fd', 'r', 'sh', 'json', 'xml', 'csv', 'tsv', 'html', 'css', 'js',
  'ts', 'c', 'cpp', 'h', 'hpp', 'java', 'rb', 'pl'
])

const EDITABLE_FILENAMES = new Set(['latexmkrc', '.latexmkrc', 'makefile', 'gnumakefile'])

export function isTextFile(relPath: string): boolean {
  const name = relPath.split('/').pop()?.toLowerCase() || ''
  if (EDITABLE_FILENAMES.has(name)) return true
  const ext = name.split('.').pop() || ''
  return TEXT_EXTENSIONS.has(ext)
}

/** Hash file contents with sha256 */
export async function hashFile(absPath: string): Promise<string> {
  const data = await readFile(absPath)
  return createHash('sha256').update(data).digest('hex')
}

/** Walk a directory, returning relative paths (forward slashes, no leading /) */
export async function walkDir(dir: string, base?: string): Promise<string[]> {
  const root = base || dir
  const results: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      // Skip the state file and hidden files
      if (entry.name === '.lattex-cli.json') continue
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...await walkDir(full, root))
      } else {
        results.push(relative(root, full).split(sep).join('/'))
      }
    }
  } catch { /* directory may not exist */ }
  return results
}

/** Compute diff between local files and stored hashes from last pull */
export async function computeDiff(
  dir: string,
  storedHashes: Record<string, string>,
  knownPaths: Set<string>
): Promise<FileChange[]> {
  const changes: FileChange[] = []
  const localFiles = await walkDir(dir)
  const localSet = new Set(localFiles)

  // Check for modified and added files
  for (const relPath of localFiles) {
    const absPath = join(dir, relPath)
    const hash = await hashFile(absPath)
    const storedHash = storedHashes[relPath]

    if (!storedHash && !knownPaths.has(relPath)) {
      changes.push({ path: relPath, type: 'added', isText: isTextFile(relPath) })
    } else if (storedHash && hash !== storedHash) {
      changes.push({ path: relPath, type: 'modified', isText: isTextFile(relPath) })
    }
  }

  // Check for deleted files
  for (const relPath of Object.keys(storedHashes)) {
    if (!localSet.has(relPath)) {
      changes.push({ path: relPath, type: 'deleted', isText: isTextFile(relPath) })
    }
  }

  return changes
}
