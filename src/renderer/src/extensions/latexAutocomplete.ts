// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// LaTeX autocomplete — a port of Overleaf's source-editor completion system
// (services/web/frontend/js/features/source-editor/languages/latex, AGPL-3.0)
// onto regex-based context detection (no lezer grammar):
//   - same trigger rules (getCompletionMatches), same argument detection
//   - same snippet data (top-hundred + environment templates, verbatim)
//   - same apply behavior (extendOverUnpairedClosingBrace /
//     extendRequiredParameter brace handling)
//   - project-wide labels/citations/commands via the sync bridge and the
//     official /project/:id/metadata endpoint (package command snippets)
import {
  autocompletion,
  snippet,
  clearSnippet,
  startCompletion,
  closeCompletion,
  acceptCompletion,
  moveCompletionSelection,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { EditorView, keymap } from '@codemirror/view'
import { Prec, type EditorState, type Text } from '@codemirror/state'
import { remoteUpdateAnnotation } from './otSyncExtension'
import topHundredSnippets from '../data/latexTopHundred'
import { packageNames } from '../data/latexPackageNames'
import { environments as environmentTemplates, snippet as envSnippet } from '../data/latexEnvironmentTemplates'
import { bibliographyStyles, classNames } from '../data/latexClassesAndStyles'
import { useAppStore } from '../stores/appStore'

// ── Project-wide completion data (bridge + official metadata endpoint) ──

interface PackageCommand {
  caption: string
  snippet: string
  meta: string
  score: number
}

interface ProjectData {
  docs: Array<{ path: string; content: string }>
  serverLabels: Set<string>
  packageCommands: PackageCommand[]
  serverPackageNames: Set<string>
  version: number
}

const projectData: ProjectData = {
  docs: [],
  serverLabels: new Set(),
  packageCommands: [],
  serverPackageNames: new Set(),
  version: 0,
}

let syncTimer: ReturnType<typeof setInterval> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
// Bumped by start/stop; in-flight refreshes from a previous project discard
// their results instead of overwriting the current project's data.
let syncGeneration = 0
let lastDataFingerprint = ''

function fingerprintDocs(docs: Array<{ path: string; content: string }>, metaKey: string): string {
  let hash = 0
  for (const { path, content } of docs) {
    const s = `${path}:${content.length}:${content.slice(0, 64)}:${content.slice(-64)}`
    for (let i = 0; i < s.length; i++) hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0
  }
  return `${docs.length}|${hash}|${metaKey}`
}

async function refreshProjectData(projectId: string): Promise<void> {
  const generation = syncGeneration
  try {
    const [docs, metadata] = await Promise.all([
      window.api.syncGetAllDocContents(),
      window.api.overleafGetMetadata(projectId),
    ])
    if (generation !== syncGeneration) return // stale — project changed

    let metaKey = ''
    let labels = projectData.serverLabels
    let commands = projectData.packageCommands
    let pkgNames = projectData.serverPackageNames
    if (metadata.success && metadata.data?.projectMeta) {
      labels = new Set<string>()
      commands = []
      pkgNames = new Set<string>()
      const seenPkgs = new Set<string>()
      for (const docMeta of Object.values(metadata.data.projectMeta)) {
        for (const label of docMeta.labels || []) labels.add(label)
        for (const name of docMeta.packageNames || []) pkgNames.add(name)
        for (const [pkg, cmds] of Object.entries(docMeta.packages || {})) {
          if (seenPkgs.has(pkg)) continue
          seenPkgs.add(pkg)
          commands.push(...cmds)
        }
      }
      metaKey = `${labels.size}|${commands.length}|${pkgNames.size}`
    }

    // Skip the cache-invalidating version bump when nothing changed —
    // otherwise every 30s tick forces a full project rescan on next popup.
    const fingerprint = fingerprintDocs(docs, metaKey)
    projectData.docs = docs
    projectData.serverLabels = labels
    projectData.packageCommands = commands
    projectData.serverPackageNames = pkgNames
    if (fingerprint !== lastDataFingerprint) {
      lastDataFingerprint = fingerprint
      projectData.version++
    }
  } catch {
    // non-fatal — completions fall back to open-file data
  }
}

/** Start background refresh of project-wide completion data */
export function startAutocompleteSync(projectId: string): void {
  stopAutocompleteSync()
  refreshProjectData(projectId)
  syncTimer = setInterval(() => refreshProjectData(projectId), 30_000)
}

export function stopAutocompleteSync(): void {
  syncGeneration++
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  projectData.docs = []
  projectData.serverLabels = new Set()
  projectData.packageCommands = []
  projectData.serverPackageNames = new Set()
  lastDataFingerprint = ''
  projectData.version++
}

/** Debounced refresh — call after entity changes / external edits */
export function scheduleAutocompleteRefresh(projectId: string): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => refreshProjectData(projectId), 2000)
}

