import { Terminal as Headless } from '@xterm/headless'
import type { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { resetModes } from '../../src/renderer/src/terminalModes'

async function term() {
  const t = new Headless({ cols: 40, rows: 6, allowProposedApi: true })
  const write = (s: string): Promise<void> => new Promise((r) => t.write(s, r))
  const sent: string[] = []
  t.onData((d) => sent.push(d))
  return { t, write, sent, reset: () => write(resetModes(t as unknown as Terminal)) }
}

describe('resetting a terminal for a new connection', () => {
  it('turns off what a program left on', async () => {
    const s = await term()
    await s.write('$ tmux\r\n')
    // A program switches on mouse reporting (SGR), focus events, bracketed paste and
    // application cursor keys, hides the cursor, sets a scroll region... then the connection drops.
    await s.write('\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?1h\x1b[?25l\x1b[2;4r')
    expect(s.t.modes.mouseTrackingMode).toBe('any')
    await s.reset()
    expect(s.t.modes).toMatchObject({
      mouseTrackingMode: 'none',
      sendFocusMode: false,
      bracketedPasteMode: false,
      applicationCursorKeysMode: false
    })
    // Arrow keys are plain again.
    s.t.input('\x1b[A')
    expect(s.sent.at(-1)).toBe('\x1b[A')
  })

  it('leaves a full-screen program and keeps the shell output in place', async () => {
    const s = await term()
    await s.write('$ vim\r\n')
    await s.write('\x1b[?1049h\x1b[2J\x1b[Hvim screen')
    expect(s.t.buffer.active.type).toBe('alternate')
    await s.reset()
    expect(s.t.buffer.active.type).toBe('normal')
    expect(s.t.buffer.active.getLine(0)!.translateToString(true)).toBe('$ vim')
    expect(s.t.buffer.active.cursorY).toBe(1)
  })

  it("doesn't move the cursor on a normal screen", async () => {
    const s = await term()
    await s.write('one\r\ntwo\r\nthree')
    const before = { x: s.t.buffer.active.cursorX, y: s.t.buffer.active.cursorY }
    await s.reset()
    expect({ x: s.t.buffer.active.cursorX, y: s.t.buffer.active.cursorY }).toEqual(before)
  })
})
