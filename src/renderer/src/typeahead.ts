import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * Instant typing (predictive local echo, as in Mosh).
 *
 * On a distant server every key only shows up once the server has echoed it
 * back. This shows simple edits (typing, Backspace, Left / Right) at once and
 * then checks them against what the server sends. Predictions are never
 * written into the terminal itself: they are drawn on top of it, so a wrong
 * guess simply disappears and the screen always shows exactly what the server
 * sent.
 *
 * To stay out of the way it only predicts when:
 * - the server has already echoed typing on this command line, so the first
 *   key after Enter waits, and password prompts (no echo) never show anything;
 * - the round trip is long enough to notice;
 * - the normal screen is shown at the bottom (not vim, less, htop, tmux or
 *   programs using the mouse) and the cursor is visible.
 */

/** Below this round trip (ms) typing feels instant anyway. */
const SHOW_FROM = 30
/** After a key we can't predict, wait at least this long (ms) before predicting again. */
const QUIET = 150

type Op = 'back' | 'left' | 'right' | { ch: string }

/** The cursor's row: one string per cell ('' for the right half of a wide character). */
interface Line {
  /** Buffer row. */
  y: number
  cells: string[]
  x: number
}

/** What to draw on top of the terminal. */
export interface Prediction {
  /** Viewport row. */
  y: number
  /** Cells to paint over (including the real cursor's cell, which hides it). */
  cells: { x: number; ch: string }[]
  cursorX: number
}

export class TypeAhead {
  private enabled = true
  /** Keys sent but not yet echoed, with when they were sent. */
  private ops: { op: Op; at: number }[] = []
  /** states[0] is the line as the server last showed it; states[i] after ops[0..i). */
  private states: Line[] = []
  /** A key we couldn't predict came after the pending ones: add nothing until they're settled. */
  private sealed = false
  private blockedUntil = 0
  /** The server echoes typing on this command line. */
  private echoes = false
  /** Where typing started on this line: Backspace / Left never predict past it into the prompt. */
  private editStart: { y: number; x: number } | null = null
  /** Smoothed round trip, ms. */
  private rtt = 0
  private cursorHidden = false
  private shown: Prediction | null = null
  private expiry: ReturnType<typeof setTimeout> | undefined
  private readonly subs: IDisposable[]

  constructor(
    private readonly t: Terminal,
    private readonly draw: (p: Prediction | null) => void,
    private readonly now: () => number = () => performance.now()
  ) {
    const cursorMode = (show: boolean) => (params: (number | number[])[]) => {
      if (params.includes(25)) this.cursorHidden = !show
      return false
    }
    this.subs = [
      t.onWriteParsed(() => this.check()),
      t.parser.registerCsiHandler({ prefix: '?', final: 'h' }, cursorMode(true)),
      t.parser.registerCsiHandler({ prefix: '?', final: 'l' }, cursorMode(false)),
      t.onResize(() => this.reset()),
      t.buffer.onBufferChange(() => this.reset()),
      t.onScroll(() => this.render())
    ]
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.render()
  }

  dispose(): void {
    clearTimeout(this.expiry)
    for (const s of this.subs) s.dispose()
    this.draw(null)
  }

  /** Every key the user sends, before it goes to the server. */
  input(data: string): void {
    const at = this.now()
    const op = toOp(data)
    if (!op || this.sealed || at < this.blockedUntil) return this.untracked(data, at)
    let from = this.states[this.states.length - 1]
    if (!from) {
      const real = this.read()
      if (!real) return this.untracked(data, at)
      if (this.editStart?.y !== real.y) this.editStart = { y: real.y, x: real.x }
      from = real
      this.states = [real]
    }
    const next = this.apply(from, op)
    if (!next) {
      if (!this.ops.length) this.states = []
      return this.untracked(data, at)
    }
    this.ops.push({ op, at })
    this.states.push(next)
    this.armExpiry()
    this.render()
  }

  private untracked(data: string, at: number): void {
    if (this.ops.length) this.sealed = true
    this.blockedUntil = at + Math.max(QUIET, 2 * this.rtt)
    // A new command line (Enter, Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+Z) has to show it echoes again.
    if (/[\r\n\x03\x04\x0c\x1a]/.test(data)) {
      this.echoes = false
      this.editStart = null
    }
    this.render()
  }

