import type { ITheme } from '@xterm/xterm'
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

/** Upload local paths into a remote directory, asking before anything gets overwritten. */
export async function uploadWithConfirm(sessionId: string, paths: string[], dir?: string): Promise<void> {
  if (paths.length === 0) return
  const prep = await api.prepareUpload(sessionId, paths, dir)
  let mode: 'replace' | 'keepBoth' = 'replace'
  if (prep.conflicts.length) {
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
    if (r.value === 'cancel') return
    mode = r.value as typeof mode
  }
  await api.upload(sessionId, paths, prep.dir, mode)
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

export function formatDate(sec: number): string {
  const d = new Date(sec * 1000)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' })
  })
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
