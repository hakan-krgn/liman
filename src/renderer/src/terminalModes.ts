import type { Terminal } from '@xterm/xterm'

/**
 * Undoes what a program on the old connection switched on and never got to
 * switch off (the connection dropped, or the shell exited under it): mouse
 * reporting would otherwise type "35;44;23M" into the new shell on every mouse
 * move. Also leaves a full-screen program's screen, and soft-resets (DECSTR)
 * the cursor, colours, scroll region and keyboard modes.
 */
export function resetModes(t: Terminal): string {
  const leaveFullScreen = t.buffer.active.type === 'alternate' ? '\x1b[?1049l' : ''
  const mouseOff = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l'
  return leaveFullScreen + mouseOff + '\x1b[?1004l\x1b[?2004l\x1b>\x1b[0 q\x1b[!p'
}
