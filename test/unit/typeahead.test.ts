import { Terminal as Headless } from '@xterm/headless'
import type { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { TypeAhead, type Prediction } from '../../src/renderer/src/typeahead'

/** A headless terminal with a shell-like prompt and a clock we move by hand. */
async function setup(rtt = 50) {
  const t = new Headless({ cols: 40, rows: 6, allowProposedApi: true })
  let clock = 0
  const drawn: (Prediction | null)[] = []
  const ta = new TypeAhead(t as unknown as Terminal, (p) => drawn.push(p), () => clock)
  const write = (s: string): Promise<void> => new Promise((r) => t.write(s, r))
  /** The server echoes `echo` after one round trip. */
  const key = async (data: string, echo?: string): Promise<Prediction | null> => {
    ta.input(data)
    const shown = drawn.at(-1) ?? null
    clock += rtt
    if (echo !== undefined) await write(echo)
    clock += 20
    return shown
  }
  const text = (p: Prediction | null): string => (p ? p.cells.map((c) => c.ch).join('') : '')
  const last = (): Prediction | null => drawn.at(-1) ?? null
  await write('$ ')
  return { t, ta, key, write, text, last, drawn }
}

describe('instant typing', () => {
  it('waits for the first echo on a line, then shows keys before the server does', async () => {
    const s = await setup()
    // The first key only proves the server echoes.
    expect(await s.key('l', 'l')).toBeNull()
    // Now keys show at once: the new letter, with the cursor after it.
    const p = await s.key('s')
    expect(p).toMatchObject({ y: 0, cursorX: 4 })
    expect(p!.cells).toContainEqual({ x: 3, ch: 's' })
    // The echo arrives and matches: nothing is left to draw.
    await s.write('s')
    expect(s.last()).toBeNull()

    // Backspace is predicted too (bash erases with "\b\x1b[K").
    const back = await s.key('\x7f')
    expect(back).toMatchObject({ cursorX: 3 })
    expect(back!.cells).toContainEqual({ x: 3, ch: ' ' })
    await s.write('\b\x1b[K')
    expect(s.last()).toBeNull()
  })

  it('never predicts into the prompt', async () => {
    const s = await setup()
    await s.key('a', 'a')
    await s.key('b', 'b')
    expect(await s.key('\x7f', '\b\x1b[K')).not.toBeNull()
    expect(await s.key('\x7f', '\b\x1b[K')).not.toBeNull()
    // The cursor is back where typing started: the prompt stays.
    expect(await s.key('\x7f')).toBeNull()
    expect(await s.key('\x1b[D')).toBeNull()
  })

  it('drops a wrong guess and waits for a fresh echo', async () => {
    const s = await setup()
    await s.key('a', 'a')
    expect(s.text(await s.key('b'))).toContain('b')
    // The server shows something else.
    await s.write('X')
    expect(s.last()).toBeNull()
    // Not trusted any more until it echoes again.
    expect(await s.key('c', 'c')).toBeNull()
    expect(await s.key('d')).not.toBeNull()
  })

  it('shows nothing at a password prompt', async () => {
    const s = await setup()
    await s.key('s', 's')
    await s.key('u', 'u')
    await s.key('\r', '\r\n[sudo] password for me: ')
    // No echo here: none of these may appear.
    for (const ch of 'secret') expect(await s.key(ch)).toBeNull()
    expect(s.drawn.filter(Boolean).every((p) => !s.text(p).match(/[secrt]{2}/))).toBe(true)
  })

  it('stays off in full-screen programs and on fast connections', async () => {
    const vim = await setup()
    await vim.key('a', 'a')
    await vim.write('\x1b[?1049h')
    expect(await vim.key('b')).toBeNull()

    const near = await setup(5)
    await near.key('a', 'a')
    expect(await near.key('b')).toBeNull()
  })

  it('follows editing in the middle of a line', async () => {
    const s = await setup()
    for (const ch of 'abc') await s.key(ch, ch)
    // Left twice: the cursor goes back over "c" and "b" (bash echoes "\b").
    expect(await s.key('\x1b[D', '\b')).toMatchObject({ cursorX: 4 })
    expect(await s.key('\x1b[D', '\b')).toMatchObject({ cursorX: 3 })
    // Typing there pushes the rest right; bash redraws the tail and steps back.
    const p = await s.key('X')
    expect(p).toMatchObject({ cursorX: 4 })
    expect(p!.cells.map((c) => c.ch).join('')).toBe('Xbc')
    await s.write('Xbc\b\b')
    expect(s.last()).toBeNull()
    expect(s.t.buffer.active.getLine(0)!.translateToString(true)).toBe('$ aXbc')
  })

  it('can be switched off', async () => {
    const s = await setup()
    s.ta.setEnabled(false)
    await s.key('a', 'a')
    expect(await s.key('b')).toBeNull()
  })
})
