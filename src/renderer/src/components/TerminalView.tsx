import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { ClipboardPaste, Copy, Eraser, Loader2, RotateCw, Search, TextSelect, Upload, WifiOff } from 'lucide-react'
import type { Tab } from '../App'
import type { ClipContent, Settings } from '@shared/types'
import { shQuote } from '@shared/shell'
import {
  api,
  confirmDialog,
  copyWithConfirm,
  droppedPaths,
  errorMessage,
  hasFiles,
  isMac,
  remoteDragOf,
  setRemoteDrag,
  onSessionData,
  showDialog,
  uploadWithConfirm
} from '../lib'
import { terminalTheme } from '../themes'
import { terminalFont } from '../fonts'
import { describeItems, pasteInto } from '../paste'
import { keyHint, useShortcuts } from '../useShortcuts'
import { SftpPanel, type Peer } from './SftpPanel'
import { TerminalFind } from './TerminalFind'
import { useAutoReconnect } from '../useAutoReconnect'
import { TypeAhead, type Prediction } from '../typeahead'
import { resetModes } from '../terminalModes'

interface Props {
  tab: Tab
  active: boolean
  /** The app's theme right now (Liman's terminal colours follow it). */
  appTheme: 'light' | 'dark'
  settings: Settings
  onSession(sessionId: string): void
  onReconnect(): void
  onClose(): void
  onToggleFiles(): void
  /** Font zoom request: +1 / -1. */
  onZoom(step: number): void
  /** Other connected tabs, for "Send to…" in the files panel. */
  peers: Peer[]
}

