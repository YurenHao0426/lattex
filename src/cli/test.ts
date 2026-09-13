// Tests for CLI arg parsing and diff logic
import { parseArgs } from './args'
import { walkRootFolder } from './fileTree'
import { join } from 'path'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { computeDiff, hashFile, isTextFile } from './diff'
import { parseCompileLog } from './logParser'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++
  } else {
    failed++
    console.error(`FAIL: ${message}`)
  }
}

function eq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++
  } else {
    failed++
    console.error(`FAIL: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}

// ── parseArgs tests ──

function testParseArgs(): void {
  console.log('--- parseArgs ---')

  // Basic command
  const r1 = parseArgs(['node', 'cli', 'projects'])
  eq(r1.command, 'projects', 'basic command')
  eq(r1.positional.length, 0, 'no positionals')

  // Command with positionals
  const r2 = parseArgs(['node', 'cli', 'clone', 'abc123', '/tmp/mydir'])
  eq(r2.command, 'clone', 'clone command')
  eq(r2.positional, ['abc123', '/tmp/mydir'], 'clone positionals')

  // Flags
  const r3 = parseArgs(['node', 'cli', 'projects', '--json'])
  eq(r3.command, 'projects', 'projects command')
  eq(r3.flags.json, true, 'json flag is boolean')

  // Flag with value
  const r4 = parseArgs(['node', 'cli', 'auth', '--cookie', 'session=abc'])
  eq(r4.command, 'auth', 'auth command')
  eq(r4.flags.cookie, 'session=abc', 'cookie flag value')

  // Flag with = syntax
  const r5 = parseArgs(['node', 'cli', 'compile', '--out=/tmp/paper.pdf'])
  eq(r5.flags.out, '/tmp/paper.pdf', 'flag with = syntax')

  // Multiple flags
  const r6 = parseArgs(['node', 'cli', 'push', '.', '--dry-run', '--force', '--json'])
  eq(r6.command, 'push', 'push command')
  eq(r6.flags['dry-run'], true, 'dry-run flag')
  eq(r6.flags.force, true, 'force flag')
  eq(r6.flags.json, true, 'json flag with push')
  eq(r6.positional, ['.'], 'push positional')

  // Empty args
  const r7 = parseArgs(['node', 'cli'])
  eq(r7.command, '', 'empty command')

  // --delete flag
  const r8 = parseArgs(['node', 'cli', 'push', '/tmp/project', '--delete'])
  eq(r8.flags.delete, true, 'delete flag')
  eq(r8.positional, ['/tmp/project'], 'push dir positional')
}

// ── walkRootFolder tests ──

function testWalkRootFolder(): void {
  console.log('--- walkRootFolder ---')

  const rootFolder = [{
    _id: 'root123',
    name: 'rootFolder',
    docs: [
      { _id: 'doc1', name: 'main.tex' },
      { _id: 'doc2', name: 'refs.bib' }
    ],
    fileRefs: [
      { _id: 'file1', name: 'figure.png' }
    ],
    folders: [{
      _id: 'folder1',
      name: 'sections',
      docs: [
        { _id: 'doc3', name: 'intro.tex' },
        { _id: 'doc4', name: 'method.tex' }
      ],
      fileRefs: [],
      folders: [{
        _id: 'folder2',
        name: 'appendix',
        docs: [{ _id: 'doc5', name: 'proofs.tex' }],
        fileRefs: [{ _id: 'file2', name: 'table.csv' }],
        folders: []
      }]
    }]
  }]

  const result = walkRootFolder(rootFolder)

  eq(result.rootFolderId, 'root123', 'root folder ID')
  eq(result.docPathMap['doc1'], 'main.tex', 'root doc path')
  eq(result.docPathMap['doc3'], 'sections/intro.tex', 'nested doc path')
  eq(result.docPathMap['doc5'], 'sections/appendix/proofs.tex', 'deeply nested doc path')
  eq(result.pathDocMap['main.tex'], 'doc1', 'reverse doc map')
  eq(result.pathDocMap['sections/method.tex'], 'doc4', 'reverse nested doc map')
  eq(result.fileRefs.length, 2, 'file refs count')
  eq(result.fileRefs[0], { id: 'file1', path: 'figure.png' }, 'file ref at root')
  eq(result.fileRefs[1], { id: 'file2', path: 'sections/appendix/table.csv' }, 'nested file ref')
  eq(result.folderMap['root123'], '', 'root folder path')
  eq(result.folderMap['folder1'], 'sections', 'subfolder path')
  eq(result.folderMap['folder2'], 'sections/appendix', 'deep subfolder path')
  eq(result.pathFolderMap[''], 'root123', 'reverse root folder')
  eq(result.pathFolderMap['sections'], 'folder1', 'reverse subfolder')
  // 5 docs + 2 fileRefs + 2 folders = 9 entries
  assert(result.entries.length === 9, `entries count: ${result.entries.length} (expected 9)`)
}

// ── isTextFile tests ──

function testIsTextFile(): void {
  console.log('--- isTextFile ---')
  assert(isTextFile('main.tex'), 'main.tex is text')
  assert(isTextFile('refs.bib'), 'refs.bib is text')
  assert(isTextFile('style.sty'), 'style.sty is text')
  assert(isTextFile('class.cls'), 'class.cls is text')
  assert(isTextFile('Makefile'), 'Makefile is text')
  assert(isTextFile('latexmkrc'), 'latexmkrc is text')
  assert(isTextFile('script.py'), 'script.py is text')
  assert(!isTextFile('figure.png'), 'figure.png is not text')
  assert(!isTextFile('photo.jpg'), 'photo.jpg is not text')
  assert(!isTextFile('archive.zip'), 'archive.zip is not text')
}

// ── computeDiff tests ──

async function testComputeDiff(): Promise<void> {
  console.log('--- computeDiff ---')

  const tmpDir = await mkdtemp(join(tmpdir(), 'lattex-test-'))

  try {
    // Create some files
    await writeFile(join(tmpDir, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}')
    await writeFile(join(tmpDir, 'refs.bib'), '@article{test, title={Test}}')
    await mkdir(join(tmpDir, 'sections'), { recursive: true })
    await writeFile(join(tmpDir, 'sections', 'intro.tex'), '\\section{Intro}\nContent here.')

    // Hash the initial state
    const hashes: Record<string, string> = {}
    hashes['main.tex'] = await hashFile(join(tmpDir, 'main.tex'))
    hashes['refs.bib'] = await hashFile(join(tmpDir, 'refs.bib'))
    hashes['sections/intro.tex'] = await hashFile(join(tmpDir, 'sections', 'intro.tex'))

    const known = new Set(['main.tex', 'refs.bib', 'sections/intro.tex'])

    // No changes
    const diff1 = await computeDiff(tmpDir, hashes, known)
    eq(diff1.length, 0, 'no changes initially')

    // Modify a file
    await writeFile(join(tmpDir, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nModified!\n\\end{document}')
    const diff2 = await computeDiff(tmpDir, hashes, known)
    eq(diff2.length, 1, 'one modified file')
    eq(diff2[0].type, 'modified', 'change type is modified')
    eq(diff2[0].path, 'main.tex', 'modified file path')

    // Add a new file
    await writeFile(join(tmpDir, 'new.tex'), '\\section{New}')
    const diff3 = await computeDiff(tmpDir, hashes, known)
    assert(diff3.length === 2, `two changes: ${diff3.length}`)
    const added = diff3.find(c => c.type === 'added')
    assert(!!added, 'has added change')
    eq(added?.path, 'new.tex', 'added file path')
    assert(added?.isText === true, 'added file is text')

    // Test deleted file detection
    const hashesWithExtra = { ...hashes, 'deleted.tex': 'fakehash' }
    const diff4 = await computeDiff(tmpDir, hashesWithExtra, new Set([...known, 'deleted.tex']))
    const deleted = diff4.find(c => c.type === 'deleted')
    assert(!!deleted, 'has deleted change')
    eq(deleted?.path, 'deleted.tex', 'deleted file path')

  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── parseCompileLog tests ──

function testParseCompileLog(): void {
  console.log('--- parseCompileLog ---')

  const log1 = `! LaTeX Error: File \`nonexistent.sty' not found.
l.3 \\usepackage{nonexistent}`
  const entries1 = parseCompileLog(log1)
  assert(entries1.length >= 1, 'parse error entry')
  eq(entries1[0].level, 'error', 'error level')
  assert(entries1[0].line === 3, 'error line number')

  const log2 = `./main.tex:15: Undefined control sequence.`
  const entries2 = parseCompileLog(log2)
  assert(entries2.length >= 1, 'parse file:line:error')
  eq(entries2[0].file, 'main.tex', 'error file')
  eq(entries2[0].line, 15, 'error line from file:line format')

  const log3 = `LaTeX Warning: Reference \`fig:missing' on page 3 undefined on input line 42.`
  const entries3 = parseCompileLog(log3)
  assert(entries3.length >= 1, 'parse LaTeX warning')
  eq(entries3[0].level, 'warning', 'warning level')
  eq(entries3[0].line, 42, 'warning line')

  const log4 = `Overfull \\hbox (10.5pt too wide) in paragraph at lines 20--25`
  const entries4 = parseCompileLog(log4)
  assert(entries4.length >= 1, 'parse overfull warning')
  eq(entries4[0].level, 'warning', 'overfull is warning')
  eq(entries4[0].line, 20, 'overfull line')
}

// ── Run all tests ──

async function runTests(): Promise<void> {
  testParseArgs()
  testWalkRootFolder()
  testIsTextFile()
  await testComputeDiff()
  testParseCompileLog()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

runTests()
