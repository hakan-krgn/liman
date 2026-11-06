import { app } from 'electron'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, promises as fsp, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, posix } from 'node:path'
import { safeLocalName } from './util'

// Stand-ins: small local files that take the place of remote ones in an OS
// drag or on the clipboard. Each carries a random marker, so wherever Explorer
// or Finder put a copy, Liman can find it and download the real content there.

/** A remote file or folder a stand-in is made for. */
export interface StandInEntry {
  path: string
  isDir: boolean
}

export interface StandIns {
  token: string
  /** Our temp folder holding the originals. */
  dir: string
  marker: string
  entries: StandInEntry[]
  /** One stand-in per entry, in `dir`. */
  files: string[]
}

/** Inside a stand-in folder, this file carries the marker. */
export const MARKER_FILE = '.liman-drop'

/** Temp folders the stand-ins live in, one per use. */
export type StandInKind = 'liman-drag' | 'liman-clip'

/** Creates stand-ins with the entries' names (folders are empty folders). Synchronous. */
export function createStandIns(kind: StandInKind, entries: StandInEntry[]): StandIns {
  const token = randomBytes(12).toString('hex')
  const dir = join(tmpdir(), kind, token)
  mkdirSync(dir, { recursive: true })
  const marker = `liman-stand-in ${token}\nLiman is downloading the real file into this place.\n`
  const taken = new Set<string>()
  const files = entries.map((e) => {
    let name = safeLocalName(posix.basename(e.path))
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${name} (${n})`
    taken.add(name.toLowerCase())
    const path = join(dir, name)
    if (e.isDir) {
      mkdirSync(path)
      writeFileSync(join(path, MARKER_FILE), marker)
    } else {
      writeFileSync(path, marker)
    }
    return path
  })
  return { token, dir, marker, entries, files }
}

export function removeStandIns(s: StandIns): void {
  rmSync(s.dir, { recursive: true, force: true })
}

/** Removes stand-in folders an earlier run left behind (older than an hour, so another instance's stay). */
export async function removeOldStandIns(): Promise<void> {
  const cutoff = Date.now() - 60 * 60_000
  for (const kind of ['liman-drag', 'liman-clip', 'liman-paste']) {
    const root = join(tmpdir(), kind)
    const names = await fsp.readdir(root).catch(() => [] as string[])
    for (const name of names) {
      const path = join(root, name)
      const st = await fsp.stat(path).catch(() => null)
      if (st && st.mtimeMs < cutoff) await fsp.rm(path, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Every copy of the stand-ins in `folders`, as entry index and path, skipping
 * paths in `claimed`. Explorer may have renamed a copy ("name (2).txt",
 * "site - Copy"), so names only need to start like the stand-in's.
 */
export async function findStandInCopies(
  folders: string[],
  s: Pick<StandIns, 'files' | 'entries' | 'marker' | 'dir'>,
  claimed: ReadonlySet<string> = new Set()
): Promise<{ index: number; path: string }[]> {
  const hits: { index: number; path: string }[] = []
  for (const folder of new Set(folders)) {
    if (samePath(folder, s.dir)) continue
    const names = await fsp.readdir(folder).catch(() => [] as string[])
    for (const [index, standIn] of s.files.entries()) {
      const base = standIn.split(/[\\/]/).pop()!
      const ext = s.entries[index].isDir ? '' : extname(base)
      const stem = (ext ? base.slice(0, -ext.length) : base).toLowerCase()
      for (const name of names) {
        const lower = name.toLowerCase()
        if (!lower.startsWith(stem) || (ext && !lower.endsWith(ext.toLowerCase()))) continue
        const path = join(folder, name)
        if (claimed.has(pathKey(path)) || hits.some((h) => samePath(h.path, path))) continue
        const markerPath = s.entries[index].isDir ? join(path, MARKER_FILE) : path
        if ((await fsp.readFile(markerPath, 'utf8').catch(() => '')) === s.marker) hits.push({ index, path })
      }
    }
  }
  return hits
}

/** The first copy of each stand-in in `folders`: entry index -> path. Used after a drag. */
export async function findStandIns(
  folders: string[],
  s: Pick<StandIns, 'files' | 'entries' | 'marker' | 'dir'>
): Promise<Map<number, string>> {
  const found = new Map<number, string>()
  for (const hit of await findStandInCopies(folders, s)) if (!found.has(hit.index)) found.set(hit.index, hit.path)
  return found
}

/** How a local path is compared: case-insensitively on Windows and macOS. */
export function pathKey(path: string): string {
  return process.platform === 'linux' ? path : path.toLowerCase()
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

/** Where a drop or paste most likely went: the desktop and every open Explorer / Finder window. */
export async function dropFolders(): Promise<string[]> {
  const folders = new Set<string>([app.getPath('desktop')])
  const windows =
    process.platform === 'win32'
      ? await run('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // Redirected output uses the OEM code page otherwise, which garbles names like "Masaüstü".
          '[Console]::OutputEncoding = [Text.Encoding]::UTF8; (New-Object -ComObject Shell.Application).Windows() | ForEach-Object { try { $_.Document.Folder.Self.Path } catch {} }'
        ])
      : process.platform === 'darwin'
        ? await run(
            'osascript',
            [
              'set out to ""',
              'tell application "Finder"',
              'repeat with w in Finder windows',
              'try',
              'set out to out & POSIX path of (target of w as alias) & linefeed',
              'end try',
              'end repeat',
              'end tell',
              'return out'
            ].flatMap((line) => ['-e', line])
          )
        : ''
  for (const line of windows.split(/\r?\n/)) {
    const path = line.trim()
    if (path && isAbsolute(path)) folders.add(path)
  }
  return [...folders]
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout))
  })
}
