import { describe, expect, it } from 'vitest'
import type { SessionStatusEvent } from '@shared/types'
import { findShells, LocalTerminals } from '../../src/main/localterm'

// node-pty ships prebuilt binaries for Windows and macOS only (what Liman is built for).
describe.skipIf(process.platform === 'linux')('local terminals', () => {
  const run = () => {
    const out = new Map<string, string>()
    const statuses: SessionStatusEvent[] = []
    const terms = new LocalTerminals(
      (channel, ...args) => {
        if (channel === 'ssh:data') out.set(args[0] as string, (out.get(args[0] as string) ?? '') + Buffer.from(args[1] as Uint8Array).toString('utf8'))
        if (channel === 'ssh:status') statuses.push(args[0] as SessionStatusEvent)
      },
      () => ''
    )
    const waitFor = async (pred: () => boolean, ms = 15_000): Promise<boolean> => {
      for (let t = 0; t < ms && !pred(); t += 100) await new Promise((r) => setTimeout(r, 100))
      return pred()
    }
    // Colours and cursor moves out of the way.
    const text = (id: string): string => (out.get(id) ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '')
    return { terms, statuses, waitFor, text }
  }

  it('runs the usual shell, types into it, and resizes it', async () => {
    const { terms, statuses, waitFor, text } = run()
    await terms.open('a', 100, 30)
    expect(statuses.at(-1)).toEqual({ sessionId: 'a', status: 'connected' })
    expect(terms.has('a')).toBe(true)
    // Arithmetic, so the answer can't be the echo of what was typed.
    terms.write('a', 'echo liman-$((6*7))\r')
    if (process.platform === 'win32') terms.write('a', 'echo liman-$(6*7)\r')
    expect(await waitFor(() => text('a').includes('liman-42')), text('a').slice(-400)).toBe(true)
    terms.resize('a', 120, 40)
    terms.close('a')
    expect(terms.has('a')).toBe(false)
  })

  it.runIf(process.platform === 'win32')('deletes words in PowerShell with Ctrl+Backspace and Ctrl+Delete', async () => {
    const { terms, waitFor, text } = run()
    await terms.open('c', 120, 30)
    // What TerminalView sends for Ctrl+Backspace, at the end of the line.
    terms.write('c', 'echo aaa-bbb ccc-ddd')
    terms.write('c', '\x1b\x7f')
    terms.write('c', '\r')
    // PowerShell's echo prints each word on a line: "ddd" is gone, the rest stays.
    expect(await waitFor(() => /\r?\nccc-\r?\n/.test(text('c'))), text('c').slice(-300)).toBe(true)
    expect(text('c')).not.toContain('^H')
    // What it sends for Ctrl+Delete, with the cursor before "xxx" (Home, then Right x5).
    terms.write('c', 'echo xxx.yyy')
    terms.write('c', '\x1b[H' + '\x1b[C'.repeat(5))
    terms.write('c', '\x1bd')
    terms.write('c', '\r')
    expect(await waitFor(() => /\r?\n\.?yyy\r?\n/.test(text('c'))), text('c').slice(-300)).toBe(true)
    terms.close('c')
  })

  it('reports a shell that exits by itself', async () => {
    const { terms, statuses, waitFor } = run()
    await terms.open('b', 80, 24)
    terms.write('b', 'exit\r')
    expect(await waitFor(() => statuses.some((s) => s.sessionId === 'b' && s.status === 'closed'))).toBe(true)
    expect(statuses.at(-1)!.message).toMatch(new RegExp(`${findShells()[0].label} exited`))
    expect(terms.has('b')).toBe(false)
  })
})