/** All doc contents: bridge data plus any newer open-editor contents */
function allDocContents(): Array<{ path: string; content: string }> {
  const { fileContents } = useAppStore.getState()
  const merged = new Map<string, string>()
  for (const { path, content } of projectData.docs) merged.set(path, content)
  for (const [path, content] of Object.entries(fileContents)) merged.set(path, content)
  return Array.from(merged.entries()).map(([path, content]) => ({ path, content }))
}

// ── Snippet template handling (port of snippets.ts) ─────────────────

// Convert Ace-style `$1` placeholders to CM `#{1}` and add a final
// tab-stop so Shift-Tab from the last field works.
const prepareSnippetTemplate = (template: string): string =>
  template.replace(/\$(\d+)/g, '#{$1}') + '${}'

const nextChar = (doc: Text, pos: number): string => doc.sliceString(pos, pos + 1)

// Count unclosed opening braces on the line up to `from`, minus closing
// braces after `to` (port of apply.ts countUnclosedBraces, with escaped
// braces `\{`/`\}` stripped first so they don't count as structural).
const countUnclosedBraces = (doc: Text, from: number, to: number): number => {
  const line = doc.lineAt(from)
  const textBefore = doc.sliceString(line.from, from).replace(/\\[{}]/g, '')
  const textAfter = doc.sliceString(to, line.to)
  const textAfterMatch = textAfter.match(/^[^\\]*/)
  const openBraces =
    (textBefore.match(/\{/g) || []).length - (textBefore.match(/}/g) || []).length
  const closedBraces = textAfterMatch
    ? (textAfterMatch[0].match(/}/g) || []).length - (textAfterMatch[0].match(/\{/g) || []).length
    : 0
  return openBraces - closedBraces
}

// Port of extendOverUnpairedClosingBrace: swallow a stray `}` directly
// after the completed range when the line has an unpaired closing brace.
const extendedTo = (state: EditorState, from: number, to: number): number => {
  if (nextChar(state.doc, to) === '}') {
    if (countUnclosedBraces(state.doc, from, to) < 0) return to + 1
  }
  return to
}

/** Apply a snippet template with Overleaf's brace-swallowing behavior */
const applySnippet = (template: string, clear = false) => {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const end = extendedTo(view.state, from, to)
    snippet(prepareSnippetTemplate(template))(view, completion, from, end)
    if (clear) clearSnippet(view)
  }
}

const longestCommonPrefix = (...strs: string[]): number => {
  if (strs.length === 0) return 0
  const minLength = Math.min(...strs.map((str) => str.length))
  let prefixLength = 0
  for (; prefixLength < minLength; prefixLength++) {
    const char = strs[0][prefixLength]
    if (!strs.every((str) => str[prefixLength] === char)) break
  }
  return prefixLength
}

// Port of extendRequiredParameter: insert a parameter value, reusing or
// adding the closing brace and replacing any partially-typed key.
const applyParameter = (view: EditorView, completion: Completion, from: number, to: number) => {
  const state = view.state
  const doc = state.doc
  let insert = completion.label
  let end = to

  if (nextChar(doc, end) === '}') {
    // include the existing closing brace, so the cursor moves after it
    insert += '}'
    end++
  } else {
    if (countUnclosedBraces(doc, from, end) > 0) {
      insert += '}'
    }
    const line = doc.lineAt(from)
    const rest = doc.sliceString(end, line.to)
    const closeIdx = rest.indexOf('}')
    if (closeIdx !== -1) {
      // well-formed argument — replace subsequent text that isn't a
      // brace, space, or comma
      const match = rest.slice(0, closeIdx).match(/^[^}\s,]+/)
      if (match) end += match[0].length
    } else {
      // don't swallow a closing brace from unrelated text
      const restOfLine = doc.sliceString(end, Math.min(line.to, from + insert.length)).split('}')[0]
      end += longestCommonPrefix(insert.slice(end - from), restOfLine)
    }
  }

  view.dispatch({
    changes: { from, to: end, insert },
    selection: { anchor: from + insert.length },
    userEvent: 'input.complete',
    annotations: pickedCompletion.of(completion),
  })
}

