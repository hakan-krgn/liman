import { useMemo, useRef, useState } from 'react'
import { ChevronRight, GripVertical, Minus, Monitor, Moon, Pencil, Plus, Search, Server, Sun } from 'lucide-react'
import type { Host, HostInput, Settings, ThemeMode } from '@shared/types'
import { parseTarget } from '@shared/target'
import { api, errorMessage, showDialog } from '../lib'
import { Logo } from './Logo'

interface Props {
  hosts: Host[]
  connected: Set<string>
  themeMode: ThemeMode
  fontSize: number
  collapsedGroups: string[]
  onSettings(patch: Partial<Settings>): void
  onHostsChange(hosts: Host[]): void
  onConnect(host: Host): void
  onEdit(host: Host): void
  onNew(prefill?: Partial<HostInput>): void
}

const nextTheme: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' }
const themeIcon = { system: Monitor, light: Sun, dark: Moon }
const themeLabel = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' }

export const FONT_MIN = 8
export const FONT_MAX = 32

type Dragging = { kind: 'host'; id: string } | { kind: 'group'; group: string }
/** Where the dragged item would land, for the drop indicator. */
type DropAt =
  | { kind: 'host'; id: string; after: boolean }
  | { kind: 'group'; group: string; after: boolean }
  | { kind: 'into'; group: string }

const groupOf = (h: Host): string => h.group?.trim() || ''
const lowerHalf = (e: React.DragEvent): boolean => {
  const r = e.currentTarget.getBoundingClientRect()
  return e.clientY > r.top + r.height / 2
}

