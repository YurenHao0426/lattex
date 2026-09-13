// Walk Overleaf project root folder into flat maps (same logic as main/index.ts walkRootFolder)

export interface FileTreeEntry {
  name: string
  path: string       // relative path, forward slashes
  isDir: boolean
  docId?: string      // text docs
  fileRefId?: string  // binary files
}

export interface FileTreeResult {
  entries: FileTreeEntry[]
  docPathMap: Record<string, string>   // docId → relPath
  pathDocMap: Record<string, string>   // relPath → docId
  fileRefs: Array<{ id: string; path: string }>
  folderMap: Record<string, string>    // folderId → relPath ('' for root)
  pathFolderMap: Record<string, string> // relPath → folderId
  rootFolderId: string
}

interface FolderLike {
  _id: string
  name: string
  docs?: Array<{ _id: string; name: string }>
  fileRefs?: Array<{ _id: string; name: string }>
  folders?: FolderLike[]
}

export function walkRootFolder(rootFolder: FolderLike[]): FileTreeResult {
  const docPathMap: Record<string, string> = {}
  const pathDocMap: Record<string, string> = {}
  const fileRefs: Array<{ id: string; path: string }> = []
  const folderMap: Record<string, string> = {}
  const pathFolderMap: Record<string, string> = {}
  const entries: FileTreeEntry[] = []
  const rootFolderId = rootFolder[0]?._id || ''

  function walk(f: FolderLike, prefix: string): void {
    // Register this folder
    const folderPath = prefix ? prefix.slice(0, -1) : '' // remove trailing /
    folderMap[f._id] = folderPath
    pathFolderMap[folderPath] = f._id

    for (const doc of f.docs || []) {
      const relPath = prefix + doc.name
      docPathMap[doc._id] = relPath
      pathDocMap[relPath] = doc._id
      entries.push({ name: doc.name, path: relPath, isDir: false, docId: doc._id })
    }

    for (const ref of f.fileRefs || []) {
      const relPath = prefix + ref.name
      fileRefs.push({ id: ref._id, path: relPath })
      entries.push({ name: ref.name, path: relPath, isDir: false, fileRefId: ref._id })
    }

    for (const sub of f.folders || []) {
      const subPrefix = prefix + sub.name + '/'
      entries.push({ name: sub.name, path: subPrefix.slice(0, -1), isDir: true })
      walk(sub, subPrefix)
    }
  }

  if (rootFolder[0]) {
    walk(rootFolder[0], '')
  }

  return { entries, docPathMap, pathDocMap, fileRefs, folderMap, pathFolderMap, rootFolderId }
}