// ── Command classification (port of lezer-latex tokens.mjs lists) ────

const REF_COMMANDS = new Set([
  'fullref', 'Vref', 'autopageref', 'autoref', 'eqref', 'labelcpageref',
  'labelcref', 'lcnamecref', 'lcnamecrefs', 'namecref', 'nameCref',
  'namecrefs', 'nameCrefs', 'thnameref', 'thref', 'titleref', 'vrefrange',
  'Crefrange', 'Crefrang', 'fref', 'pref', 'tref', 'Aref', 'Bref', 'Pref',
  'Sref', 'vref', 'nameref',
  'vpageref', 'zcpageref', 'zcref', 'zfullref', 'zref', 'zvpageref',
  'zvref', 'cref', 'Cref', 'pageref', 'ref', 'Ref', 'subref', 'zpageref',
  'ztitleref', 'vpagerefrange', 'zvpagerefrange', 'zvrefrange', 'crefrange',
])

const isCiteCommand = (name: string) => name.toLowerCase().includes('cite')
const isRefCommand = (name: string) => REF_COMMANDS.has(name.replace(/\*$/, ''))
const INPUT_COMMANDS = new Set(['input', 'include', 'subfile', 'subfileinclude'])
const PACKAGE_COMMANDS = new Set(['usepackage', 'RequirePackage'])
const BIBLIOGRAPHY_COMMANDS = new Set(['bibliography', 'addbibresource'])

// ── Trigger detection (port of complete.ts getCompletionMatches) ─────

interface CompletionMatches {
  match: RegExpMatchArray | null
  matchBefore: { from: number; to: number; text: string }
}

// Match `\command[opt]{existingKey1, existingKey2, prefix` before the cursor.
// Differs from Overleaf's original in the `existing` group: keys are matched
// as `[^},]+` (a key cannot contain the comma separator) instead of `[^}]+`,
// which removes the exponential backtracking the original exhibits on lines
// like `\cite{k1, k2, …, k15} tail` when the overall match must fail.
const multipleArgumentMatcher =
  /^(?<before>\\(?<command>\w+)\*?(?<arguments>(\[[^\]]*?]|\{[^}]*?})+)?{)(?<existing>(?:[^},]+,\s*)+)?(?<prefix>[^},]+)?$/

function getCompletionMatches(context: CompletionContext): CompletionMatches | null {
  const matchBefore = context.explicit
    ? context.matchBefore(/(?:^|\\)[^\\]*(\[[^\]]*])?[^\\]*/)
    : context.matchBefore(/\\?\\[^\\]*(\[[^\]]*])?[^\\]*/)

  if (!matchBefore) return null

  if (!context.explicit) {
    // \\ is a line break, not a command prefix
    if (/\\\\$/.test(matchBefore.text)) return null
    // trailing whitespace ends the command, unless after a comma
    if (/[^,\s]\s+$/.test(matchBefore.text)) return null
  }

  const match = matchBefore.text.match(multipleArgumentMatcher)
  return { match, matchBefore }
}

interface ArgumentDetails {
  command: string
  from: number
  validFor: RegExp
  existingKeys: string[]
  matchBefore: { from: number; to: number; text: string }
}

function getArgumentDetails(context: CompletionContext): ArgumentDetails | null {
  const matches = getCompletionMatches(context)
  if (!matches?.match?.groups) return null
  const { match, matchBefore } = matches
  const groups = match.groups as {
    before: string; command: string; existing?: string; prefix?: string
  }
  const existing = groups.existing ?? ''
  return {
    command: groups.command,
    from: matchBefore.from + groups.before.length + existing.length,
    // Excludes ',' so typing a comma invalidates the result and the source
    // re-runs with a fresh `from` after the separator (multi-key support).
    validFor: /[^}\s,]*/,
    existingKeys: existing.split(',').map((k) => k.trim()).filter(Boolean),
    matchBefore,
  }
}

