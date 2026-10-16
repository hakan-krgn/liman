import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The store persists under Electron's userData folder; point it at a temp dir and
// stand in for safeStorage with a reversible fake.
const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test',
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice(4)
  }
}))

const seed = (data: object): void => writeFileSync(join(dir.path, 'liman.json'), JSON.stringify(data))

async function freshStore() {
  vi.resetModules()
  return (await import('../../src/main/store')).store
}

const host = (id: string, name: string, group?: string) => ({
  id,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: 'u',
  authType: 'agent',
  ...(group ? { group } : {})
})
const names = (list: { name: string; group?: string }[]): string[] => list.map((h) => `${h.group ?? '-'}/${h.name}`)

describe('host ordering', () => {
  beforeEach(() => {
    dir.path = mkdtempSync(join(tmpdir(), 'liman-store-'))
  })
  afterAll(() => rmSync(dir.path, { recursive: true, force: true }))

  it('starts older files from the previous sorted look, ungrouped first', async () => {
    seed({ hosts: [host('a', 'web-2', 'Prod'), host('b', 'dev'), host('c', 'stage', 'Beta'), host('d', 'db', 'Prod')] })
    const store = await freshStore()
    expect(names(store.listHosts())).toEqual(['-/dev', 'Beta/stage', 'Prod/db', 'Prod/web-2'])
    expect(JSON.parse(readFileSync(join(dir.path, 'liman.json'), 'utf8')).ordered).toBe(true)
  })

  it('keeps the saved order once migrated', async () => {
    seed({ ordered: true, hosts: [host('a', 'zeta'), host('b', 'alpha')] })
    const store = await freshStore()
    expect(names(store.listHosts())).toEqual(['-/zeta', '-/alpha'])
  })

  it('moves a host before another one in the same group', async () => {
    seed({ ordered: true, hosts: [host('a', 'one', 'G'), host('b', 'two', 'G'), host('c', 'three', 'G')] })
    const store = await freshStore()
    expect(names(store.moveHost('c', 'G', 'a'))).toEqual(['G/three', 'G/one', 'G/two'])
  })

  it('moves a host into another group, at its end', async () => {
    seed({ ordered: true, hosts: [host('a', 'one', 'A'), host('b', 'two', 'B'), host('c', 'three', 'B'), host('d', 'four', 'C')] })
    const store = await freshStore()
    expect(names(store.moveHost('a', 'B', null))).toEqual(['B/two', 'B/three', 'B/one', 'C/four'])
  })

  it('ungroups a host', async () => {
    seed({ ordered: true, hosts: [host('a', 'one', 'A'), host('b', 'two')] })
    const store = await freshStore()
    const list = store.moveHost('a', '  ', null)
    expect(list.find((h) => h.id === 'a')?.group).toBeUndefined()
  })

  it('moves a whole group before another, or to the end', async () => {
    seed({ ordered: true, hosts: [host('a', 'a1', 'A'), host('b', 'b1', 'B'), host('c', 'a2', 'A'), host('d', 'c1', 'C')] })
    const store = await freshStore()
    expect(names(store.moveGroup('C', 'A'))).toEqual(['C/c1', 'A/a1', 'A/a2', 'B/b1'])
    expect(names(store.moveGroup('C', null))).toEqual(['A/a1', 'A/a2', 'B/b1', 'C/c1'])
  })

  it('rejects moving an unknown host', async () => {
    seed({ ordered: true, hosts: [] })
    const store = await freshStore()
    expect(() => store.moveHost('nope', '', null)).toThrow('Host not found')
  })
})

describe('settings', () => {
  beforeEach(() => {
    dir.path = mkdtempSync(join(tmpdir(), 'liman-store-'))
  })

  it('fills new settings in for older files', async () => {
    seed({ settings: { theme: 'dark', fontSize: 15 } })
    const store = await freshStore()
    expect(store.getSettings()).toEqual({ theme: 'dark', fontSize: 15, instantTyping: true, collapsedGroups: [] })
  })

  it('clamps and sanitises what the renderer sends', async () => {
    seed({})
    const store = await freshStore()
    const s = store.setSettings({ fontSize: 400, theme: 'neon' as never, instantTyping: 'no' as never, collapsedGroups: ['Prod', 7 as never] })
    expect(s).toEqual({ theme: 'system', fontSize: 32, instantTyping: true, collapsedGroups: ['Prod'] })
    expect(store.setSettings({ instantTyping: false }).instantTyping).toBe(false)
  })
})
