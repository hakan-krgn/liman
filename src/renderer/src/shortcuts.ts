// Every keyboard shortcut in one place: what it does, where it works and its
// keys on each platform. The dispatcher (useShortcuts.ts), the F1 sheet and the
// README table all read this list, so they can't drift apart.

export type Scope = 'global' | 'terminal' | 'files' | 'hosts'
export type Platform = 'win' | 'mac'

export interface ShortcutDef {
  id: string
  label: string
  scope: Scope
  /** Chords like "Ctrl+Shift+K"; several are allowed. Windows and Linux share `win`. */
  keys: { win: string[]; mac: string[] }
  /** Handled inside a component (not by the dispatcher); listed for the docs only. */
  local?: boolean
  /** How the keys read in the docs (Markdown) when the chords alone don't say it well. */
  docKeys?: { win: string; mac: string }
}

const k = (win: string | string[], mac: string | string[]): ShortcutDef['keys'] => ({
  win: Array.isArray(win) ? win : [win],
  mac: Array.isArray(mac) ? mac : [mac]
})

export const SHORTCUTS: ShortcutDef[] = [
  // ------------------------------------------------------------ everywhere
  { id: 'tab.next', label: 'Next tab', scope: 'global', keys: k('Ctrl+Tab', 'Ctrl+Tab') },
  { id: 'tab.prev', label: 'Previous tab', scope: 'global', keys: k('Ctrl+Shift+Tab', 'Ctrl+Shift+Tab') },
  ...Array.from({ length: 9 }, (_, i): ShortcutDef => ({
    id: `tab.goto${i + 1}`,
    label: `Go to tab ${i + 1}`,
    scope: 'global',
    keys: k(`Ctrl+${i + 1}`, `Cmd+${i + 1}`)
  })),
  { id: 'tab.new', label: 'New connection (search hosts)', scope: 'global', keys: k('Ctrl+Shift+T', 'Cmd+T') },
  { id: 'tab.duplicate', label: 'Duplicate tab', scope: 'global', keys: k('Ctrl+Shift+D', 'Cmd+Shift+D') },
  { id: 'tab.reconnect', label: 'Reconnect', scope: 'global', keys: k('Ctrl+Shift+R', 'Cmd+Shift+R') },
  { id: 'tab.close', label: 'Close tab', scope: 'global', keys: k('Ctrl+Shift+W', 'Cmd+W') },
  { id: 'tab.rename', label: 'Rename tab', scope: 'global', keys: k('F2', 'F2') },
  { id: 'files.toggle', label: 'Show or hide the files panel', scope: 'global', keys: k('Ctrl+Shift+E', 'Cmd+Shift+E') },
  {
    id: 'zoom.in',
    label: 'Larger text',
    scope: 'global',
    keys: k(['Ctrl+=', 'Ctrl+Plus'], ['Cmd+=', 'Cmd+Plus']),
    docKeys: { win: '`Ctrl+=`', mac: '`⌘=`' }
  },
  { id: 'zoom.out', label: 'Smaller text', scope: 'global', keys: k('Ctrl+-', 'Cmd+-') },
  { id: 'zoom.reset', label: 'Default text size', scope: 'global', keys: k('Ctrl+0', 'Cmd+0') },
  { id: 'help.shortcuts', label: 'Keyboard shortcuts', scope: 'global', keys: k('F1', 'F1') },
  { id: 'app.settings', label: 'Settings', scope: 'global', keys: k('Ctrl+,', 'Cmd+,') },

  // -------------------------------------------------------------- terminal
  { id: 'terminal.copy', label: 'Copy the selection', scope: 'terminal', keys: k(['Ctrl+Shift+C', 'Ctrl+C'], 'Cmd+C') },
  { id: 'terminal.paste', label: 'Paste (files are uploaded here, after asking)', scope: 'terminal', keys: k(['Ctrl+Shift+V', 'Ctrl+V'], 'Cmd+V') },
  { id: 'terminal.find', label: 'Find', scope: 'terminal', keys: k('Ctrl+Shift+F', 'Cmd+F') },
  { id: 'terminal.clear', label: 'Clear the screen and scrollback', scope: 'terminal', keys: k('Ctrl+Shift+L', 'Cmd+K') },
  { id: 'terminal.deleteWord', label: 'Delete the previous / next word', scope: 'terminal', local: true, keys: k(['Ctrl+Backspace', 'Ctrl+Delete'], 'Alt+Backspace') },

  // ----------------------------------------------------------- files panel
  { id: 'files.copy', label: 'Copy (paste in Explorer / Finder, or in Liman)', scope: 'files', keys: k('Ctrl+C', 'Cmd+C') },
  { id: 'files.cut', label: 'Cut (paste in Liman to move)', scope: 'files', keys: k('Ctrl+X', 'Cmd+X') },
  { id: 'files.paste', label: 'Paste here (files, a screenshot, or what Liman copied)', scope: 'files', keys: k('Ctrl+V', 'Cmd+V') },
  { id: 'files.refresh', label: 'Refresh', scope: 'files', keys: k(['F5', 'Ctrl+R'], 'Cmd+R') },
  { id: 'files.open', label: 'Open folder / download file', scope: 'files', keys: k('Enter', ['Enter', 'Cmd+Down']) },
  { id: 'files.up', label: 'Parent folder', scope: 'files', keys: k(['Backspace', 'Alt+Up'], 'Cmd+Up') },
  { id: 'files.back', label: 'Back', scope: 'files', keys: k('Alt+Left', 'Cmd+[') },
  { id: 'files.forward', label: 'Forward', scope: 'files', keys: k('Alt+Right', 'Cmd+]') },
  { id: 'files.rename', label: 'Rename', scope: 'files', keys: k('F2', 'F2') },
  { id: 'files.delete', label: 'Delete', scope: 'files', keys: k('Delete', 'Cmd+Backspace') },
  { id: 'files.newFolder', label: 'New folder', scope: 'files', keys: k('Ctrl+Shift+N', 'Cmd+Shift+N') },
  { id: 'files.download', label: 'Download to the Downloads folder', scope: 'files', keys: k('Ctrl+S', 'Cmd+S') },
  { id: 'files.copyPath', label: 'Copy path', scope: 'files', keys: k('Ctrl+Shift+C', 'Cmd+Alt+C') },
  { id: 'files.cdHere', label: 'Go to this folder in the terminal', scope: 'files', keys: k('Ctrl+Enter', 'Cmd+Enter') },
  { id: 'files.filter', label: 'Filter this folder', scope: 'files', keys: k('Ctrl+F', 'Cmd+F') },
  { id: 'files.goTo', label: 'Type a path to go to', scope: 'files', keys: k('Ctrl+L', 'Cmd+Shift+G') },
  { id: 'files.selectAll', label: 'Select all', scope: 'files', keys: k('Ctrl+A', 'Cmd+A') },
  { id: 'files.escape', label: 'Cancel a cut, then clear the selection', scope: 'files', keys: k('Escape', 'Escape') },
  {
    id: 'files.move',
    label: 'Move through the list (Shift extends the selection)',
    scope: 'files',
    local: true,
    keys: k([], []),
    docKeys: { win: '`↑` `↓` `Home` `End` `PgUp` `PgDn`', mac: '`↑` `↓` `Home` `End` `PgUp` `PgDn`' }
  },
  {
    id: 'files.typeToFind',
    label: 'Jump to the first name starting with what you type',
    scope: 'files',
    local: true,
    keys: k([], []),
    docKeys: { win: 'Type the start of a name', mac: 'Type the start of a name' }
  },

  // ------------------------------------------------------------- host list
  { id: 'hosts.move', label: 'Move through the hosts', scope: 'hosts', local: true, keys: k(['Up', 'Down'], ['Up', 'Down']) },
  { id: 'hosts.connect', label: 'Connect', scope: 'hosts', local: true, keys: k('Enter', 'Enter') },
  { id: 'hosts.edit', label: 'Edit host', scope: 'hosts', keys: k('F2', 'F2') },
  { id: 'hosts.delete', label: 'Delete host', scope: 'hosts', keys: k('Delete', 'Cmd+Backspace') }
]

