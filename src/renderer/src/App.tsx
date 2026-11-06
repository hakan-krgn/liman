import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import type { Host, HostInput, SessionStatus, Settings } from '@shared/types'
import { api, chrome, confirmDialog, dismissDialog, setConflictDefault, showDialog } from './lib'
import { installShortcutDispatcher, setShortcutOverrides, useShortcuts } from './useShortcuts'
import { FONT_MAX, FONT_MIN, Sidebar } from './components/Sidebar'
import { HostForm } from './components/HostForm'
import { TerminalView } from './components/TerminalView'
import { DialogHost } from './components/DialogHost'
import { Transfers } from './components/Transfers'
import { Logo } from './components/Logo'
import { TabBar } from './components/TabBar'
import { ShortcutSheet } from './components/ShortcutSheet'
import { SettingsWindow } from './components/SettingsWindow'

export interface Tab {
  id: string
  hostId: string
  title: string
  sessionId?: string
  status: SessionStatus
  message?: string
  /** The last connection dropped on its own (see useAutoReconnect). */
  lost?: boolean
  attempt: number
  filesOpen: boolean
}

type FormState = { host?: Host; prefill?: Partial<HostInput> } | null

export function App(): React.JSX.Element {
  const [hosts, setHosts] = useState<Host[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(null)
  const [renameRequest, setRenameRequest] = useState<{ id: string; seq: number } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void api.listHosts().then(setHosts)
    void api.getSettings().then(setSettings)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // ------------------------------------------------------------------ theme
  const theme: 'light' | 'dark' =
    !settings || settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    void api.setTitleBar(chrome[theme].bg, chrome[theme].fg)
  }, [theme])

  // Changes apply at once; writing them to disk is batched (Ctrl+scroll fires a lot).
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const unsaved = useRef<Partial<Settings>>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const updateSettings = useCallback((patch: Partial<Settings>) => {
    // Keep the ref current right away: wheel events can arrive faster than renders.
    if (settingsRef.current) settingsRef.current = { ...settingsRef.current, ...patch }
    setSettings((s) => (s ? { ...s, ...patch } : s))
    Object.assign(unsaved.current, patch)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const changes = unsaved.current
      unsaved.current = {}
      void api.setSettings(changes)
    }, 300)
  }, [])

  /** Terminal font zoom: +1 / -1 steps, or 0 to reset. */
  const zoom = useCallback(
    (step: number) => {
      const current = settingsRef.current?.fontSize ?? 14
      const fontSize = step === 0 ? 14 : Math.min(FONT_MAX, Math.max(FONT_MIN, current + step))
      if (fontSize !== current) updateSettings({ fontSize })
    },
    [updateSettings]
  )

  // --------------------------------------------------------------- sessions
  useEffect(
    () =>
      api.onStatus((e) =>
        setTabs((ts) =>
          ts.map((t) => (t.sessionId === e.sessionId ? { ...t, status: e.status, message: e.message, lost: e.lost } : t))
        )
      ),
    []
  )

  useEffect(
    () =>
      api.onPrompt(async (id, req) => {
        if (req.kind === 'hostkey') {
          const changed = !!req.previous
          const r = await showDialog({
            title: changed ? 'Host key has changed' : 'Trust this host?',
            message: changed
              ? `The key presented by ${req.host} is different from the one saved earlier. This can mean the server was reinstalled — or that someone is intercepting the connection.\n\nNew ${req.keyType} key:\n${req.fingerprint}`
              : `First connection to ${req.host}. Make sure this fingerprint is the one you expect.\n\n${req.keyType}\n${req.fingerprint}`,
            buttons: changed
              ? [
                  { label: 'Cancel', value: 'no', variant: 'primary' },
                  { label: 'Connect anyway', value: 'yes', variant: 'danger' }
                ]
              : [
                  { label: 'Cancel', value: 'no', variant: 'ghost' },
                  { label: 'Trust & connect', value: 'yes', variant: 'primary' }
                ],
            cancelValue: 'no',
            key: id
          })
          api.respondPrompt(id, r.value === 'yes')
        } else {
          const fromServer = req.source === 'server'
          const r = await showDialog({
            // Server-supplied text is always framed as such, so a server can't
            // dress its prompt up as Liman's own passphrase dialog.
            title: fromServer ? `${req.host} asks` : req.title,
            message: fromServer
              ? ['Message from the server:', req.title, req.instructions].filter(Boolean).join('\n')
              : req.instructions,
            input: req.prompts.map((p) => ({ value: '', placeholder: p.prompt.replace(/:\s*$/, ''), secret: !p.echo })),
            buttons: [
              { label: 'Cancel', value: 'cancel', variant: 'ghost' },
              { label: 'Continue', value: 'ok', variant: 'primary' }
            ],
            cancelValue: 'cancel',
            key: id
          })
          api.respondPrompt(id, r.value === 'ok' ? r.inputs : null)
        }
      }),
    []
  )
  useEffect(() => api.onPromptCancel(dismissDialog), [])

  /** Opens a new session tab, at the end or right after `afterId`. */
  const openHost = useCallback((host: Host, afterId?: string) => {
    const id = crypto.randomUUID()
    setTabs((ts) => {
      const same = ts.filter((t) => t.hostId === host.id).length
      const title = same ? `${host.name} (${same + 1})` : host.name
      const tab: Tab = { id, hostId: host.id, title, status: 'connecting', attempt: 0, filesOpen: false }
      const at = afterId ? ts.findIndex((t) => t.id === afterId) + 1 : 0
      return at > 0 ? [...ts.slice(0, at), tab, ...ts.slice(at)] : [...ts, tab]
    })
    setActiveId(id)
  }, [])

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  const closeTab = useCallback((id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id)
      const tab = ts[i]
      if (tab?.sessionId) api.disconnect(tab.sessionId)
      const next = ts.filter((t) => t.id !== id)
      setActiveId((a) => (a === id ? (next[Math.min(i, next.length - 1)]?.id ?? null) : a))
      return next
    })
  }, [])

  const closeOtherTabs = useCallback((keepId: string) => {
    setTabs((ts) => {
      for (const t of ts) if (t.id !== keepId && t.sessionId) api.disconnect(t.sessionId)
      return ts.filter((t) => t.id === keepId)
    })
    setActiveId(keepId)
  }, [])

  const reorderTabs = useCallback((ids: string[]) => {
    setTabs((ts) => ids.map((id) => ts.find((t) => t.id === id)).filter((t): t is Tab => !!t))
  }, [])

  const duplicateTab = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id)
      const host = tab && hosts.find((h) => h.id === tab.hostId)
      if (host) openHost(host, id)
    },
    [tabs, hosts, openHost]
  )

  const reconnect = useCallback(
    (id: string) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, status: 'connecting', message: undefined, lost: false, attempt: t.attempt + 1 } : t))),
    []
  )

  // -------------------------------------------------------------- shortcuts
  useEffect(() => installShortcutDispatcher(), [])
  useEffect(() => setShortcutOverrides(settings?.shortcuts), [settings?.shortcuts])
  useEffect(() => setConflictDefault(settings?.conflictDefault ?? 'ask'), [settings?.conflictDefault])
  // macOS: Liman › Settings… in the menu bar.
  useEffect(() => api.onOpenSettings(() => setSettingsOpen(true)), [])

  const switchTab = (step: number): void =>
    setActiveId((a) => {
      if (!tabs.length) return a
      const i = tabs.findIndex((t) => t.id === a)
      return tabs[(i + step + tabs.length) % tabs.length].id
    })

  /** Shows or hides the active tab's files panel (the focus moves with it, see TerminalView). */
  const toggleFiles = (): void => {
    const tab = tabs.find((t) => t.id === activeId)
    if (tab) patchTab(tab.id, { filesOpen: !tab.filesOpen })
  }

  const reconnectActive = async (): Promise<void> => {
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab) return
    if (tab.status === 'connected' && !(await confirmDialog(`Reconnect ${tab.title}?`, 'The shell running in this tab ends.', 'Reconnect'))) return
    reconnect(tab.id)
  }

  useShortcuts({
    'tab.next': () => switchTab(1),
    'tab.prev': () => switchTab(-1),
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `tab.goto${i + 1}`,
        () => {
          const t = tabs[i]
          if (t) setActiveId(t.id)
        }
      ])
    ),
    'tab.close': () => {
      if (activeId) closeTab(activeId)
    },
    'tab.rename': () => {
      if (!activeId) return false
      setRenameRequest({ id: activeId, seq: Date.now() })
    },
    'tab.new': () => {
      const search = document.querySelector<HTMLInputElement>('.sidebar .search input')
      search?.focus()
      search?.select()
    },
    'tab.duplicate': () => {
      if (activeId) duplicateTab(activeId)
    },
    'tab.reconnect': () => void reconnectActive(),
    'files.toggle': toggleFiles,
    'zoom.in': () => zoom(1),
    'zoom.out': () => zoom(-1),
    'zoom.reset': () => zoom(0),
    'help.shortcuts': () => setSheetOpen(true),
    'app.settings': () => setSettingsOpen(true)
  })

  const active = tabs.find((t) => t.id === activeId)
  const connectedHosts = useMemo(
    () => new Set(tabs.filter((t) => t.status === 'connected').map((t) => t.hostId)),
    [tabs]
  )

  if (!settings) return <div className="app" />

  return (
    <div className="app">
      <Sidebar
        hosts={hosts}
        connected={connectedHosts}
        themeMode={settings.theme}
        fontSize={settings.fontSize}
        instantTyping={settings.instantTyping}
        collapsedGroups={settings.collapsedGroups}
        onSettings={updateSettings}
        onHostsChange={setHosts}
        onConnect={openHost}
        onEdit={(host) => setForm({ host })}
        onNew={(prefill) => setForm({ prefill })}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="main">
        <header className="tabbar">
          <TabBar
            tabs={tabs}
            activeId={activeId}
            onActivate={setActiveId}
            onClose={closeTab}
            onCloseOthers={closeOtherTabs}
            onRename={(id, title) => patchTab(id, { title })}
            onDuplicate={duplicateTab}
            onReorder={reorderTabs}
            renameRequest={renameRequest}
          />
          <div className="tabbar-actions">
            {active && (
              <button
                className={`icon-btn ${active.filesOpen ? 'on' : ''}`}
                onClick={() => patchTab(active.id, { filesOpen: !active.filesOpen })}
                title="Files (SFTP)"
              >
                <FolderOpen size={16} />
                <span>Files</span>
              </button>
            )}
          </div>
        </header>

        <div className="content">
          {tabs.map((t) => (
            <TerminalView
              key={t.id}
              tab={t}
              active={t.id === activeId}
              appTheme={theme}
              settings={settings}
              onZoom={zoom}
              peers={tabs
                .filter((o) => o.id !== t.id && o.status === 'connected' && o.sessionId)
                .map((o) => ({ sessionId: o.sessionId!, title: o.title }))}
              onSession={(sessionId) => patchTab(t.id, { sessionId })}
              onReconnect={() => reconnect(t.id)}
              onClose={() => closeTab(t.id)}
              onToggleFiles={() => patchTab(t.id, { filesOpen: !t.filesOpen })}
            />
          ))}
          {tabs.length === 0 && (
            <div className="empty">
              <Logo size={44} />
              <h1>Connect to a server</h1>
              <p>Pick a host from the sidebar, or add a new one.</p>
              <button className="btn primary" onClick={() => setForm({})}>
                <Plus size={15} /> New host
              </button>
              <p className="hint">Tip: drop files from your desktop onto a terminal to upload them into its current folder.</p>
            </div>
          )}
        </div>
      </main>

      {form && (
        <HostForm
          host={form.host}
          prefill={form.prefill}
          onClose={() => setForm(null)}
          onSaved={(h, connect) => {
            setHosts((hs) => (hs.some((x) => x.id === h.id) ? hs.map((x) => (x.id === h.id ? h : x)) : [...hs, h]))
            setForm(null)
            if (connect) openHost(h)
          }}
          onDeleted={(id) => {
            setHosts((hs) => hs.filter((h) => h.id !== id))
            setForm(null)
          }}
        />
      )}
      {sheetOpen && <ShortcutSheet onClose={() => setSheetOpen(false)} />}
      {settingsOpen && (
        <SettingsWindow settings={settings} appTheme={theme} onChange={updateSettings} onClose={() => setSettingsOpen(false)} />
      )}
      <Transfers />
      <DialogHost />
    </div>
  )
}
