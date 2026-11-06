import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  ClipboardPaste,
  Copy,
  Crosshair,
  Download,
  File,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Send,
  SquareTerminal,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { RemoteEntry } from '@shared/types'
import { joinPath, parentOf } from '@shared/shell'
import {
  api,
  cachedListing,
  confirmDialog,
  copyWithConfirm,
  droppedPaths,
  errorMessage,
  fetchListing,
  formatBytes,
  formatDate,
  hasFiles,
  invalidateListing,
  isMac,
  isRemoteDrag,
  REMOTE_DRAG,
  remoteDragOf,
  setRemoteDrag,
  type Listing,
  showDialog,
  textDialog,
  uploadWithConfirm
} from '../lib'
import { cancelCut, copyEntries, pasteInto, useCutPaths } from '../paste'
import { keyHint, useShortcuts } from '../useShortcuts'

/** Another open, connected tab that files can be sent to. */
export interface Peer {
  sessionId: string
  title: string
}

interface Props {
  sessionId?: string
  connected: boolean
  peers: Peer[]
  onClose(): void
  /** Takes the terminal's shell to this folder. */
  onCdHere(dir: string): void
}

type Menu = { x: number; y: number; entry?: RemoteEntry }

/** Height of a row in px (see .sftp-row), for paging with PgUp / PgDn. */
const ROW_HEIGHT = 34
/** Folders remembered for Back / Forward. */
const HISTORY = 100

