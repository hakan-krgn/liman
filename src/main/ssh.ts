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
  helper?: Promise<ClientChannel>
  helperQueue: Promise<unknown>
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
/** Files transferred at the same time within one upload/download. */
const PARALLEL = 8

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

type FileJob = { from: string; to: string; size: number }

/** Natural order: file2 before file10. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

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
    const session: Session = { id: sessionId, client, scan: '', closed: false, helperQueue: Promise.resolve() }
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
      // Send keystrokes immediately instead of letting Nagle batch them.
      client.setNoDelay(true)
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
      // Warm up the channels used for browsing and cwd lookups so the first use is instant.
      this.sftp(session).catch(() => {})
      this.helper(session).catch(() => {})
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

  /**
   * A long-lived `/bin/sh` channel for small helper commands. Opening a fresh
   * exec channel per query costs extra round trips; this one is reused.
   */
  private helper(s: Session): Promise<ClientChannel> {
    if (!s.helper) {
      s.helper = new Promise((resolve, reject) =>
        s.client.exec('/bin/sh', (err, ch) => {
          if (err) {
            s.helper = undefined
            return reject(err)
          }
          ch.stderr.on('data', () => {})
          ch.on('close', () => (s.helper = undefined))
          resolve(ch)
        })
      )
    }
    return s.helper
  }

  /** Runs a POSIX sh snippet on the helper channel, one at a time. */
  private run(s: Session, script: string): Promise<{ code: number; out: string }> {
    const job = s.helperQueue.then(async () => {
      const ch = await this.helper(s)
      const marker = `__liman_${randomUUID().slice(0, 8)}__`
      return new Promise<{ code: number; out: string }>((resolve, reject) => {
        let buf = ''
        const done = (): void => {
          clearTimeout(timer)
          ch.off('data', onData)
          ch.off('close', onClose)
        }
        const onData = (d: Buffer): void => {
          buf += d.toString('utf8')
          const i = buf.indexOf(marker)
          const m = i >= 0 ? buf.slice(i + marker.length).match(/^ (\d+)\n/) : null
          if (!m) return
          done()
          resolve({ code: Number(m[1]), out: buf.slice(0, i) })
        }
        const onClose = (): void => {
          done()
          reject(new Error('Helper channel closed'))
        }
        const timer = setTimeout(() => {
          done()
          ch.close()
          reject(new Error('Helper command timed out'))
        }, 5000)
        ch.on('data', onData)
        ch.on('close', onClose)
        // The subshell keeps `exit` in the script from ending the helper itself.
        ch.write(`(\n${script}\n)\nprintf '\\n${marker} %s\\n' $?\n`)
      })
    })
    s.helperQueue = job.catch(() => {})
    return job
  }

  /** Best-effort current directory of the terminal's shell. */
  async getCwd(sessionId: string): Promise<string> {
    const s = this.get(sessionId)
    if (s.shellPid) {
      try {
        const { code, out } = await this.run(s, cwdScript(s.shellPid))
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

  /** Shared SFTP channel for browsing. Transfers open their own (see `transfer`). */
  private sftp(s: Session): Promise<SFTPWrapper> {
    if (!s.sftp) {
      s.sftp = openSftp(s.client)
      s.sftp.then(
        (sftp) => sftp.on('close', () => (s.sftp = undefined)),
        () => (s.sftp = undefined)
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
    // Absolute paths need no server round trip to resolve.
    const path = dir.startsWith('/')
      ? posix.normalize(dir).replace(/(.)\/+$/, '$1')
      : await promisify<string>((cb) => sftp.realpath(dir, cb))
    const items = await readdirFast(sftp, path)
    const entries = await Promise.all(
      items.map(async (it): Promise<RemoteEntry> => {
        const full = posix.join(path, it.filename)
        const type = it.attrs.mode & S_IFMT
        let isDir = type === S_IFDIR
        const isLink = type === S_IFLNK
        if (isLink) {
          // Follow symlinks so linked folders can be opened.
          isDir = await promisify<{ mode: number }>((cb) => sftp.stat(full, cb))
            .then((st) => (st.mode & S_IFMT) === S_IFDIR)
            .catch(() => false)
        }
        return { name: it.filename, path: full, isDir, isLink, size: it.attrs.size, mtime: it.attrs.mtime }
      })
    )
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || byName.compare(a.name, b.name))
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
    const rm = async (p: string, mode?: number): Promise<void> => {
      mode ??= (await promisify<{ mode: number }>((cb) => sftp.lstat(p, cb))).mode
      if ((mode & S_IFMT) === S_IFDIR) {
        const items = await readdirFast(sftp, p)
        await pool(items, PARALLEL, (it) => rm(posix.join(p, it.filename), it.attrs.mode))
        await promisify<void>((cb) => sftp.rmdir(p, cb))
      } else {
        await promisify<void>((cb) => sftp.unlink(p, cb))
      }
    }
    await Promise.all(paths.map((p) => rm(p)))
  }

  /** Resolves the upload target and reports which top-level names already exist there. */
  async prepareUpload(
    sessionId: string,
    localPaths: string[],
    remoteDir?: string
  ): Promise<{ dir: string; conflicts: string[] }> {
    const s = this.get(sessionId)
    const [dir, sftp] = await Promise.all([remoteDir ?? this.getCwd(sessionId), this.sftp(s)])
    const names = localPaths.map((p) => basename(p))
    const taken = await Promise.all(names.map((n) => exists(sftp, posix.join(dir, n))))
    return { dir, conflicts: names.filter((_, i) => taken[i]) }
  }

  async upload(sessionId: string, localPaths: string[], remoteDir: string, mode: ConflictMode): Promise<void> {
    const s = this.get(sessionId)
    const browse = await this.sftp(s)

    const dirs: string[] = []
    const files: FileJob[] = []
    const walk = async (local: string, remote: string): Promise<void> => {
      const st = await fsp.stat(local)
      if (st.isDirectory()) {
        dirs.push(remote)
        for (const name of await fsp.readdir(local)) await walk(join(local, name), posix.join(remote, name))
      } else if (st.isFile()) {
        files.push({ from: local, to: remote, size: st.size })
      }
    }
    for (const p of localPaths) {
      let name = basename(p)
      if (mode === 'keepBoth') name = await uniqueName(name, (n) => exists(browse, posix.join(remoteDir, n)))
      await walk(p, posix.join(remoteDir, name))
    }

    const label = localPaths.length === 1 ? basename(localPaths[0]) : `${localPaths.length} items`
    await this.transfer(s, 'up', label, remoteDir, files, async (sftp) => {
      // Parents come before children in `dirs`, so creating them in order is safe.
      for (const d of dirs) {
        await promisify<void>((cb) => sftp.mkdir(d, cb)).catch(async (err) => {
          const st = await promisify<{ mode: number }>((cb) => sftp.stat(d, cb)).catch(() => null)
          if (!st || (st.mode & S_IFMT) !== S_IFDIR) throw err
        })
      }
    })
  }

  async download(sessionId: string, remotePaths: string[], localDir = join(homedir(), 'Downloads')): Promise<void> {
    const s = this.get(sessionId)
    const browse = await this.sftp(s)

    const dirs: string[] = []
    const files: FileJob[] = []
    const walk = async (remote: string, local: string, mode: number, size: number): Promise<void> => {
      if ((mode & S_IFMT) === S_IFLNK) {
        const st = await promisify<{ mode: number; size: number }>((cb) => browse.stat(remote, cb))
        mode = st.mode
        size = st.size
      }
      if ((mode & S_IFMT) === S_IFDIR) {
        dirs.push(local)
        const items = await readdirFast(browse, remote)
        await pool(items, PARALLEL, (it) =>
          walk(posix.join(remote, it.filename), join(local, it.filename), it.attrs.mode, it.attrs.size)
        )
      } else {
        files.push({ from: remote, to: local, size })
      }
    }
    const firstLocal: string[] = []
    for (const p of remotePaths) {
      const name = await uniqueName(posix.basename(p), (n) => fsp.access(join(localDir, n)).then(() => true, () => false))
      const st = await promisify<{ mode: number; size: number }>((cb) => browse.stat(p, cb))
      firstLocal.push(join(localDir, name))
      await walk(p, join(localDir, name), st.mode, st.size)
    }

    const label = remotePaths.length === 1 ? posix.basename(remotePaths[0]) : `${remotePaths.length} items`
    const target = remotePaths.length === 1 ? firstLocal[0] : localDir
    await this.transfer(s, 'down', label, target, files, async () => {
      for (const d of dirs) await fsp.mkdir(d, { recursive: true })
    })
  }

  /**
   * Runs a batch of file copies on a dedicated SFTP channel, several files at a
   * time, so cancelling it never disturbs browsing and small files don't queue
   * behind each other one round trip at a time.
   */
  private async transfer(
    s: Session,
    direction: 'up' | 'down',
    label: string,
    target: string,
    files: FileJob[],
    prepare: (sftp: SFTPWrapper) => Promise<void>
  ): Promise<void> {
    const t = this.startTransfer(s.id, direction, label, target, files.reduce((n, f) => n + f.size, 0))
    let sftp: SFTPWrapper | undefined
    try {
      sftp = await openSftp(s.client)
      t.sftp = sftp
      await prepare(sftp)
      let finished = 0
      const inFlight = new Map<FileJob, number>()
      const report = (force = false): void => {
        let n = finished
        for (const v of inFlight.values()) n += v
        this.progress(t, n, force)
      }
      await pool(files, PARALLEL, async (f) => {
        if (t.cancelled) return
        inFlight.set(f, 0)
        const step = (n: number): void => {
          inFlight.set(f, n)
          report()
        }
        await promisify<void>((cb) =>
          direction === 'up' ? sftp!.fastPut(f.from, f.to, { step }, cb) : sftp!.fastGet(f.from, f.to, { step }, cb)
        )
        inFlight.delete(f)
        finished += f.size
        report(true)
      })
      this.finish(t)
    } catch (err) {
      this.finish(t, err as Error)
    } finally {
      sftp?.end()
    }
  }

  cancelTransfer(id: string): void {
    const t = this.transfers.get(id)
    if (!t || t.status !== 'running') return
    t.cancelled = true
    // Closing the transfer's own SFTP channel aborts in-flight fastPut/fastGet calls.
    t.sftp?.end()
  }

  private startTransfer(
    sessionId: string,
    direction: 'up' | 'down',
    label: string,
    target: string,
    total: number
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
      cancelled: false
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

function openSftp(client: Client): Promise<SFTPWrapper> {
  return promisify<SFTPWrapper>((cb) => client.sftp(cb))
}

type DirItem = { filename: string; attrs: { mode: number; size: number; mtime: number } }

/**
 * Like `sftp.readdir(path)`, but keeps several READDIR requests in flight (each
 * returns the next batch of entries) and doesn't wait for the handle to close.
 * Order of batches doesn't matter because callers sort the result.
 */
function readdirFast(sftp: SFTPWrapper, path: string, depth = 4): Promise<DirItem[]> {
  return new Promise((resolve, reject) => {
    sftp.opendir(path, (err, handle) => {
      if (err) return reject(err)
      const all: DirItem[] = []
      let inFlight = 0
      let ended = false
      let failure: Error | undefined
      const settle = (): void => {
        if (inFlight > 0) return
        sftp.close(handle, () => {})
        if (failure) reject(failure)
        else resolve(all)
      }
      const request = (): void => {
        inFlight++
        sftp.readdir(handle, (err, list) => {
          inFlight--
          if (err || !list) {
            ended = true
            if (err && (err as { code?: number }).code !== 1) failure ??= err
          } else {
            all.push(...(list as DirItem[]))
            if (!ended) request()
          }
          if (ended) settle()
        })
      }
      for (let i = 0; i < depth; i++) request()
    })
  })
}

/** Runs `fn` over `items` with at most `limit` running at once. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < items.length) await fn(items[i++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
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
