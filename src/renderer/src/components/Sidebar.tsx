import { useMemo, useState } from 'react'
import { Minus, Monitor, Moon, Pencil, Plus, Search, Server, Sun } from 'lucide-react'
import type { Host, HostInput, Settings, ThemeMode } from '@shared/types'
import { parseTarget } from '@shared/target'
import { Logo } from './Logo'

interface Props {
  hosts: Host[]
  connected: Set<string>
  themeMode: ThemeMode
  fontSize: number
  onSettings(patch: Partial<Settings>): void
  onConnect(host: Host): void
  onEdit(host: Host): void
  onNew(prefill?: Partial<HostInput>): void
}

const nextTheme: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' }
const themeIcon = { system: Monitor, light: Sun, dark: Moon }
const themeLabel = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' }

export function Sidebar(p: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const ThemeIcon = themeIcon[p.themeMode]

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = p.hosts.filter((h) =>
      !q ? true : [h.name, h.host, h.username, h.group].some((v) => v?.toLowerCase().includes(q))
    )
    const map = new Map<string, Host[]>()
    for (const h of [...filtered].sort((a, b) => a.name.localeCompare(b.name))) {
      const g = h.group?.trim() || ''
      map.set(g, [...(map.get(g) ?? []), h])
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [p.hosts, query])

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') setQuery('')
    if (e.key !== 'Enter') return
    const first = groups[0]?.[1][0]
    if (first) return p.onConnect(first)
    const target = parseTarget(query)
    if (target) p.onNew(target)
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
        {groups.map(([group, hosts]) => (
          <div key={group} className="host-group">
            {group && <div className="group-label">{group}</div>}
            {hosts.map((h) => (
              <div
                key={h.id}
                className="host-row"
                role="button"
                tabIndex={0}
                onClick={() => p.onConnect(h)}
                onKeyDown={(e) => e.key === 'Enter' && p.onConnect(h)}
                title={`Connect to ${h.username}@${h.host}`}
              >
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
          <div className="font-stepper" title="Terminal font size">
            <button className="icon-btn" onClick={() => p.onSettings({ fontSize: Math.max(10, p.fontSize - 1) })}>
              <Minus size={14} />
            </button>
            <span>{p.fontSize}</span>
            <button className="icon-btn" onClick={() => p.onSettings({ fontSize: Math.min(24, p.fontSize + 1) })}>
              <Plus size={14} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