// ── Document scans (regex ports of doc-commands / doc-environments) ──
//
// Full-project scans are memoized for a short TTL (and invalidated by data
// refreshes) so opening the popup doesn't rescan every doc on each trigger.

function memoScan<T>(compute: () => T, ttlMs = 3000): () => T {
  let cached: T | undefined
  let cachedVersion = -1
  let expires = 0
  return () => {
    const now = Date.now()
    if (cached !== undefined && cachedVersion === projectData.version && now < expires) {
      return cached
    }
    cached = compute()
    cachedVersion = projectData.version
    expires = now + ttlMs
    return cached
  }
}

const scanLabels = memoScan(scanLabelsUncached)
const scanCitationKeys = memoScan(scanCitationKeysUncached)
const scanDocEnvironments = memoScan(scanDocEnvironmentsUncached)

function scanLabelsUncached(): Set<string> {
  const labels = new Set<string>(projectData.serverLabels)
  const labelRe = /\\(?:label|thlabel|zlabel)\{([^}]{1,80})\}/g
  const labelOptRe = /\blabel=\{?(.{1,80}?)[\s},\]]/g
  for (const { content } of allDocContents()) {
    let m: RegExpExecArray | null
    while ((m = labelRe.exec(content)) !== null) labels.add(m[1])
    while ((m = labelOptRe.exec(content)) !== null) labels.add(m[1])
  }
  return labels
}

function scanCitationKeysUncached(): Array<{ key: string; type: string; title?: string }> {
  const entries: Array<{ key: string; type: string; title?: string }> = []
  const seen = new Set<string>()
  for (const { path, content } of allDocContents()) {
    if (!path.endsWith('.bib')) continue
    const entryRe = /@(\w+)\s*\{\s*([^,\s}]+)/g
    let m: RegExpExecArray | null
    while ((m = entryRe.exec(content)) !== null) {
      const type = m[1].toLowerCase()
      if (type === 'string' || type === 'comment' || type === 'preamble') continue
      const key = m[2].trim()
      if (seen.has(key)) continue
      seen.add(key)
      const afterKey = content.slice(m.index, m.index + 2000)
      const titleMatch = afterKey.match(/\btitle\s*=\s*[{"]+([^}"]+)/i)
      entries.push({ key, type, title: titleMatch?.[1] })
    }
  }
  return entries
}

function scanExistingPackages(context: CompletionContext): Set<string> {
  const names = new Set<string>()
  const re = /\\usepackage(?:\[.*?])?\{(\w+)\}/g
  const { activeTab } = useAppStore.getState()
  // Scan every doc EXCEPT the one being edited — its store copy may still
  // contain the package name on the very line the user is retyping.
  for (const { path, content } of allDocContents()) {
    if (path === activeTab) continue
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) names.add(m[1])
  }
  // For the active doc, use the live buffer and skip the line being typed
  const doc = context.state.doc
  const cursorLine = context.state.doc.lineAt(context.pos).number
  for (let i = 1; i <= doc.lines; i++) {
    if (i === cursorLine) continue
    const line = doc.line(i)
    let m: RegExpExecArray | null
    const lineRe = /\\usepackage(?:\[.*?])?\{(\w+)\}/g
    while ((m = lineRe.exec(line.text)) !== null) names.add(m[1])
  }
  return names
}

interface DocCommand {
  title: string
  optionalArgCount: number
  requiredArgCount: number
  count: number
}

