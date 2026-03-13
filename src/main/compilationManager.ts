// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// Manages temp directory for Overleaf socket-mode compilation
import { join, basename } from 'path'
import { writeFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { net } from 'electron'

export class CompilationManager {
  private tmpDir: string
  private projectId: string
  private cookie: string
  private docContents = new Map<string, string>() // docPath → content
  private fileRefCache = new Map<string, boolean>() // fileRefPath → downloaded

  constructor(projectId: string, cookie: string) {
    this.projectId = projectId
    this.cookie = cookie
    this.tmpDir = join(require('os').tmpdir(), `lattex-${projectId}`)
  }

  get dir(): string {
    return this.tmpDir
  }

  /** Check if a doc is already stored */
  hasDoc(relativePath: string): boolean {
    return this.docContents.has(relativePath)
  }

  /** Store doc content (called when docs are joined/updated) */
  setDocContent(relativePath: string, content: string) {
    // Strip C1 control characters (U+0080-U+009F) — Overleaf embeds these as
    // range markers for tracked changes / comments. They break pdflatex.
    this.docContents.set(relativePath, content.replace(/[\u0080-\u009F]/g, ''))
  }

  /** Write all doc contents to disk */
  async syncDocs(): Promise<void> {
    await mkdir(this.tmpDir, { recursive: true })
    for (const [relPath, content] of this.docContents) {
      const fullPath = join(this.tmpDir, relPath)
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
      await mkdir(dir, { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
    }
  }

  /** Download a binary file (image, .bst, etc.) from Overleaf */
  async downloadFile(fileRefId: string, relativePath: string): Promise<void> {
    if (this.fileRefCache.has(relativePath)) return

    const fullPath = join(this.tmpDir, relativePath)
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
    await mkdir(dir, { recursive: true })

    return new Promise((resolve, reject) => {
      const url = `https://www.overleaf.com/project/${this.projectId}/file/${fileRefId}`
      const req = net.request(url)
      req.setHeader('Cookie', this.cookie)
      req.setHeader('User-Agent', 'Mozilla/5.0')

      const chunks: Buffer[] = []
      req.on('response', (res) => {
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', async () => {
          try {
            const { writeFile: wf } = await import('fs/promises')
            await wf(fullPath, Buffer.concat(chunks))
            this.fileRefCache.set(relativePath, true)
            resolve()
          } catch (e) {
            reject(e)
          }
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** Download all binary files in the project */
  async syncBinaries(fileRefs: Array<{ id: string; path: string }>): Promise<void> {
    for (const ref of fileRefs) {
      try {
        await this.downloadFile(ref.id, ref.path)
      } catch (e) {
        console.log(`[CompilationManager] failed to download ${ref.path}:`, e)
      }
    }
  }

  /** Run latexmk compilation */
  async compile(
    mainTexRelPath: string,
    onLog: (data: string) => void
  ): Promise<{ success: boolean; log: string; pdfPath: string }> {
    await this.syncDocs()

    const texPaths = [
      '/Library/TeX/texbin',
      '/usr/local/texlive/2024/bin/universal-darwin',
      '/usr/texbin',
      '/opt/homebrew/bin'
    ]
    const envPath = texPaths.join(':') + ':' + (process.env.PATH || '')

    // Use // suffix for recursive search of ALL subdirectories in the project tree.
    // This ensures .sty, .bst, .cls, images, etc. are always found regardless of nesting.
    const texInputs = `${this.tmpDir}//:`
    const texBase = basename(mainTexRelPath, '.tex')
    const pdfPath = join(this.tmpDir, texBase + '.pdf')

    const args = [
      '-pdf', '-f', '-g', '-bibtex', '-synctex=1',
      '-interaction=nonstopmode', '-file-line-error',
      '-outdir=' + this.tmpDir,
      mainTexRelPath
    ]
    console.log('[compile] cwd:', this.tmpDir)
    console.log('[compile] args:', args.join(' '))
    console.log('[compile] TEXINPUTS:', texInputs)
    console.log('[compile] pdfPath:', pdfPath)
    console.log('[compile] docs synced:', this.docContents.size, 'files:', [...this.docContents.keys()].slice(0, 5))

    return new Promise((resolve) => {
      let log = ''
      const proc = spawn('latexmk', args, {
        cwd: this.tmpDir,
        env: { ...process.env, PATH: envPath, TEXINPUTS: texInputs, BIBINPUTS: texInputs, BSTINPUTS: texInputs }
      })

      proc.stdout.on('data', (data) => {
        const s = data.toString()
        log += s
        onLog(s)
      })

      proc.stderr.on('data', (data) => {
        const s = data.toString()
        log += s
        onLog(s)
      })

      proc.on('close', (code) => {
        resolve({ success: code === 0, log, pdfPath })
      })

      proc.on('error', (err) => {
        resolve({ success: false, log: log + '\n' + err.message, pdfPath })
      })
    })
  }

  /** Clean up temp directory */
  async cleanup(): Promise<void> {
    try {
      if (existsSync(this.tmpDir)) {
        await rm(this.tmpDir, { recursive: true })
      }
    } catch { /* ignore */ }
  }
}
