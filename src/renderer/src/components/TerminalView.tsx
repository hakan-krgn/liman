import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { Loader2, RotateCw, Upload, WifiOff } from 'lucide-react'
import type { Tab } from '../App'
import { api, droppedPaths, errorMessage, hasFiles, isMac, onSessionData, showDialog, terminalThemes, uploadWithConfirm } from '../lib'
import { SftpPanel } from './SftpPanel'

interface Props {
  tab: Tab
  active: boolean
  theme: 'light' | 'dark'
  fontSize: number
  onSession(sessionId: string): void
  onReconnect(): void
  onClose(): void
  onToggleFiles(): void
}

export const TERMINAL_FONT = '"JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace'

export function TerminalView({ tab, active, theme, fontSize, onSession, onReconnect, onClose, onToggleFiles }: Props): React.JSX.Element {
  const hostEl = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const sessionId = useRef<string>('')
  const live = useRef({ status: tab.status, onReconnect })
  live.current = { status: tab.status, onReconnect }

  const [drop, setDrop] = useState<{ dir?: string } | null>(null)
  const dragDepth = useRef(0)

  const refit = (): void => {
    if (hostEl.current && hostEl.current.clientWidth > 0) fit.current?.fit()
  }

  // Create the terminal once per tab.
  useEffect(() => {
    const t = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: terminalThemes[theme]
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.loadAddon(new WebLinksAddon((_e, url) => window.open(url)))
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = '11'
    t.open(hostEl.current!)
    // GPU rendering keeps typing and fast output smooth; the DOM renderer is the fallback.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      t.loadAddon(webgl)
    } catch {
      /* WebGL unavailable */
    }
    term.current = t
    fit.current = f
    refit()

    const copy = (): void => {
      void navigator.clipboard.writeText(t.getSelection())
      t.clearSelection()
    }
    const paste = (): void => {
      void navigator.clipboard.readText().then((text) => text && t.paste(text))
    }

    t.onData((d) => {
      const { status, onReconnect } = live.current
      if (status === 'connected') api.write(sessionId.current, d)
      else if ((status === 'closed' || status === 'error') && d === '\r') onReconnect()
    })
    t.onResize(({ cols, rows }) => sessionId.current && api.resize(sessionId.current, cols, rows))

    // Windows-style clipboard keys. On macOS Cmd+C / Cmd+V come from the Edit menu.
    t.attachCustomKeyEventHandler((e) => {
      if (isMac || e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true
      const k = e.key.toLowerCase()
      if (k === 'c' && (e.shiftKey || t.hasSelection())) {
        e.preventDefault()
        copy()
        return false
      }
      if (k === 'v') {
        e.preventDefault()
        paste()
        return false
      }
      return true
    })

    // Right click: copy the selection, or paste when nothing is selected.
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      if (t.hasSelection()) copy()
      else paste()
    }
    hostEl.current!.addEventListener('contextmenu', onContext)

    const ro = new ResizeObserver(() => refit())
    ro.observe(hostEl.current!)
    return () => {
      ro.disconnect()
      t.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // (Re)connect whenever the attempt counter changes.
  useEffect(() => {
    const t = term.current!
    refit()
    const id = crypto.randomUUID()
    sessionId.current = id
    const off = onSessionData(id, (d) => t.write(d))
    onSession(id)
    if (tab.attempt > 0) t.write('\r\n')
    api.connect(id, tab.hostId, t.cols, t.rows)
    return () => {
      off()
      api.disconnect(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.attempt])

  useEffect(() => {
    if (!term.current) return
    term.current.options.theme = terminalThemes[theme]
    term.current.options.fontSize = fontSize
    refit()
  }, [theme, fontSize])

  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      refit()
      term.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, tab.filesOpen])

  // -------------------------------------------------------------- drag & drop
  const connected = tab.status === 'connected'

  const onDragEnter = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (++dragDepth.current > 1) return
    setDrop({})
    if (connected) {
      api
        .getCwd(sessionId.current)
        .then((dir) => setDrop((d) => (d ? { dir } : d)))
        .catch(() => {})
    }
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = connected ? 'copy' : 'none'
  }
  const onDragLeave = (): void => {
    if (--dragDepth.current <= 0) {
      dragDepth.current = 0
      setDrop(null)
    }
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    const dir = drop?.dir
    dragDepth.current = 0
    setDrop(null)
    if (!connected) return
    uploadWithConfirm(sessionId.current, droppedPaths(e), dir)
      .catch((err) =>
        showDialog({ title: 'Upload failed', message: errorMessage(err), buttons: [{ label: 'OK', value: 'ok', variant: 'primary' }] })
      )
      .finally(() => term.current?.focus())
  }

  return (
    <div className="session" style={{ display: active ? 'flex' : 'none' }}>
      <div className="term-area" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div className="term-host" ref={hostEl} />

        {tab.status === 'connecting' && (
          <div className="pill">
            <Loader2 size={14} className="spin" /> Connecting…
          </div>
        )}

        {(tab.status === 'closed' || tab.status === 'error') && (
          <div className="disconnected">
            <div className="card">
              <WifiOff size={22} />
              <h3>{tab.status === 'error' ? "Couldn't connect" : 'Disconnected'}</h3>
              {tab.message && <p>{tab.message}</p>}
              <div className="row">
                <button className="btn ghost" onClick={onClose}>
                  Close tab
                </button>
                <button className="btn primary" onClick={onReconnect}>
                  <RotateCw size={14} /> Reconnect
                </button>
              </div>
              <span className="hint">or press Enter</span>
            </div>
          </div>
        )}

        {drop && (
          <div className={`drop-overlay ${connected ? '' : 'disabled'}`}>
            <div className="drop-card">
              <Upload size={22} />
              {connected ? (
                <>
                  <strong>Drop to upload</strong>
                  <code>{drop.dir ?? 'finding current folder…'}</code>
                </>
              ) : (
                <strong>Not connected</strong>
              )}
            </div>
          </div>
        )}
      </div>

      {tab.filesOpen && (
        <SftpPanel sessionId={tab.sessionId} connected={connected} onClose={onToggleFiles} />
      )}
    </div>
  )
}
