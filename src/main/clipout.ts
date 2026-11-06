import { app, clipboard, ClipboardItem } from 'electron'
import { randomBytes } from 'node:crypto'
import { watch, promises as fsp, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStandIns, dropFolders, findStandInCopies, MARKER_FILE, pathKey, removeStandIns, type StandIns } from './standins'
import type { ClipContent, ClipEntry } from '@shared/types'
import { screenshotName } from './util'

/** A clipboard format by its platform name (Electron's raw clipboard access). */
const raw = (format: string): string => `electron application/osclipboard;format="${format}"`
/** Marks the clipboard as holding the stand-ins of a Liman copy. */
const MARK = raw('LimanClip')
/** Tells Explorer to copy, never move: the stand-ins must stay for the next paste. */
const DROP_EFFECT = raw('Preferred DropEffect')
const DROPEFFECT_COPY = [1, 0, 0, 0]

/** Stop watching for pastes after this long without one. */
const IDLE = 30 * 60_000
/** How often to check that the clipboard still holds our copy. */
const OWNER_CHECK = 2_000
/** While Liman is in the background, look for newly opened folder windows this often (after the first few looks). */
const WINDOW_SCAN = 10_000
/** How often one pasted path is downloaded at most (each paste over it is one). */
const MAX_DOWNLOADS = 3
/** First looks for folder windows after Liman loses focus, in ms. */
const FIRST_SCANS = [0, 2_000, 5_000]
/** Stand-ins stay a little after watching stops, for copies Explorer is still making. */
const KEEP_AFTER = 60_000

interface Copy {
  sessionId: string
  mode: 'copy' | 'cut'
  s: StandIns
  /** Pasted copies being downloaded right now. */
  claimed: Set<string>
  /** Downloads started per pasted path: pasting over the same file again downloads again, a few times at most. */
  downloads: Map<string, number>
  watchers: Map<string, FSWatcher>
  timers: Set<NodeJS.Timeout>
  /** Scans run one after another, so two can't both see a copy before its download starts. */
  scans: Promise<void>
  lastPaste: number
}

/**
 * Copying remote files to the system clipboard.
 *
 * Like dragging out, it puts stand-ins on the clipboard. Pastes can happen any
 * time later, often more than once, and while Liman is in the background: it
 * watches the desktop and every Explorer / Finder folder it has seen open, and
 * downloads the real content over each pasted copy.
 */
export class ClipOut {
  private current: Copy | null = null
  private focused = true
  private windowTimer?: NodeJS.Timeout

  constructor(
    private readonly deps: {
      download: (sessionId: string, remotePaths: string[], targets: string[]) => Promise<unknown>
      log: (line: string) => void
      /** Where pastes may land; the desktop and open folder windows by default. */
      folders?: () => Promise<string[]>
    }
  ) {}

  /** Whether a copy is on the clipboard and being watched. */
  get active(): boolean {
    return this.current !== null
  }

  /** Puts stand-ins for `entries` on the clipboard and starts watching for pastes. */
  async copy(sessionId: string, entries: ClipEntry[], mode: 'copy' | 'cut'): Promise<void> {
    this.stop()
    const s = createStandIns('liman-clip', entries)
    try {
      await clipboard.write([
        new ClipboardItem({
          'text/uri-list': s.files.map((f) => pathToFileURL(f).href).join('\r\n'),
          [MARK]: new Blob([Buffer.from(s.token)]),
          [DROP_EFFECT]: new Blob([Buffer.from(DROPEFFECT_COPY)])
        })
      ])
    } catch (err) {
      removeStandIns(s)
      throw err
    }
    const copy: Copy = {
      sessionId,
      mode,
      s,
      claimed: new Set(),
      downloads: new Map(),
      watchers: new Map(),
      timers: new Set(),
      scans: Promise.resolve(),
      lastPaste: Date.now()
    }
    this.current = copy
    this.watchFolder(copy, app.getPath('desktop'))
    this.every(copy, OWNER_CHECK, () => void this.checkOwner(copy))
    if (!this.focused) this.lookForWindows()
  }