export const SHORTCUT_BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]))

// ----------------------------------------------------------------- chords

export interface Chord {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** "K", "F5", "Enter", "Up", "1", "=", … */
  key: string
}

const NAMED: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Esc: 'Escape',
  ' ': 'Space',
  '+': 'Plus'
}

/** Parses "Ctrl+Shift+K" (modifiers Ctrl, Alt, Shift, Cmd in any order, then one key). */
export function parseChord(text: string): Chord {
  const parts = text.split('+')
  // "Ctrl++" or "Ctrl+Plus" both mean the + key.
  const key = parts.at(-1) === '' ? 'Plus' : parts.pop()!
  const mods = new Set(parts.filter(Boolean).map((p) => p.toLowerCase()))
  for (const m of mods) if (!['ctrl', 'alt', 'shift', 'cmd'].includes(m)) throw new Error(`Unknown modifier in ${text}`)
  return { ctrl: mods.has('ctrl'), alt: mods.has('alt'), shift: mods.has('shift'), meta: mods.has('cmd'), key: normalizeKey(key) }
}

function normalizeKey(key: string): string {
  if (NAMED[key]) return NAMED[key]
  return key.length === 1 ? key.toUpperCase() : key
}

/** The chord a key press makes, or null for a lone modifier or an AltGr character. */
export function chordFromEvent(e: {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  getModifierState?: (key: string) => boolean
}): Chord | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return null
  // AltGr reports Ctrl+Alt on Windows; those keys type characters (@, €, …).
  if (e.getModifierState?.('AltGraph')) return null
  let key = normalizeKey(e.key)
  // A letter outside A–Z (ı, ş, ç, Cyrillic, ⌥-letters on macOS): use the key's position instead.
  if (e.key.length === 1 && !/^[\x20-\x7e]$/.test(e.key) && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key }
}