function scanDocCommands(): DocCommand[] {
  const commands = new Map<string, DocCommand>()

  const record = (name: string, optional: number, required: number) => {
    const existing = commands.get(name)
    if (existing) {
      existing.count++
      existing.optionalArgCount = Math.max(existing.optionalArgCount, optional)
      existing.requiredArgCount = Math.max(existing.requiredArgCount, required)
    } else {
      commands.set(name, { title: `\\${name}`, optionalArgCount: optional, requiredArgCount: required, count: 1 })
    }
  }

  for (const { path, content } of allDocContents()) {
    if (!/\.(tex|sty|cls|ltx|tikz)$/i.test(path) && path.includes('.')) continue

    // Definitions: \newcommand{\name}[n][default]{...}
    const defRe = /\\(?:re)?newcommand\*?\s*\{?\\(\w+)\}?((?:\[[^\]]*\])*)/g
    let m: RegExpExecArray | null
    while ((m = defRe.exec(content)) !== null) {
      const name = m[1]
      const argSpecs = (m[2] || '').match(/\[[^\]]*\]/g) || []
      const total = argSpecs.length > 0 ? parseInt(argSpecs[0]!.slice(1, -1), 10) || 0 : 0
      const hasOptional = argSpecs.length > 1
      const optional = hasOptional ? 1 : 0
      const required = Math.max(0, total - optional)
      record(name, optional, required)
    }

    // Usages: \name[opt]{req} — records commands seen anywhere in the project
    const useRe = /\\([a-zA-Z]+)((?:\[[^\]\n]*\]|\{[^}\n]*\})*)/g
    while ((m = useRe.exec(content)) !== null) {
      const name = m[1]
      const args = m[2] || ''
      const optional = (args.match(/\[/g) || []).length
      const required = (args.match(/\{/g) || []).length
      record(name, optional, required)
    }
  }

  return Array.from(commands.values())
}

function scanDocEnvironmentsUncached(): Map<string, number> {
  const envs = new Map<string, number>()
  const re = /\\(?:begin|newenvironment\*?\s*\{|newtheorem\*?\s*\{)\{?([^}]+)\}/g
  for (const { content } of allDocContents()) {
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const name = m[1]
      envs.set(name, (envs.get(name) || 0) + 1)
    }
  }
  return envs
}

// ── Command list assembly (cached per data version) ──────────────────

let cachedCommands: Completion[] | null = null
let cachedCommandsVersion = -1
let cachedFilesKey = ''

const IMAGE_RE = /\.(eps|jpe?g|gif|png|tiff?|pdf|svg)$/i

function walkFileTree(): { texPaths: string[]; imagePaths: string[]; bibPaths: string[] } {
  const { files } = useAppStore.getState()
  const texPaths: string[] = []
  const imagePaths: string[] = []
  const bibPaths: string[] = []
  const walk = (nodes: typeof files, prefix: string) => {
    for (const node of nodes) {
      const full = prefix ? `${prefix}/${node.name}` : node.name
      if (node.isDir) {
        if (node.children) walk(node.children, full)
      } else if (/\.(tex|txt)$/i.test(node.name)) {
        texPaths.push(full)
      } else if (IMAGE_RE.test(node.name)) {
        imagePaths.push(full)
      } else if (/\.bib$/i.test(node.name)) {
        bibPaths.push(full)
      }
    }
  }
  walk(files, '')
  return { texPaths, imagePaths, bibPaths }
}

/** Deduplicate by label — prefer entries with apply, then higher boost */
function dedupeByLabel(options: Completion[]): Completion[] {
  const byLabel = new Map<string, Completion>()
  for (const option of options) {
    const existing = byLabel.get(option.label)
    if (!existing) {
      byLabel.set(option.label, option)
      continue
    }
    const score = (c: Completion) => ((c.boost || 0) * 100) + (c.apply ? 10 : 0) + (c.info ? 5 : 0) + (c.type ? 1 : 0)
    if (score(option) > score(existing)) byLabel.set(option.label, option)
  }
  return Array.from(byLabel.values())
}

