import { extname, isAbsolute, join, relative, sep } from 'node:path'

// Pure helpers used by the SSH engine; kept separate so they can be unit tested.

/** Caps how many promises created through it run at the same time. */
export function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async (fn) => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/**
 * Turns a name chosen by the remote server into a safe single path component:
 * no separators, no `..`, nothing Windows would reinterpret (ADS, devices).
 */
export function safeLocalName(name: string, platform: NodeJS.Platform = process.platform): string {
  let n = name.replace(/[\x00-\x1f/\\]/g, '_')
  if (platform === 'win32') {
    n = n.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '')
    if (WINDOWS_RESERVED.test(n)) n = '_' + n
  }
  return n === '' || n === '.' || n === '..' ? '_' : n
}

/** Joins `name` onto `dir`, refusing anything that would land outside `dir`. */
export function inside(dir: string, name: string): string {
  const full = join(dir, name)
  const rel = relative(dir, full)
  if (!rel || rel.split(sep)[0] === '..' || isAbsolute(rel)) throw new Error(`Refusing unsafe file name: ${name}`)
  return full
}

/** Runs `fn` over `items` with at most `limit` running at once. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < items.length) await fn(items[i++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** "name" and ".ext" of a file name; a dotfile such as ".bashrc" has no extension. */
function splitExt(name: string): [string, string] {
  const ext = name.startsWith('.') && name.indexOf('.', 1) < 0 ? '' : extname(name)
  return [name.slice(0, name.length - ext.length), ext]
}

/** `name` if free, otherwise `name (1).ext`, `name (2).ext`, … whichever `taken` reports free first. */
export async function uniqueName(name: string, taken: (n: string) => Promise<boolean>): Promise<string> {
  if (!(await taken(name))) return name
  const [stem, ext] = splitExt(name)
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!(await taken(candidate))) return candidate
  }
}

/** For a copy next to the original: `name (copy).ext`, then `name (copy 2).ext`, … */
export async function copyName(name: string, taken: (n: string) => Promise<boolean>): Promise<string> {
  const [stem, ext] = splitExt(name)
  for (let i = 1; ; i++) {
    const candidate = `${stem} (copy${i > 1 ? ` ${i}` : ''})${ext}`
    if (!(await taken(candidate))) return candidate
  }
}

/** "screenshot-2026-11-06-14-30-12.png" in local time, for a pasted image. */
export function screenshotName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `screenshot-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.png`
}

/** True when version `a` is newer than `b` (both `x.y.z`, an optional `v` and pre-release tag allowed). */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string): [number[], string] => {
    const [core, pre = ''] = v.trim().replace(/^v/i, '').split('-', 2)
    return [core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre]
  }
  const [ca, pa] = parse(a)
  const [cb, pb] = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (ca[i] ?? 0) - (cb[i] ?? 0)
    if (d !== 0) return d > 0
  }
  // 1.2.0 is newer than 1.2.0-beta; two pre-releases compare as text.
  if (!pa !== !pb) return !pa
  return pa > pb
}
