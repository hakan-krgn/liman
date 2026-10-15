import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inside, limiter, pool, safeLocalName, uniqueName } from '../../src/main/util'

describe('safeLocalName', () => {
  it('keeps ordinary names', () => {
    expect(safeLocalName('report.pdf', 'linux')).toBe('report.pdf')
    expect(safeLocalName('çiçek dosyası.txt', 'win32')).toBe('çiçek dosyası.txt')
  })

  it('removes path separators and traversal', () => {
    expect(safeLocalName('../../.bashrc', 'linux')).toBe('.._.._.bashrc')
    expect(safeLocalName('..\\..\\Startup\\evil.bat', 'win32')).toBe('.._.._Startup_evil.bat')
    expect(safeLocalName('..', 'linux')).toBe('_')
    expect(safeLocalName('.', 'linux')).toBe('_')
    expect(safeLocalName('', 'linux')).toBe('_')
  })

  it('strips control characters', () => {
    expect(safeLocalName('a\x00b\x1bc', 'linux')).toBe('a_b_c')
  })

  it('neutralises names Windows would reinterpret', () => {
    expect(safeLocalName('file.txt:stream', 'win32')).toBe('file.txt_stream')
    expect(safeLocalName('what?<>|*".txt', 'win32')).toBe('what______.txt')
    expect(safeLocalName('trailing. . ', 'win32')).toBe('trailing')
    expect(safeLocalName('CON', 'win32')).toBe('_CON')
    expect(safeLocalName('nul.txt', 'win32')).toBe('_nul.txt')
    expect(safeLocalName('com1.log', 'win32')).toBe('_com1.log')
    expect(safeLocalName('console.txt', 'win32')).toBe('console.txt')
  })

  it('leaves Windows-only characters alone elsewhere', () => {
    expect(safeLocalName('a:b?.txt', 'darwin')).toBe('a:b?.txt')
  })
})

describe('inside', () => {
  const root = join(sep === '\\' ? 'C:\\' : '/', 'downloads')

  it('joins a safe name', () => {
    expect(inside(root, 'file.txt')).toBe(join(root, 'file.txt'))
    expect(inside(root, '..hidden')).toBe(join(root, '..hidden'))
  })

  it('refuses names that leave the folder', () => {
    expect(() => inside(root, '..')).toThrow(/unsafe/)
    expect(() => inside(root, '../x')).toThrow(/unsafe/)
    expect(() => inside(root, join('..', '..', 'etc', 'passwd'))).toThrow(/unsafe/)
    expect(() => inside(root, '')).toThrow(/unsafe/)
  })
})

describe('uniqueName', () => {
  const takenFrom = (names: string[]) => async (n: string) => names.includes(n)

  it('returns the name when free', async () => {
    expect(await uniqueName('a.txt', takenFrom([]))).toBe('a.txt')
  })

  it('numbers before the extension', async () => {
    expect(await uniqueName('a.txt', takenFrom(['a.txt']))).toBe('a (1).txt')
    expect(await uniqueName('a.txt', takenFrom(['a.txt', 'a (1).txt']))).toBe('a (2).txt')
    expect(await uniqueName('archive.tar.gz', takenFrom(['archive.tar.gz']))).toBe('archive.tar (1).gz')
  })

  it('treats dotfiles and folders as having no extension', async () => {
    expect(await uniqueName('.bashrc', takenFrom(['.bashrc']))).toBe('.bashrc (1)')
    expect(await uniqueName('folder', takenFrom(['folder']))).toBe('folder (1)')
  })
})

describe('limiter and pool', () => {
  const tracker = () => {
    let active = 0
    let peak = 0
    return {
      async run() {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
      },
      get peak() {
        return peak
      }
    }
  }

  it('limiter caps concurrency', async () => {
    const t = tracker()
    const limit = limiter(3)
    await Promise.all(Array.from({ length: 20 }, () => limit(() => t.run())))
    expect(t.peak).toBe(3)
  })

  it('limiter passes results and errors through', async () => {
    const limit = limiter(1)
    expect(await limit(async () => 42)).toBe(42)
    await expect(limit(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await limit(async () => 'still works')).toBe('still works')
  })

  it('pool visits every item with bounded concurrency', async () => {
    const t = tracker()
    const seen: number[] = []
    await pool([...Array(25).keys()], 4, async (i) => {
      seen.push(i)
      await t.run()
    })
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(25).keys()])
    expect(t.peak).toBe(4)
  })

  it('pool handles an empty list', async () => {
    await expect(pool([], 4, async () => {})).resolves.toBeUndefined()
  })
})
