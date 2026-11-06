import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

// A system clipboard in memory, shaped like Electron 44's async API.
const env = vi.hoisted(() => {
  class ClipboardItem {
    readonly types: string[]
    constructor(readonly items: Record<string, unknown>) {
      this.types = Object.keys(items)
    }
    async getType(type: string): Promise<unknown> {
      if (!(type in this.items)) throw new Error(`no ${type}`)
      return this.items[type]
    }
  }
  const board: { item?: ClipboardItem } = {}
  return {
    desktop: '',
    board,
    ClipboardItem,
    clipboard: {
      write: async (items: ClipboardItem[]) => void (board.item = items[0]),
      read: async () => (board.item ? [board.item] : []),
      clear: () => void (board.item = undefined)
    }
  }
})
vi.mock('electron', () => ({
  app: { getPath: () => env.desktop },
  clipboard: env.clipboard,
  ClipboardItem: env.ClipboardItem
}))

const { ClipOut } = await import('../../src/main/clipout')

env.desktop = mkdtempSync(join(tmpdir(), 'liman-desktop-'))
const explorer = mkdtempSync(join(tmpdir(), 'liman-explorer-'))
afterAll(() => {
  rmSync(env.desktop, { recursive: true, force: true })
  rmSync(explorer, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
  for (let t = 0; t < ms && !pred(); t += 50) await sleep(50)
}
/** The stand-ins Liman put on the clipboard. */
const clipboardFiles = async (): Promise<string[]> => {
  const list = (await env.board.item!.getType('text/uri-list')) as string
  return list.split('\r\n').map((u) => fileURLToPath(u))
}

const entries = [
  { path: '/srv/report.txt', isDir: false },
  { path: '/srv/site', isDir: true }
]

describe('copying remote files to the clipboard', () => {
  it('puts stand-ins on the clipboard and downloads each paste once', async () => {
    // Like the real download: files get their content (folders already exist).
    const download = vi.fn(async (_sid: string, _remotes: string[], targets: string[]) => {
      for (const t of targets) if (!existsSync(join(t, '.')) || !statSync(t).isDirectory()) writeFileSync(t, 'real')
    })
    const clip = new ClipOut({ download, log: () => {}, folders: async () => [env.desktop, explorer] })
    await clip.copy('s1', entries, 'copy')
    const files = await clipboardFiles()
    expect(files.map((f) => basename(f))).toEqual(['report.txt', 'site'])
    expect(await clip.inspect()).toEqual({ kind: 'liman', sessionId: 's1', paths: ['/srv/report.txt', '/srv/site'], mode: 'copy' })

    // Liman goes to the background and the user pastes into an Explorer window...
    clip.setFocused(false)
    await sleep(200)
    cpSync(files[0], join(explorer, 'report.txt'))
    cpSync(files[1], join(explorer, 'site'), { recursive: true })
    await waitFor(() => download.mock.calls.length >= 2)
    // ...and once more onto the desktop.
    cpSync(files[0], join(env.desktop, 'report.txt'))
    await waitFor(() => download.mock.calls.length >= 3)
    await sleep(2000)

    const calls = download.mock.calls as unknown as [string, string[], string[]][]
    expect(calls.map(([sid, remotes, targets]) => [sid, remotes[0], targets[0]]).sort()).toEqual(
      [
        ['s1', '/srv/report.txt', join(env.desktop, 'report.txt')],
        ['s1', '/srv/report.txt', join(explorer, 'report.txt')],
        ['s1', '/srv/site', join(explorer, 'site')]
      ].sort()
    )
    // The folder's marker is gone before its contents arrive.
    expect(existsSync(join(explorer, 'site', '.liman-drop'))).toBe(false)
    expect(readFileSync(join(explorer, 'report.txt'), 'utf8')).toBe('real')

    // Pasting over the same file again (Explorer: "Replace") downloads it again.
    cpSync(files[0], join(explorer, 'report.txt'))
    await waitFor(() => download.mock.calls.length >= 4)
    expect(download.mock.calls.length).toBe(4)
    await sleep(1500)
    expect(download.mock.calls.length).toBe(4)
    await clip.dispose()
  }, 20_000)

  it('stops watching once something else is copied', async () => {
    const download = vi.fn(async () => {})
    const clip = new ClipOut({ download, log: () => {}, folders: async () => [explorer] })
    await clip.copy('s1', [{ path: '/srv/late.txt', isDir: false }], 'cut')
    const [standIn] = await clipboardFiles()
    clip.setFocused(false)
    expect(clip.active).toBe(true)
    await env.clipboard.write([new env.ClipboardItem({ 'text/plain': 'hello' })])
    await waitFor(() => !clip.active, 4000)
    expect(clip.active).toBe(false)
    // Its stand-ins are no longer pasted from Liman's point of view.
    cpSync(standIn, join(explorer, 'late.txt'))
    await sleep(800)
    expect(download).not.toHaveBeenCalled()
    expect(await clip.inspect()).toEqual({ kind: 'none' })
  }, 20_000)

  it('clears its stand-ins off the clipboard when their session ends', async () => {
    const clip = new ClipOut({ download: async () => {}, log: () => {}, folders: async () => [] })
    await clip.copy('gone', entries, 'copy')
    clip.sessionEnded('other')
    expect(clip.active).toBe(true)
    clip.sessionEnded('gone')
    await waitFor(() => !clip.active)
    expect(env.board.item).toBeUndefined()
  })
})

describe('reading the clipboard for a paste in Liman', () => {
  const clip = new ClipOut({ download: async () => {}, log: () => {}, folders: async () => [] })

  it('lists files copied in Explorer', async () => {
    const a = join(explorer, 'çiçek a.txt')
    writeFileSync(a, 'a')
    const uris = [a, explorer].map((p) => pathToFileURL(p).href).join('\r\n')
    await env.clipboard.write([new env.ClipboardItem({ 'text/uri-list': new Blob([uris]) })])
    expect(await clip.inspect()).toEqual({ kind: 'files', paths: [a, explorer] })
  })

  it('saves a pasted image as a PNG', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    await env.clipboard.write([new env.ClipboardItem({ 'image/png': new Blob([png]) })])
    expect(await clip.inspect()).toEqual({ kind: 'image' })
    const file = await clip.saveImage()
    expect(basename(file)).toMatch(/^screenshot-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.png$/)
    expect(readFileSync(file)).toEqual(png)
  })

  it('ignores stand-ins it no longer watches, and plain text', async () => {
    await env.clipboard.write([
      new env.ClipboardItem({ 'text/uri-list': 'file:///tmp/x', 'electron application/osclipboard;format="LimanClip"': new Blob(['old']) })
    ])
    expect(await clip.inspect()).toEqual({ kind: 'none' })
    await env.clipboard.write([new env.ClipboardItem({ 'text/plain': 'hi' })])
    expect(await clip.inspect()).toEqual({ kind: 'none' })
  })
})
