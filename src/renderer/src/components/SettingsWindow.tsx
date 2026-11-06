import { Fragment, useEffect, useState } from 'react'
import { Download, FolderOpen, Keyboard, Network, Palette, RotateCcw, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS, FONT_SIZE } from '@shared/settings'
import { api, isMac } from '../lib'
import { TERMINAL_THEME_LIST, terminalTheme } from '../themes'
import { installedMonospaceFonts, terminalFont } from '../fonts'
import { SCOPE_TITLES, shortcutRows, type Scope } from '../shortcuts'

type Section = 'appearance' | 'terminal' | 'files' | 'connection' | 'shortcuts' | 'updates'

const SECTIONS: { id: Section; title: string; icon: LucideIcon; keys: (keyof Settings)[] }[] = [
  {
    id: 'appearance',
    title: 'Appearance',
    icon: Palette,
    keys: ['theme', 'terminalTheme', 'fontFamily', 'fontSize', 'lineHeight', 'cursorStyle', 'cursorBlink']
  },
  {
    id: 'terminal',
    title: 'Terminal',
    icon: SquareTerminal,
    keys: ['scrollback', 'instantTyping', 'copyOnSelect', 'rightClick', 'confirmMultilinePaste', 'bell']
  },
  { id: 'files', title: 'Files', icon: FolderOpen, keys: ['showHidden', 'conflictDefault', 'downloadDir', 'confirmDelete'] },
  {
    id: 'connection',
    title: 'Connection',
    icon: Network,
    keys: ['autoReconnect', 'reconnectAttempts', 'keepaliveSeconds', 'connectTimeoutSeconds']
  },
  { id: 'shortcuts', title: 'Shortcuts', icon: Keyboard, keys: [] },
  { id: 'updates', title: 'Updates & About', icon: Download, keys: ['autoUpdate'] }
]

interface Props {
  settings: Settings
  appTheme: 'light' | 'dark'
  onChange(patch: Partial<Settings>): void
  onClose(): void
}

