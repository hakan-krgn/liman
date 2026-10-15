import { Client, utils, type ClientChannel, type SFTPWrapper } from 'ssh2'
import type { AnyAuthMethod, KeyboardInteractiveAuthMethod, NextAuthHandler } from 'ssh2'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, posix } from 'node:path'
import { store } from './store'
import type {
  ConflictMode,
  PromptRequest,
  PromptResponse,
  RemoteEntry,
  SessionStatusEvent,
  Transfer
} from '@shared/types'

type KbdPrompt = KeyboardInteractiveAuthMethod['prompt']

export interface Bridge {
  send(channel: string, ...args: unknown[]): void
  ask(req: PromptRequest): Promise<PromptResponse>
}

interface Session {
  id: string
  client: Client
  stream?: ClientChannel
  sftp?: Promise<SFTPWrapper>
  /** PID of the interactive shell on the remote host (when it could be determined). */
  shellPid?: number
  /** Last directory reported by the shell through OSC 7, if the shell emits it. */
  osc7Cwd?: string
  scan: string
  closed: boolean
}

interface ActiveTransfer extends Transfer {
  cancelled: boolean
  sftp?: SFTPWrapper
}

const CONNECT_TIMEOUT = 20_000

/**
 * Starts the user's login shell through /bin/sh so we learn its PID first.
 * Knowing the PID lets us ask the server for the shell's live working directory
 * without typing anything into the user's terminal.
 */
const SHELL_BOOTSTRAP = `exec /bin/sh -c 'printf "\\033]1337;LimanPid=%s\\007" $$; exec "\${SHELL:-/bin/sh}" -l'`

/**
 * Prints the working directory of the terminal's foreground process (so a nested
 * shell or `cd` inside it is respected), falling back to the login shell itself.
 * Linux uses /proc, macOS/BSD use ps + lsof.
 */
const cwdScript = (pid: number): string => `
p=${pid}
t=$(sed 's/.*) //' /proc/$p/stat 2>/dev/null | cut -d' ' -f6)
[ -z "$t" ] && t=$(ps -o tpgid= -p $p 2>/dev/null | tr -d ' ')
for x in $t $p; do
  d=$(readlink /proc/$x/cwd 2>/dev/null)
  [ -z "$d" ] && d=$(lsof -a -p $x -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  [ -n "$d" ] && { printf '%s\\n' "$d"; exit 0; }
done
exit 1
`

export class SessionManager {
  private sessions = new Map<string, Session>()
  private transfers = new Map<string, ActiveTransfer>()

  constructor(private bridge: Bridge) {}

  // ---------------------------------------------------------------- terminal

