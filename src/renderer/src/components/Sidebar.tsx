import { useMemo, useState } from 'react'
import { ChevronRight, GripVertical, Minus, Monitor, Moon, Pencil, Plus, Search, Server, Sun, Zap } from 'lucide-react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import type { Host, HostInput, Settings, ThemeMode } from '@shared/types'
import { groupOf, moveGroupIn, moveHostIn } from '@shared/order'
import { parseTarget } from '@shared/target'
import { api, errorMessage, showDialog } from '../lib'
import { Logo } from './Logo'
import { UpdateNotice } from './UpdateNotice'

interface Props {
  hosts: Host[]
  connected: Set<string>
  themeMode: ThemeMode
  fontSize: number
  instantTyping: boolean
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

/** Group headers share the sortable list with hosts; their ids can't clash with host UUIDs. */
const GROUP = 'group:'

/** The sidebar as one flat list: ungrouped hosts, then each group header followed by its hosts. */
type Item =
  | { kind: 'group'; id: string; group: string; count: number; collapsed: boolean }
  | { kind: 'host'; id: string; host: Host }

export function Sidebar(p: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const ThemeIcon = themeIcon[p.themeMode]
  const searching = query.trim() !== ''
  // While a group is dragged its hosts fold into the header so it moves as one piece.
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

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

  const collapsed = new Set(p.collapsedGroups)
  const isCollapsed = (g: string): boolean => !searching && collapsed.has(g)

  const items = useMemo(() => {
    const out: Item[] = []
    for (const [group, hosts] of groups) {
      const folded = !searching && (collapsed.has(group) || draggingGroup === group)
      if (group) out.push({ kind: 'group', id: GROUP + group, group, count: hosts.length, collapsed: folded })
      if (!folded) for (const host of hosts) out.push({ kind: 'host', id: host.id, host })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, p.collapsedGroups, draggingGroup, searching])

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
  /** Shows the new order at once, then saves it (and takes the stored result). */
  const apply = (optimistic: Host[], saving: Promise<Host[]>): void => {
    p.onHostsChange(optimistic)
    saving.then(p.onHostsChange).catch((e) => {
      void api.listHosts().then(p.onHostsChange)
      void showDialog({ title: "Couldn't move", message: errorMessage(e), buttons: [{ label: 'OK', value: 'ok', variant: 'primary' }] })
    })
  }

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    setDraggingGroup(null)
    if (!over || active.id === over.id) return
    const ids = items.map((i) => i.id)
    const next = arrayMove(items, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    const at = next.findIndex((i) => i.id === active.id)
    const moved = next[at]

    if (moved.kind === 'host') {
      // A host joins the group whose header is above it (none above: ungrouped).
      const header = next.slice(0, at).findLast((i) => i.kind === 'group')
      const group = header?.kind === 'group' ? header.group : ''
      const after = next[at + 1]
      const before = after?.kind === 'host' ? after.id : null
      apply(moveHostIn(p.hosts, moved.id, group, before), api.moveHost(moved.id, group, before))
    } else {
      const following = next.slice(at + 1).find((i) => i.kind === 'group')
      const before = following?.kind === 'group' ? following.group : null
      apply(moveGroupIn(p.hosts, moved.group, before), api.moveGroup(moved.group, before))
    }
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

      <nav className="host-list">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          // Keep the dragged row inside the visible list (it auto-scrolls near the edges).
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragStart={({ active }) => {
            const id = String(active.id)
            if (id.startsWith(GROUP)) setDraggingGroup(id.slice(GROUP.length))
          }}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDraggingGroup(null)}
        >
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            {items.map((item) =>
              item.kind === 'group' ? (
                <SortableGroup
                  key={item.id}
                  item={item}
                  disabled={searching}
                  onToggle={() => toggleGroup(item.group)}
                />
              ) : (
                <SortableHost
                  key={item.id}
                  host={item.host}
                  live={p.connected.has(item.host.id)}
                  disabled={searching}
                  onConnect={() => p.onConnect(item.host)}
                  onEdit={() => p.onEdit(item.host)}
                />
              )
            )}
          </SortableContext>
        </DndContext>
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
        <UpdateNotice />
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
          <button
            className={`icon-btn${p.instantTyping ? ' on' : ''}`}
            onClick={() => p.onSettings({ instantTyping: !p.instantTyping })}
            title={
              p.instantTyping
                ? 'Instant typing is on: on distant servers, what you type shows before the server echoes it'
                : 'Instant typing is off'
            }
          >
            <Zap size={16} />
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

/** Position styles from dnd-kit: the dragged item follows the pointer, the rest slide aside. */
function useSortableItem(id: string, disabled: boolean) {
  const s = useSortable({ id, disabled })
  return {
    ...s,
    style: { transform: CSS.Translate.toString(s.transform), transition: s.transition }
  }
}

function SortableGroup({
  item,
  disabled,
  onToggle
}: {
  item: Extract<Item, { kind: 'group' }>
  disabled: boolean
  onToggle(): void
}): React.JSX.Element {
  const { setNodeRef, attributes, listeners, style, isDragging } = useSortableItem(item.id, disabled)
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group-label ${isDragging ? 'lifted' : ''}`}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
      aria-expanded={!item.collapsed}
      title={item.collapsed ? 'Expand group' : 'Collapse group'}
    >
      <ChevronRight size={13} className={`chevron ${item.collapsed ? '' : 'open'}`} />
      <span className="group-name">{item.group}</span>
      {item.collapsed && <span className="group-count">{item.count}</span>}
    </div>
  )
}

function SortableHost({
  host,
  live,
  disabled,
  onConnect,
  onEdit
}: {
  host: Host
  live: boolean
  disabled: boolean
  onConnect(): void
  onEdit(): void
}): React.JSX.Element {
  const { setNodeRef, attributes, listeners, style, isDragging } = useSortableItem(host.id, disabled)
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`host-row ${isDragging ? 'lifted' : ''}`}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={onConnect}
      onKeyDown={(e) => e.key === 'Enter' && onConnect()}
      title={`Connect to ${host.username}@${host.host}`}
    >
      {!disabled && <GripVertical size={12} className="grip" aria-hidden />}
      <span className="host-icon">
        <Server size={14} />
        {live && <span className="live" />}
      </span>
      <span className="host-text">
        <span className="host-name">{host.name}</span>
        <span className="host-sub">
          {host.username}@{host.host}
          {host.port !== 22 ? `:${host.port}` : ''}
        </span>
      </span>
      <button
        className="host-edit"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onEdit()
        }}
        aria-label="Edit host"
      >
        <Pencil size={13} />
      </button>
    </div>
  )
}