export function TerminalView({ tab, active, appTheme, settings, onSession, onReconnect, onClose, onToggleFiles, onZoom, peers }: Props): React.JSX.Element {
  const hostEl = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const typeAhead = useRef<TypeAhead | null>(null)
  const search = useRef<SearchAddon | null>(null)
  const [finding, setFinding] = useState(false)
  const sessionId = useRef<string>('')
  const live = useRef({ status: tab.status, onReconnect, onZoom, settings, paste: async (): Promise<void> => {}, bell: (): void => {} })
  const lastPasteKey = useRef(0)
  const colors = useMemo(() => terminalTheme(settings.terminalTheme, appTheme), [settings.terminalTheme, appTheme])
  const [flash, setFlash] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuEl = useRef<HTMLDivElement>(null)

  const [drop, setDrop] = useState<{ dir?: string; remote: boolean } | null>(null)
  const dragDepth = useRef(0)

  const { retry, stop: stopRetry, now: retryNow } = useAutoReconnect(
    tab,
    onReconnect,
    () => term.current?.write('\x1b[2m[Liman] Reconnected. The previous shell ended with the old connection.\x1b[0m\r\n'),
    { enabled: settings.autoReconnect, maxAttempts: settings.reconnectAttempts }
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

  const copySelection = (): void => {
    const t = term.current
    if (!t) return
    void navigator.clipboard.writeText(t.getSelection())
    t.clearSelection()
  }

  /**
   * Pastes text as typing. Files (from Explorer / Finder, or copied in a files
   * panel) and screenshots are uploaded into the shell's folder after asking.
   */
  const smartPaste = async (): Promise<void> => {
    const t = term.current
    if (!t) return
    const content: ClipContent = await api.inspectClipboard().catch(() => ({ kind: 'none' }))
    if (content.kind === 'none') {
      const text = await navigator.clipboard.readText().catch(() => '')
      if (text && (await confirmLines(text))) t.paste(text)
      t.focus()
      return
    }
    if (tab.status !== 'connected') return
    const sid = sessionId.current
    try {
      const dir = await api.getCwd(sid)
      const what = content.kind === 'image' ? 'the screenshot' : describeItems(content.paths)
      const verb = content.kind === 'liman' ? 'Copy' : 'Upload'
      if (!(await confirmDialog(`${verb} ${what} here?`, `Into ${dir}, the terminal's current folder.`, verb))) return
      await pasteInto(sid, dir, content)
    } catch (err) {
      await showDialog({ title: 'Paste failed', message: errorMessage(err), buttons: [{ label: 'OK', value: 'ok', variant: 'primary' }] })
    } finally {
      t.focus()
    }
  }
  /** Several lines pasted at a prompt may each run as a command: ask first (Settings › Terminal). */
  const confirmLines = async (text: string): Promise<boolean> => {
    const lines = text.replace(/(\r?\n)+$/, '').split(/\r\n|\r|\n/)
    const fullScreen = term.current?.buffer.active.type === 'alternate'
    if (lines.length < 2 || fullScreen || !live.current.settings.confirmMultilinePaste) return true
    const preview = lines.slice(0, 8).map((l) => (l.length > 90 ? `${l.slice(0, 90)}…` : l))
    if (lines.length > 8) preview.push(`… ${lines.length - 8} more`)
    return confirmDialog(`Paste ${lines.length} lines?`, <pre className="paste-preview">{preview.join('\n')}</pre>, 'Paste')
  }

  /** The bell (Ctrl+G, tab completion with no match, …) as Settings › Terminal says. */
  const ring = (): void => {
    const bell = live.current.settings.bell
    if (bell === 'sound') beep()
    else if (bell === 'visual') {
      setFlash(true)
      setTimeout(() => setFlash(false), 180)
    }
  }
  live.current = { status: tab.status, onReconnect, onZoom, settings, paste: smartPaste, bell: ring }

  /** Ctrl+Enter in the files panel: `cd` the shell into that folder. */
  const cdHere = (dir: string): void => {
    const t = term.current
    if (!t || tab.status !== 'connected') return
    if (t.buffer.active.type === 'alternate') {
      void showDialog({
        title: "Can't change folder now",
        message: 'A full-screen program is running in the terminal. Quit it first.',
        buttons: [{ label: 'OK', value: 'ok', variant: 'primary' }]
      })
      return
    }
    // Ctrl+U first: whatever was typed on the prompt would end up in front of `cd`.
    api.write(sessionId.current, `\x15cd -- ${shQuote(dir)}\r`)
    typeAhead.current?.reset()
    t.focus()
  }

  useShortcuts(
    {
      'terminal.copy': (e) => {
        if (term.current?.hasSelection()) return copySelection()
        // Ctrl+C with nothing selected is the shell's interrupt; Ctrl+Shift+C just does nothing.
        return e.shiftKey ? undefined : false
      },
      'terminal.paste': () => {
        lastPasteKey.current = Date.now()
        void smartPaste()
      },
      'terminal.find': () => setFinding(true),
      'terminal.clear': () => {
        term.current?.clear()
        typeAhead.current?.reset()
      },
      // htop, mc and others use F1 for their own help.
      'help.shortcuts': () => (term.current?.buffer.active.type === 'alternate' ? 'pass' : false)
    },
    hostEl
  )

  // Create the terminal once per tab.
  useEffect(() => {
    const t = new Terminal({
      fontFamily: terminalFont(settings.fontFamily),
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
      allowProposedApi: true,
      macOptionIsMeta: true,
      // In programs that capture the mouse (Claude Code, vim, htop), Shift-drag (Option-drag
      // on macOS) still selects text in the terminal itself.
      macOptionClickForcesSelection: true,
      theme: colors
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.loadAddon(new WebLinksAddon((_e, url) => window.open(url)))
    t.loadAddon(new Unicode11Addon())
    const s = new SearchAddon()
    t.loadAddon(s)
    search.current = s
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
    // Instant typing draws its guesses on a layer above the terminal.
    const overlay = document.createElement('div')
    overlay.className = 'typeahead'
    t.element!.querySelector('.xterm-screen')!.appendChild(overlay)
    const ta = new TypeAhead(t, (p) => drawPrediction(t, overlay, p))
    ta.setEnabled(settings.instantTyping)
    typeAhead.current = ta

    term.current = t
    fit.current = f
    refit()

    t.onData((d) => {
      const { status, onReconnect } = live.current
      if (status === 'connected') {
        ta.input(d)
        api.write(sessionId.current, d)
      }
      else if ((status === 'closed' || status === 'error') && d === '\r') onReconnect()
    })
    t.onResize(({ cols, rows }) => sessionId.current && api.resize(sessionId.current, cols, rows))

    // Copy and paste go through the app's shortcuts (useShortcuts below); this is for word deletion.
    t.attachCustomKeyEventHandler((e) => {
      if (isMac || e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true
      // Ctrl+Backspace / Ctrl+Delete delete a word as on Windows, where punctuation
      // splits words ("aaa-bbb" loses only "bbb"): the shell's Esc-Backspace / Esc-d.
      // Full-screen programs like vim would read Esc as "leave insert mode", so they
      // get ^W, and Ctrl+Delete keeps its usual key code. On macOS Option+Backspace does this.
      if (!e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
        const fullScreen = t.buffer.active.type === 'alternate'
        if (fullScreen && e.key === 'Delete') return true
        e.preventDefault()
        t.input(e.key === 'Delete' ? '\x1bd' : fullScreen ? '\x17' : '\x1b\x7f')
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

    t.onBell(() => live.current.bell())

    // Settings › Terminal: copy what gets selected, a moment after the mouse lets go.
    let selectionTimer: ReturnType<typeof setTimeout> | undefined
    t.onSelectionChange(() => {
      clearTimeout(selectionTimer)
      if (!live.current.settings.copyOnSelect || !t.hasSelection()) return
      selectionTimer = setTimeout(() => void navigator.clipboard.writeText(t.getSelection()), 150)
    })

    // Right click: copy the selection or paste when nothing is selected, or a menu (Settings › Terminal).
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      if (live.current.settings.rightClick === 'menu') setMenu({ x: e.clientX, y: e.clientY })
      else if (t.hasSelection()) copySelection()
      else void live.current.paste()
    }
    hostEl.current!.addEventListener('contextmenu', onContext)
    // A paste the keys didn't start (macOS Edit menu, by mouse) gets the same treatment; xterm's own is off.
    const onPaste = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (Date.now() - lastPasteKey.current > 300) void live.current.paste()
    }
    hostEl.current!.addEventListener('paste', onPaste, true)

    const ro = new ResizeObserver(() => refit())
    ro.observe(hostEl.current!)
    return () => {
      ro.disconnect()
      ta.dispose()
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
    typeAhead.current?.reset()
    const off = onSessionData(id, (d) => t.write(d))
    onSession(id)
    if (tab.attempt > 0) t.write(resetModes(t) + '\r\n')
    api.connect(id, tab.hostId, t.cols, t.rows)
    return () => {
      off()
      api.disconnect(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.attempt])

  // Settings › Appearance and Terminal apply at once.
  useEffect(() => {
    const t = term.current
    if (!t) return
    t.options.theme = colors
    t.options.fontFamily = terminalFont(settings.fontFamily)
    t.options.fontSize = settings.fontSize
    t.options.lineHeight = settings.lineHeight
    t.options.cursorStyle = settings.cursorStyle
    t.options.cursorBlink = settings.cursorBlink
    t.options.scrollback = settings.scrollback
    refit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors, settings.fontFamily, settings.fontSize, settings.lineHeight, settings.cursorStyle, settings.cursorBlink, settings.scrollback])

  useEffect(() => typeAhead.current?.setEnabled(settings.instantTyping), [settings.instantTyping])

  // The right-click menu closes on any click elsewhere, and stays inside the window.
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
  useLayoutEffect(() => {
    const el = menuEl.current
    if (!menu || !el) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))}px`
  }, [menu])

  /** A right-click menu item; it closes the menu and gives the terminal the focus back. */
  const menuItem = (icon: React.ReactNode, label: string, shortcut: string, run: () => void, disabled = false): React.JSX.Element => (
    <button
      disabled={disabled}
      onClick={() => {
        setMenu(null)
        run()
        term.current?.focus()
      }}
    >
      {icon} {label}
      {shortcut && <kbd className="menu-key">{keyHint(shortcut)}</kbd>}
    </button>
  )

  // Focus follows what just appeared: the files panel when it opens, the terminal otherwise.
  const filesWereOpen = useRef(tab.filesOpen)
  useEffect(() => {
    const opened = tab.filesOpen && !filesWereOpen.current
    filesWereOpen.current = tab.filesOpen
    if (!active) return
    const raf = requestAnimationFrame(() => {
      refit()
      const panel = opened ? hostEl.current?.closest('.session')?.querySelector<HTMLElement>('.sftp') : null
      if (panel) panel.focus()
      else term.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, tab.filesOpen])

  // -------------------------------------------------------------- drag & drop
  const connected = tab.status === 'connected'

  /** Local files, or remote files dragged from another server's files panel. */
  const accepts = (e: React.DragEvent): boolean => {
    const drag = remoteDragOf(e)
    // Files from this very server have nowhere to go in its own terminal.
    return drag ? drag.sessionId !== sessionId.current : hasFiles(e)
  }

  const onDragEnter = (e: React.DragEvent): void => {
    if (!accepts(e)) return
    e.preventDefault()
    if (++dragDepth.current > 1) return
    setDrop({ remote: !!remoteDragOf(e) })
    if (connected) {
      api
        .getCwd(sessionId.current)
        .then((dir) => setDrop((d) => (d ? { ...d, dir } : d)))
        .catch(() => {})
    }
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (!accepts(e)) return
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
    if (!accepts(e)) return
    e.preventDefault()
    const dir = drop?.dir
    dragDepth.current = 0
    setDrop(null)
    if (!connected) return
    const drag = remoteDragOf(e, true)
    if (drag) setRemoteDrag(null)
    const work = drag
      ? copyWithConfirm(drag.sessionId, drag.paths, sessionId.current, dir)
      : uploadWithConfirm(sessionId.current, droppedPaths(e), dir)
    work
      .catch((err) =>
        showDialog({ title: drag ? 'Copy failed' : 'Upload failed', message: errorMessage(err), buttons: [{ label: 'OK', value: 'ok', variant: 'primary' }] })
      )
      .finally(() => term.current?.focus())
  }

  return (
    <div className="session" style={{ display: active ? 'flex' : 'none' }}>
      <div
        className={`term-area ${flash ? 'bell' : ''}`}
        style={{ background: colors.background }}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="term-host" ref={hostEl} />
        {finding && search.current && (
          <TerminalFind
            search={search.current}
            onClose={() => {
              setFinding(false)
              term.current?.focus()
            }}
          />
        )}

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
                  <strong>{drop.remote ? 'Drop to copy here' : 'Drop to upload'}</strong>
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
        <SftpPanel
          sessionId={tab.sessionId}
          connected={connected}
          peers={peers}
          showHidden={settings.showHidden}
          confirmDelete={settings.confirmDelete}
          onClose={onToggleFiles}
          onCdHere={cdHere}
        />
      )}

      {menu && (
        <div className="menu" ref={menuEl} style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menuItem(<Copy size={14} />, 'Copy', 'terminal.copy', copySelection, !term.current?.hasSelection())}
          {menuItem(<ClipboardPaste size={14} />, 'Paste', 'terminal.paste', () => void smartPaste())}
          {menuItem(<TextSelect size={14} />, 'Select all', '', () => term.current?.selectAll())}
          <hr />
          {menuItem(<Search size={14} />, 'Find', 'terminal.find', () => setFinding(true))}
          {menuItem(<Eraser size={14} />, 'Clear', 'terminal.clear', () => {
            term.current?.clear()
            typeAhead.current?.reset()
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Paints instant-typing guesses over the terminal: each changed cell in the
 * terminal's font and colours, plus the cursor where it will be. Applied in the
 * next animation frame, right after the terminal's own repaint, so a confirmed
 * guess hands over to the real text without a flicker.
 */
function drawPrediction(t: Terminal, el: HTMLElement, p: Prediction | null): void {
  cancelAnimationFrame(Number(el.dataset.frame))
  el.dataset.frame = String(
    requestAnimationFrame(() => {
      el.replaceChildren()
      const screen = el.parentElement
      if (!p || !screen) return
      const w = screen.clientWidth / t.cols
      const h = screen.clientHeight / t.rows
      const theme = t.options.theme ?? {}
      el.style.fontFamily = t.options.fontFamily ?? ''
      el.style.fontSize = `${t.options.fontSize}px`
      el.style.color = theme.foreground ?? ''
      for (const c of p.cells) {
        const cell = document.createElement('span')
        cell.textContent = c.ch
        cell.style.cssText = `left:${c.x * w}px;top:${p.y * h}px;width:${w}px;height:${h}px;line-height:${h}px;background:${theme.background ?? ''}`
        el.appendChild(cell)
      }
      const cursor = document.createElement('i')
      cursor.style.cssText = `left:${p.cursorX * w}px;top:${p.y * h}px;height:${h}px;background:${theme.cursor ?? theme.foreground ?? ''}`
      el.appendChild(cursor)
    })
  )
}

let audio: AudioContext | null = null

/** A short, quiet beep for the terminal bell. */
function beep(): void {
  audio ??= new AudioContext()
  const tone = audio.createOscillator()
  const gain = audio.createGain()
  tone.frequency.value = 880
  gain.gain.setValueAtTime(0.06, audio.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12)
  tone.connect(gain).connect(audio.destination)
  tone.start()
  tone.stop(audio.currentTime + 0.13)
}
