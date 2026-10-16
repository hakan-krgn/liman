import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The desktop is where the fake drags below drop their stand-ins.
const desktop = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => desktop.path, getFileIcon: async () => ({ isEmpty: () => false }) },
  nativeImage: { createFromDataURL: () => ({}) }
}))

const { DragOut, findStandIns } = await import('../../src/main/dragout')

desktop.path = mkdtempSync(join(tmpdir(), 'liman-desktop-'))
afterAll(() => rmSync(desktop.path, { recursive: true, force: true }))

const entries = [
  { path: '/srv/report.txt', isDir: false },
  { path: '/srv/site', isDir: true }
]

describe('dragging files out', () => {
  it('makes named stand-ins that carry a marker', () => {
    const out = new DragOut(async () => {}, () => {})
    const { files } = out.prepare('s1', entries)
    expect(files.map((f) => basename(f))).toEqual(['report.txt', 'site'])
    expect(readFileSync(files[0], 'utf8')).toContain('liman-stand-in')
    expect(readdirSync(files[1])).toEqual(['.liman-drop'])
    rmSync(dirname(files[0]), { recursive: true, force: true })
  })

  it('finds dropped copies, also when Explorer renamed them', async () => {
    const out = new DragOut(async () => {}, () => {})
    const { files } = out.prepare('s1', entries)
    const marker = readFileSync(files[0], 'utf8')
    const folder = mkdtempSync(join(tmpdir(), 'liman-drop-'))
    // Already taken names, one an unrelated file with the same name.
    writeFileSync(join(folder, 'report.txt'), 'mine')
    cpSync(files[0], join(folder, 'report (2).txt'))
    cpSync(files[1], join(folder, 'site - Copy'), { recursive: true })
    const found = await findStandIns([folder], {
      standIns: files,
      entries,
      marker,
      dir: dirname(files[0])
    })
    expect(found.get(0)).toBe(join(folder, 'report (2).txt'))
    expect(found.get(1)).toBe(join(folder, 'site - Copy'))
    rmSync(folder, { recursive: true, force: true })
    rmSync(dirname(files[0]), { recursive: true, force: true })
  })

  it('downloads exactly where the stand-ins landed, then cleans up', async () => {
    const download = vi.fn(async () => {})
    const out = new DragOut(download, () => {})
    const { token, files } = out.prepare('s1', entries)
    const ended = vi.fn()
    // An OS drag that drops everything onto the desktop.
    const sender = {
      startDrag: ({ files: dragged }: { files: string[] }) => {
        for (const f of dragged) cpSync(f, join(desktop.path, basename(f)), { recursive: true })
      }
    }
    await out.begin(token, sender as never, ended)

    expect(download).toHaveBeenCalledWith(
      's1',
      ['/srv/report.txt', '/srv/site'],
      [join(desktop.path, 'report.txt'), join(desktop.path, 'site')]
    )
    if (process.platform !== 'darwin') expect(ended).toHaveBeenCalled()
    // The folder's marker is gone so the download fills a clean folder, and our temp copies are removed.
    expect(existsSync(join(desktop.path, 'site', '.liman-drop'))).toBe(false)
    expect(existsSync(files[0])).toBe(false)
  })
})