function buildCommandCompletions(): Completion[] {
  const { texPaths, imagePaths } = walkFileTree()
  const filesKey = texPaths.join('|') + '#' + imagePaths.join('|')
  if (cachedCommands && cachedCommandsVersion === projectData.version && cachedFilesKey === filesKey) {
    return cachedCommands
  }

  const options: Completion[] = []

  // 1. Static top-hundred snippets (official usage-scored data)
  for (const item of topHundredSnippets) {
    options.push({
      type: item.meta,
      label: item.caption,
      boost: item.score,
      apply: item.snippet === item.caption ? undefined : applySnippet(item.snippet),
    })
  }
  options.push({ type: 'cmd', label: '\\verb||', apply: applySnippet('\\verb|#{}|') })

  // 2. Environments as whole begin/end snippets
  for (const [name, template] of environmentTemplates) {
    const clear = name === 'abstract' || name === 'itemize' || name === 'enumerate'
    options.push({
      type: 'env',
      label: `\\begin{${name}} …`,
      apply: applySnippet(template, clear),
    })
  }

  // 3. \usepackage — boosted empty snippet + one entry per unused package
  options.push({
    type: 'pkg',
    label: '\\usepackage{}',
    boost: 10,
    apply: applySnippet('\\usepackage{#{}}'),
  })
  for (const name of packageNames) {
    options.push({ type: 'pkg', label: `\\usepackage{${name}}` })
  }

  // 4. Commands provided by used packages (official metadata endpoint)
  for (const command of projectData.packageCommands) {
    options.push({
      type: command.meta,
      label: command.caption,
      apply: command.snippet === command.caption ? undefined : applySnippet(command.snippet),
    })
  }

  // 5. File-based include commands
  for (const path of texPaths) {
    const stripped = path.replace(/\.tex$/i, '')
    options.push({ type: 'cmd', label: `\\input{${stripped}}` })
    options.push({ type: 'cmd', label: `\\include{${stripped}}` })
  }
  for (const path of imagePaths) {
    options.push({
      type: 'cmd',
      label: `\\includegraphics{${path}}`,
      apply: applySnippet(`\\includegraphics[width=0.5\\linewidth]{${path.replace(/([\\{}$])/g, '\\$1')}}`),
    })
  }

  // 6. Commands seen in the project (definitions + usages)
  const staticPrefixes = new Set<string>()
  for (const option of options) {
    const m = option.label.match(/^\\\w+/)
    if (m) staticPrefixes.add(m[0])
  }
  for (const item of scanDocCommands()) {
    if (staticPrefixes.has(item.title)) continue
    const label = [item.title, '[]'.repeat(item.optionalArgCount), '{}'.repeat(item.requiredArgCount)].join('')
    const snippetStr = [
      item.title,
      ...Array.from({ length: item.optionalArgCount }, () => '[#{}]'),
      ...Array.from({ length: item.requiredArgCount }, () => '{#{}}'),
    ].join('')
    options.push({
      type: 'cmd',
      label,
      boost: Math.max(0, item.count - 10),
      apply: label === item.title ? undefined : applySnippet(snippetStr),
    })
  }

  cachedCommands = dedupeByLabel(options)
  cachedCommandsVersion = projectData.version
  cachedFilesKey = filesKey
  return cachedCommands
}

/** Custom environments from the project, as full begin/end snippets */
function customEnvironmentCompletions(): Completion[] {
  const options: Completion[] = []
  for (const name of scanDocEnvironments().keys()) {
    if (environmentTemplates.has(name)) continue
    options.push({
      type: 'env',
      label: `\\begin{${name}} …`,
      apply: applySnippet(envSnippet(name)),
    })
  }
  return options
}

// ── Completion sources ───────────────────────────────────────────────

/** Commands — active on `\prefix` (or explicit trigger) */
const commandSource: CompletionSource = (context) => {
  const matches = getCompletionMatches(context)
  if (!matches) return null
  const { match, matchBefore } = matches
  // inside a command argument — argument sources handle it
  if (match) return null

  const options = [...buildCommandCompletions(), ...customEnvironmentCompletions()]

  const prefixMatcher = /^\\[^{\s]*$/
  if (prefixMatcher.test(matchBefore.text)) {
    return { from: matchBefore.from, validFor: prefixMatcher, options }
  }
  if (!context.explicit) return null
  return { from: matchBefore.to, options }
}

/** Environment names inside \begin{...} / \end{...} */
const environmentNameSource: CompletionSource = (context) => {
  const details = getArgumentDetails(context)
  if (!details) return null

  if (details.command === 'begin') {
    // Replace the whole `\begin{prefix` with a full environment snippet.
    // validFor excludes `}` so the popup closes once the name is complete —
    // Enter on an already-closed `\begin{env}` then inserts a newline
    // (handled by latexClosing) instead of re-applying the snippet.
    return {
      from: details.matchBefore.from,
      validFor: /^\\begin\{[^}\s]*$/,
      options: [...buildCommandCompletions(), ...customEnvironmentCompletions()],
    }
  }

  if (details.command === 'end') {
    // Suggest currently-open environments, most recent first
    const doc = context.state.doc.sliceString(0, context.pos)
    const open: string[] = []
    const re = /\\(begin|end)\{([^}]+)\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(doc)) !== null) {
      if (m[1] === 'begin') {
        open.push(m[2])
      } else {
        const idx = open.lastIndexOf(m[2])
        if (idx >= 0) open.splice(idx, 1)
      }
    }
    let boost = 10
    const options: Completion[] = []
    const seen = new Set<string>()
    for (const env of open) {
      if (seen.has(env)) continue
      seen.add(env)
      options.push({ type: 'env', label: env, boost: boost++ })
    }
    for (const name of environmentTemplates.keys()) {
      if (!seen.has(name)) options.push({ type: 'env', label: name })
    }
    return { from: details.from, validFor: /^[^}]*/, options }
  }

  return null
}

