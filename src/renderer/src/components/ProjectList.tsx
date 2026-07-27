// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

// Project dashboard — a faithful clone of the Overleaf project list
// (services/web/frontend/js/features/project-list): sidebar filters,
// tags, archive/trash, bulk actions, and the same client-side filtering
// pipeline over the official /api/project + /tag endpoints.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '../stores/appStore'
import { hashString } from '../extensions/remoteCursors'

interface OverleafProject {
  id: string
  name: string
  lastUpdated: string
  owner?: { firstName: string; lastName: string; email?: string }
  lastUpdatedBy?: { firstName: string; lastName: string } | null
  accessLevel?: string
  source?: string
  archived?: boolean
  trashed?: boolean
}

interface Tag {
  _id: string
  name: string
  color?: string | null
  project_ids?: string[]
}

type Filter = 'all' | 'owned' | 'shared' | 'archived' | 'trashed'
type SortKey = 'lastUpdated' | 'title' | 'owner'
type SortOrder = 'asc' | 'desc'

const UNCATEGORIZED_KEY = 'uncategorized'
const PAGE_SIZE = 20

// Overleaf's preset tag palette (project-list color-picker)
const PRESET_COLORS = [
  { color: '#A7B1C2', name: 'Grey' },
  { color: '#F04343', name: 'Red' },
  { color: '#DD8A3E', name: 'Orange' },
  { color: '#E4CA3E', name: 'Yellow' },
  { color: '#33CF67', name: 'Green' },
  { color: '#43A7F0', name: 'Light blue' },
  { color: '#434AF0', name: 'Dark blue' },
  { color: '#B943F0', name: 'Purple' },
  { color: '#FF4BCD', name: 'Pink' },
]

const MAX_TAG_LENGTH = 50

/** Default tag color when none is set (Overleaf: hsl(hue, 70%, 45%)) */
function getTagColor(tag?: Tag): string | undefined {
  if (!tag) return undefined
  return tag.color || `hsl(${hashString(tag._id) % 320}, 70%, 45%)`
}

const isArchivedOrTrashed = (p: OverleafProject) => !!p.archived || !!p.trashed

// ── Icons (inline SVG, Material-style outlines) ─────────────────────

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)

const ICONS = {
  copy: 'M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3M4 8h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 19h14',
  archive: 'M4 7h16v3H4zM6 10v9h12v-9M10 14h4',
  trash: 'M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7M10 11v6M14 11v6',
  restore: 'M4 10a8 8 0 1 1 2 6M4 10V5m0 5h5',
  leave: 'M14 5h5v14h-5M10 8l-4 4 4 4M6 12h10',
  block: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.5 5.5l13 13',
  tag: 'M4 5a1 1 0 0 1 1-1h6l9 9-7 7-9-9V5zM8.5 8.5h0',
  kebab: 'M12 6h.01M12 12h.01M12 18h.01',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15 15l5 5',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4l11-11-4-4L4 16v4zM13 7l4 4',
  check: 'M5 13l4 4 10-10',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6L12.5 18',
}

// ── Component ───────────────────────────────────────────────────────

interface Props {
  onOpenProject: (projectId: string) => void
}