  connect(sessionId: string, hostId: string, cols: number, rows: number): void {
    const host = store.getHostSecrets(hostId)
    if (!host) return this.status({ sessionId, status: 'error', message: 'Host not found' })

    const client = new Client()
    const session: Session = { id: sessionId, client, scan: '', closed: false }
    this.sessions.set(sessionId, session)
    this.status({ sessionId, status: 'connecting' })

    // Our own connect timer: paused while the user is answering a prompt.
    let timer: NodeJS.Timeout | undefined
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        this.status({ sessionId, status: 'error', message: 'Connection timed out' })
        client.end()
      }, CONNECT_TIMEOUT)
    }
    const ask = async (req: PromptRequest): Promise<PromptResponse> => {
      clearTimeout(timer)
      try {
        return await this.bridge.ask(req)
      } finally {
        if (!session.closed) arm()
      }
    }
    const hostLabel = host.port === 22 ? host.host : `[${host.host}]:${host.port}`
    let failed = false

    const kbdInteractive: KbdPrompt = (name, instructions, _lang, prompts, finish) => {
      if (prompts.length === 0) return finish([])
      ask({ kind: 'auth', host: hostLabel, title: name || 'Authentication', instructions, prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })) }).then(
        (answers) => finish(Array.isArray(answers) ? answers : [])
      )
    }

    client.on('banner', (msg) => this.bridge.send('ssh:data', sessionId, Buffer.from(msg.replace(/\r?\n/g, '\r\n'))))
    client.on('ready', () => {
      clearTimeout(timer)
      this.openShell(session, cols, rows)
    })
    client.on('error', (err: Error & { level?: string }) => {
      failed = true
      clearTimeout(timer)
      const message =
        err.level === 'client-authentication'
          ? 'Authentication failed'
          : err.message.replace(/^connect /, '')
      this.status({ sessionId, status: 'error', message })
    })
    client.on('close', () => {
      clearTimeout(timer)
      session.closed = true
      this.sessions.delete(sessionId)
      if (!failed) this.status({ sessionId, status: 'closed' })
    })

    arm()
    client.connect({
      host: host.host,
      port: host.port,
      username: host.username,
      readyTimeout: 0,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
        const keyType = key.subarray(4, 4 + key.readUInt32BE(0)).toString()
        const value = `${keyType} ${fingerprint}`
        const known = store.getKnownHost(hostLabel)
        if (known === value) return verify(true)
        ask({ kind: 'hostkey', host: hostLabel, fingerprint, keyType, previous: known }).then((ok) => {
          if (ok === true) store.setKnownHost(hostLabel, value)
          else failed = true
          if (ok !== true) this.status({ sessionId, status: 'error', message: 'Host key was not accepted' })
          verify(ok === true)
        })
      },
      authHandler: this.authHandler(host, ask, kbdInteractive)
    })
  }

  private authHandler(
    host: NonNullable<ReturnType<typeof store.getHostSecrets>>,
    ask: (req: PromptRequest) => Promise<PromptResponse>,
    kbdInteractive: KbdPrompt
  ) {
    const { username } = host
    const hostLabel = `${username}@${host.host}`
    type Step = () => Promise<AnyAuthMethod | null | 'abort'>
    const steps: Step[] = []

    if (host.authType === 'password' && host.password) {
      steps.push(async () => ({ type: 'password', username, password: host.password! }))
    }
    if (host.authType === 'key') {
      steps.push(async () => {
        const path = host.keyPath ? expandHome(host.keyPath) : await findDefaultKey()
        if (!path) return null
        const key = await fsp.readFile(path)
        let passphrase = host.passphrase
        if (utils.parseKey(key, passphrase) instanceof Error) {
          const res = await ask({
            kind: 'auth',
            host: hostLabel,
            title: 'Key passphrase',
            instructions: basename(path),
            prompts: [{ prompt: 'Passphrase', echo: false }]
          })
          if (!Array.isArray(res)) return 'abort'
          passphrase = res[0]
        }
        return { type: 'publickey', username, key, passphrase }
      })
    }
    if (host.authType === 'agent') {
      const agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK
      if (agent) steps.push(async () => ({ type: 'agent', username, agent }))
    }
    steps.push(async () => ({ type: 'keyboard-interactive', username, prompt: kbdInteractive }))
    // Last resort: ask for a password (twice at most).
    for (let i = 0; i < 2; i++) {
      steps.push(async () => {
        const res = await ask({
          kind: 'auth',
          host: hostLabel,
          title: i === 0 ? 'Password' : 'Wrong password, try again',
          prompts: [{ prompt: 'Password', echo: false }]
        })
        return Array.isArray(res) ? { type: 'password', username, password: res[0] } : 'abort'
      })
    }

    const methodOf = (a: AnyAuthMethod): string => (a.type === 'agent' ? 'publickey' : a.type)

    // ssh2 accepts `false` to stop authenticating, but its typings do not say so.
    const giveUp = false as unknown as AnyAuthMethod

    return (authsLeft: string[] | null, _partial: boolean | null, next: NextAuthHandler): void => {
      const run = async (): Promise<void> => {
        while (steps.length) {
          const step = steps.shift()!
          const method = await step().catch(() => null)
          // A cancelled prompt aborts the whole login.
          if (method === 'abort') return next(giveUp)
          if (!method) continue
          if (!authsLeft || authsLeft.includes(methodOf(method))) return next(method)
        }
        next(giveUp)
      }
      void run()
    }
  }

  private openShell(session: Session, cols: number, rows: number): void {
    const pty = { term: 'xterm-256color', cols, rows }
    const attach = (stream: ClientChannel): void => {
      session.stream = stream
      this.status({ sessionId: session.id, status: 'connected' })
      const onData = (d: Buffer): void => {
        this.inspect(session, d)
        this.bridge.send('ssh:data', session.id, d)
      }
      stream.on('data', onData)
      stream.stderr.on('data', onData)
      stream.on('close', () => session.client.end())
    }
    session.client.exec(SHELL_BOOTSTRAP, { pty }, (err, stream) => {
      if (!err) return attach(stream)
      // Restricted servers may refuse exec; fall back to a plain shell.
      session.client.shell(pty, (err2, stream2) => {
        if (err2) {
          this.status({ sessionId: session.id, status: 'error', message: err2.message })
          session.client.end()
        } else attach(stream2)
      })
    })
  }

  /** Watches terminal output for our PID marker and OSC 7 (cwd) sequences. */
  private inspect(session: Session, chunk: Buffer): void {
    const text = session.scan + chunk.toString('latin1')
    session.scan = ''
    if (!text.includes('\x1b]')) return
    if (!session.shellPid) {
      const m = text.match(/\x1b\]1337;LimanPid=(\d+)\x07/)
      if (m) session.shellPid = Number(m[1])
    }
    for (const m of text.matchAll(/\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      try {
        session.osc7Cwd = Buffer.from(decodeURIComponent(m[1]), 'latin1').toString('utf8')
      } catch {
        /* ignore malformed */
      }
    }
    // Keep an unterminated sequence around in case it is split across chunks.
    const tail = text.slice(text.lastIndexOf('\x1b]'))
    if (!/\x07|\x1b\\/.test(tail) && tail.length < 1024) session.scan = tail
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.stream?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0)
  }

  disconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) s.client.end()
  }

  disconnectAll(): void {
    for (const s of this.sessions.values()) s.client.end()
  }

  private status(e: SessionStatusEvent): void {
    this.bridge.send('ssh:status', e)
  }

  private get(sessionId: string): Session {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('Session is not connected')
    return s
  }

  // --------------------------------------------------------------- cwd / exec

  private exec(session: Session, command: string, stdin?: string): Promise<{ code: number; out: string }> {
    return new Promise((resolve, reject) => {
      session.client.exec(command, (err, ch) => {
        if (err) return reject(err)
        let out = ''
        const t = setTimeout(() => ch.close(), 5000)
        ch.on('data', (d: Buffer) => (out += d.toString('utf8')))
        ch.stderr.on('data', () => {})
        ch.on('close', (code: number) => {
          clearTimeout(t)
          resolve({ code: code ?? -1, out })
        })
        if (stdin !== undefined) ch.end(stdin)
      })
    })
  }

  /** Best-effort current directory of the terminal's shell. */
  async getCwd(sessionId: string): Promise<string> {
    const s = this.get(sessionId)
    if (s.shellPid) {
      try {
        const { code, out } = await this.exec(s, '/bin/sh -s', cwdScript(s.shellPid))
        const dir = out.trim().split('\n')[0]
        if (code === 0 && dir.startsWith('/')) return dir
      } catch {
        /* fall through */
      }
    }
    if (s.osc7Cwd) return s.osc7Cwd
    return this.realpath(sessionId, '.')
  }

  // -------------------------------------------------------------------- sftp

  private sftp(s: Session): Promise<SFTPWrapper> {
    if (!s.sftp) {
      s.sftp = new Promise((resolve, reject) =>
        s.client.sftp((err, sftp) => {
          if (err) {
            s.sftp = undefined
            return reject(err)
          }
          sftp.on('close', () => (s.sftp = undefined))
          resolve(sftp)
        })
      )
    }
    return s.sftp
  }

  async realpath(sessionId: string, path: string): Promise<string> {
    const sftp = await this.sftp(this.get(sessionId))
    return promisify<string>((cb) => sftp.realpath(path, cb))
  }

  async list(sessionId: string, dir: string): Promise<{ path: string; entries: RemoteEntry[] }> {
    const sftp = await this.sftp(this.get(sessionId))
    const path = await promisify<string>((cb) => sftp.realpath(dir, cb))
    const items = await promisify<{ filename: string; attrs: { mode: number; size: number; mtime: number } }[]>(
      (cb) => sftp.readdir(path, cb)
    )
    const entries = await Promise.all(
      items.map(async (it): Promise<RemoteEntry> => {
        const full = posix.join(path, it.filename)
        const type = it.attrs.mode & 0o170000
        let isDir = type === 0o040000
        const isLink = type === 0o120000
        if (isLink) {
          // Follow symlinks so linked folders can be opened.
          isDir = await promisify<{ mode: number }>((cb) => sftp.stat(full, cb))
            .then((st) => (st.mode & 0o170000) === 0o040000)
            .catch(() => false)
        }
        return { name: it.filename, path: full, isDir, isLink, size: it.attrs.size, mtime: it.attrs.mtime }
      })
    )
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    return { path, entries }
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const sftp = await this.sftp(this.get(sessionId))
    await promisify<void>((cb) => sftp.mkdir(path, cb))
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.sftp(this.get(sessionId))
    await promisify<void>((cb) => sftp.rename(from, to, cb))
  }

  async remove(sessionId: string, paths: string[]): Promise<void> {
    const sftp = await this.sftp(this.get(sessionId))
    const rm = async (p: string): Promise<void> => {
      const st = await promisify<{ mode: number }>((cb) => sftp.lstat(p, cb))
      if ((st.mode & 0o170000) === 0o040000) {
        const items = await promisify<{ filename: string }[]>((cb) => sftp.readdir(p, cb))
        for (const it of items) await rm(posix.join(p, it.filename))
        await promisify<void>((cb) => sftp.rmdir(p, cb))
      } else {
        await promisify<void>((cb) => sftp.unlink(p, cb))
      }
    }
    for (const p of paths) await rm(p)
  }

  /** Resolves the upload target and reports which top-level names already exist there. */
  async prepareUpload(
    sessionId: string,
    localPaths: string[],
    remoteDir?: string
  ): Promise<{ dir: string; conflicts: string[] }> {
    const s = this.get(sessionId)
    const dir = remoteDir ?? (await this.getCwd(sessionId))
    const sftp = await this.sftp(s)
    const conflicts: string[] = []
    for (const p of localPaths) {
      const name = basename(p)
      if (await exists(sftp, posix.join(dir, name))) conflicts.push(name)
    }
    return { dir, conflicts }
  }

  async upload(sessionId: string, localPaths: string[], remoteDir: string, mode: ConflictMode): Promise<void> {
    const s = this.get(sessionId)
    const sftp = await this.sftp(s)

    type Item = { local: string; remote: string; isDir: boolean; size: number }
    const plan: Item[] = []
    const walk = async (local: string, remote: string): Promise<void> => {
      const st = await fsp.stat(local)
      if (st.isDirectory()) {
        plan.push({ local, remote, isDir: true, size: 0 })
        for (const name of await fsp.readdir(local)) await walk(join(local, name), posix.join(remote, name))
      } else if (st.isFile()) {
        plan.push({ local, remote, isDir: false, size: st.size })
      }
    }
    for (const p of localPaths) {
      let name = basename(p)
      if (mode === 'keepBoth') name = await uniqueName(name, (n) => exists(sftp, posix.join(remoteDir, n)))
      await walk(p, posix.join(remoteDir, name))
    }

    const label = localPaths.length === 1 ? basename(localPaths[0]) : `${localPaths.length} items`
    const t = this.startTransfer(sessionId, 'up', label, remoteDir, plan.reduce((n, i) => n + i.size, 0), sftp)
    try {
      for (const item of plan) {
        if (t.cancelled) break
        if (item.isDir) {
          if (!(await exists(sftp, item.remote))) await promisify<void>((cb) => sftp.mkdir(item.remote, cb))
          continue
        }
        const base = t.done
        await promisify<void>((cb) =>
          sftp.fastPut(item.local, item.remote, { step: (sent) => this.progress(t, base + sent) }, cb)
        )
        this.progress(t, base + item.size, true)
      }
      this.finish(t)
    } catch (err) {
      this.finish(t, err as Error)
    }
  }

  async download(sessionId: string, remotePaths: string[], localDir = join(homedir(), 'Downloads')): Promise<void> {
    const sftp = await this.sftp(this.get(sessionId))

    type Item = { remote: string; local: string; isDir: boolean; size: number }
    const plan: Item[] = []
    const walk = async (remote: string, local: string): Promise<void> => {
      const st = await promisify<{ mode: number; size: number }>((cb) => sftp.stat(remote, cb))
      if ((st.mode & 0o170000) === 0o040000) {
        plan.push({ remote, local, isDir: true, size: 0 })
        const items = await promisify<{ filename: string }[]>((cb) => sftp.readdir(remote, cb))
        for (const it of items) await walk(posix.join(remote, it.filename), join(local, it.filename))
      } else {
        plan.push({ remote, local, isDir: false, size: st.size })
      }
    }
    const firstLocal: string[] = []
    for (const p of remotePaths) {
      const name = await uniqueName(posix.basename(p), (n) => fsp.access(join(localDir, n)).then(() => true, () => false))
      firstLocal.push(join(localDir, name))
      await walk(p, join(localDir, name))
    }

    const label = remotePaths.length === 1 ? posix.basename(remotePaths[0]) : `${remotePaths.length} items`
    const target = remotePaths.length === 1 ? firstLocal[0] : localDir
    const t = this.startTransfer(sessionId, 'down', label, target, plan.reduce((n, i) => n + i.size, 0), sftp)
    try {
      for (const item of plan) {
        if (t.cancelled) break
        if (item.isDir) {
          await fsp.mkdir(item.local, { recursive: true })
          continue
        }
        const base = t.done
        await promisify<void>((cb) =>
          sftp.fastGet(item.remote, item.local, { step: (got) => this.progress(t, base + got) }, cb)
        )
        this.progress(t, base + item.size, true)
      }
      this.finish(t)
    } catch (err) {
      this.finish(t, err as Error)
    }
  }

  cancelTransfer(id: string): void {
    const t = this.transfers.get(id)
    if (!t || t.status !== 'running') return
    t.cancelled = true
    // Closing the SFTP channel aborts an in-flight fastPut/fastGet.
    t.sftp?.end()
  }

  private startTransfer(
    sessionId: string,
    direction: 'up' | 'down',
    label: string,
    target: string,
    total: number,
    sftp: SFTPWrapper
  ): ActiveTransfer {
    const t: ActiveTransfer = {
      id: randomUUID(),
      sessionId,
      direction,
      label,
      target,
      total,
      done: 0,
      status: 'running',
      cancelled: false,
      sftp
    }
    this.transfers.set(t.id, t)
    this.emitTransfer(t)
    return t
  }

  private lastEmit = new Map<string, number>()
  private progress(t: ActiveTransfer, done: number, force = false): void {
    t.done = done
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(t.id) ?? 0) < 100) return
    this.lastEmit.set(t.id, now)
    this.emitTransfer(t)
  }

  private finish(t: ActiveTransfer, err?: Error): void {
    t.status = t.cancelled ? 'cancelled' : err ? 'error' : 'done'
    if (err && !t.cancelled) t.error = err.message
    this.emitTransfer(t)
    this.transfers.delete(t.id)
    this.lastEmit.delete(t.id)
  }

  private emitTransfer({ cancelled: _c, sftp: _s, ...t }: ActiveTransfer): void {
    this.bridge.send('transfer:update', t)
  }
}

// ------------------------------------------------------------------- helpers

function promisify<T>(fn: (cb: (err: Error | null | undefined, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))))
}

function exists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => sftp.lstat(path, (err) => resolve(!err)))
}

async function uniqueName(name: string, taken: (n: string) => Promise<boolean>): Promise<string> {
  if (!(await taken(name))) return name
  const ext = name.startsWith('.') && name.indexOf('.', 1) < 0 ? '' : extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!(await taken(candidate))) return candidate
  }
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

async function findDefaultKey(): Promise<string | undefined> {
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const p = join(homedir(), '.ssh', name)
    if (await fsp.access(p).then(() => true, () => false)) return p
  }
  return undefined
}
