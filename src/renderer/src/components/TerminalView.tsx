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
import { useAutoReconnect } from '../useAutoReconnect'

interface Props {
  tab: Tab
  active: boolean
  theme: 'light' | 'dark'
  fontSize: number
  onSession(sessionId: string): void
  onReconnect(): void
  onClose(): void
  onToggleFiles(): void
  /** Font zoom request: +1 / -1. */
  onZoom(step: number): void
}

export const TERMINAL_FONT = '"JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace'

export function TerminalView({ tab, active, theme, fontSize, onSession, onReconnect, onClose, onToggleFiles, onZoom }: Props): React.JSX.Element {
  const hostEl = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const sessionId = useRef<string>('')
  const live = useRef({ status: tab.status, onReconnect, onZoom })
  live.current = { status: tab.status, onReconnect, onZoom }

  const [drop, setDrop] = useState<{ dir?: string } | null>(null)
  const dragDepth = useRef(0)

  const { retry, stop: stopRetry, now: retryNow } = useAutoReconnect(tab, onReconnect, () =>
    term.current?.write('\x1b[2m[Liman] Reconnected. The previous shell ended with the old connection.\x1b[0m\r\n')
  )
  // Re-render once a second for the countdown.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!retry?.at) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [retry?.at])

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
      // In programs that capture the mouse (Claude Code, vim, htop), Shift-drag (Option-drag
      // on macOS) still selects text in the terminal itself.
      macOptionClickForcesSelection: true,
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

    // OSC 52: programs on the server (Claude Code, tmux, vim, …) copy to the local
    // clipboard this way, e.g. after selecting text with the mouse. Write-only:
    // clipboard queries ("?") are ignored so a server can never read it.
    t.parser.registerOscHandler(52, (data) => {
      const payload = data.slice(data.indexOf(';') + 1)
      if (!data.includes(';') || !payload || payload === '?' || payload.length > 1_400_000) return true
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
        api.copyText(new TextDecoder().decode(bytes))
      } catch {
        /* not valid base64 */
      }
      return true
    })

    // Ctrl/Cmd + wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms the font.
    // Small trackpad deltas are summed so a gesture doesn't jump several sizes at once.
    let wheelSum = 0
    t.attachCustomWheelEventHandler((e) => {
      if (!e.ctrlKey && !e.metaKey) return true
      e.preventDefault()
      wheelSum += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 33 : e.deltaY
      if (Math.abs(wheelSum) >= 50) {
        live.current.onZoom(wheelSum < 0 ? 1 : -1)
        wheelSum = 0
      }
      return false
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

        {tab.status === 'connecting' && !retry && (
          <div className="pill">
            <Loader2 size={14} className="spin" /> Connecting…
          </div>
        )}

        {retry && (
          <div className="disconnected">
            <div className="card">
              <WifiOff size={22} />
              <h3>Connection lost</h3>
              {/* Only the cause; the heading already says the connection was lost. */}
              {tab.message?.replace(/^Connection lost:?\s*/, '') && <p>{tab.message.replace(/^Connection lost:?\s*/, '')}</p>}
              <p className="retrying">
                <Loader2 size={13} className="spin" />
                {retry.at
                  ? `Reconnecting in ${Math.max(1, Math.ceil((retry.at - Date.now()) / 1000))}s`
                  : 'Reconnecting…'}
                <span className="hint"> · attempt {retry.attempt}</span>
              </p>
              <div className="row">
                <button className="btn ghost" onClick={stopRetry}>
                  Stop
                </button>
                <button className="btn primary" onClick={retryNow} disabled={!retry.at}>
                  <RotateCw size={14} /> Reconnect now
                </button>
              </div>
            </div>
          </div>
        )}

        {!retry && (tab.status === 'closed' || tab.status === 'error') && (
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