  /** What the clipboard holds, for a paste inside Liman. */
  async inspect(): Promise<ClipContent> {
    const item = (await clipboard.read())[0]
    if (!item) return { kind: 'none' }
    if (item.types.includes(MARK)) {
      const c = this.current
      // Stand-ins from an earlier run, or from a copy we stopped watching, can't be pasted.
      if (!c || (await text(item, MARK)) !== c.s.token) return { kind: 'none' }
      return { kind: 'liman', sessionId: c.sessionId, paths: c.s.entries.map((e) => e.path), mode: c.mode }
    }
    if (item.types.includes('text/uri-list')) {
      const paths = (await text(item, 'text/uri-list'))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('file:'))
        .map((url) => fileURLToPath(url))
      if (paths.length) return { kind: 'files', paths }
    }
    // Apps like Word put a picture of copied text next to it: text wins.
    if (item.types.includes('image/png') && !item.types.includes('text/plain')) return { kind: 'image' }
    return { kind: 'none' }
  }

  /** Saves an image on the clipboard as a PNG in a temp folder, for uploading. */
  async saveImage(): Promise<string> {
    const item = (await clipboard.read()).find((i) => i.types.includes('image/png'))
    if (!item) throw new Error('There is no image on the clipboard')
    const blob = (await item.getType('image/png')) as Blob
    const dir = join(tmpdir(), 'liman-paste', randomBytes(6).toString('hex'))
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, screenshotName(new Date()))
    await fsp.writeFile(file, Buffer.from(await blob.arrayBuffer()))
    setTimeout(() => void fsp.rm(dir, { recursive: true, force: true }), IDLE).unref()
    return file
  }

  /** A cut was pasted inside Liman: the files moved, so the copy is over. */
  async release(): Promise<void> {
    await this.clearIfOurs()
    this.stop()
  }

  /** The session the copy came from ended: its files can't be fetched any more. */
  sessionEnded(sessionId: string): void {
    if (this.current?.sessionId !== sessionId) return
    void this.clearIfOurs().finally(() => this.stop())
  }

  /** Liman gained or lost focus. Pastes elsewhere happen while it is in the background. */
  setFocused(focused: boolean): void {
    this.focused = focused
    clearTimeout(this.windowTimer)
    const c = this.current
    if (!c) return
    if (focused) void this.scan(c, [...c.watchers.keys()])
    else this.lookForWindows()
  }

  async dispose(): Promise<void> {
    await this.clearIfOurs().catch(() => {})
    const c = this.current
    this.stop()
    if (c) removeStandIns(c.s)
  }

  // ------------------------------------------------------------------ watching

  /** Looks for open folder windows now, after 2 s and 5 s, then every 10 s while Liman stays in the background. */
  private lookForWindows(step = 0): void {
    const c = this.current
    if (!c || this.focused) return
    void this.scanWindows(c)
    const delay = step + 1 < FIRST_SCANS.length ? FIRST_SCANS[step + 1] - FIRST_SCANS[step] : WINDOW_SCAN
    this.windowTimer = setTimeout(() => this.lookForWindows(step + 1), delay)
    this.windowTimer.unref?.()
  }

  private async scanWindows(c: Copy): Promise<void> {
    const folders = await (this.deps.folders ?? dropFolders)()
    if (this.current !== c) return
    for (const f of folders) this.watchFolder(c, f)
    await this.scan(c, [...c.watchers.keys()])
  }

  /** Watches a folder for pastes (it stays watched while the copy lasts, even once its window closes). */
  private watchFolder(c: Copy, folder: string): void {
    if (c.watchers.has(folder)) return
    try {
      const w = watch(folder, () => {
        // Look right away and once more shortly after: Explorer may still be writing the copy.
        this.later(c, 300, () => void this.scan(c, [folder]))
        this.later(c, 1500, () => void this.scan(c, [folder]))
      })
      w.on('error', () => {
        w.close()
        c.watchers.delete(folder)
      })
      c.watchers.set(folder, w)
    } catch {
      /* gone or not readable */
    }
  }

  private scan(c: Copy, folders: string[]): Promise<void> {
    c.scans = c.scans.then(() => this.scanNow(c, folders)).catch((err) => this.deps.log(`paste scan failed: ${(err as Error).message}`))
    return c.scans
  }

  private async scanNow(c: Copy, folders: string[]): Promise<void> {
    if (this.current !== c) return
    for (const hit of await findStandInCopies(folders, c.s, c.claimed)) {
      const key = pathKey(hit.path)
      const count = c.downloads.get(key) ?? 0
      if (c.claimed.has(key) || count >= MAX_DOWNLOADS) continue
      c.claimed.add(key)
      c.downloads.set(key, count + 1)
      c.lastPaste = Date.now()
      const entry = c.s.entries[hit.index]
      void (async () => {
        if (entry.isDir) await fsp.rm(join(hit.path, MARKER_FILE), { force: true })
        await this.deps.download(c.sessionId, [entry.path], [hit.path])
      })()
        .catch((err) => this.deps.log(`paste from Liman failed: ${(err as Error).message}`))
        // Once it's done the file holds real content; a stand-in showing up there again is a new paste.
        .finally(() => c.claimed.delete(key))
    }
  }

  private async checkOwner(c: Copy): Promise<void> {
    if (Date.now() - c.lastPaste > IDLE) return this.stop()
    let item: Electron.ClipboardItem | undefined
    try {
      item = (await clipboard.read())[0]
    } catch {
      return // another app has the clipboard open; ask again next time
    }
    const ours = !!item && item.types.includes(MARK) && (await text(item, MARK)) === c.s.token
    if (ours || this.current !== c) return
    // Something else was copied: catch a last paste, then stop.
    await this.scan(c, [...c.watchers.keys()])
    if (this.current === c) this.stop()
  }

  private async clearIfOurs(): Promise<void> {
    const c = this.current
    const item = (await clipboard.read().catch(() => []))[0]
    if (c && item?.types.includes(MARK) && (await text(item, MARK)) === c.s.token) clipboard.clear()
  }

  /** Stops watching; the stand-ins go a minute later. */
  private stop(): void {
    const c = this.current
    if (!c) return
    this.current = null
    clearTimeout(this.windowTimer)
    for (const t of c.timers) clearTimeout(t)
    for (const w of c.watchers.values()) w.close()
    setTimeout(() => removeStandIns(c.s), KEEP_AFTER).unref()
  }

  private later(c: Copy, ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      c.timers.delete(t)
      fn()
    }, ms)
    t.unref?.()
    c.timers.add(t)
  }

  private every(c: Copy, ms: number, fn: () => void): void {
    const tick = (): void =>
      this.later(c, ms, () => {
        fn()
        if (this.current === c) tick()
      })
    tick()
  }
}

/** A clipboard entry as text (Electron hands most types over as a Blob). */
async function text(item: Electron.ClipboardItem, type: string): Promise<string> {
  const v = (await item.getType(type).catch(() => '')) as unknown
  if (typeof v === 'string') return v
  if (v && typeof (v as Blob).arrayBuffer === 'function') return Buffer.from(await (v as Blob).arrayBuffer()).toString('utf8')
  return ''
}