/** Settings: a window with the sections on the left. Changes apply (and are saved) at once. */
export function SettingsWindow({ settings, appTheme, onChange, onClose }: Props): React.JSX.Element {
  const [section, setSection] = useState<Section>('appearance')
  const current = SECTIONS.find((s) => s.id === section)!

  // Esc closes it, wherever the focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('.dialog-overlay')) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const reset = (): void => onChange(Object.fromEntries(current.keys.map((k) => [k, DEFAULT_SETTINGS[k]])))
  const isDefault = current.keys.every((k) => JSON.stringify(settings[k]) === JSON.stringify(DEFAULT_SETTINGS[k]))

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-label="Settings">
        <nav className="settings-nav">
          <h2>Settings</h2>
          {SECTIONS.map(({ id, title, icon: Icon }) => (
            <button key={id} className={id === section ? 'on' : ''} onClick={() => setSection(id)}>
              <Icon size={15} /> {title}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <div className="settings-head">
            <h3>{current.title}</h3>
            <button className="icon-btn" onClick={onClose} title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
          <div className="settings-content">
            {section === 'appearance' && <Appearance settings={settings} appTheme={appTheme} onChange={onChange} />}
            {section === 'terminal' && <TerminalSection settings={settings} onChange={onChange} />}
            {section === 'files' && <FilesSection settings={settings} onChange={onChange} />}
            {section === 'connection' && <ConnectionSection settings={settings} onChange={onChange} />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'updates' && <UpdatesSection settings={settings} onChange={onChange} />}
          </div>
          {current.keys.length > 0 && (
            <div className="settings-foot">
              <button className="btn ghost" onClick={reset} disabled={isDefault}>
                <RotateCcw size={14} /> Reset {current.title.toLowerCase()} to defaults
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

type SectionProps = { settings: Settings; onChange(patch: Partial<Settings>): void }

// ---------------------------------------------------------------- sections

function Appearance({ settings: s, appTheme, onChange }: SectionProps & { appTheme: 'light' | 'dark' }): React.JSX.Element {
  const fonts = installedMonospaceFonts()
  const colors = terminalTheme(s.terminalTheme, appTheme)
  return (
    <>
      <Row label="App theme">
        <Segmented
          value={s.theme}
          options={[
            ['system', 'System'],
            ['light', 'Light'],
            ['dark', 'Dark']
          ]}
          onChange={(theme) => onChange({ theme })}
        />
      </Row>
      <div className="set-row column">
        <div className="set-label">
          <span>Terminal colours</span>
        </div>
        <div className="theme-cards">
          {TERMINAL_THEME_LIST.map((t) => {
            const c = terminalTheme(t.id, appTheme)
            return (
              <button
                key={t.id}
                className={`theme-card ${s.terminalTheme === t.id ? 'on' : ''}`}
                style={{ background: c.background, color: c.foreground }}
                onClick={() => onChange({ terminalTheme: t.id })}
              >
                <span className="swatches">
                  {[c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan].map((col, i) => (
                    <i key={i} style={{ background: col }} />
                  ))}
                </span>
                <span>{t.label}</span>
              </button>
            )
          })}
        </div>
      </div>
      <Row label="Font">
        <select value={s.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value })}>
          <option value="">JetBrains Mono (built in)</option>
          {fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          {/* A font chosen earlier that is no longer found still shows. */}
          {s.fontFamily && !fonts.includes(s.fontFamily) && <option value={s.fontFamily}>{s.fontFamily}</option>}
        </select>
      </Row>
      <Row label="Font size" hint={`${isMac ? '⌘' : 'Ctrl'} + scroll changes it in the terminal too.`}>
        <select value={s.fontSize} onChange={(e) => onChange({ fontSize: Number(e.target.value) })}>
          {Array.from({ length: FONT_SIZE.max - FONT_SIZE.min + 1 }, (_, i) => FONT_SIZE.min + i).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Line height">
        <select value={s.lineHeight} onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}>
          {[1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2].map((n) => (
            <option key={n} value={n}>
              {n.toFixed(1)}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Cursor">
        <div className="set-inline">
          <Segmented
            value={s.cursorStyle}
            options={[
              ['bar', 'Bar'],
              ['block', 'Block'],
              ['underline', 'Underline']
            ]}
            onChange={(cursorStyle) => onChange({ cursorStyle })}
          />
          <Toggle on={s.cursorBlink} onChange={(cursorBlink) => onChange({ cursorBlink })} label="Blink" />
        </div>
      </Row>
      <div
        className="term-preview"
        style={{
          background: colors.background,
          color: colors.foreground,
          fontFamily: terminalFont(s.fontFamily),
          fontSize: s.fontSize,
          lineHeight: s.lineHeight
        }}
      >
        <div>
          <span style={{ color: colors.green }}>user@server</span>:<span style={{ color: colors.blue }}>~/app</span>$ ls
        </div>
        <div>
          <span style={{ color: colors.blue }}>src</span> <span style={{ color: colors.green }}>run.sh</span> README.md{' '}
          <span style={{ color: colors.red }}>error.log</span>
        </div>
        <div>
          <span style={{ color: colors.green }}>user@server</span>:<span style={{ color: colors.blue }}>~/app</span>${' '}
          <span className={`preview-cursor ${s.cursorStyle} ${s.cursorBlink ? 'blink' : ''}`} style={{ ['--cursor' as string]: colors.cursor }}>
            {' '}
          </span>
        </div>
      </div>
    </>
  )
}

function TerminalSection({ settings: s, onChange }: SectionProps): React.JSX.Element {
  return (
    <>
      <Row label="Scrollback" hint="Lines kept to scroll back through.">
        <select value={s.scrollback} onChange={(e) => onChange({ scrollback: Number(e.target.value) })}>
          {[1_000, 5_000, 10_000, 50_000, 100_000].map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString('en')} lines
            </option>
          ))}
        </select>
      </Row>
      <Row label="Instant typing" hint="On distant servers, show what you type before the server echoes it back.">
        <Toggle on={s.instantTyping} onChange={(instantTyping) => onChange({ instantTyping })} />
      </Row>
      <Row label="Copy on select" hint="Selected text goes to the clipboard right away.">
        <Toggle on={s.copyOnSelect} onChange={(copyOnSelect) => onChange({ copyOnSelect })} />
      </Row>
      <Row label="Right click">
        <Segmented
          value={s.rightClick}
          options={[
            ['copyPaste', 'Copy / paste'],
            ['menu', 'Menu']
          ]}
          onChange={(rightClick) => onChange({ rightClick })}
        />
      </Row>
      <Row label="Ask before pasting several lines" hint="At a prompt each line may run as a command.">
        <Toggle on={s.confirmMultilinePaste} onChange={(confirmMultilinePaste) => onChange({ confirmMultilinePaste })} />
      </Row>
      <Row label="Bell">
        <Segmented
          value={s.bell}
          options={[
            ['off', 'Off'],
            ['visual', 'Flash'],
            ['sound', 'Sound']
          ]}
          onChange={(bell) => onChange({ bell })}
        />
      </Row>
    </>
  )
}

function FilesSection({ settings: s, onChange }: SectionProps): React.JSX.Element {
  return (
    <>
      <Row label="Show hidden files" hint="Names starting with a dot, such as .bashrc.">
        <Toggle on={s.showHidden} onChange={(showHidden) => onChange({ showHidden })} />
      </Row>
      <Row label="When a name is taken" hint="On uploads, copies and pastes.">
        <Segmented
          value={s.conflictDefault}
          options={[
            ['ask', 'Ask'],
            ['keepBoth', 'Keep both'],
            ['replace', 'Replace']
          ]}
          onChange={(conflictDefault) => onChange({ conflictDefault })}
        />
      </Row>
      <Row label="Downloads go to" hint={s.downloadDir || 'Your Downloads folder'}>
        <div className="set-inline">
          <button
            className="btn ghost"
            onClick={() => void api.pickFolder().then((dir) => dir && onChange({ downloadDir: dir }))}
          >
            Change…
          </button>
          {s.downloadDir && (
            <button className="btn ghost" onClick={() => onChange({ downloadDir: '' })}>
              Use Downloads
            </button>
          )}
        </div>
      </Row>
      <Row label="Ask before deleting">
        <Toggle on={s.confirmDelete} onChange={(confirmDelete) => onChange({ confirmDelete })} />
      </Row>
    </>
  )
}

function ConnectionSection({ settings: s, onChange }: SectionProps): React.JSX.Element {
  return (
    <>
      <Row label="Reconnect when a connection drops" hint="After sleep, a Wi-Fi or VPN change, or a server restart.">
        <Toggle on={s.autoReconnect} onChange={(autoReconnect) => onChange({ autoReconnect })} />
      </Row>
      <Row label="Tries before giving up" hint="The wait grows between tries, up to 30 seconds; 14 tries take about five minutes.">
        <select
          value={s.reconnectAttempts}
          disabled={!s.autoReconnect}
          onChange={(e) => onChange({ reconnectAttempts: Number(e.target.value) })}
        >
          {[...new Set([3, 5, 10, 14, 30, 60, s.reconnectAttempts])].sort((a, b) => a - b).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Keepalive" hint="How often Liman checks a quiet connection; four missed answers count as dropped. New connections only.">
        <select value={s.keepaliveSeconds} onChange={(e) => onChange({ keepaliveSeconds: Number(e.target.value) })}>
          {[...new Set([0, 5, 10, 15, 30, 60, s.keepaliveSeconds])].sort((a, b) => a - b).map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'Off' : `Every ${n} seconds`}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Connection timeout" hint="How long to wait for a server to answer.">
        <select
          value={s.connectTimeoutSeconds}
          onChange={(e) => onChange({ connectTimeoutSeconds: Number(e.target.value) })}
        >
          {[...new Set([10, 20, 30, 60, s.connectTimeoutSeconds])].sort((a, b) => a - b).map((n) => (
            <option key={n} value={n}>
              {n} seconds
            </option>
          ))}
        </select>
      </Row>
    </>
  )
}

function ShortcutsSection(): React.JSX.Element {
  const rows = shortcutRows()
  return (
    <>
      <p className="set-note">F1 shows this list anywhere in Liman.</p>
      {(Object.keys(SCOPE_TITLES) as Scope[]).map((scope) => (
        <section key={scope} className="set-shortcuts">
          <h4>{SCOPE_TITLES[scope]}</h4>
          <dl>
            {rows
              .filter((r) => r.scope === scope)
              .map((r) => (
                <Fragment key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{keyCaps(isMac ? r.mac : r.win)}</dd>
                </Fragment>
              ))}
          </dl>
        </section>
      ))}
    </>
  )
}

function UpdatesSection({ settings: s, onChange }: SectionProps): React.JSX.Element {
  const [info, setInfo] = useState<{ version: string; packaged: boolean } | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState('')
  useEffect(() => void api.getAppInfo().then(setInfo), [])

  const check = async (): Promise<void> => {
    setChecking(true)
    setResult('')
    const { status, error } = await api.checkForUpdates()
    setChecking(false)
    if (error) return setResult(error)
    setResult(
      status.state === 'idle'
        ? 'Liman is up to date.'
        : status.state === 'downloading'
          ? `Downloading Liman ${status.version}…`
          : `Liman ${status.version} is available.`
    )
  }

  return (
    <>
      <Row label={`Liman ${info?.version ?? ''}`} hint={result || 'New versions come from GitHub Releases.'}>
        <button className="btn ghost" onClick={() => void check()} disabled={checking}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </Row>
      {!isMac && (
        <Row label="Download updates automatically" hint="Otherwise Liman only tells you a new version is out.">
          <Toggle on={s.autoUpdate} onChange={(autoUpdate) => onChange({ autoUpdate })} />
        </Row>
      )}
      <Row label="Log file" hint="Connection drops and errors are written here.">
        <button className="btn ghost" onClick={() => api.openLogs()}>
          Open folder
        </button>
      </Row>
      <Row label="Source and release notes">
        <button className="btn ghost" onClick={() => window.open('https://github.com/hakan-krgn/liman/releases')}>
          GitHub
        </button>
      </Row>
    </>
  )
}

// ---------------------------------------------------------------- controls

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="set-row">
      <div className="set-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange(on: boolean): void; label?: string }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={on} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="knob" />
      {label && <span className="switch-label">{label}</span>}
    </button>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: [T, string][]
  onChange(v: T): void
}): React.JSX.Element {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** Keys written as Markdown ("`Ctrl+C` / `F5`"): code spans become key caps. */
function keyCaps(markdown: string): React.ReactNode {
  return markdown.split('`').map((part, i) => (i % 2 ? <kbd key={i}>{part}</kbd> : part))
}
