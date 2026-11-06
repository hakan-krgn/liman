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

export class LocalTerminals {
  private readonly ptys = new Map<string, IPty>()

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
      status({ status: 'connected' })
      pty.onData((d) => this.send('ssh:data', sessionId, Buffer.from(d, 'utf8')))
      pty.onExit(({ exitCode }) => {
        // Closed by us (tab closed): nobody is waiting to hear.
        if (this.ptys.get(sessionId) !== pty) return
        this.ptys.delete(sessionId)
        status({ status: 'closed', message: exitCode ? `${shell.label} exited with code ${exitCode}` : `${shell.label} exited` })
      })
    } catch (err) {
      status({ status: 'error', message: `Couldn't start ${shell.label}: ${(err as Error).message}` })
    }
  }

  write(sessionId: string, data: string): void {
    this.ptys.get(sessionId)?.write(data)
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
