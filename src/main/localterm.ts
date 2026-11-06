import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import type { LocalShell, SessionStatusEvent } from '@shared/types'

// Terminals on this computer. They talk to the renderer like SSH sessions do
// (ssh:data, ssh:status), so a tab doesn't need to know which kind it shows.

interface Env {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  exists(path: string): boolean
  read(path: string): string
}

const realEnv = (): Env => ({
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8')
})

/** The shells this computer has, the usual one first. */
export function findShells(e: Env = realEnv()): LocalShell[] {
  const shells: LocalShell[] = []
  const add = (path: string | undefined, label: string, args: string[]): void => {
    if (path && e.exists(path) && !shells.some((s) => s.path.toLowerCase() === path.toLowerCase())) shells.push({ path, args, label })
  }
  if (e.platform === 'win32') {
    const root = e.env.SystemRoot ?? 'C:\\Windows'
    const programs = e.env.ProgramFiles ?? 'C:\\Program Files'
    add(`${programs}\\PowerShell\\7\\pwsh.exe`, 'PowerShell 7', ['-NoLogo'])
    add(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, 'Windows PowerShell', ['-NoLogo'])
    add(e.env.ComSpec ?? `${root}\\System32\\cmd.exe`, 'Command Prompt', [])
    add(`${programs}\\Git\\bin\\bash.exe`, 'Git Bash', ['--login', '-i'])
    add(`${root}\\System32\\wsl.exe`, 'WSL', [])
    return shells
  }
  // macOS and Linux: the login shell first, then the others listed in /etc/shells.
  const listed = (() => {
    try {
      return e.read('/etc/shells').split('\n')
    } catch {
      return []
    }
  })()
  const usual = e.env.SHELL || (e.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  for (const line of [usual, ...listed]) {
    const path = line.trim()
    if (!path.startsWith('/')) continue
    // A login shell, like a terminal app opens: the profile sets PATH and the like.
    add(path, path.slice(path.lastIndexOf('/') + 1), ['-l'])
  }
  return shells
}

/** The shell chosen in Settings while this computer has it, otherwise the usual one. */
export function pickShell(chosen: string, shells: LocalShell[]): LocalShell | undefined {
  return shells.find((s) => chosen && s.path.toLowerCase() === chosen.toLowerCase()) ?? shells[0]
}

/** Windows console shells: they read keys, not terminal sequences. */
const CONSOLE_SHELL = /[\\/](powershell|pwsh|cmd)\.exe$/i

/**
 * A key press and release in ConPTY's win32-input-mode: the program gets that
 * very key, as it would in a console window.
 */
function keyEvent(vk: number, scanCode: number, char: number, controlKeys: number): string {
  const event = (down: 0 | 1): string => `\x1b[${vk};${scanCode};${char};${down};${controlKeys};1_`
  return event(1) + event(0)
}
const LEFT_CTRL = 0x08
const ENHANCED_KEY = 0x100

/**
 * What the terminal sends for Ctrl+Backspace / Ctrl+Delete (see TerminalView)
 * means "delete a word" to Unix shells. ConPTY would hand PowerShell or cmd an
 * Alt+Backspace (PowerShell then types ^H) and a plain "d": they get the keys.
 */
export const CONSOLE_KEYS: Record<string, string> = {
  '\x1b\x7f': keyEvent(8, 14, 127, LEFT_CTRL),
  '\x1bd': keyEvent(46, 83, 0, LEFT_CTRL | ENHANCED_KEY)
}

/** Whether a shell is a Windows console program (PowerShell, cmd) rather than a Unix-style one. */
export function readsConsoleKeys(shellPath: string): boolean {
  return CONSOLE_SHELL.test(shellPath)
}

export class LocalTerminals {
  private readonly ptys = new Map<string, IPty>()
  /** Sessions running a Windows console shell. */
  private readonly consoleKeys = new Set<string>()

  constructor(
    private readonly send: (channel: string, ...args: unknown[]) => void,
    /** Settings › Terminal › Local shell. */
    private readonly chosenShell: () => string
  ) {}

  has(sessionId: string): boolean {
    return this.ptys.has(sessionId)
  }

  async open(sessionId: string, cols: number, rows: number): Promise<void> {
    const status = (e: Omit<SessionStatusEvent, 'sessionId'>): void => this.send('ssh:status', { sessionId, ...e })
    const shell = pickShell(this.chosenShell(), findShells())
    if (!shell) return status({ status: 'error', message: 'No shell was found on this computer' })
    try {
      const { spawn } = await import('node-pty')
      const pty = spawn(shell.path, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: homedir(),
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Liman' } as Record<string, string>,
        // Windows: the ConPTY that comes with node-pty. Closing a terminal then needs no
        // helper process; the system one would fork Node, which Liman can't (runAsNode is off).
        useConptyDll: true
      })
      this.ptys.set(sessionId, pty)
      if (process.platform === 'win32' && readsConsoleKeys(shell.path)) this.consoleKeys.add(sessionId)
      status({ status: 'connected' })
      pty.onData((d) => this.send('ssh:data', sessionId, Buffer.from(d, 'utf8')))
      pty.onExit(({ exitCode }) => {
        // Closed by us (tab closed): nobody is waiting to hear.
        if (this.ptys.get(sessionId) !== pty) return
        this.ptys.delete(sessionId)
        this.consoleKeys.delete(sessionId)
        status({ status: 'closed', message: exitCode ? `${shell.label} exited with code ${exitCode}` : `${shell.label} exited` })
      })
    } catch (err) {
      status({ status: 'error', message: `Couldn't start ${shell.label}: ${(err as Error).message}` })
    }
  }

  write(sessionId: string, data: string): void {
    // Only a lone key press is translated, never the same bytes inside a paste.
    const key = this.consoleKeys.has(sessionId) ? CONSOLE_KEYS[data] : undefined
    this.ptys.get(sessionId)?.write(key ?? data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    try {
      this.ptys.get(sessionId)?.resize(cols, rows)
    } catch {
      /* the shell is just exiting */
    }
  }

  close(sessionId: string): void {
    const pty = this.ptys.get(sessionId)
    if (!pty) return
    this.ptys.delete(sessionId)
    this.consoleKeys.delete(sessionId)
    try {
      pty.kill()
    } catch {
      /* already gone */
    }
  }

  closeAll(): void {
    for (const id of [...this.ptys.keys()]) this.close(id)
  }
}