/** Citation keys inside \cite{...} and friends (multi-key aware) */
const citationSource: CompletionSource = (context) => {
  const details = getArgumentDetails(context)
  if (!details || !isCiteCommand(details.command)) return null

  const options: Completion[] = scanCitationKeys()
    .filter((entry) => !details.existingKeys.includes(entry.key))
    .map((entry) => ({
      type: 'reference',
      label: entry.key,
      detail: `@${entry.type}`,
      info: entry.title,
      apply: applyParameter,
    }))
  return { from: details.from, validFor: details.validFor, options }
}

/** Labels inside \ref{...} and friends (multi-key aware) */
const labelSource: CompletionSource = (context) => {
  const details = getArgumentDetails(context)
  if (!details || !isRefCommand(details.command)) return null

  const options: Completion[] = Array.from(scanLabels())
    .filter((label) => !details.existingKeys.includes(label))
    .map((label) => ({ type: 'label', label, apply: applyParameter }))
  return { from: details.from, validFor: details.validFor, options }
}

/** Package names inside \usepackage{...} */
const packageSource: CompletionSource = (context) => {
  const details = getArgumentDetails(context)
  if (!details || !PACKAGE_COMMANDS.has(details.command)) return null

  const existing = scanExistingPackages(context)
  const names = new Set<string>([...packageNames, ...projectData.serverPackageNames])
  const options: Completion[] = []
  for (const name of names) {
    if (existing.has(name) || details.existingKeys.includes(name)) continue
    options.push({ type: 'pkg', label: name, apply: applyParameter })
  }
  return { from: details.from, validFor: details.validFor, options }
}

/** Class names inside \documentclass{...} */
const documentClassSource: CompletionSource = (context) => {
  const details = getArgumentDetails(context)
  if (!details || details.command !== 'documentclass') return null
  return {
    from: details.from,
    validFor: details.validFor,
    options: classNames.map((name) => ({ type: 'cls', label: name, apply: applyParameter })),
  }
}

/** Bibliography styles inside \bibliographystyle{...} */
const bibliographyStyleSource: CompletionSource = (context) => {
  const details = getArgumentDetails(context)
  if (!details || details.command !== 'bibliographystyle') return null
  const options: Completion[] = []
  for (const styles of Object.values(bibliographyStyles)) {
    for (const style of styles) {
      options.push({ type: 'bib', label: style, apply: applyParameter })
    }
  }
  return { from: details.from, validFor: details.validFor, options }
}

/** .bib files inside \bibliography{...} / \addbibresource{...} */
const bibliographySource: CompletionSource = (context) => {
  const details = getArgumentDetails(context)
  if (!details || !BIBLIOGRAPHY_COMMANDS.has(details.command)) return null
  const { bibPaths } = walkFileTree()
  const keepExtension = details.command === 'addbibresource'
  const options: Completion[] = bibPaths
    .map((path) => (keepExtension ? path : path.replace(/\.bib$/i, '')))
    .filter((path) => !details.existingKeys.includes(path))
    .map((path) => ({ type: 'file', label: path, apply: applyParameter }))
  return { from: details.from, validFor: details.validFor, options }
}