export function Sidebar(p: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const ThemeIcon = themeIcon[p.themeMode]
  const searching = query.trim() !== ''
  const dragging = useRef<Dragging | null>(null)
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const [draggingHost, setDraggingHost] = useState(false)

  // Hosts keep the user's order; groups appear in the order of their first host,
  // with ungrouped hosts on top.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const map = new Map<string, Host[]>([['', []]])
    for (const h of p.hosts) {
      if (q && ![h.name, h.host, h.username, h.group].some((v) => v?.toLowerCase().includes(q))) continue
      const g = groupOf(h)
      map.set(g, [...(map.get(g) ?? []), h])
    }
    return [...map.entries()].filter(([g, hs]) => g !== '' || hs.length > 0)
  }, [p.hosts, query])

  const groupNames = groups.map(([g]) => g).filter(Boolean)
  const hasUngrouped = groups.some(([g]) => g === '')
  const collapsed = new Set(p.collapsedGroups)
  const isCollapsed = (g: string): boolean => !searching && collapsed.has(g)

  const toggleGroup = (g: string): void => {
    const next = collapsed.has(g) ? p.collapsedGroups.filter((x) => x !== g) : [...p.collapsedGroups, g]
    p.onSettings({ collapsedGroups: next })
  }

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') setQuery('')
    if (e.key !== 'Enter') return
    const first = groups.find(([g]) => !isCollapsed(g))?.[1][0]
    if (first) return p.onConnect(first)
    const target = parseTarget(query)
    if (target) p.onNew(target)
  }

  // ------------------------------------------------------------ reordering
  const apply = (moving: Promise<Host[]>): void => {
    moving.then(p.onHostsChange).catch((e) =>
      showDialog({ title: "Couldn't move", message: errorMessage(e), buttons: [{ label: 'OK', value: 'ok', variant: 'primary' }] })
    )
  }

  const endDrag = (): void => {
    dragging.current = null
    setDropAt(null)
    setDraggingHost(false)
  }

  const startHostDrag = (e: React.DragEvent, h: Host): void => {
    dragging.current = { kind: 'host', id: h.id }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-liman-host', h.id)
    // Defer so the drag image is taken before the row restyles.
    requestAnimationFrame(() => dragging.current?.kind === 'host' && setDraggingHost(true))
  }

  const startGroupDrag = (e: React.DragEvent, group: string): void => {
    dragging.current = { kind: 'group', group }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-liman-group', group)
  }

  const overHost = (e: React.DragEvent, h: Host): void => {
    if (dragging.current?.kind !== 'host') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropAt({ kind: 'host', id: h.id, after: lowerHalf(e) })
  }

  const dropOnHost = (e: React.DragEvent, target: Host, siblings: Host[]): void => {
    const d = dragging.current
    if (d?.kind !== 'host') return
    e.preventDefault()
    const after = lowerHalf(e)
    endDrag()
    if (d.id === target.id) return
    const rest = siblings.filter((h) => h.id !== d.id)
    const before = after ? (rest[rest.indexOf(target) + 1]?.id ?? null) : target.id
    apply(api.moveHost(d.id, groupOf(target), before))
  }

  const overGroup = (e: React.DragEvent, group: string): void => {
    const d = dragging.current
    if (!d) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (d.kind === 'host') setDropAt({ kind: 'into', group })
    else setDropAt({ kind: 'group', group, after: lowerHalf(e) })
  }

  const dropOnGroup = (e: React.DragEvent, group: string): void => {
    const d = dragging.current
    if (!d) return
    e.preventDefault()
    const after = lowerHalf(e)
    endDrag()
    // A host dropped on a group header goes to the end of that group.
    if (d.kind === 'host') return apply(api.moveHost(d.id, group, null))
    if (d.group === group) return
    const rest = groupNames.filter((g) => g !== d.group)
    const before = after ? (rest[rest.indexOf(group) + 1] ?? null) : group
    apply(api.moveGroup(d.group, before))
  }

  const hostClass = (h: Host): string => {
    const at = dropAt?.kind === 'host' && dropAt.id === h.id ? (dropAt.after ? ' drop-after' : ' drop-before') : ''
    const self = draggingHost && dragging.current?.kind === 'host' && dragging.current.id === h.id ? ' dragging' : ''
    return `host-row${at}${self}`
  }

  const groupClass = (g: string): string => {
    if (dropAt?.kind === 'into' && dropAt.group === g) return 'group-label drop-into'
    if (dropAt?.kind === 'group' && dropAt.group === g) return `group-label ${dropAt.after ? 'drop-after' : 'drop-before'}`
    return 'group-label'
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <Logo />
        <span className="brand">Liman</span>
      </div>

      <div className="search">
        <Search size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search or user@host"
          spellCheck={false}
        />
      </div>

      <nav className="host-list" onDragEnd={endDrag} onDragLeave={(e) => e.target === e.currentTarget && setDropAt(null)}>
        {/* Lets a grouped host be dragged out of its group when nothing is ungrouped yet. */}
        {draggingHost && !hasUngrouped && (
          <div
            className={`ungroup-zone ${dropAt?.kind === 'into' && dropAt.group === '' ? 'active' : ''}`}
            onDragOver={(e) => overGroup(e, '')}
            onDrop={(e) => dropOnGroup(e, '')}
          >
            Drop here to remove from group
          </div>
        )}

        {groups.map(([group, hosts]) => (
          <div key={group || '\u0000'} className="host-group">
            {group && (
              <div
                className={groupClass(group)}
                role="button"
                tabIndex={0}
                draggable={!searching}
                onClick={() => toggleGroup(group)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleGroup(group))}
                onDragStart={(e) => startGroupDrag(e, group)}
                onDragOver={(e) => overGroup(e, group)}
                onDrop={(e) => dropOnGroup(e, group)}
                aria-expanded={!isCollapsed(group)}
                title={isCollapsed(group) ? 'Expand group' : 'Collapse group'}
              >
                <ChevronRight size={13} className={`chevron ${isCollapsed(group) ? '' : 'open'}`} />
                <span className="group-name">{group}</span>
                {isCollapsed(group) && <span className="group-count">{hosts.length}</span>}
              </div>
            )}
            {!isCollapsed(group) &&
              hosts.map((h) => (
                <div
                  key={h.id}
                  className={hostClass(h)}
                  role="button"
                  tabIndex={0}
                  draggable={!searching}
                  onClick={() => p.onConnect(h)}
                  onKeyDown={(e) => e.key === 'Enter' && p.onConnect(h)}
                  onDragStart={(e) => startHostDrag(e, h)}
                  onDragOver={(e) => overHost(e, h)}
                  onDrop={(e) => dropOnHost(e, h, hosts)}
                  title={`Connect to ${h.username}@${h.host}`}
                >
                  {!searching && <GripVertical size={12} className="grip" aria-hidden />}
                  <span className="host-icon">
                    <Server size={14} />
                    {p.connected.has(h.id) && <span className="live" />}
                  </span>
                  <span className="host-text">
                    <span className="host-name">{h.name}</span>
                    <span className="host-sub">
                      {h.username}@{h.host}
                      {h.port !== 22 ? `:${h.port}` : ''}
                    </span>
                  </span>
                  <button
                    className="host-edit"
                    onClick={(e) => {
                      e.stopPropagation()
                      p.onEdit(h)
                    }}
                    aria-label="Edit host"
                  >
                    <Pencil size={13} />
                  </button>
                </div>
              ))}
          </div>
        ))}
        {p.hosts.length > 0 && groups.length === 0 && (
          <div className="list-empty">
            No match.{' '}
            {parseTarget(query) && (
              <button className="link" onClick={() => p.onNew(parseTarget(query)!)}>
                Add {query.trim()}
              </button>
            )}
          </div>
        )}
        {p.hosts.length === 0 && <div className="list-empty">No hosts yet.</div>}
      </nav>

      <div className="sidebar-foot">
        <button className="btn primary block" onClick={() => p.onNew()}>
          <Plus size={15} /> New host
        </button>
        <div className="foot-tools">
          <button
            className="icon-btn"
            onClick={() => p.onSettings({ theme: nextTheme[p.themeMode] })}
            title={themeLabel[p.themeMode]}
          >
            <ThemeIcon size={16} />
          </button>
          <div className="font-stepper" title="Terminal font size (Ctrl + scroll)">
            <button className="icon-btn" onClick={() => p.onSettings({ fontSize: Math.max(FONT_MIN, p.fontSize - 1) })}>
              <Minus size={14} />
            </button>
            <span>{p.fontSize}</span>
            <button className="icon-btn" onClick={() => p.onSettings({ fontSize: Math.min(FONT_MAX, p.fontSize + 1) })}>
              <Plus size={14} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
