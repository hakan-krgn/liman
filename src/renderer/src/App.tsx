import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import type { Host, HostInput, SessionStatus, Settings } from '@shared/types'
import { api, chrome, dismissDialog, isMac, showDialog } from './lib'
import { FONT_MAX, FONT_MIN, Sidebar } from './components/Sidebar'
import { HostForm } from './components/HostForm'
import { TerminalView } from './components/TerminalView'
import { DialogHost } from './components/DialogHost'
import { Transfers } from './components/Transfers'
import { Logo } from './components/Logo'
import { TabBar } from './components/TabBar'

export interface Tab {
  id: string
  hostId: string
  title: string
  sessionId?: string
  status: SessionStatus
  message?: string
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
          ts.map((t) => (t.sessionId === e.sessionId ? { ...t, status: e.status, message: e.message } : t))
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

  const moveTab = useCallback((id: string, targetId: string, after: boolean) => {
    setTabs((ts) => {
      const moving = ts.find((t) => t.id === id)
      if (!moving) return ts
      const rest = ts.filter((t) => t.id !== id)
      const at = rest.findIndex((t) => t.id === targetId) + (after ? 1 : 0)
      return [...rest.slice(0, at), moving, ...rest.slice(at)]
    })
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
    (id: string) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, status: 'connecting', message: undefined, attempt: t.attempt + 1 } : t))),
    []
  )

  // -------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Tab shortcuts are off while a modal is open.
      if (document.querySelector('.overlay')) return
      const mod = isMac ? e.metaKey : e.ctrlKey
      let handled = true
      if (e.ctrlKey && e.key === 'Tab') {
        setActiveId((a) => {
          if (!tabs.length) return a
          const i = tabs.findIndex((t) => t.id === a)
          return tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id
        })
      } else if (mod && (isMac ? e.key === 'w' && !e.shiftKey : e.shiftKey && e.key === 'W')) {
        if (activeId) closeTab(activeId)
      } else if (mod && /^[1-9]$/.test(e.key) && !e.shiftKey) {
        const t = tabs[Number(e.key) - 1]
        if (t) setActiveId(t.id)
      } else if (mod && !e.altKey && (e.key === '=' || e.key === '+')) {
        zoom(1)
      } else if (mod && !e.altKey && e.key === '-') {
        zoom(-1)
      } else if (mod && !e.altKey && e.key === '0') {
        zoom(0)
      } else {
        handled = false
      }
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [tabs, activeId, closeTab, zoom])

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
        collapsedGroups={settings.collapsedGroups}
        onSettings={updateSettings}
        onHostsChange={setHosts}
        onConnect={openHost}
        onEdit={(host) => setForm({ host })}
        onNew={(prefill) => setForm({ prefill })}
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
            onMove={moveTab}
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
              theme={theme}
              fontSize={settings.fontSize}
              onZoom={zoom}
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
      <Transfers />
      <DialogHost />
    </div>
  )
}