  /** After the terminal took in output from the server: what of our guesses came true? */
  private check(): void {
    if (this.ops.length) {
      const real = this.read()
      let k = -1
      if (real) for (let i = this.states.length - 1; i >= 0 && k < 0; i--) if (same(this.states[i], real)) k = i
      if (k < 0) {
        // Something else happened: drop every guess and wait for the next echo.
        this.clear()
        this.echoes = false
      } else if (k > 0) {
        const ms = this.now() - this.ops[k - 1].at
        this.rtt = this.rtt ? this.rtt * 0.7 + ms * 0.3 : ms
        this.echoes = true
        this.ops.splice(0, k)
        this.states.splice(0, k)
        if (!this.ops.length) this.clear()
        else this.armExpiry()
      }
    }
    this.render()
  }

  /** Forgets everything about the current line (e.g. on a new connection). */
  reset(): void {
    this.clear()
    this.echoes = false
    this.editStart = null
    this.render()
  }

  private clear(): void {
    this.ops = []
    this.states = []
    this.sealed = false
    clearTimeout(this.expiry)
  }

  /** Guesses the server never confirms (it stopped echoing) are dropped. */
  private armExpiry(): void {
    clearTimeout(this.expiry)
    const limit = Math.max(1000, 4 * this.rtt)
    this.expiry = setTimeout(() => {
      if (!this.ops.length) return
      this.clear()
      this.echoes = false
      this.render()
    }, limit)
  }

  /** The cursor's row as the terminal shows it, or null when predicting makes no sense. */
  private read(): Line | null {
    const b = this.t.buffer.active
    if (b.type !== 'normal' || this.t.modes.mouseTrackingMode !== 'none' || this.cursorHidden) return null
    const y = b.baseY + b.cursorY
    const line = b.getLine(y)
    if (!line) return null
    const cells: string[] = []
    for (let x = 0; x < this.t.cols; x++) {
      const c = line.getCell(x)
      if (!c) return null
      cells.push(c.getWidth() === 0 ? '' : c.getChars() || ' ')
    }
    return { y, cells, x: b.cursorX }
  }

  /** The line after a key, as a shell's line editor shows it; null if unsure. */
  private apply(s: Line, op: Op): Line | null {
    const { cells, x } = s
    const cols = cells.length
    // Wide characters at or after the cursor would make the cell maths wrong.
    if (x >= cols - 1 || cells.slice(Math.max(0, x - 1)).some((c) => c === '' || c.length > 1)) return null
    const atEnd = cells.slice(x).every((c) => c === ' ')
    const start = this.editStart?.y === s.y ? this.editStart.x : cols
    if (op === 'left') return x > start ? { ...s, x: x - 1 } : null
    if (op === 'right') return atEnd ? null : { ...s, x: x + 1 }
    if (op === 'back') {
      if (x <= start) return null
      return { ...s, cells: [...cells.slice(0, x - 1), ...cells.slice(x), ' '], x: x - 1 }
    }
    if (atEnd) return { ...s, cells: cells.map((c, i) => (i === x ? op.ch : c)), x: x + 1 }
    // Typing in the middle pushes the rest right; it must not reach the edge.
    if (cells[cols - 1] !== ' ' || cells[cols - 2] !== ' ') return null
    return { ...s, cells: [...cells.slice(0, x), op.ch, ...cells.slice(x, cols - 1)], x: x + 1 }
  }

  private render(): void {
    let p: Prediction | null = null
    const b = this.t.buffer.active
    const last = this.states[this.states.length - 1]
    if (this.enabled && this.echoes && this.rtt >= SHOW_FROM && this.ops.length && b.viewportY === b.baseY) {
      const real = this.read()
      if (real && real.y === last.y) {
        const cells: Prediction['cells'] = []
        for (let x = 0; x < real.cells.length; x++) {
          if (last.cells[x] !== real.cells[x] || x === real.x) cells.push({ x, ch: last.cells[x] })
        }
        p = { y: last.y - b.viewportY, cells, cursorX: last.x }
      }
    }
    if (JSON.stringify(p) === JSON.stringify(this.shown)) return
    this.shown = p
    this.draw(p)
  }
}

/** The edit a key makes, if it's one we can predict. */
function toOp(d: string): Op | null {
  if (d === '\x7f' || d === '\b') return 'back'
  if (d === '\x1b[D' || d === '\x1bOD') return 'left'
  if (d === '\x1b[C' || d === '\x1bOC') return 'right'
  // A single one-cell character: ASCII and Latin letters such as ç, ğ, ş, é.
  if (d.length === 1 && ((d >= ' ' && d <= '~') || (d >= '\xa0' && d <= 'ɏ'))) return { ch: d }
  return null
}

const same = (a: Line, b: Line): boolean => a.y === b.y && a.x === b.x && a.cells.every((c, i) => c === b.cells[i])