/** Keys whose Shift state counts; punctuation such as "=" or "+" needs Shift on many layouts. */
const SHIFT_MATTERS = /^([A-Z0-9]|F\d{1,2}|Up|Down|Left|Right|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Space)$/

/** Whether a key press makes `chord`. */
export function chordMatches(pressed: Chord, chord: Chord): boolean {
  return (
    pressed.key === chord.key &&
    pressed.ctrl === chord.ctrl &&
    pressed.alt === chord.alt &&
    pressed.meta === chord.meta &&
    (pressed.shift === chord.shift || !SHIFT_MATTERS.test(chord.key))
  )
}

// ----------------------------------------------------------- bindings

export type Bindings = Map<string, Chord[]>

/** Effective chords per action: the defaults, with the user's changes (`overrides`) on top. */
export function resolveBindings(platform: Platform, overrides: Record<string, string[]> = {}): Bindings {
  const out: Bindings = new Map()
  for (const s of SHORTCUTS) {
    if (s.local) continue
    const keys = overrides[s.id] ?? s.keys[platform]
    out.set(
      s.id,
      keys.flatMap((text) => {
        try {
          return [parseChord(text)]
        } catch {
          return []
        }
      })
    )
  }
  return out
}

/**
 * Actions of the same scope that share a chord. (A panel's own action taking
 * over an app-wide key there, like F2, is intended: the focused scope wins.)
 */
export function findConflicts(bindings: Bindings): [string, string, string][] {
  const out: [string, string, string][] = []
  const entries = [...bindings.entries()]
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [a, ca] = entries[i]
      const [b, cb] = entries[j]
      const sa = SHORTCUT_BY_ID.get(a)!.scope
      const sb = SHORTCUT_BY_ID.get(b)!.scope
      if (sa !== sb) continue
      for (const x of ca) for (const y of cb) if (sameChord(x, y)) out.push([a, b, formatChord(x, 'win')])
    }
  }
  return out
}

function sameChord(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta
}

// --------------------------------------------------------------- display

const MAC_KEYS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: 'Esc',
  Plus: '+',
  Enter: 'Enter',
  Tab: 'Tab'
}
const WIN_KEYS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Escape: 'Esc', Plus: '+' }

/** "Ctrl+Shift+K" on Windows / Linux, "⌘⇧K" on macOS. */
export function formatChord(c: Chord, platform: Platform): string {
  if (platform === 'mac') {
    return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${MAC_KEYS[c.key] ?? c.key}`
  }
  const mods = [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.meta && 'Win'].filter(Boolean)
  return [...mods, WIN_KEYS[c.key] ?? c.key].join('+')
}

export const SCOPE_TITLES: Record<Scope, string> = {
  global: 'Everywhere',
  terminal: 'Terminal',
  files: 'Files panel',
  hosts: 'Host list'
}

/** One documentation row per action (the nine "go to tab" actions share one); keys as Markdown. */
export function shortcutRows(): { scope: Scope; label: string; win: string; mac: string }[] {
  const rows: { scope: Scope; label: string; win: string; mac: string }[] = []
  for (const s of SHORTCUTS) {
    if (/^tab\.goto[2-9]$/.test(s.id)) continue
    if (s.id === 'tab.goto1') {
      rows.push({ scope: s.scope, label: 'Go to tab 1–9', win: '`Ctrl+1…9`', mac: '`⌘1…9`' })
      continue
    }
    const show = (p: Platform): string =>
      s.docKeys?.[p] ?? s.keys[p].map((t) => `\`${formatChord(parseChord(t), p)}\``).join(' / ')
    rows.push({ scope: s.scope, label: s.label, win: show('win'), mac: show('mac') })
  }
  return rows
}

/** The Markdown tables in the README, one per scope. */
export function renderShortcutTables(): string {
  const rows = shortcutRows()
  const out: string[] = []
  for (const scope of Object.keys(SCOPE_TITLES) as Scope[]) {
    out.push(`### ${SCOPE_TITLES[scope]}`, '', '| Action | Windows / Linux | macOS |', '|---|---|---|')
    for (const r of rows.filter((x) => x.scope === scope)) out.push(`| ${r.label} | ${r.win || '—'} | ${r.mac || '—'} |`)
    out.push('')
  }
  return out.join('\n').trimEnd()
}
