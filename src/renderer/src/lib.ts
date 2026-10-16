import type { ITheme } from '@xterm/xterm'
import type { ConflictMode, RemoteEntry } from '@shared/types'
import type { DragEvent, ReactNode } from 'react'

export const api = window.api
export const isMac = api.platform === 'darwin'

// ------------------------------------------------------------ data dispatch
// One IPC listener fans terminal output out to the right xterm instance.

const dataHandlers = new Map<string, (d: Uint8Array) => void>()
api.onData((sessionId, data) => dataHandlers.get(sessionId)?.(data))

export function onSessionData(sessionId: string, cb: (d: Uint8Array) => void): () => void {
  dataHandlers.set(sessionId, cb)
  return () => dataHandlers.delete(sessionId)
}

// ----------------------------------------------------------- listing cache
// Remote folder listings are kept per session so revisiting a folder is instant;
// the panel still revalidates in the background.

export type Listing = { path: string; entries: RemoteEntry[] }

const listings = new Map<string, Listing>()
const inflight = new Map<string, Promise<Listing>>()
const MAX_LISTINGS = 300
const listingKey = (sessionId: string, path: string): string => `${sessionId}\n${path}`

export function cachedListing(sessionId: string, path: string): Listing | undefined {
  return listings.get(listingKey(sessionId, path))
}

/** Loads a folder; `fresh` skips joining a request that started before a change. */
export function fetchListing(sessionId: string, dir: string, fresh = false): Promise<Listing> {
  const key = listingKey(sessionId, dir)
  const pending = inflight.get(key)
  if (pending && !fresh) return pending
  const p = api
    .list(sessionId, dir)
    .then((res) => {
      for (const k of new Set([key, listingKey(sessionId, res.path)])) {
        listings.delete(k)
        listings.set(k, res)
      }
      while (listings.size > MAX_LISTINGS) listings.delete(listings.keys().next().value!)
      return res
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
  inflight.set(key, p)
  return p
}

export function invalidateListing(sessionId: string, path: string): void {
  listings.delete(listingKey(sessionId, path))
}

// ------------------------------------------------------------------ dialogs

export interface DialogButton {
  label: string
  value: string
  variant?: 'primary' | 'danger' | 'ghost'
}

export interface DialogSpec {
  title: string
  message?: ReactNode
  buttons: DialogButton[]
  input?: { value: string; placeholder?: string; secret?: boolean }[]
  /** Value returned when the dialog is dismissed with Escape. */
  cancelValue?: string
  /** Lets `dismissDialog` close it from outside (e.g. its session ended). */
  key?: string
}

export interface DialogResult {
  value: string
  inputs: string[]
}

type OpenDialog = DialogSpec & { id: number; resolve: (r: DialogResult) => void }
let dialogs: OpenDialog[] = []
const dialogListeners = new Set<(d: OpenDialog[]) => void>()
let nextId = 1

export function showDialog(spec: DialogSpec): Promise<DialogResult> {
  return new Promise((resolve) => {
    const id = nextId++
    const d: OpenDialog = {
      ...spec,
      id,
      resolve: (r) => {
        dialogs = dialogs.filter((x) => x.id !== id)
        dialogListeners.forEach((l) => l(dialogs))
        resolve(r)
      }
    }
    dialogs = [...dialogs, d]
    dialogListeners.forEach((l) => l(dialogs))
  })
}

/** Closes a dialog opened with `key` as if it were cancelled. */
export function dismissDialog(key: string): void {
  const d = dialogs.find((x) => x.key === key)
  if (d) d.resolve({ value: d.cancelValue ?? 'cancel', inputs: [] })
}

export function subscribeDialogs(cb: (d: OpenDialog[]) => void): () => void {
  dialogListeners.add(cb)
  cb(dialogs)
  return () => dialogListeners.delete(cb)
}

export async function confirmDialog(title: string, message: ReactNode, okLabel = 'OK', danger = false): Promise<boolean> {
  const r = await showDialog({
    title,
    message,
    buttons: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      { label: okLabel, value: 'ok', variant: danger ? 'danger' : 'primary' }
    ]
  })
  return r.value === 'ok'
}

export async function textDialog(title: string, value: string, okLabel = 'Save'): Promise<string | null> {
  const r = await showDialog({
    title,
    input: [{ value }],
    buttons: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      { label: okLabel, value: 'ok', variant: 'primary' }
    ]
  })
  const text = r.inputs[0]?.trim()
  return r.value === 'ok' && text ? text : null
}

// ------------------------------------------------------------------ uploads

/** Asks what to do about name clashes; null when the user cancels. */
async function askConflicts(prep: { dir: string; conflicts: string[] }): Promise<ConflictMode | null> {
  if (!prep.conflicts.length) return 'replace'
  const what = prep.conflicts.length === 1 ? `“${prep.conflicts[0]}” already exists` : `${prep.conflicts.length} items already exist`
  const r = await showDialog({
    title: 'Replace existing files?',
    message: `${what} in ${prep.dir}.`,
    buttons: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      { label: 'Keep both', value: 'keepBoth', variant: 'primary' },
      { label: 'Replace', value: 'replace', variant: 'danger' }
    ]
  })
  return r.value === 'cancel' ? null : (r.value as ConflictMode)
}