export default function ProjectList({ onOpenProject }: Props) {
  const [projects, setProjects] = useState<OverleafProject[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyText, setBusyText] = useState('')

  const [filter, setFilter] = useState<Filter>('all')
  const [selectedTagId, setSelectedTagId] = useState<string | undefined>(undefined)
  const [searchText, setSearchText] = useState('')
  const [sort, setSort] = useState<{ by: SortKey; order: SortOrder }>({ by: 'lastUpdated', order: 'desc' })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [maxVisible, setMaxVisible] = useState(PAGE_SIZE)

  // Modals
  const [modal, setModal] = useState<
    | { kind: 'newProject'; template?: 'none' | 'example' }
    | { kind: 'rename'; project: OverleafProject }
    | { kind: 'clone'; project: OverleafProject }
    | { kind: 'confirm'; action: 'archive' | 'trash' | 'delete' | 'leave'; projects: OverleafProject[] }
    | { kind: 'createTag'; forProjects?: string[] }
    | { kind: 'editTag'; tag: Tag }
    | { kind: 'deleteTag'; tag: Tag }
    | { kind: 'apiKeys' }
    | null
  >(null)
  const [modalInput, setModalInput] = useState('')
  const [modalColor, setModalColor] = useState<string | undefined>(undefined)
  const [modalBusy, setModalBusy] = useState(false)
  const [modalError, setModalError] = useState('')
  const [tagsMenuOpen, setTagsMenuOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [tagKebabOpen, setTagKebabOpen] = useState<string | null>(null)
  const [rowTagMenu, setRowTagMenu] = useState<{ projectId: string; up: boolean } | null>(null)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [apiKeysVisible, setApiKeysVisible] = useState<Record<string, boolean>>({})
  const { setStatusMessage } = useAppStore()

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    const [projResult, tagResult] = await Promise.all([
      window.api.overleafListProjects(),
      window.api.overleafGetTags(),
    ])
    setLoading(false)
    if (projResult.success && projResult.projects) {
      setProjects(projResult.projects)
    } else {
      setError(projResult.message || 'Failed to load projects')
    }
    if (tagResult.success && tagResult.tags) {
      setTags(tagResult.tags)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Close dropdowns on outside click
  useEffect(() => {
    const close = () => {
      setTagsMenuOpen(false)
      setNewMenuOpen(false)
      setTagKebabOpen(null)
      setRowTagMenu(null)
    }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  // ── Derived state (mirrors Overleaf's project-list-context pipeline) ──

  const taggedProjectIds = useMemo(
    () => new Set(tags.flatMap((t) => t.project_ids || [])),
    [tags]
  )

  const filteredProjects = useMemo(() => {
    let list = projects

    // 1. Search
    if (searchText.length) {
      const q = searchText.toLowerCase()
      list = list.filter((p) => p.name.toLowerCase().includes(q))
    }

    // 2. Tag or filter (mutually exclusive)
    if (selectedTagId === UNCATEGORIZED_KEY) {
      list = list.filter((p) => !p.archived && !p.trashed && !taggedProjectIds.has(p.id))
    } else if (selectedTagId) {
      const tag = tags.find((t) => t._id === selectedTagId)
      list = list.filter((p) => !isArchivedOrTrashed(p) && !!tag?.project_ids?.includes(p.id))
    } else {
      switch (filter) {
        case 'all': list = list.filter((p) => !p.archived && !p.trashed); break
        case 'owned': list = list.filter((p) => p.accessLevel === 'owner' && !p.archived && !p.trashed); break
        case 'shared': list = list.filter((p) => p.accessLevel !== 'owner' && !p.archived && !p.trashed); break
        case 'archived': list = list.filter((p) => p.archived && !p.trashed); break
        case 'trashed': list = list.filter((p) => p.trashed); break
      }
    }

    // 3. Sort
    const dir = sort.order === 'asc' ? 1 : -1
    const ownerName = (p: OverleafProject) =>
      p.accessLevel === 'owner' ? '' : `${p.owner?.firstName || ''} ${p.owner?.lastName || ''}`.trim() || p.owner?.email || '~'
    list = [...list].sort((a, b) => {
      let cmp = 0
      if (sort.by === 'lastUpdated') {
        cmp = a.lastUpdated < b.lastUpdated ? -1 : a.lastUpdated > b.lastUpdated ? 1 : 0
      } else if (sort.by === 'title') {
        cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      } else {
        cmp = ownerName(a).localeCompare(ownerName(b))
      }
      return cmp * dir
    })

    return list
  }, [projects, tags, filter, selectedTagId, searchText, sort, taggedProjectIds])

  const visibleProjects = useMemo(() => filteredProjects.slice(0, maxVisible), [filteredProjects, maxVisible])
  const hiddenCount = filteredProjects.length - visibleProjects.length
  const selectedProjects = useMemo(
    () => visibleProjects.filter((p) => selectedIds.has(p.id)),
    [visibleProjects, selectedIds]
  )

  const projectsPerTag = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const tag of tags) {
      counts[tag._id] = projects.filter(
        (p) => !isArchivedOrTrashed(p) && tag.project_ids?.includes(p.id)
      ).length
    }
    return counts
  }, [tags, projects])

  const untaggedCount = useMemo(
    () => projects.filter((p) => !p.archived && !p.trashed && !taggedProjectIds.has(p.id)).length,
    [projects, taggedProjectIds]
  )

  // ── Navigation helpers ──

  const selectFilter = (f: Filter) => {
    setFilter(f)
    setSelectedTagId(undefined)
    setSelectedIds(new Set())
    setMaxVisible(PAGE_SIZE)
  }

  const selectTag = (tagId: string) => {
    setFilter('all')
    setSelectedTagId(tagId)
    setSelectedIds(new Set())
    setMaxVisible(PAGE_SIZE)
  }

  const pageTitle = useMemo(() => {
    if (selectedTagId === UNCATEGORIZED_KEY) return 'Uncategorized projects'
    if (selectedTagId) return tags.find((t) => t._id === selectedTagId)?.name || 'All projects'
    switch (filter) {
      case 'owned': return 'Your projects'
      case 'shared': return 'Shared with you'
      case 'archived': return 'Archived projects'
      case 'trashed': return 'Trashed projects'
      default: return 'All projects'
    }
  }, [filter, selectedTagId, tags])

  const searchPlaceholder = useMemo(() => {
    if (selectedTagId === UNCATEGORIZED_KEY) return 'Search uncategorized projects…'
    if (selectedTagId) return `Search ${tags.find((t) => t._id === selectedTagId)?.name || ''}…`
    switch (filter) {
      case 'owned': return 'Search in your projects…'
      case 'shared': return 'Search in projects shared with you…'
      case 'archived': return 'Search in archived projects…'
      case 'trashed': return 'Search in trashed projects…'
      default: return 'Search in all projects…'
    }
  }, [filter, selectedTagId, tags])

  // ── Project state transitions (mirror Overleaf's handlers) ──

  const updateProject = (updated: OverleafProject) => {
    setProjects((list) => list.map((p) => (p.id === updated.id ? updated : p)))
  }

  const deselect = (id: string) => {
    setSelectedIds((ids) => {
      const next = new Set(ids)
      next.delete(id)
      return next
    })
  }

  type ProjectAction = 'archive' | 'unarchive' | 'trash' | 'untrash' | 'delete' | 'leave'

  // State patch per action — mirrors the web client's handlers: archiving
  // clears trashed, trashing clears archived; delete/leave drop the project.
  const ACTION_PATCH: Record<ProjectAction, ((p: OverleafProject) => OverleafProject) | null> = {
    archive: (p) => ({ ...p, archived: true, trashed: false }),
    unarchive: (p) => ({ ...p, archived: false }),
    trash: (p) => ({ ...p, trashed: true, archived: false }),
    untrash: (p) => ({ ...p, trashed: false }),
    delete: null,
    leave: null,
  }

  const transitionProjects = async (targets: OverleafProject[], actionFor: (p: OverleafProject) => ProjectAction) => {
    const results = await Promise.allSettled(
      targets.map(async (p) => {
        const action = actionFor(p)
        const r = await window.api.overleafSetProjectState(p.id, action)
        if (!r.success) throw new Error(`Failed to ${action} "${p.name}": ${r.message}`)
        return { project: p, action }
      })
    )

    const succeeded = results.filter(
      (r): r is PromiseFulfilledResult<{ project: OverleafProject; action: ProjectAction }> =>
        r.status === 'fulfilled'
    )
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    setSelectedIds((ids) => {
      const next = new Set(ids)
      for (const { value } of succeeded) next.delete(value.project.id)
      return next
    })
    setProjects((list) => {
      const patched = new Map(
        succeeded.map(({ value }) => [value.project.id, ACTION_PATCH[value.action]] as const)
      )
      return list
        .filter((p) => !(patched.has(p.id) && patched.get(p.id) === null))
        .map((p) => {
          const patch = patched.get(p.id)
          return patch ? patch(p) : p
        })
    })
    setError(failed.map((r) => String(r.reason?.message ?? r.reason)).join('; '))
  }

  const archiveProjects = (targets: OverleafProject[]) => transitionProjects(targets, () => 'archive')
  const trashProjects = (targets: OverleafProject[]) => transitionProjects(targets, () => 'trash')
  const unarchiveProjects = (targets: OverleafProject[]) => transitionProjects(targets, () => 'unarchive')
  const untrashProjects = (targets: OverleafProject[]) => transitionProjects(targets, () => 'untrash')
  const deleteOrLeaveProjects = (targets: OverleafProject[], mode: 'delete' | 'leave' | 'auto') =>
    transitionProjects(targets, (p) =>
      mode === 'auto' ? (p.accessLevel === 'owner' ? 'delete' : 'leave') : mode
    )

  // ── Tag membership (optimistic, like the web client) ──

  const addProjectsToTagInView = (tagId: string, projectIds: string[]) => {
    setTags((list) => list.map((t) =>
      t._id === tagId
        ? { ...t, project_ids: Array.from(new Set([...(t.project_ids || []), ...projectIds])) }
        : t
    ))
  }

  const removeProjectsFromTagInView = (tagId: string, projectIds: string[]) => {
    const remove = new Set(projectIds)
    setTags((list) => list.map((t) =>
      t._id === tagId
        ? { ...t, project_ids: (t.project_ids || []).filter((id) => !remove.has(id)) }
        : t
    ))
  }

  /** Toggle tag membership: if every project has the tag, remove it; else add to the missing ones */
  const toggleTagForProjects = async (tag: Tag, ids: string[]) => {
    const allContained = ids.every((id) => tag.project_ids?.includes(id))
    if (allContained) {
      removeProjectsFromTagInView(tag._id, ids)
      await window.api.overleafRemoveProjectsFromTag(tag._id, ids)
    } else {
      const missing = ids.filter((id) => !tag.project_ids?.includes(id))
      addProjectsToTagInView(tag._id, missing)
      await window.api.overleafAddProjectsToTag(tag._id, missing)
    }
  }

  // ── Open project ──

  const handleOpen = async (pid: string) => {
    setError('')
    setBusy(true)
    setBusyText('Connecting to project...')
    setStatusMessage('Connecting...')

    const result = await window.api.otConnect(pid)
    setBusy(false)

    if (result.success) {
      const store = useAppStore.getState()
      if (result.files) store.setFiles(result.files as any)
      if (result.project) store.setOverleafProject(result.project)
      if (result.docPathMap && result.pathDocMap) store.setDocMaps(result.docPathMap, result.pathDocMap)
      if (result.fileRefs) store.setFileRefs(result.fileRefs)
      if (result.rootFolderId) store.setRootFolderId(result.rootFolderId)
      store.setOverleafProjectId(pid)
      store.setConnectionState('connected')
      if (result.syncDir) store.setSyncDir(result.syncDir)
      if (result.cachedPdfPath) store.setPdfPath(result.cachedPdfPath)
      setStatusMessage('Connected')
      onOpenProject(pid)
    } else {
      setStatusMessage('Connection failed')
      setError(result.message || 'Failed to connect')
    }
  }

  // ── Modal actions ──

  const openModal = (m: NonNullable<typeof modal>) => {
    setModalError('')
    setModalBusy(false)
    if (m.kind === 'rename') setModalInput(m.project.name)
    else if (m.kind === 'clone') setModalInput(`${m.project.name} (Copy)`)
    else if (m.kind === 'newProject') setModalInput('')
    else if (m.kind === 'createTag') { setModalInput(''); setModalColor(PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)].color) }
    else if (m.kind === 'editTag') { setModalInput(m.tag.name); setModalColor(getTagColor(m.tag)) }
    setModal(m)
  }

  const closeModal = () => { setModal(null); setModalError(''); setModalBusy(false) }

  const runModalAction = async () => {
    if (!modal) return
    setModalBusy(true)
    setModalError('')

    try {
      if (modal.kind === 'newProject') {
        const name = modalInput.trim()
        if (!name) return
        const r = await window.api.overleafCreateProject(name)
        if (!r.success) { setModalError(r.message || 'Failed to create project'); return }
        closeModal()
        setStatusMessage(`Created "${name}"`)
        loadData()
      } else if (modal.kind === 'rename') {
        const name = modalInput.trim()
        if (!name || name === modal.project.name) return
        const r = await window.api.overleafRenameProject(modal.project.id, name)
        if (!r.success) { setModalError(r.message || 'Rename failed'); return }
        deselect(modal.project.id)
        updateProject({ ...modal.project, name })
        closeModal()
      } else if (modal.kind === 'clone') {
        const name = modalInput.trim()
        if (!name) return
        const projectTags = tags.filter((t) => t.project_ids?.includes(modal.project.id)).map((t) => t._id)
        const r = await window.api.overleafCloneProject(modal.project.id, name, projectTags)
        if (!r.success) { setModalError(r.message || 'Copy failed'); return }
        closeModal()
        setStatusMessage(`Copied to "${name}"`)
        loadData()
      } else if (modal.kind === 'confirm') {
        const { action, projects: targets } = modal
        if (action === 'archive') await archiveProjects(targets)
        else if (action === 'trash') await trashProjects(targets)
        else if (action === 'delete') await deleteOrLeaveProjects(targets.filter((p) => p.accessLevel === 'owner'), 'delete')
        else if (action === 'leave') await deleteOrLeaveProjects(targets.filter((p) => p.accessLevel !== 'owner'), 'leave')
        closeModal()
      } else if (modal.kind === 'createTag') {
        const name = modalInput.trim()
        if (!name) return
        if (name.length > MAX_TAG_LENGTH) { setModalError('Tag name cannot exceed 50 characters'); return }
        if (tags.some((t) => t.name === name)) { setModalError(`Tag "${name}" already exists`); return }
        const r = await window.api.overleafCreateTag(name, modalColor)
        if (!r.success || !r.tag) { setModalError(r.message || 'Failed to create tag'); return }
        const newTag: Tag = r.tag
        setTags((list) => [...list, newTag])
        if (modal.forProjects?.length) {
          addProjectsToTagInView(newTag._id, modal.forProjects)
          await window.api.overleafAddProjectsToTag(newTag._id, modal.forProjects)
        }
        closeModal()
      } else if (modal.kind === 'editTag') {
        const name = modalInput.trim()
        if (!name) return
        if (name.length > MAX_TAG_LENGTH) { setModalError('Tag name cannot exceed 50 characters'); return }
        if (tags.some((t) => t.name === name && t._id !== modal.tag._id)) { setModalError(`Tag "${name}" already exists`); return }
        const r = await window.api.overleafEditTag(modal.tag._id, name, modalColor)
        if (!r.success) { setModalError(r.message || 'Failed to update tag'); return }
        setTags((list) => list.map((t) => (t._id === modal.tag._id ? { ...t, name, color: modalColor } : t)))
        closeModal()
      } else if (modal.kind === 'deleteTag') {
        const r = await window.api.overleafDeleteTag(modal.tag._id)
        if (!r.success) { setModalError(r.message || 'Failed to delete tag'); return }
        setTags((list) => list.filter((t) => t._id !== modal.tag._id))
        if (selectedTagId === modal.tag._id) setSelectedTagId(undefined)
        closeModal()
      } else if (modal.kind === 'apiKeys') {
        const cleaned: Record<string, string> = {}
        for (const [k, v] of Object.entries(apiKeys)) {
          if (v.trim()) cleaned[k] = v.trim()
        }
        await window.api.setApiKeys(cleaned)
        closeModal()
        setStatusMessage('API keys saved')
      }
    } finally {
      setModalBusy(false)
    }
  }

  const handleUploadProject = async () => {
    setError('')
    setBusy(true)
    setBusyText('Uploading project...')
    const result = await window.api.overleafUploadProject()
    setBusy(false)
    if (result.success && result.projectId) {
      setStatusMessage('Project uploaded')
      loadData()
    } else if (result.message !== 'cancelled') {
      setError(result.message || 'Failed to upload project')
    }
  }

  const handleDownload = async (targets: OverleafProject[]) => {
    const name = targets.length === 1 ? targets[0].name : 'projects'
    const r = await window.api.overleafDownloadProjectZip(targets.map((p) => p.id), name)
    if (r.success) setStatusMessage(`Downloaded to ${r.path}`)
    else if (r.message !== 'cancelled') setError(r.message || 'Download failed')
  }

  const handleLogout = async () => {
    await window.api.otDisconnect()
    useAppStore.getState().resetEditorState()
    useAppStore.getState().setScreen('login')
  }

  const openApiKeysModal = async () => {
    const keys = await window.api.getApiKeys()
    setApiKeys(keys)
    setApiKeysVisible({})
    openModal({ kind: 'apiKeys' })
  }

  // ── Formatting helpers ──

  const formatDate = (d: string) => {
    if (!d) return ''
    try {
      const date = new Date(d)
      if (isNaN(date.getTime())) return ''
      const diffMs = Date.now() - date.getTime()
      const diffDays = Math.floor(diffMs / 86400000)
      if (diffDays === 0) {
        const diffH = Math.floor(diffMs / 3600000)
        if (diffH === 0) {
          const diffM = Math.floor(diffMs / 60000)
          return diffM <= 1 ? 'Just now' : `${diffM}m ago`
        }
        return `${diffH}h ago`
      }
      if (diffDays === 1) return 'Yesterday'
      if (diffDays < 7) return `${diffDays}d ago`
      if (diffDays < 365) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    } catch { return '' }
  }

  const personName = (p?: { firstName: string; lastName: string; email?: string } | null) => {
    if (!p) return ''
    return `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.email || ''
  }

  const ownerDisplay = (p: OverleafProject) => {
    if (p.accessLevel === 'owner') return 'You'
    return personName(p.owner)
  }

  const toggleSort = (key: SortKey) => {
    setSort((s) => (s.by === key ? { by: key, order: s.order === 'asc' ? 'desc' : 'asc' } : { by: key, order: s.order }))
  }

  const sortIndicator = (key: SortKey) => (sort.by !== key ? '' : sort.order === 'asc' ? ' ↑' : ' ↓')

  const toggleSelected = (id: string) => {
    setSelectedIds((ids) => {
      const next = new Set(ids)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allVisibleSelected = visibleProjects.length > 0 && selectedProjects.length === visibleProjects.length

  const toggleSelectAll = () => {
    if (allVisibleSelected) setSelectedIds(new Set())
    else setSelectedIds(new Set(visibleProjects.map((p) => p.id)))
  }

  const hasDeletableSelected = selectedProjects.some((p) => p.accessLevel === 'owner')
  const hasLeavableSelected = selectedProjects.some((p) => p.accessLevel !== 'owner')

  const sortedTags = useMemo(() => [...tags].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())), [tags])

  // ── Render ──

  const API_KEY_FIELDS = [
    { id: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
    { id: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
    { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
    { id: 'gemini', label: 'Google Gemini', placeholder: 'AIza...' },
    { id: 'semanticScholar', label: 'Semantic Scholar', placeholder: 'API key (optional, avoids rate limits)' }
  ]

  const iconBtn = (title: string, icon: keyof typeof ICONS, onClick: () => void, danger = false) => (
    <button
      key={title}
      className={`pl-icon-btn ${danger ? 'pl-icon-btn-danger' : ''}`}
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick() }}
    >
      <Icon d={ICONS[icon]} />
    </button>
  )

  /** Tag checklist dropdown, shared by the toolbar bulk action and per-row menus */
  const tagToggleDropdown = (projectIds: string[], onClose: () => void, extraClass = '') => (
    <div className={`pl-dropdown pl-dropdown-right ${extraClass}`}>
      <div className="pl-dropdown-header">Add to tag</div>
      {sortedTags.map((tag) => {
        const allIn = projectIds.every((id) => tag.project_ids?.includes(id))
        return (
          <button key={tag._id} className="pl-dropdown-item" onClick={() => toggleTagForProjects(tag, projectIds)}>
            <span className="pl-tag-dot" style={{ backgroundColor: getTagColor(tag) }} />
            <span className="pl-dropdown-label">{tag.name}</span>
            {allIn && <Icon d={ICONS.check} size={13} />}
          </button>
        )
      })}
      {sortedTags.length > 0 && <hr className="pl-dropdown-divider" />}
      <button
        className="pl-dropdown-item"
        onClick={() => {
          onClose()
          openModal({ kind: 'createTag', forProjects: projectIds })
        }}
      >
        <Icon d={ICONS.plus} size={13} /> Create new tag
      </button>
    </div>
  )

  const rowActions = (p: OverleafProject) => {
    const isOwner = p.accessLevel === 'owner'
    const buttons: JSX.Element[] = []
    if (!p.archived && !p.trashed) {
      const menuOpen = rowTagMenu?.projectId === p.id
      buttons.push(
        <div key="tags" className={`pl-row-tag-wrap ${menuOpen ? 'open' : ''}`} onClick={(e) => e.stopPropagation()}>
          <button
            className="pl-icon-btn"
            title="Add to tag"
            onClick={(e) => {
              // Open upward when the row sits in the lower part of the window
              const up = e.currentTarget.getBoundingClientRect().top > window.innerHeight * 0.55
              setRowTagMenu(menuOpen ? null : { projectId: p.id, up })
            }}
          >
            <Icon d={ICONS.tag} />
          </button>
          {menuOpen && tagToggleDropdown([p.id], () => setRowTagMenu(null), rowTagMenu?.up ? 'pl-dropdown-up' : '')}
        </div>
      )
    }
    if (!p.archived && !p.trashed) buttons.push(iconBtn('Copy', 'copy', () => openModal({ kind: 'clone', project: p })))
    buttons.push(iconBtn('Download .zip file', 'download', () => handleDownload([p])))
    if (!p.archived) buttons.push(iconBtn('Archive', 'archive', () => openModal({ kind: 'confirm', action: 'archive', projects: [p] })))
    if (!p.trashed) buttons.push(iconBtn('Trash', 'trash', () => openModal({ kind: 'confirm', action: 'trash', projects: [p] })))
    if (p.archived) buttons.push(iconBtn('Restore', 'restore', () => unarchiveProjects([p])))
    if (p.trashed) buttons.push(iconBtn('Restore', 'restore', () => untrashProjects([p])))
    if (p.trashed && !isOwner) buttons.push(iconBtn('Leave', 'leave', () => openModal({ kind: 'confirm', action: 'leave', projects: [p] }), true))
    if (p.trashed && isOwner) buttons.push(iconBtn('Delete', 'block', () => openModal({ kind: 'confirm', action: 'delete', projects: [p] }), true))
    if (isOwner && !p.archived && !p.trashed) buttons.push(iconBtn('Rename', 'edit', () => openModal({ kind: 'rename', project: p })))
    return buttons
  }

  const projectTags = (p: OverleafProject) =>
    sortedTags.filter((t) => t.project_ids?.includes(p.id))

  const confirmCopy: Record<string, { title: string; intro: string; note: string; danger: boolean; button: string }> = {
    archive: {
      title: 'Archive projects',
      intro: 'You are about to archive the following projects:',
      note: "Archiving projects won't affect your collaborators.",
      danger: false,
      button: 'Confirm',
    },
    trash: {
      title: 'Trash projects',
      intro: 'You are about to trash the following projects:',
      note: "Trashing projects won't affect your collaborators.",
      danger: false,
      button: 'Confirm',
    },
    delete: {
      title: 'Delete projects',
      intro: 'You are about to delete the following projects:',
      note: 'This action cannot be undone.',
      danger: true,
      button: 'Delete',
    },
    leave: {
      title: 'Leave projects',
      intro: 'You are about to leave the following projects:',
      note: 'This action cannot be undone.',
      danger: true,
      button: 'Leave',
    },
  }

  return (
    <div className="projects-page">
      <div className="projects-drag-bar" />
      <div className="pl-layout">
        {/* ── Sidebar ── */}
        <aside className="pl-sidebar">
          <div className="pl-sidebar-brand">
            <h1>Latte<span className="lattex-x">X</span></h1>
          </div>

          <div className="pl-new-project-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-primary pl-new-project-btn" onClick={() => setNewMenuOpen((v) => !v)}>
              New project
            </button>
            {newMenuOpen && (
              <div className="pl-dropdown">
                <button className="pl-dropdown-item" onClick={() => { setNewMenuOpen(false); openModal({ kind: 'newProject' }) }}>
                  Blank project
                </button>
                <button className="pl-dropdown-item" onClick={() => { setNewMenuOpen(false); handleUploadProject() }}>
                  Upload project
                </button>
              </div>
            )}
          </div>

          <nav className="pl-filters">
            {([
              ['all', 'All projects'],
              ['owned', 'Your projects'],
              ['shared', 'Shared with you'],
              ['archived', 'Archived projects'],
              ['trashed', 'Trashed projects'],
            ] as Array<[Filter, string]>).map(([f, label]) => (
              <button
                key={f}
                className={`pl-filter-item ${selectedTagId === undefined && filter === f ? 'active' : ''}`}
                onClick={() => selectFilter(f)}
              >
                {label}
              </button>
            ))}
          </nav>

          <hr className="pl-sidebar-divider" />

          <div className="pl-tags-section">
            <div className="pl-tags-header">Tags</div>
            <button className="pl-filter-item pl-new-tag" onClick={() => openModal({ kind: 'createTag' })}>
              <Icon d={ICONS.plus} size={13} /> New tag
            </button>
            {sortedTags.map((tag) => (
              <div key={tag._id} className={`pl-tag-row ${selectedTagId === tag._id ? 'active' : ''}`}>
                <button className="pl-tag-main" onClick={() => selectTag(tag._id)}>
                  <span className="pl-tag-dot" style={{ backgroundColor: getTagColor(tag) }} />
                  <span className="pl-tag-name">{tag.name}</span>
                  <span className="pl-tag-count">({projectsPerTag[tag._id] ?? 0})</span>
                </button>
                <div className="pl-tag-kebab-wrap" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="pl-icon-btn pl-tag-kebab"
                    onClick={() => setTagKebabOpen(tagKebabOpen === tag._id ? null : tag._id)}
                  >
                    <Icon d={ICONS.kebab} size={14} />
                  </button>
                  {tagKebabOpen === tag._id && (
                    <div className="pl-dropdown pl-dropdown-right">
                      <button className="pl-dropdown-item" onClick={() => { setTagKebabOpen(null); openModal({ kind: 'editTag', tag }) }}>
                        Edit
                      </button>
                      <button className="pl-dropdown-item pl-danger" onClick={() => { setTagKebabOpen(null); openModal({ kind: 'deleteTag', tag }) }}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {sortedTags.length > 0 && (
              <button
                className={`pl-filter-item pl-uncategorized ${selectedTagId === UNCATEGORIZED_KEY ? 'active' : ''}`}
                onClick={() => selectTag(UNCATEGORIZED_KEY)}
              >
                Uncategorized ({untaggedCount})
              </button>
            )}
          </div>

          <div className="pl-sidebar-footer">
            <button className="btn btn-secondary btn-sm" onClick={openApiKeysModal}>API Keys</button>
            <button className="btn btn-secondary btn-sm" onClick={handleLogout}>Sign out</button>
          </div>
        </aside>

        {/* ── Main column ── */}
        <main className="pl-main">
          {busy ? (
            <div className="projects-busy">
              <div className="overleaf-spinner" />
              <div className="overleaf-log">{busyText}</div>
            </div>
          ) : (
            <>
              <div className="pl-main-header">
                <h2 className="pl-title">{pageTitle}</h2>
                <div className="pl-header-actions">
                  {selectedProjects.length > 0 ? (
                    <div className="pl-bulk-tools" onClick={(e) => e.stopPropagation()}>
                      {iconBtn('Download .zip', 'download', () => handleDownload(selectedProjects))}
                      {filter !== 'archived' && iconBtn('Archive', 'archive', () => openModal({ kind: 'confirm', action: 'archive', projects: selectedProjects }))}
                      {filter !== 'trashed' && iconBtn('Trash', 'trash', () => openModal({ kind: 'confirm', action: 'trash', projects: selectedProjects }))}
                      {filter === 'trashed' && (
                        <button className="btn btn-secondary btn-sm" onClick={() => untrashProjects(selectedProjects)}>Restore</button>
                      )}
                      {filter === 'archived' && (
                        <button className="btn btn-secondary btn-sm" onClick={() => unarchiveProjects(selectedProjects)}>Restore</button>
                      )}
                      {filter === 'trashed' && hasDeletableSelected && !hasLeavableSelected && (
                        <button className="btn btn-danger btn-sm" onClick={() => openModal({ kind: 'confirm', action: 'delete', projects: selectedProjects })}>Delete</button>
                      )}
                      {filter === 'trashed' && hasLeavableSelected && !hasDeletableSelected && (
                        <button className="btn btn-danger btn-sm" onClick={() => openModal({ kind: 'confirm', action: 'leave', projects: selectedProjects })}>Leave</button>
                      )}
                      {filter === 'trashed' && hasLeavableSelected && hasDeletableSelected && (
                        <>
                          <button className="btn btn-danger btn-sm" onClick={() => openModal({ kind: 'confirm', action: 'delete', projects: selectedProjects })}>Delete</button>
                          <button className="btn btn-danger btn-sm" onClick={() => openModal({ kind: 'confirm', action: 'leave', projects: selectedProjects })}>Leave</button>
                        </>
                      )}
                      {!['archived', 'trashed'].includes(filter) && (
                        <div className="pl-tags-dropdown-wrap">
                          <button className="pl-icon-btn" title="Add to tag" onClick={() => setTagsMenuOpen((v) => !v)}>
                            <Icon d={ICONS.tag} />
                          </button>
                          {tagsMenuOpen &&
                            tagToggleDropdown(selectedProjects.map((p) => p.id), () => setTagsMenuOpen(false))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button className="btn btn-secondary btn-sm" onClick={loadData} title="Refresh">
                      {loading ? '…' : '↻'}
                    </button>
                  )}
                </div>
              </div>

              {error && <div className="overleaf-error" style={{ margin: '0 0 12px' }}>{error}</div>}

              <div className="pl-search-row">
                <span className="pl-search-icon"><Icon d={ICONS.search} size={14} /></span>
                <input
                  className="projects-search pl-search-input"
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={searchPlaceholder}
                />
                {searchText && (
                  <button className="pl-icon-btn pl-search-clear" title="Clear search" onClick={() => setSearchText('')}>
                    <Icon d={ICONS.x} size={13} />
                  </button>
                )}
              </div>

              <div className="pl-scroll">
              <div className="pl-table">
                <div className="pl-table-header">
                  <span className="pl-col-check">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedProjects.length > 0 && !allVisibleSelected
                      }}
                      onChange={toggleSelectAll}
                    />
                  </span>
                  <span className="pl-col-name pl-sortable" onClick={() => toggleSort('title')}>
                    Title{sortIndicator('title')}
                  </span>
                  <span className="pl-col-owner pl-sortable" onClick={() => toggleSort('owner')}>
                    Owner{sortIndicator('owner')}
                  </span>
                  <span className="pl-col-updated pl-sortable" onClick={() => toggleSort('lastUpdated')}>
                    Last Modified{sortIndicator('lastUpdated')}
                  </span>
                  <span className="pl-col-actions">Actions</span>
                </div>

                <div className="pl-table-body">
                  {loading && projects.length === 0 ? (
                    <div className="projects-empty">Loading projects…</div>
                  ) : visibleProjects.length === 0 ? (
                    <div className="projects-empty">
                      {searchText ? 'No projects match your search' : 'No projects'}
                    </div>
                  ) : (
                    visibleProjects.map((p) => (
                      <div key={p.id} className={`pl-row ${selectedIds.has(p.id) ? 'selected' : ''}`}>
                        <span className="pl-col-check" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(p.id)}
                            onChange={() => toggleSelected(p.id)}
                          />
                        </span>
                        <span className="pl-col-name">
                          <button className="pl-project-link" onClick={() => handleOpen(p.id)}>{p.name}</button>
                          <span className="pl-row-tags">
                            {projectTags(p).map((tag) => (
                              <span key={tag._id} className="pl-chip">
                                <span className="pl-tag-dot" style={{ backgroundColor: getTagColor(tag) }} />
                                <button className="pl-chip-name" onClick={() => selectTag(tag._id)}>{tag.name}</button>
                                <button
                                  className="pl-chip-x"
                                  title={`Remove from ${tag.name}`}
                                  onClick={() => {
                                    removeProjectsFromTagInView(tag._id, [p.id])
                                    window.api.overleafRemoveProjectsFromTag(tag._id, [p.id])
                                  }}
                                >
                                  <Icon d={ICONS.x} size={9} />
                                </button>
                              </span>
                            ))}
                          </span>
                        </span>
                        <span className="pl-col-owner">
                          {ownerDisplay(p)}
                          {p.source === 'token' && <span className="pl-link-icon" title="Link sharing"><Icon d={ICONS.link} size={12} /></span>}
                        </span>
                        <span className="pl-col-updated" title={new Date(p.lastUpdated).toLocaleString()}>
                          {formatDate(p.lastUpdated)}
                          {p.lastUpdatedBy && <span className="projects-updated-by"> by {personName(p.lastUpdatedBy)}</span>}
                        </span>
                        <span className="pl-col-actions">{rowActions(p)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {hiddenCount > 0 && (
                <div className="pl-load-more">
                  <button className="btn btn-secondary btn-sm" onClick={() => setMaxVisible((m) => m + Math.min(hiddenCount, PAGE_SIZE))}>
                    Show {Math.min(hiddenCount, PAGE_SIZE)} more projects
                  </button>
                  <span className="pl-load-more-info">
                    Showing {visibleProjects.length} out of {filteredProjects.length} projects.{' '}
                    <button className="pl-link-btn" onClick={() => setMaxVisible(filteredProjects.length)}>Show all</button>
                  </span>
                </div>
              )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* ── Modals ── */}
      {modal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ minWidth: modal.kind === 'apiKeys' ? 460 : 400 }}>
            {modal.kind === 'newProject' && (
              <>
                <h3 className="pl-modal-title">New project</h3>
                <label className="pl-modal-label">Project name</label>
                <input
                  type="text" className="modal-input" value={modalInput} autoFocus
                  onChange={(e) => setModalInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runModalAction(); if (e.key === 'Escape') closeModal() }}
                />
                {modalError && <div className="overleaf-error pl-modal-error">{modalError}</div>}
                <div className="pl-modal-actions">
                  <button className="btn btn-secondary btn-sm" onClick={closeModal}>Cancel</button>
                  <button className="btn btn-primary btn-sm" disabled={!modalInput.trim() || modalBusy} onClick={runModalAction}>
                    {modalBusy ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </>
            )}

            {modal.kind === 'rename' && (
              <>
                <h3 className="pl-modal-title">Rename project</h3>
                <label className="pl-modal-label">New name</label>
                <input
                  type="text" className="modal-input" value={modalInput} autoFocus
                  onChange={(e) => setModalInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runModalAction(); if (e.key === 'Escape') closeModal() }}
                />
                {modalError && <div className="overleaf-error pl-modal-error">{modalError}</div>}
                <div className="pl-modal-actions">
                  <button className="btn btn-secondary btn-sm" onClick={closeModal}>Cancel</button>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!modalInput.trim() || modalInput.trim() === modal.project.name || modalBusy}
                    onClick={runModalAction}
                  >
                    {modalBusy ? 'Renaming…' : 'Rename'}
                  </button>
                </div>
              </>
            )}

            {modal.kind === 'clone' && (
              <>
                <h3 className="pl-modal-title">Copy project</h3>
                <label className="pl-modal-label">New name</label>
                <input
                  type="text" className="modal-input" value={modalInput} autoFocus
                  onChange={(e) => setModalInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runModalAction(); if (e.key === 'Escape') closeModal() }}
                />
                {modalError && <div className="overleaf-error pl-modal-error">{modalError}</div>}
                <div className="pl-modal-actions">
                  <button className="btn btn-secondary btn-sm" onClick={closeModal}>Cancel</button>
                  <button className="btn btn-primary btn-sm" disabled={!modalInput.trim() || modalBusy} onClick={runModalAction}>
                    {modalBusy ? 'Copying…' : 'Copy'}
                  </button>
                </div>
              </>
            )}

            {modal.kind === 'confirm' && (
              <>
                <h3 className="pl-modal-title">{confirmCopy[modal.action].title}</h3>
                <p className="pl-modal-text">{confirmCopy[modal.action].intro}</p>
                <ul className="pl-modal-list">
                  {modal.projects.map((p) => <li key={p.id}><b>{p.name}</b></li>)}
                </ul>
                <p className={`pl-modal-note ${confirmCopy[modal.action].danger ? 'pl-danger' : ''}`}>
                  {confirmCopy[modal.action].note}
                </p>
                {modalError && <div className="overleaf-error pl-modal-error">{modalError}</div>}
                <div className="pl-modal-actions">
                  <button className="btn btn-secondary btn-sm" onClick={closeModal}>Cancel</button>
                  <button
                    className={`btn btn-sm ${confirmCopy[modal.action].danger ? 'btn-danger' : 'btn-primary'}`}
                    disabled={modalBusy}
                    onClick={runModalAction}
                  >
                    {modalBusy ? 'Working…' : confirmCopy[modal.action].button}
                  </button>
                </div>
              </>
            )}

            {(modal.kind === 'createTag' || modal.kind === 'editTag') && (
              <>
                <h3 className="pl-modal-title">{modal.kind === 'createTag' ? 'Create new tag' : 'Edit tag'}</h3>
                <label className="pl-modal-label">{modal.kind === 'createTag' ? 'New tag name' : 'Tag name'}</label>
                <input
                  type="text" className="modal-input" value={modalInput} autoFocus maxLength={MAX_TAG_LENGTH + 1}
                  onChange={(e) => setModalInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runModalAction(); if (e.key === 'Escape') closeModal() }}
                />
                <label className="pl-modal-label">Tag color</label>
                <div className="pl-color-row">
                  {PRESET_COLORS.map(({ color, name }) => (
                    <button
                      key={color}
                      className={`pl-color-swatch ${modalColor === color ? 'selected' : ''}`}
                      style={{ backgroundColor: color }}
                      title={name}
                      onClick={() => setModalColor(color)}
                    >
                      {modalColor === color && <Icon d={ICONS.check} size={12} />}
                    </button>
                  ))}
                  <input
                    type="color"
                    className="pl-color-custom"
                    title="Custom color"
                    value={modalColor && /^#/.test(modalColor) ? modalColor : '#A7B1C2'}
                    onChange={(e) => setModalColor(e.target.value)}
                  />
                </div>
                {modalError && <div className="overleaf-error pl-modal-error">{modalError}</div>}
                <div className="pl-modal-actions">
                  <button className="btn btn-secondary btn-sm" onClick={closeModal}>Cancel</button>
                  <button className="btn btn-primary btn-sm" disabled={!modalInput.trim() || modalBusy} onClick={runModalAction}>
                    {modalBusy ? (modal.kind === 'createTag' ? 'Creating…' : 'Saving…') : (modal.kind === 'createTag' ? 'Create' : 'Save')}
                  </button>
                </div>
              </>
            )}

            {modal.kind === 'deleteTag' && (
              <>
                <h3 className="pl-modal-title">Delete tag</h3>
                <p className="pl-modal-text">
                  You are about to delete the following tag (any projects in it will not be deleted):
                </p>
                <ul className="pl-modal-list"><li><b>{modal.tag.name}</b></li></ul>
                {modalError && <div className="overleaf-error pl-modal-error">{modalError}</div>}
                <div className="pl-modal-actions">
                  <button className="btn btn-secondary btn-sm" onClick={closeModal}>Cancel</button>
                  <button className="btn btn-danger btn-sm" disabled={modalBusy} onClick={runModalAction}>
                    {modalBusy ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </>
            )}

            {modal.kind === 'apiKeys' && (
              <>
                <h3 className="pl-modal-title">API Keys</h3>
                <p className="pl-modal-text" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Keys are stored locally on this device.
                </p>
                {API_KEY_FIELDS.map((field) => (
                  <div key={field.id} style={{ marginBottom: 12 }}>
                    <label className="pl-modal-label">{field.label}</label>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input
                        type={apiKeysVisible[field.id] ? 'text' : 'password'}
                        className="modal-input"
                        value={apiKeys[field.id] || ''}
                        onChange={(e) => setApiKeys({ ...apiKeys, [field.id]: e.target.value })}
                        placeholder={field.placeholder}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setApiKeysVisible({ ...apiKeysVisible, [field.id]: !apiKeysVisible[field.id] })}
                        style={{ flexShrink: 0, padding: '6px 8px', fontSize: 11 }}
                      >
                        {apiKeysVisible[field.id] ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                ))}
                <div className="pl-modal-actions">
                  <button className="btn btn-secondary btn-sm" onClick={closeModal}>Cancel</button>
                  <button className="btn btn-primary btn-sm" onClick={runModalAction}>Save</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