export function SftpPanel({ sessionId, connected, peers, onClose, onCdHere }: Props): React.JSX.Element {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  /** The row the keyboard is on. */
  const [cursor, setCursor] = useState<string | null>(null)
  /** Text the list is narrowed to; null when the filter box is closed. */
  const [filter, setFilter] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [width, setWidth] = useState(400)
  const panelEl = useRef<HTMLElement>(null)
  const listEl = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const crumbsEl = useRef<HTMLDivElement>(null)
  const menuEl = useRef<HTMLDivElement>(null)
  const pathRef = useRef(path)
  pathRef.current = path
  const loadSeq = useRef(0)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** Folders visited, for Back / Forward, and whether the next folder shown is a new visit. */
  const history = useRef<{ list: string[]; at: number; visiting: boolean }>({ list: [], at: -1, visiting: true })
  const typed = useRef({ text: '', at: 0 })
  const cutPaths = useCutPaths(sessionId)

  const visible = filter ? entries.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase())) : entries

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
      setCursor(null)
      setFilter(null)
      const h = history.current
      if (h.visiting) {
        h.list = [...h.list.slice(0, h.at + 1), res.path].slice(-HISTORY)
        h.at = h.list.length - 1
      }
    } else {
      const still = new Set(res.entries.map((e) => e.path))
      setSelected((sel) => new Set([...sel].filter((p) => still.has(p))))
      setAnchor((a) => (a && still.has(a) ? a : null))
      setCursor((c) => (c && still.has(c) ? c : null))
    }
    history.current.visiting = true
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

  /** Back (-1) or Forward (+1) through the folders visited. */
  const step = (by: -1 | 1): void => {
    const h = history.current
    const to = h.at + by
    if (to < 0 || to >= h.list.length) return
    h.at = to
    h.visiting = false
    void load(h.list[to])
  }

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

  // Refresh when an upload or copy into the visible folder finishes.
  useEffect(
    () =>
      api.onTransfer((t) => {
        if (!sessionId || t.sessionId !== sessionId || t.direction === 'down' || t.status === 'running') return
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

  // Keep the keyboard's row in view.
  useEffect(() => {
    if (!cursor) return
    listEl.current?.querySelector(`[data-path="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const focusPanel = (): void => panelEl.current?.focus()

  // ---------------------------------------------------------------- actions
  const selection = (): RemoteEntry[] => visible.filter((e) => selected.has(e.path))

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

  /** Copies entries to another open session, into its terminal's current folder. */
  const sendTo = (peer: Peer, items: RemoteEntry[]): void => {
    if (sessionId && items.length) copyWithConfirm(sessionId, items.map((i) => i.path), peer.sessionId).catch(fail)
  }

  /** Ctrl+C / Ctrl+X: onto the system clipboard, for Explorer / Finder or another Liman panel. */
  const copySelection = (mode: 'copy' | 'cut', items = selection()): void => {
    if (!sessionId || !items.length) return
    copyEntries(sessionId, items.map((i) => ({ path: i.path, isDir: i.isDir })), mode).catch(fail)
  }

  /** Ctrl+V: files from Explorer / Finder, a screenshot, or what Liman copied, into `dir`. */
  const paste = async (dir = path): Promise<void> => {
    if (!sessionId) return
    try {
      const pasted = await pasteInto(sessionId, dir, await api.inspectClipboard())
      if (pasted) void load(path, true)
    } catch (e) {
      fail(e)
    }
  }

  const open = (item: RemoteEntry): void => {
    if (item.isDir) void load(item.path)
    else download([item])
  }

  /** The folder an action on the selection is about: a single selected folder, or the open one. */
  const selectedFolder = (): string => {
    const sel = selection()
    return sel.length === 1 && sel[0].isDir ? sel[0].path : path
  }

  const onRowClick = (e: React.MouseEvent, item: RemoteEntry): void => {
    const multi = isMac ? e.metaKey : e.ctrlKey
    setCursor(item.path)
    if (e.shiftKey && anchor) {
      selectRange(anchor, item.path)
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

  const selectRange = (from: string, to: string): void => {
    const a = visible.findIndex((x) => x.path === from)
    const b = visible.findIndex((x) => x.path === to)
    const [lo, hi] = a < b ? [a, b] : [b, a]
    setSelected(new Set(visible.slice(Math.max(0, lo), hi + 1).map((x) => x.path)))
  }

  /** Puts the keyboard on row `index`; with Shift the selection grows from the anchor. */
  const moveTo = (index: number, extend: boolean): void => {
    if (!visible.length) return
    const item = visible[Math.max(0, Math.min(visible.length - 1, index))]
    setCursor(item.path)
    if (extend) {
      const from = anchor ?? cursor ?? item.path
      setAnchor(from)
      selectRange(from, item.path)
    } else {
      setAnchor(item.path)
      setSelected(new Set([item.path]))
    }
  }

  // Keys that aren't shortcuts: moving through the list, and typing a name to jump to it.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return
    const at = visible.findIndex((x) => x.path === cursor)
    const page = Math.max(1, Math.floor((listEl.current?.clientHeight ?? 340) / ROW_HEIGHT) - 1)
    const targets: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowUp: at < 0 ? 0 : at - 1,
      Home: 0,
      End: visible.length - 1,
      PageDown: Math.max(at, 0) + page,
      PageUp: Math.max(at, 0) - page
    }
    if (e.key in targets) {
      e.preventDefault()
      moveTo(targets[e.key], e.shiftKey)
      return
    }
    if (e.key.length !== 1 || e.key === ' ') return
    e.preventDefault()
    const t = typed.current
    const now = Date.now()
    t.text = now - t.at < 1000 ? t.text + e.key.toLowerCase() : e.key.toLowerCase()
    t.at = now
    // Pressing one letter again goes on to the next name that starts with it.
    const again = [...t.text].every((c) => c === t.text[0])
    const prefix = again ? t.text[0] : t.text
    const start = again ? at + 1 : 0
    const order = [...visible.slice(start), ...visible.slice(0, start)]
    const hit = order.find((x) => x.name.toLowerCase().startsWith(prefix))
    if (hit) moveTo(visible.indexOf(hit), false)
  }

  useShortcuts(
    {
      'files.copy': () => copySelection('copy'),
      'files.cut': () => copySelection('cut'),
      'files.paste': () => void paste(),
      'files.refresh': () => void load(path, true),
      'files.open': () => {
        const sel = selection()
        if (sel.length === 1) open(sel[0])
      },
      'files.up': () => void load(parentOf(path)),
      'files.back': () => step(-1),
      'files.forward': () => step(1),
      // Handled even with nothing selected: F2 in the panel never renames the tab.
      'files.rename': () => {
        const sel = selection()
        if (sel.length === 1) void rename(sel[0])
      },
      'files.delete': () => void remove(selection()),
      'files.newFolder': () => void newFolder(),
      'files.download': () => download(selection()),
      'files.copyPath': () => {
        const sel = selection()
        void navigator.clipboard.writeText(sel.length ? sel.map((i) => i.path).join('\n') : path)
      },
      'files.cdHere': () => onCdHere(selectedFolder()),
      'files.filter': () => setFilter((f) => f ?? ''),
      'files.goTo': () => setEditing(true),
      'files.selectAll': () => setSelected(new Set(visible.map((x) => x.path))),
      'files.escape': () => {
        if (cancelCut()) return
        if (filter !== null) return setFilter(null)
        if (selected.size) return setSelected(new Set())
        return false
      }
    },
    panelEl
  )

  // ------------------------------------------------------------ drag & drop
  const upload = (paths: string[], dir: string): void => {
    if (sessionId) uploadWithConfirm(sessionId, paths, dir).catch(fail)
  }

  /** Starts dragging the selection (or just this row) to another panel, folder, terminal or tab. */
  const startRowDrag = (e: React.DragEvent, item: RemoteEntry): void => {
    if (!sessionId) return
    const items = selected.has(item.path) ? selection() : [item]
    if (!selected.has(item.path)) setSelected(new Set([item.path]))
    const paths = items.map((i) => i.path)
    // Prefer an OS drag of local stand-ins: it can also land on the desktop or in a folder.
    const out = api.dragOutPrepare(sessionId, items.map((i) => ({ path: i.path, isDir: i.isDir })))
    if (out) {
      e.preventDefault()
      setRemoteDrag({ sessionId, paths, standIns: out.files })
      api.dragOutBegin(out.token)
      return
    }
    setRemoteDrag({ sessionId, paths })
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData(REMOTE_DRAG, items.map((i) => i.path).join('\n'))
  }

  const accepts = (e: React.DragEvent): boolean => hasFiles(e) || isRemoteDrag(e)

  /** Where a drop would go: the folder row under the pointer, or the open folder. */
  const targetOf = (e: React.DragEvent): string =>
    (e.target as HTMLElement).closest<HTMLElement>('[data-dir]')?.dataset.dir ?? path

  const panelDrop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!accepts(e)) return
      e.preventDefault()
      dragDepth.current++
    },
    onDragOver: (e: React.DragEvent) => {
      if (!accepts(e)) return
      const target = targetOf(e)
      const drag = remoteDragOf(e)
      // Dragging within this server only means something onto another folder (a move).
      if (drag && drag.sessionId === sessionId) {
        const pointless = drag.paths.some((p) => p === target) || drag.paths.every((p) => parentOf(p) === target)
        if (pointless) {
          e.dataTransfer.dropEffect = 'none'
          setDropTarget(null)
          return
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      } else {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
      setDropTarget(target)
    },
    onDragLeave: () => {
      if (--dragDepth.current <= 0) {
        dragDepth.current = 0
        setDropTarget(null)
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!accepts(e) || !sessionId) return
      e.preventDefault()
      e.stopPropagation()
      const target = dropTarget ?? path
      dragDepth.current = 0
      setDropTarget(null)
      const drag = remoteDragOf(e, true)
      if (!drag) return upload(droppedPaths(e), target)
      setRemoteDrag(null)
      if (drag.sessionId === sessionId) {
        api
          .moveInto(sessionId, drag.paths, target)
          .catch(fail)
          .finally(() => void load(path, true))
      } else {
        copyWithConfirm(drag.sessionId, drag.paths, sessionId, target).catch(fail)
      }
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

  /** A menu item with its shortcut on the right. */
  const menuItem = (icon: React.ReactNode, label: string, shortcut: string, run: () => void, className?: string): React.JSX.Element => (
    <button className={className} onClick={() => (setMenu(null), run())}>
      {icon} {label}
      {shortcut && <kbd className="menu-key">{keyHint(shortcut)}</kbd>}
    </button>
  )

  return (
    <section
      ref={panelEl}
      className={`sftp ${dropTarget === path ? 'drop-here' : ''}`}
      style={{ width }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      {...panelDrop}
    >
      <div className="resizer" onMouseDown={startResize} />

      <div className="sftp-bar">
        <button
          className="icon-btn"
          onClick={() => void load(parentOf(path))}
          disabled={path === '/'}
          title={`Up (${keyHint('files.up')})`}
        >
          <ArrowUp size={15} />
        </button>
        {editing ? (
          <input
            className="path-input"
            autoFocus
            defaultValue={path}
            // Selected, so typing replaces it (as in Explorer's address bar).
            onFocus={(e) => e.currentTarget.select()}
            spellCheck={false}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setEditing(false)
                void load((e.target as HTMLInputElement).value.trim() || '/')
                focusPanel()
              } else if (e.key === 'Escape') {
                setEditing(false)
                focusPanel()
              }
            }}
          />
        ) : (
          <div className="crumbs" ref={crumbsEl} onDoubleClick={() => setEditing(true)} title={`Double-click (or ${keyHint('files.goTo')}) to type a path`}>
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
        <button className="icon-btn" onClick={() => void newFolder()} title={`New folder (${keyHint('files.newFolder')})`}>
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" onClick={() => void load(path, true)} title={`Refresh (${keyHint('files.refresh')})`}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">
          <X size={15} />
        </button>
      </div>

      {filter !== null && (
        <div className="sftp-filter">
          <Search size={13} />
          <input
            autoFocus
            value={filter}
            placeholder="Filter this folder"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setFilter(null)
                focusPanel()
              } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault()
                focusPanel()
                moveTo(0, false)
              }
            }}
          />
          <button className="icon-btn" onClick={() => (setFilter(null), focusPanel())} title="Clear filter (Esc)">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="sftp-head">
        <span>Name</span>
        <span>Size</span>
        <span>Modified</span>
      </div>

      <div
        ref={listEl}
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
        {connected && !error && entries.length > 0 && visible.length === 0 && <div className="sftp-empty">No matches</div>}
        {visible.map((item) => (
          <div
            key={item.path}
            className={[
              'sftp-row',
              selected.has(item.path) && 'sel',
              cursor === item.path && 'cursor',
              cutPaths?.has(item.path) && 'cut',
              dropTarget === item.path && 'drop'
            ]
              .filter(Boolean)
              .join(' ')}
            onMouseDown={(e) => e.button === 0 && onRowClick(e, item)}
            onDoubleClick={() => open(item)}
            onContextMenu={(e) => {
              e.preventDefault()
              if (!selected.has(item.path)) setSelected(new Set([item.path]))
              setCursor(item.path)
              setMenu({ x: e.clientX, y: e.clientY, entry: item })
            }}
            data-path={item.path}
            data-dir={item.isDir ? item.path : undefined}
            draggable
            onDragStart={(e) => startRowDrag(e, item)}
            onDragEnd={() => setRemoteDrag(null)}
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
        <Upload size={13} /> Drop or paste ({keyHint('files.paste')}) files here · F1 for all shortcuts
      </div>

      {menu && (
        <div className="menu" ref={menuEl} style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menu.entry ? (
            <>
              {menuItem(<Download size={14} />, 'Download', 'files.download', () => download(selection()))}
              {menuItem(<Copy size={14} />, 'Copy', 'files.copy', () => copySelection('copy'))}
              {menuItem(<Scissors size={14} />, 'Cut', 'files.cut', () => copySelection('cut'))}
              {menu.entry.isDir &&
                selected.size <= 1 &&
                menuItem(<ClipboardPaste size={14} />, `Paste into ${menu.entry.name}`, '', () => void paste(menu.entry!.path))}
              {selected.size <= 1 && menuItem(<Pencil size={14} />, 'Rename', 'files.rename', () => void rename(menu.entry!))}
              {menuItem(<Copy size={14} />, 'Copy path', 'files.copyPath', () => void navigator.clipboard.writeText(menu.entry!.path))}
              {menuItem(<SquareTerminal size={14} />, 'Open in terminal', 'files.cdHere', () => onCdHere(menu.entry!.isDir ? menu.entry!.path : path))}
              {peers.length > 0 && (
                <>
                  <hr />
                  <div className="menu-label">Send to</div>
                  {peers.map((peer) => (
                    <button key={peer.sessionId} onClick={() => (setMenu(null), sendTo(peer, selection()))}>
                      <Send size={14} /> {peer.title}
                    </button>
                  ))}
                </>
              )}
              <hr />
              {menuItem(<Trash2 size={14} />, 'Delete', 'files.delete', () => void remove(selection()), 'danger-text')}
            </>
          ) : (
            <>
              {menuItem(<ClipboardPaste size={14} />, 'Paste', 'files.paste', () => void paste())}
              {menuItem(<FolderPlus size={14} />, 'New folder', 'files.newFolder', () => void newFolder())}
              {menuItem(<RefreshCw size={14} />, 'Refresh', 'files.refresh', () => void load(path, true))}
              {menuItem(<SquareTerminal size={14} />, 'Open in terminal', 'files.cdHere', () => onCdHere(path))}
            </>
          )}
        </div>
      )}
    </section>
  )
}
