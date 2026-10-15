import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Copy,
  Crosshair,
  Download,
  File,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { RemoteEntry } from '@shared/types'
import {
  api,
  cachedListing,
  confirmDialog,
  droppedPaths,
  errorMessage,
  fetchListing,
  formatBytes,
  formatDate,
  hasFiles,
  invalidateListing,
  isMac,
  type Listing,
  showDialog,
  textDialog,
  uploadWithConfirm
} from '../lib'

interface Props {
  sessionId?: string
  connected: boolean
  onClose(): void
}

type Menu = { x: number; y: number; entry?: RemoteEntry }

const parentOf = (p: string): string => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/')
const joinPath = (dir: string, name: string): string => (dir.endsWith('/') ? dir : dir + '/') + name

export function SftpPanel({ sessionId, connected, onClose }: Props): React.JSX.Element {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [width, setWidth] = useState(400)
  const dragDepth = useRef(0)
  const crumbsEl = useRef<HTMLDivElement>(null)
  const menuEl = useRef<HTMLDivElement>(null)
  const pathRef = useRef(path)
  pathRef.current = path
  const loadSeq = useRef(0)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const fail = (e: unknown): void => {
    void showDialog({
      title: 'Something went wrong',
      message: errorMessage(e),
      buttons: [{ label: 'OK', value: 'ok', variant: 'primary' }]
    })
  }

  const show = useCallback((res: Listing) => {
    const samePath = res.path === pathRef.current
    setPath(res.path)
    setEntries(res.entries)
    setError('')
    if (!samePath) {
      setSelected(new Set())
      setAnchor(null)
    } else {
      const still = new Set(res.entries.map((e) => e.path))
      setSelected((sel) => new Set([...sel].filter((p) => still.has(p))))
      setAnchor((a) => (a && still.has(a) ? a : null))
    }
  }, [])

  /** Shows a cached listing right away (unless `fresh`), then refreshes it from the server. */
  const load = useCallback(
    async (dir: string, fresh = false) => {
      if (!sessionId) return
      const seq = ++loadSeq.current
      if (fresh) invalidateListing(sessionId, dir)
      const cached = cachedListing(sessionId, dir)
      if (cached) show(cached)
      setLoading(true)
      try {
        const res = await fetchListing(sessionId, dir, fresh)
        if (seq === loadSeq.current) show(res)
      } catch (e) {
        // The folder may be gone; don't leave a stale cached copy on screen.
        invalidateListing(sessionId, dir)
        if (seq === loadSeq.current) {
          setEntries([])
          setError(errorMessage(e))
        }
      } finally {
        if (seq === loadSeq.current) setLoading(false)
      }
    },
    [sessionId, show]
  )

  /** Hovering a folder briefly loads it in the background, so opening it is instant. */
  const prefetch = (item: RemoteEntry): void => {
    clearTimeout(hoverTimer.current)
    if (!sessionId || !item.isDir || cachedListing(sessionId, item.path)) return
    hoverTimer.current = setTimeout(() => fetchListing(sessionId, item.path).catch(() => {}), 120)
  }

  const goToTerminalDir = useCallback(async () => {
    if (!sessionId) return
    const dir = await api.getCwd(sessionId).catch(() => '.')
    await load(dir)
  }, [sessionId, load])

  useEffect(() => {
    if (connected && sessionId) void goToTerminalDir()
  }, [connected, sessionId, goToTerminalDir])

  // Refresh when an upload into the visible folder finishes.
  useEffect(
    () =>
      api.onTransfer((t) => {
        if (!sessionId || t.sessionId !== sessionId || t.direction !== 'up' || t.status === 'running') return
        if (t.target === pathRef.current) void load(pathRef.current, true)
        else invalidateListing(sessionId, t.target)
      }),
    [sessionId, load]
  )

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  // ---------------------------------------------------------------- actions
  const selection = (): RemoteEntry[] => entries.filter((e) => selected.has(e.path))

  const download = (items: RemoteEntry[]): void => {
    if (sessionId && items.length) api.download(sessionId, items.map((i) => i.path)).catch(fail)
  }

  const remove = async (items: RemoteEntry[]): Promise<void> => {
    if (!sessionId || !items.length) return
    const what = items.length === 1 ? `“${items[0].name}”` : `${items.length} items`
    if (!(await confirmDialog(`Delete ${what}?`, 'This cannot be undone.', 'Delete', true))) return
    try {
      await api.remove(sessionId, items.map((i) => i.path))
    } catch (e) {
      fail(e)
    }
    void load(path, true)
  }

  const rename = async (item: RemoteEntry): Promise<void> => {
    if (!sessionId) return
    const name = await textDialog('Rename', item.name, 'Rename')
    if (!name || name === item.name) return
    try {
      await api.rename(sessionId, item.path, joinPath(path, name))
    } catch (e) {
      fail(e)
    }
    void load(path, true)
  }

  const newFolder = async (): Promise<void> => {
    if (!sessionId) return
    const name = await textDialog('New folder', '', 'Create')
    if (!name) return
    try {
      await api.mkdir(sessionId, joinPath(path, name))
    } catch (e) {
      fail(e)
    }
    void load(path, true)
  }

  const open = (item: RemoteEntry): void => {
    if (item.isDir) void load(item.path)
    else download([item])
  }

  const onRowClick = (e: React.MouseEvent, item: RemoteEntry): void => {
    const multi = isMac ? e.metaKey : e.ctrlKey
    if (e.shiftKey && anchor) {
      const a = entries.findIndex((x) => x.path === anchor)
      const b = entries.findIndex((x) => x.path === item.path)
      const [from, to] = a < b ? [a, b] : [b, a]
      setSelected(new Set(entries.slice(from, to + 1).map((x) => x.path)))
      return
    }
    setAnchor(item.path)
    if (multi) {
      const next = new Set(selected)
      if (next.has(item.path)) next.delete(item.path)
      else next.add(item.path)
      setSelected(next)
    } else {
      setSelected(new Set([item.path]))
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const sel = selection()
    if (e.key === 'Delete' || (isMac && e.key === 'Backspace' && e.metaKey)) void remove(sel)
    else if (e.key === 'Backspace') void load(parentOf(path))
    else if (e.key === 'Enter' && sel.length === 1) open(sel[0])
    else if (e.key === 'F2' && sel.length === 1) void rename(sel[0])
    else if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'a') setSelected(new Set(entries.map((x) => x.path)))
    else return
    e.preventDefault()
  }

  // ------------------------------------------------------------ drag & drop
  const upload = (paths: string[], dir: string): void => {
    if (sessionId) uploadWithConfirm(sessionId, paths, dir).catch(fail)
  }

  const panelDrop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current++
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      // Hovering a folder row targets that folder, anything else the open folder.
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]')
      setDropTarget(row?.dataset.dir ?? path)
    },
    onDragLeave: () => {
      if (--dragDepth.current <= 0) {
        dragDepth.current = 0
        setDropTarget(null)
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      const target = dropTarget ?? path
      dragDepth.current = 0
      setDropTarget(null)
      upload(droppedPaths(e), target)
    }
  }

  // ---------------------------------------------------------------- resizing
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent): void =>
      setWidth(Math.min(Math.max(260, startW + startX - ev.clientX), window.innerWidth * 0.7))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const crumbs = path === '/' ? [''] : path.split('/')

  // Keep the context menu inside the window (the panel sits at the right edge).
  useLayoutEffect(() => {
    const el = menuEl.current
    if (!menu || !el) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))}px`
  }, [menu])

  // Long paths: keep the deepest folder in view.
  useEffect(() => {
    if (crumbsEl.current) crumbsEl.current.scrollLeft = crumbsEl.current.scrollWidth
  }, [path, editing])

  return (
    <section
      className={`sftp ${dropTarget === path ? 'drop-here' : ''}`}
      style={{ width }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      {...panelDrop}
    >
      <div className="resizer" onMouseDown={startResize} />

      <div className="sftp-bar">
        <button className="icon-btn" onClick={() => void load(parentOf(path))} disabled={path === '/'} title="Up">
          <ArrowUp size={15} />
        </button>
        {editing ? (
          <input
            className="path-input"
            autoFocus
            defaultValue={path}
            spellCheck={false}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setEditing(false)
                void load((e.target as HTMLInputElement).value.trim() || '/')
              } else if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <div className="crumbs" ref={crumbsEl} onDoubleClick={() => setEditing(true)} title="Double-click to type a path">
            {crumbs.map((c, i) => {
              const target = crumbs.slice(0, i + 1).join('/') || '/'
              return (
                <span key={i} className="crumb" onClick={() => void load(target)}>
                  {i === 0 ? '/' : c}
                  {i > 0 && i < crumbs.length - 1 && <span className="sep">/</span>}
                </span>
              )
            })}
          </div>
        )}
        <button className="icon-btn" onClick={() => void goToTerminalDir()} title="Go to terminal's folder">
          <Crosshair size={15} />
        </button>
        <button className="icon-btn" onClick={() => void newFolder()} title="New folder">
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" onClick={() => void load(path, true)} title="Refresh">
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">
          <X size={15} />
        </button>
      </div>

      <div className="sftp-head">
        <span>Name</span>
        <span>Size</span>
        <span>Modified</span>
      </div>

      <div
        className="sftp-list"
        onMouseDown={(e) => e.target === e.currentTarget && setSelected(new Set())}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {!connected && <div className="sftp-empty">Not connected</div>}
        {connected && error && <div className="sftp-empty error">{error}</div>}
        {connected && !error && entries.length === 0 && !loading && <div className="sftp-empty">Empty folder</div>}
        {entries.map((item) => (
          <div
            key={item.path}
            className={`sftp-row ${selected.has(item.path) ? 'sel' : ''} ${dropTarget === item.path ? 'drop' : ''}`}
            onMouseDown={(e) => e.button === 0 && onRowClick(e, item)}
            onDoubleClick={() => open(item)}
            onContextMenu={(e) => {
              e.preventDefault()
              if (!selected.has(item.path)) setSelected(new Set([item.path]))
              setMenu({ x: e.clientX, y: e.clientY, entry: item })
            }}
            data-dir={item.isDir ? item.path : undefined}
            onMouseEnter={() => prefetch(item)}
            onMouseLeave={() => clearTimeout(hoverTimer.current)}
          >
            <span className="name">
              {item.isDir ? <Folder size={15} className="ico dir" /> : <File size={15} className="ico" />}
              <span className={item.isLink ? 'link-name' : ''}>{item.name}</span>
            </span>
            <span className="size">{item.isDir ? '' : formatBytes(item.size)}</span>
            <span className="date">{formatDate(item.mtime)}</span>
          </div>
        ))}
      </div>

      <div className="sftp-foot">
        <Upload size={13} /> Drop files here or onto a folder to upload
      </div>

      {menu && (
        <div className="menu" ref={menuEl} style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menu.entry ? (
            <>
              <button onClick={() => (setMenu(null), download(selection()))}>
                <Download size={14} /> Download
              </button>
              {selected.size <= 1 && (
                <button onClick={() => (setMenu(null), void rename(menu.entry!))}>
                  <Pencil size={14} /> Rename
                </button>
              )}
              <button onClick={() => (setMenu(null), void navigator.clipboard.writeText(menu.entry!.path))}>
                <Copy size={14} /> Copy path
              </button>
              <hr />
              <button className="danger-text" onClick={() => (setMenu(null), void remove(selection()))}>
                <Trash2 size={14} /> Delete
              </button>
            </>
          ) : (
            <>
              <button onClick={() => (setMenu(null), void newFolder())}>
                <FolderPlus size={14} /> New folder
              </button>
              <button onClick={() => (setMenu(null), void load(path, true))}>
                <RefreshCw size={14} /> Refresh
              </button>
            </>
          )}
        </div>
      )}
    </section>
  )
}