/** File paths inside \input{...} / \include{...} / \subfile{...} */
const inputFileSource: CompletionSource = (context) => {
  const details = getArgumentDetails(context)
  if (!details || !INPUT_COMMANDS.has(details.command)) return null
  const { texPaths } = walkFileTree()
  const options: Completion[] = []
  for (const path of texPaths) {
    const stripped = path.replace(/\.tex$/i, '')
    options.push({ type: 'file', label: stripped, apply: applyParameter })
  }
  return { from: details.from, validFor: /^[^}\s]*/, options }
}

/** Graphics paths inside \includegraphics{...} */
const graphicsSource: CompletionSource = (context) => {
  const details = getArgumentDetails(context)
  if (!details || details.command !== 'includegraphics') return null
  const { imagePaths } = walkFileTree()
  return {
    from: details.from,
    validFor: /^[^}\s]*/,
    options: imagePaths.map((path) => ({ type: 'file', label: path, apply: applyParameter })),
  }
}

// ── Auto-open on empty argument braces (port of open-autocomplete.ts) ──

const AUTO_OPEN_RE =
  /\\(?:begin|end|usepackage|RequirePackage|documentclass|bibliography|addbibresource|bibliographystyle|input|include|subfile|includegraphics|[a-zA-Z]*[cC]ite[a-zA-Z]*|[a-zA-Z]*ref(?:range)?|ref)\*?(?:\[[^\]]*\])*\{$/

const autoOpenOnEmptyBraces = EditorView.updateListener.of((update) => {
  // Only open on local typing (or a completion landing the cursor in a
  // snippet field) — not on plain cursor movement, so Escape + arrowing back
  // through `\cmd{|}` doesn't force the popup to reopen.
  if (!update.docChanged) return
  if (!update.transactions.some((tr) => tr.isUserEvent('input'))) return
  // Ignore remote OT updates — only open for local edits
  if (update.transactions.every((tr) => tr.annotation(remoteUpdateAnnotation) !== undefined)) return

  const state = update.state
  const main = state.selection.main
  if (!main.empty) return
  const pos = main.head
  if (state.doc.sliceString(pos, pos + 1) !== '}') return
  const before = state.doc.sliceString(state.doc.lineAt(pos).from, pos)
  const m = before.match(AUTO_OPEN_RE)
  if (!m) return
  // Verify the command is one we complete (ref list is exact, cite is fuzzy)
  const cmd = m[0].match(/^\\([a-zA-Z]+)/)?.[1]
  if (!cmd) return
  const known =
    ['begin', 'end', 'usepackage', 'RequirePackage', 'documentclass', 'bibliography',
      'addbibresource', 'bibliographystyle', 'includegraphics'].includes(cmd) ||
    INPUT_COMMANDS.has(cmd) || isCiteCommand(cmd) || isRefCommand(cmd)
  if (!known) return
  startCompletion(update.view)
})

// ── Extension export ─────────────────────────────────────────────────

export function latexAutocomplete() {
  return [
    autocompletion({
      override: [
        citationSource,
        labelSource,
        packageSource,
        inputFileSource,
        graphicsSource,
        environmentNameSource,
        documentClassSource,
        bibliographySource,
        bibliographyStyleSource,
        commandSource,
      ],
      icons: false,
      defaultKeymap: false,
      addToOptions: [
        {
          // display the completion "type" at the end of the suggestion
          render: (completion: Completion) => {
            const span = document.createElement('span')
            span.classList.add('ol-cm-completionType')
            if (completion.type) span.textContent = completion.type
            return span
          },
          position: 400,
        },
      ],
      optionClass: (completion: Completion) => `ol-cm-completion-${completion.type}`,
      interactionDelay: 0,
    }),
    Prec.highest(
      keymap.of([
        { key: 'Escape', run: closeCompletion },
        { key: 'ArrowDown', run: moveCompletionSelection(true) },
        { key: 'ArrowUp', run: moveCompletionSelection(false) },
        { key: 'PageDown', run: moveCompletionSelection(true, 'page') },
        { key: 'PageUp', run: moveCompletionSelection(false, 'page') },
        { key: 'Enter', run: acceptCompletion },
        { key: 'Tab', run: acceptCompletion },
      ])
    ),
    Prec.high(
      keymap.of([
        { key: 'Ctrl-Space', run: startCompletion },
        { key: 'Alt-Space', run: startCompletion },
      ])
    ),
    autoOpenOnEmptyBraces,
  ]
}