/** Upload local paths into a remote directory, asking before anything gets overwritten. */
export async function uploadWithConfirm(sessionId: string, paths: string[], dir?: string): Promise<void> {
  if (paths.length === 0) return
  const prep = await api.prepareUpload(sessionId, paths, dir)
  const mode = await askConflicts(prep)
  if (mode) await api.upload(sessionId, paths, prep.dir, mode)
}

/**
 * Copy remote paths from one open session to another, into `dir` or the target
 * terminal's current folder, asking before anything gets overwritten.
 */
export async function copyWithConfirm(fromId: string, paths: string[], toId: string, dir?: string): Promise<void> {
  if (paths.length === 0) return
  const names = paths.map((p) => p.replace(/\/+$/, '').split('/').pop() || p)
  const prep = await api.prepareCopy(toId, names, dir)
  const mode = await askConflicts(prep)
  if (mode) await api.copyBetween(fromId, paths, toId, prep.dir, mode)
}

// --------------------------------------------------------- remote drags
// Files dragged out of a files panel. Normally that's an OS drag of local
// stand-ins (so it can land on the desktop); if those can't be made, a plain
// in-app drag with REMOTE_DRAG data. Either way the payload is kept here.

export const REMOTE_DRAG = 'application/x-liman-remote'
export type RemoteDrag = { sessionId: string; paths: string[]; standIns?: string[] }
let remoteDrag: RemoteDrag | null = null
let clearTimer: ReturnType<typeof setTimeout> | undefined
let startedAt = 0

export function setRemoteDrag(drag: RemoteDrag | null): void {
  clearTimeout(clearTimer)
  remoteDrag = drag
  startedAt = Date.now()
}

// The OS drag ended (dropped anywhere): forget it once drop handlers have run.
api.onDragOutEnded(() => {
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => (remoteDrag = null), 1500)
})

// The window gets no mouse moves during an OS drag, so one means it's over
// (that's how macOS, where the drag doesn't block, finds out).
window.addEventListener('mousemove', () => {
  if (remoteDrag?.standIns && Date.now() - startedAt > 500) remoteDrag = null
})

export const isRemoteDrag = (e: DragEvent): boolean => e.dataTransfer.types.includes(REMOTE_DRAG)

const samePath = (a: string, b: string): boolean =>
  isMac ? a === b : a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/**
 * The files-panel drag behind a drag event, or null for files from elsewhere.
 * While hovering only the drag's type is known; on drop (`dropping`) the
 * dropped paths must be exactly our stand-ins.
 */
export function remoteDragOf(e: DragEvent, dropping = false): RemoteDrag | null {
  const d = remoteDrag
  if (!d) return null
  if (isRemoteDrag(e)) return d
  if (!d.standIns || !hasFiles(e)) return null
  if (!dropping) return d
  const paths = droppedPaths(e)
  return paths.length > 0 && paths.every((p) => d.standIns!.some((s) => samePath(s, p))) ? d : null
}

export function droppedPaths(e: DragEvent): string[] {
  return Array.from(e.dataTransfer.files)
    .map((f) => api.pathForFile(f))
    .filter(Boolean)
}

export const hasFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')

// ------------------------------------------------------------------ format

/** Strips Electron's IPC wrapper from errors thrown in the main process. */
export function errorMessage(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do {
    n /= 1024
    i++
  } while (n >= 1024 && i < units.length - 1)
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

// Building an Intl formatter is costly; reuse them for every row.
const dateThisYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const dateOtherYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const currentYear = new Date().getFullYear()

export function formatDate(sec: number): string {
  const d = new Date(sec * 1000)
  return (d.getFullYear() === currentYear ? dateThisYear : dateOtherYear).format(d)
}

// ------------------------------------------------------------------ themes

export const terminalThemes: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#24292f',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(9, 105, 218, 0.22)',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#7d4e00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f'
  },
  dark: {
    background: '#141517',
    foreground: '#e3e4e8',
    cursor: '#e3e4e8',
    cursorAccent: '#141517',
    selectionBackground: 'rgba(124, 140, 255, 0.32)',
    black: '#3f4451',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d7dae0',
    brightBlack: '#5c6370',
    brightRed: '#ff7b86',
    brightGreen: '#b1e18b',
    brightYellow: '#efd089',
    brightBlue: '#67cdff',
    brightMagenta: '#e48bff',
    brightCyan: '#63d4e0',
    brightWhite: '#ffffff'
  }
}

/** Window chrome colours, mirrored from styles.css, for the native title bar overlay. */
export const chrome = {
  light: { bg: '#f6f6f7', fg: '#1f1f22' },
  dark: { bg: '#1b1c1f', fg: '#e3e4e8' }
}
