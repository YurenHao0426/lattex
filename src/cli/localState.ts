// Manages per-clone state stored in <dir>/.lattex-cli.json
// and the global auth credential at ~/.config/lattex/auth.json

import { join } from 'path'
import { readFile, writeFile, mkdir, chmod } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'

const CONFIG_DIR = join(homedir(), '.config', 'lattex')
const AUTH_PATH = join(CONFIG_DIR, 'auth.json')
const STATE_FILE = '.lattex-cli.json'

// ── Global auth ──

export async function saveCookie(cookie: string): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(AUTH_PATH, JSON.stringify({ cookie }), { mode: 0o600 })
  // Ensure directory and file are user-only
  await chmod(CONFIG_DIR, 0o700).catch(() => {})
  await chmod(AUTH_PATH, 0o600).catch(() => {})
}

export async function loadCookie(): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(AUTH_PATH, 'utf-8'))
    return data.cookie || null
  } catch {
    return null
  }
}

// ── Per-clone state ──

export interface CloneState {
  projectId: string
  projectName: string
  /** docId → relPath */
  docPathMap: Record<string, string>
  /** relPath → docId */
  pathDocMap: Record<string, string>
  /** fileRefId → relPath */
  fileRefPathMap: Record<string, string>
  /** relPath → fileRefId */
  pathFileRefMap: Record<string, string>
  /** folderId → relDirPath */
  folderMap: Record<string, string>
  /** relDirPath → folderId */
  pathFolderMap: Record<string, string>
  rootFolderId: string
  rootDocId: string
  /** ISO timestamp of last pull */
  lastPull: string
  /** sha256 hash of each file at last pull (relPath → hash) */
  fileHashes: Record<string, string>
}

export function statePath(dir: string): string {
  return join(dir, STATE_FILE)
}

export async function loadState(dir: string): Promise<CloneState | null> {
  const p = statePath(dir)
  try {
    return JSON.parse(await readFile(p, 'utf-8'))
  } catch {
    return null
  }
}

export async function saveState(dir: string, state: CloneState): Promise<void> {
  await writeFile(statePath(dir), JSON.stringify(state, null, 2))
}

export function hasState(dir: string): boolean {
  return existsSync(statePath(dir))
}
