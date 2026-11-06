import type { Settings } from './types'

// The settings' defaults and rules, shared by main (which saves them) and the
// renderer (which shows them and resets sections to their defaults).

export const TERMINAL_THEMES = ['liman', 'one-dark', 'dracula', 'solarized-dark', 'solarized-light', 'nord', 'gruvbox-dark'] as const
export type TerminalThemeId = (typeof TERMINAL_THEMES)[number]

export const DEFAULT_SETTINGS: Settings = {
  // Appearance
  theme: 'system',
  terminalTheme: 'liman',
  fontFamily: '',
  fontSize: 14,
  lineHeight: 1.2,
  cursorStyle: 'bar',
  cursorBlink: true,
  // Terminal
  scrollback: 10_000,
  instantTyping: true,
  copyOnSelect: false,
  rightClick: 'copyPaste',
  confirmMultilinePaste: true,
  bell: 'off',
  // Files
  showHidden: true,
  conflictDefault: 'ask',
  downloadDir: '',
  confirmDelete: true,
  // Connection
  autoReconnect: true,
  reconnectAttempts: 14,
  keepaliveSeconds: 15,
  connectTimeoutSeconds: 20,
  // Updates
  autoUpdate: true,
  // Remembered state
  collapsedGroups: []
}

export const FONT_SIZE = { min: 8, max: 32 }
export const LINE_HEIGHT = { min: 1, max: 2 }
export const SCROLLBACK = { min: 1_000, max: 100_000 }
export const RECONNECT_ATTEMPTS = { min: 1, max: 100 }
/** 0 turns keepalives off. */
export const KEEPALIVE = { min: 0, max: 300 }
export const CONNECT_TIMEOUT = { min: 5, max: 120 }

const oneOf =
  <T extends string>(...values: T[]) =>
  (v: unknown, prev: T): T =>
    values.includes(v as T) ? (v as T) : prev
const bool = (v: unknown, prev: boolean): boolean => (typeof v === 'boolean' ? v : prev)
const int =
  ({ min, max }: { min: number; max: number }) =>
  (v: unknown, prev: number): number => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && v !== null && v !== '' ? Math.min(max, Math.max(min, n)) : prev
  }

type Rules = { [K in keyof Settings]-?: (v: unknown, prev: Settings[K]) => Settings[K] }

const RULES: Rules = {
  theme: oneOf('system', 'light', 'dark'),
  terminalTheme: (v, prev) => ((TERMINAL_THEMES as readonly unknown[]).includes(v) ? (v as string) : prev),
  // A font name only: it ends up in CSS.
  fontFamily: (v, prev) => (typeof v === 'string' ? v.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 80) : prev),
  fontSize: int(FONT_SIZE),
  lineHeight: (v, prev) => {
    const n = Number(v)
    return Number.isFinite(n) && v !== null && v !== '' ? Math.min(LINE_HEIGHT.max, Math.max(LINE_HEIGHT.min, Math.round(n * 20) / 20)) : prev
  },
  cursorStyle: oneOf('bar', 'block', 'underline'),
  cursorBlink: bool,
  scrollback: int(SCROLLBACK),
  instantTyping: bool,
  copyOnSelect: bool,
  rightClick: oneOf('copyPaste', 'menu'),
  confirmMultilinePaste: bool,
  bell: oneOf('off', 'visual', 'sound'),
  showHidden: bool,
  conflictDefault: oneOf('ask', 'keepBoth', 'replace'),
  // '' means the system's Downloads folder; otherwise an absolute path.
  downloadDir: (v, prev) => (typeof v === 'string' && (v === '' || /^([a-zA-Z]:[\\/]|\/)/.test(v)) ? v.slice(0, 1000) : prev),
  confirmDelete: bool,
  autoReconnect: bool,
  reconnectAttempts: int(RECONNECT_ATTEMPTS),
  keepaliveSeconds: int(KEEPALIVE),
  connectTimeoutSeconds: int(CONNECT_TIMEOUT),
  autoUpdate: bool,
  collapsedGroups: (v, prev) => (Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string').slice(0, 500) : prev),
  shortcuts: (v, prev) => (v === undefined ? prev : cleanShortcuts(v))
}

/**
 * `prev` with `patch` applied. Every value is checked: one that isn't valid
 * keeps its previous value, and unknown keys are dropped.
 */
export function mergeSettings(prev: Settings, patch: Partial<Record<keyof Settings, unknown>>): Settings {
  const out = { ...prev }
  for (const key of Object.keys(RULES) as (keyof Settings)[]) {
    if (!(key in patch)) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(out as any)[key] = (RULES[key] as (v: unknown, p: unknown) => unknown)(patch[key], prev[key])
  }
  if (out.shortcuts === undefined) delete out.shortcuts
  return out
}

/** Changed keys: short action ids mapping to a few short chord strings. */
function cleanShortcuts(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!v || typeof v !== 'object') return out
  for (const [id, keys] of Object.entries(v).slice(0, 200)) {
    if (!/^[a-z][a-zA-Z0-9.]{0,40}$/.test(id) || !Array.isArray(keys)) continue
    out[id] = keys.filter((k): k is string => typeof k === 'string' && k.length <= 40).slice(0, 4)
  }
  return out
}
