import { Client, utils, type ClientChannel, type SFTPWrapper } from 'ssh2'
import type { AnyAuthMethod, KeyboardInteractiveAuthMethod, NextAuthHandler } from 'ssh2'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { store } from './store'
import { inside, limiter, pool, safeLocalName, uniqueName } from './util'
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
  /** Shows a prompt for a session; resolves with `null` if it is cancelled. */
  ask(sessionId: string, req: PromptRequest): Promise<PromptResponse>
  /** Dismisses any prompt still open for a session that went away. */
  cancelPrompts(sessionId: string): void
  /** Appends a line to the app log (connection drops and the like). */
  log?(line: string): void
}

interface Session {
  id: string
  client: Client
  /** Latest terminal size, also tracked before the shell exists. */
  cols: number
  rows: number
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
  /** The connection is going away (user disconnect or socket ended); open nothing new. */
  ending: boolean
  /** The user closed the session (tab closed, app quit). */
  userClosed?: boolean
  /** The remote shell ended by itself (`exit`, logout). */
  shellExited?: boolean
  connectedAt?: number
  /** How this session logged in, so a second connection for transfers can do the same. */
  login?: LoginInfo
  /** Separate connection for file transfers (null: unavailable, use the main one). */
  transferConn?: Promise<Client | null>
  transferUnavailable?: boolean
  activeTransfers: number
  transferIdle?: NodeJS.Timeout
}

interface LoginInfo {
  host: string
  port: number
  username: string
  hostKey: string
  method: AnyAuthMethod
  kbdAnswers?: string[]
}

interface ActiveTransfer extends Transfer {
  cancelled: boolean
  /** The transfer's own SFTP channels; closing them aborts it. */
  channels: SFTPWrapper[]
}

const CONNECT_TIMEOUT = 20_000
/** The transfer connection is closed after this long without transfers. */
const TRANSFER_IDLE = 120_000
/** How long the bootstrap may take to report its PID before we stop waiting for it. */
const BOOTSTRAP_TIMEOUT = 2_000
/** Files transferred at the same time within one upload/download. */
const PARALLEL = 8
/**
 * 32 KB SFTP requests kept in flight per file. More only fills network queues
 * (and delays terminal echo during downloads) without going faster on most links.
 */
const CHUNKS_IN_FLIGHT = 16

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

type FileJob = { from: string; to: string; size: number; mode?: number }

/** Bytes per SFTP read/write request when copying between two servers. */
const CHUNK = 32 * 1024

/** Natural order: file2 before file10. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Starts the user's login shell through /bin/sh so we learn its PID first.
 * Knowing the PID lets us ask the server for the shell's live working directory
 * without typing anything into the user's terminal.
 */
const SHELL_BOOTSTRAP = `exec /bin/sh -c 'printf "\\033]1337;LimanPid=%s\\007" $$; exec "\${SHELL:-/bin/sh}" -l'`
const PID_MARKER = /\x1b\]1337;LimanPid=(\d+)\x07/

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

type HostSecrets = NonNullable<ReturnType<typeof store.getHostSecrets>>

/** Connection state shared between the event handlers of one `connect()` call. */
interface ConnectState {
  /** First fatal error; reported when the connection closes. */
  fatal?: string
  ready: boolean
  /** The user accepted a host key that differs from the saved one. */
  keyChanged: boolean
  /** The host key this connection was verified with. */
  hostKey?: string
  /** The last auth method offered, i.e. the one that succeeded once 'ready' fires. */
  lastMethod?: AnyAuthMethod
  kbdAnswers?: string[]
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  private transfers = new Map<string, ActiveTransfer>()
  /** Local download targets in use, so two downloads never pick the same name. */
  private reserved = new Set<string>()

  constructor(private bridge: Bridge) {}

  // ---------------------------------------------------------------- terminal

  connect(sessionId: string, hostId: string, cols: number, rows: number): void {
    if (this.sessions.has(sessionId)) return
    const host = store.getHostSecrets(hostId)
    if (!host) return this.status({ sessionId, status: 'error', message: 'Host not found' })

    const client = new Client()
    const session: Session = {
      id: sessionId,
      client,
      cols,
      rows,
      scan: '',
      closed: false,
      ending: false,
      activeTransfers: 0,
      helperQueue: Promise.resolve()
    }
    this.sessions.set(sessionId, session)
    this.status({ sessionId, status: 'connecting' })

    const state: ConnectState = { ready: false, keyChanged: false }
    const fail = (message: string): void => {
      state.fatal ??= message
    }

    // Our own connect timer: paused while the user is answering a prompt.
    let timer: NodeJS.Timeout | undefined
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        fail('Connection timed out')
        client.destroy()
      }, CONNECT_TIMEOUT)
    }
    const ask = async (req: PromptRequest): Promise<PromptResponse> => {
      clearTimeout(timer)
      try {
        return await this.bridge.ask(sessionId, req)
      } finally {
        if (!session.closed && !state.ready) arm()
      }
    }
    const hostLabel = host.port === 22 ? host.host : `[${host.host}]:${host.port}`

    client.on('banner', (msg) => this.bridge.send('ssh:data', sessionId, Buffer.from(msg.replace(/\r?\n/g, '\r\n'))))
    client.on('ready', () => {
      clearTimeout(timer)
      state.ready = true
      session.connectedAt = Date.now()
      if (state.hostKey && state.lastMethod) {
        session.login = {
          host: host.host,
          port: host.port,
          username: host.username,
          hostKey: state.hostKey,
          method: state.lastMethod,
          kbdAnswers: state.kbdAnswers
        }
      }
      // Send keystrokes immediately instead of letting Nagle batch them.
      client.setNoDelay(true)
      this.openShell(session, fail)
    })
    client.on('error', (err: Error & { level?: string }) => {
      // ssh2 also reports problems it recovers from (an agent that isn't running,
      // a key that failed to sign) and then simply tries the next auth method.
      if (err.level === 'agent' || err.message.startsWith('Error while signing')) return
      fail(err.level === 'client-authentication' ? 'Authentication failed' : err.message.replace(/^connect /, ''))
    })
    client.on('end', () => (session.ending = true))
    client.on('close', () => {
      clearTimeout(timer)
      session.ending = true
      session.closed = true
      this.sessions.delete(sessionId)
      clearTimeout(session.transferIdle)
      void session.transferConn?.then((c) => c?.end())
      this.bridge.cancelPrompts(sessionId)
      if (!state.ready) {
        this.bridge.log?.(`${hostLabel}: could not connect: ${state.fatal ?? 'connection closed'}`)
        return this.status({ sessionId, status: 'error', message: state.fatal ?? 'Connection closed' })
      }
      // Neither `exit` nor the user: the network, the server or something in between.
      const lost = !session.shellExited && !session.userClosed
      const minutes = ((Date.now() - (session.connectedAt ?? Date.now())) / 60_000).toFixed(1)
      const why = lost ? `connection lost (${state.fatal ?? 'closed by the server'})` : session.userClosed ? 'closed by the user' : 'shell exited'
      this.bridge.log?.(`${hostLabel}: session ended after ${minutes} min: ${why}`)
      this.status({
        sessionId,
        status: 'closed',
        lost,
        message: lost ? `Connection lost${state.fatal ? `: ${state.fatal}` : ''}` : undefined
      })
    })

    arm()
    try {
      client.connect({
        host: host.host,
        port: host.port,
        username: host.username,
        readyTimeout: 0,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        tryKeyboard: true,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          const value = hostKeyId(key)
          const [keyType, fingerprint] = value.split(' ')
          const known = store.getKnownHost(hostLabel)
          if (known === value) {
            state.hostKey = value
            return verify(true)
          }
          ask({ kind: 'hostkey', host: hostLabel, fingerprint, keyType, previous: known }).then((ok) => {
            if (ok === true) {
              store.setKnownHost(hostLabel, value)
              state.hostKey = value
              state.keyChanged = !!known
            } else {
              fail('Host key was not accepted')
            }
            verify(ok === true)
          })
        },
        authHandler: this.authHandler(host, state, ask, fail)
      })
    } catch (err) {
      // e.g. an invalid port throws synchronously from net.connect
      clearTimeout(timer)
      session.closed = true
      this.sessions.delete(sessionId)
      this.status({ sessionId, status: 'error', message: (err as Error).message })
    }
  }

  private authHandler(
    host: HostSecrets,
    state: ConnectState,
    ask: (req: PromptRequest) => Promise<PromptResponse>,
    fail: (message: string) => void
  ) {
    const { username } = host
    const who = `${username}@${host.host}`
    // A saved password is never sent after the user overrode a changed host key.
    const savedPassword = (): string | undefined => (state.keyChanged ? undefined : host.password)
    let savedPasswordUsedForKbd = false
    /** The user cancelled a server prompt; stop instead of asking for something else. */
    let cancelled = false

    const kbdInteractive: KbdPrompt = (name, instructions, _lang, prompts, finish) => {
      if (prompts.length === 0) return finish([])
      // Answer a lone "Password:" prompt with the saved password once (PAM-only servers).
      const pw = savedPassword()
      if (pw && !savedPasswordUsedForKbd && prompts.length === 1 && !prompts[0].echo && /password/i.test(prompts[0].prompt)) {
        savedPasswordUsedForKbd = true
        state.kbdAnswers = [pw]
        return finish([pw])
      }
      ask({
        kind: 'auth',
        source: 'server',
        host: who,
        title: name,
        instructions,
        prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo }))
      }).then((answers) => {
        if (!Array.isArray(answers)) cancelled = true
        else state.kbdAnswers = answers
        finish(Array.isArray(answers) ? answers : [])
      })
    }

    type Method = 'password' | 'publickey' | 'keyboard-interactive'
    type Step = { method: Method; run: () => Promise<AnyAuthMethod | null | 'abort'> }
    const steps: Step[] = []

    if (host.authType === 'password') {
      steps.push({
        method: 'password',
        run: async () => {
          const password = savedPassword()
          return password ? { type: 'password', username, password } : null
        }
      })
    }
    if (host.authType === 'key') {
      steps.push({
        method: 'publickey',
        run: async () => {
          const path = host.keyPath ? expandHome(host.keyPath) : await findDefaultKey()
          if (!path) return null
          const key = await fsp.readFile(path)
          let passphrase = host.passphrase
          if (utils.parseKey(key, passphrase) instanceof Error) {
            const res = await ask({
              kind: 'auth',
              source: 'app',
              host: who,
              title: 'Unlock SSH key',
              instructions: `${basename(path)} is encrypted. The passphrase stays on this computer.`,
              prompts: [{ prompt: 'Passphrase', echo: false }]
            })
            if (!Array.isArray(res)) return 'abort'
            passphrase = res[0]
          }
          return { type: 'publickey', username, key, passphrase }
        }
      })
    }
    if (host.authType === 'agent') {
      const agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK
      if (agent) steps.push({ method: 'publickey', run: async () => ({ type: 'agent', username, agent }) })
    }
    steps.push({
      method: 'keyboard-interactive',
      run: async () => ({ type: 'keyboard-interactive', username, prompt: kbdInteractive })
    })
    // Last resort: ask for a password (twice at most).
    for (let i = 0; i < 2; i++) {
      steps.push({
        method: 'password',
        run: async () => {
          const res = await ask({
            kind: 'auth',
            source: 'app',
            host: who,
            title: i === 0 ? `Password for ${who}` : 'Wrong password, try again',
            prompts: [{ prompt: 'Password', echo: false }]
          })
          return Array.isArray(res) ? { type: 'password', username, password: res[0] } : 'abort'
        }
      })
    }

    // ssh2 accepts `false` to stop authenticating, but its typings do not say so.
    const giveUp = false as unknown as AnyAuthMethod

    return (authsLeft: string[] | null, _partial: boolean | null, next: NextAuthHandler): void => {
      const run = async (): Promise<void> => {
        while (steps.length && !cancelled) {
          const step = steps.shift()!
          // Skip methods the server no longer accepts *before* prompting for them.
          if (authsLeft && !authsLeft.includes(step.method)) continue
          const method = await step.run().catch(() => null)
          if (method === 'abort') {
            fail('Authentication cancelled')
            return next(giveUp)
          }
          if (method) {
            state.lastMethod = method
            return next(method)
          }
        }
        if (cancelled) fail('Authentication cancelled')
        next(giveUp)
      }
      void run()
    }
  }

  private openShell(session: Session, fail: (message: string) => void): void {
    const pty = (): { term: string; cols: number; rows: number } => ({
      term: 'xterm-256color',
      cols: session.cols,
      rows: session.rows
    })

    const attach = (stream: ClientChannel, bootstrap: boolean): void => {
      session.stream = stream
      this.status({ sessionId: session.id, status: 'connected' })

      // While the bootstrap hasn't reported its PID, output is held back: if the
      // server has no /bin/sh the error text is discarded and a plain shell opened.
      let held: Buffer[] | null = bootstrap ? [] : null
      const release = (): void => {
        clearTimeout(holdTimer)
        if (held?.length) this.bridge.send('ssh:data', session.id, Buffer.concat(held))
        held = null
      }
      const holdTimer = bootstrap ? setTimeout(release, BOOTSTRAP_TIMEOUT) : undefined

      const onData = (d: Buffer): void => {
        if (held) {
          held.push(d)
          const m = Buffer.concat(held).toString('latin1').match(PID_MARKER)
          if (m) {
            // Only the bootstrap's own first output may set the PID.
            session.shellPid = Number(m[1])
            release()
          }
          return
        }
        this.inspect(session, d)
        this.bridge.send('ssh:data', session.id, d)
      }
      stream.on('data', onData)
      stream.stderr.on('data', onData)
      // Only the server reports an exit status; a dropped connection just closes the channel.
      stream.on('exit', () => (session.shellExited = true))
      stream.on('close', () => {
        if (held && !session.ending) {
          clearTimeout(holdTimer)
          held = null
          return openPlain()
        }
        session.client.end()
      })
      // Warm up the channels used for browsing and cwd lookups so the first use is instant.
      this.sftp(session).catch(() => {})
      this.helper(session).catch(() => {})
    }

    // ssh2 throws synchronously once the socket is gone (e.g. the tab was closed
    // while connecting); that must never escape into the main process.
    const openChannel = (kind: 'exec' | 'shell', cb: (err: Error | undefined, stream?: ClientChannel) => void): void => {
      if (session.ending) return
      try {
        if (kind === 'exec') session.client.exec(SHELL_BOOTSTRAP, { pty: pty() }, cb)
        else session.client.shell(pty(), cb)
      } catch {
        // "Not connected": the socket is gone; the client's close event reports it.
        session.ending = true
      }
    }

    const openPlain = (): void =>
      openChannel('shell', (err, stream) => {
        if (session.ending) return
        if (err || !stream) {
          fail(err?.message ?? 'Could not open a shell')
          session.client.end()
        } else attach(stream, false)
      })

    openChannel('exec', (err, stream) => {
      if (session.ending) return
      // Restricted servers may refuse exec outright; fall back to a plain shell.
      if (err || !stream) openPlain()
      else attach(stream, true)
    })
  }

  /** Watches terminal output for OSC 7 (cwd) sequences. */
  private inspect(session: Session, chunk: Buffer): void {
    const text = session.scan + chunk.toString('latin1')
    session.scan = ''
    if (!text.includes('\x1b]')) return
    for (const m of text.matchAll(/\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      try {
        session.osc7Cwd = decodeURIComponent(Buffer.from(m[1], 'latin1').toString('utf8'))
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
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.cols = cols
    s.rows = rows
    s.stream?.setWindow(rows, cols, 0, 0)
  }

  disconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.ending = true
    s.userClosed = true
    s.client.end()
  }

  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
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
        const dir = out.trim().split('\n').pop() ?? ''
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
    // Limit concurrent SFTP requests across the whole tree, not per level.
    const limit = limiter(PARALLEL * 2)
    const rm = async (p: string, mode?: number): Promise<void> => {
      mode ??= (await limit(() => promisify<{ mode: number }>((cb) => sftp.lstat(p, cb)))).mode
      // lstat/readdir modes don't follow symlinks, so a link is unlinked, never descended into.
      if ((mode & S_IFMT) === S_IFDIR) {
        const items = await limit(() => readdirFast(sftp, p))
        await Promise.all(items.map((it) => rm(posix.join(p, it.filename), it.attrs.mode)))
        await limit(() => promisify<void>((cb) => sftp.rmdir(p, cb)))
      } else {
        await limit(() => promisify<void>((cb) => sftp.unlink(p, cb)))
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
      // lstat: symlinks inside a dropped folder are skipped, so a link to ~/.ssh
      // (or a link loop) can't pull unrelated local files onto the server.
      const st = await fsp.lstat(local)
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
      // The dropped item itself may be a shortcut/symlink the user chose explicitly.
      const top = await fsp.stat(p)
      if (top.isFile()) files.push({ from: p, to: posix.join(remoteDir, name), size: top.size })
      else await walk(p, posix.join(remoteDir, name))
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

  /** Downloads into `localDir`; resolves with the local path to reveal when done. */
  async download(sessionId: string, remotePaths: string[], localDir: string): Promise<string | undefined> {
    const s = this.get(sessionId)
    const browse = await this.sftp(s)
    await fsp.mkdir(localDir, { recursive: true })

    const dirs: string[] = []
    const files: FileJob[] = []
    const stat = (p: string): Promise<{ mode: number; size: number }> => promisify((cb) => browse.stat(p, cb))

    // Breadth-first so one shared limit bounds concurrent requests. Symlinked
    // folders below the top level are skipped, which also rules out link loops.
    let level: { remote: string; local: string }[] = []
    const reserved: string[] = []
    const firstLocal: string[] = []
    try {
      for (const p of remotePaths) {
        let local: string
        do {
          const name = await uniqueName(safeLocalName(posix.basename(p)), async (n) => {
            const full = join(localDir, n)
            return this.reserved.has(full) || (await fsp.access(full).then(() => true, () => false))
          })
          local = inside(localDir, name)
          // Re-check synchronously: another download may have taken it while we awaited.
        } while (this.reserved.has(local))
        this.reserved.add(local)
        reserved.push(local)
        firstLocal.push(local)
        const st = await stat(p)
        if ((st.mode & S_IFMT) === S_IFDIR) {
          dirs.push(local)
          level.push({ remote: p, local })
        } else if ((st.mode & S_IFMT) === 0o100000) {
          files.push({ from: p, to: local, size: st.size })
        } else {
          throw new Error(`${posix.basename(p)} is not a regular file`)
        }
      }
      while (level.length) {
        const next: typeof level = []
        await pool(level, PARALLEL, async (d) => {
          for (const it of await readdirFast(browse, d.remote)) {
            const remote = posix.join(d.remote, it.filename)
            // Server-supplied names must never escape the folder being written.
            const local = inside(d.local, safeLocalName(it.filename))
            let { mode, size } = it.attrs
            if ((mode & S_IFMT) === S_IFLNK) {
              const st = await stat(remote).catch(() => null)
              if (!st || (st.mode & S_IFMT) === S_IFDIR) continue
              mode = st.mode
              size = st.size
            }
            if ((mode & S_IFMT) === S_IFDIR) {
              dirs.push(local)
              next.push({ remote, local })
            } else if ((mode & S_IFMT) === 0o100000) {
              files.push({ from: remote, to: local, size })
            }
          }
        })
        level = next
      }

      const label = remotePaths.length === 1 ? posix.basename(remotePaths[0]) : `${remotePaths.length} items`
      const target = remotePaths.length === 1 ? firstLocal[0] : localDir
      const ok = await this.transfer(
        s,
        'down',
        label,
        target,
        files,
        async () => {
          for (const d of dirs) await fsp.mkdir(d, { recursive: true })
        },
        markFromInternet
      )
      return ok ? target : undefined
    } finally {
      for (const r of reserved) this.reserved.delete(r)
    }
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
    prepare: (sftp: SFTPWrapper) => Promise<void>,
    afterFile?: (path: string) => Promise<void>
  ): Promise<boolean> {
    const t = this.startTransfer(s.id, direction, label, target, files.reduce((n, f) => n + f.size, 0))
    this.holdTransfer(s)
    try {
      // A separate connection keeps bulk data from queueing in front of keystrokes.
      const sftp = await this.transferSftp(s)
      t.channels.push(sftp)
      await prepare(sftp)
      await this.runFiles(t, files, (f, step) =>
        promisify<void>((cb) =>
          direction === 'up'
            ? sftp.fastPut(f.from, f.to, { step, concurrency: CHUNKS_IN_FLIGHT }, cb)
            : sftp.fastGet(f.from, f.to, { step, concurrency: CHUNKS_IN_FLIGHT }, cb)
        ).then(() => afterFile?.(f.to))
      )
      this.finish(t)
    } catch (err) {
      this.finish(t, err as Error)
    } finally {
      for (const c of t.channels) c.end()
      this.releaseTransfer(s)
    }
    return t.status === 'done'
  }

  /** An SFTP channel on the session's transfer connection (or the terminal's, as a fallback). */
  private async transferSftp(s: Session): Promise<SFTPWrapper> {
    return openSftp((await this.transferClient(s)) ?? s.client)
  }

  private holdTransfer(s: Session): void {
    s.activeTransfers++
    clearTimeout(s.transferIdle)
  }

  /** Closes the transfer connection once it has been idle for a while. */
  private releaseTransfer(s: Session): void {
    if (--s.activeTransfers > 0) return
    s.transferIdle = setTimeout(() => {
      const conn = s.transferConn
      s.transferConn = undefined
      void conn?.then((c) => c?.end())
    }, TRANSFER_IDLE)
  }

  /** Copies files several at a time, reporting combined progress on `t`. */
  private async runFiles(
    t: ActiveTransfer,
    files: FileJob[],
    copy: (f: FileJob, step: (bytes: number) => void) => Promise<unknown>
  ): Promise<void> {
    let finished = 0
    const inFlight = new Map<FileJob, number>()
    const report = (force = false): void => {
      if (t.status !== 'running') return
      let n = finished
      for (const v of inFlight.values()) n += v
      this.progress(t, n, force)
    }
    await pool(files, PARALLEL, async (f) => {
      if (t.cancelled) return
      inFlight.set(f, 0)
      await copy(f, (n) => {
        inFlight.set(f, n)
        report()
      })
      inFlight.delete(f)
      finished += f.size
      report(true)
    })
  }

  // ------------------------------------------------------- between servers

  /** Where a copy to `sessionId` would land, and which top-level names already exist there. */
  async prepareCopy(sessionId: string, names: string[], dir?: string): Promise<{ dir: string; conflicts: string[] }> {
    const s = this.get(sessionId)
    const [target, sftp] = await Promise.all([dir ?? this.getCwd(sessionId), this.sftp(s)])
    const taken = await Promise.all(names.map((n) => exists(sftp, posix.join(target, n))))
    return { dir: target, conflicts: names.filter((_, i) => taken[i]) }
  }

  /**
   * Copies files and folders from one open session to another. Data streams
   * through Liman (nothing is stored locally), so the servers don't need to
   * reach or trust each other.
   */
  async copyBetween(fromId: string, paths: string[], toId: string, dir: string, mode: ConflictMode): Promise<void> {
    const src = this.get(fromId)
    const dst = this.get(toId)
    const [srcBrowse, dstBrowse] = await Promise.all([this.sftp(src), this.sftp(dst)])
    const stat = (p: string): Promise<{ mode: number; size: number }> => promisify((cb) => srcBrowse.stat(p, cb))

    const dirs: string[] = []
    const files: FileJob[] = []
    let level: { from: string; to: string }[] = []
    for (const p of paths) {
      let name = posix.basename(p)
      if (mode === 'keepBoth') name = await uniqueName(name, (n) => exists(dstBrowse, posix.join(dir, n)))
      const to = posix.join(dir, name)
      const st = await stat(p)
      if ((st.mode & S_IFMT) === S_IFDIR) {
        dirs.push(to)
        level.push({ from: p, to })
      } else if ((st.mode & S_IFMT) === 0o100000) {
        files.push({ from: p, to, size: st.size, mode: st.mode })
      } else {
        throw new Error(`${name} is not a regular file`)
      }
    }
    // Breadth-first; symlinked folders below the top level are skipped (no loops).
    while (level.length) {
      const next: typeof level = []
      await pool(level, PARALLEL, async (d) => {
        for (const it of await readdirFast(srcBrowse, d.from)) {
          const from = posix.join(d.from, it.filename)
          const to = posix.join(d.to, it.filename)
          let { mode: m, size } = it.attrs
          if ((m & S_IFMT) === S_IFLNK) {
            const st = await stat(from).catch(() => null)
            if (!st || (st.mode & S_IFMT) === S_IFDIR) continue
            m = st.mode
            size = st.size
          }
          if ((m & S_IFMT) === S_IFDIR) {
            dirs.push(to)
            next.push({ from, to })
          } else if ((m & S_IFMT) === 0o100000) {
            files.push({ from, to, size, mode: m })
          }
        }
      })
      level = next
    }

    const label = paths.length === 1 ? posix.basename(paths[0]) : `${paths.length} items`
    const t = this.startTransfer(toId, 'copy', label, dir, files.reduce((n, f) => n + f.size, 0))
    t.sourceHost = sessionLabel(src)
    t.targetHost = sessionLabel(dst)
    this.emitTransfer(t)
    this.holdTransfer(src)
    this.holdTransfer(dst)
    try {
      const [from, to] = await Promise.all([this.transferSftp(src), this.transferSftp(dst)])
      t.channels.push(from, to)
      for (const d of dirs) {
        await promisify<void>((cb) => to.mkdir(d, cb)).catch(async (err) => {
          const st = await promisify<{ mode: number }>((cb) => to.stat(d, cb)).catch(() => null)
          if (!st || (st.mode & S_IFMT) !== S_IFDIR) throw err
        })
      }
      await this.runFiles(t, files, async (f, step) => {
        await pipeFile(from, f.from, to, f.to, f.size, step)
        // Keep permissions such as the executable bit.
        if (f.mode !== undefined) await promisify<void>((cb) => to.chmod(f.to, f.mode! & 0o7777, cb)).catch(() => {})
      })
      this.finish(t)
    } catch (err) {
      this.finish(t, err as Error)
    } finally {
      for (const c of t.channels) c.end()
      this.releaseTransfer(src)
      this.releaseTransfer(dst)
    }
  }

  /** Moves entries into `dir` on the same server (a rename, so it's instant). */
  async moveInto(sessionId: string, paths: string[], dir: string): Promise<void> {
    const sftp = await this.sftp(this.get(sessionId))
    for (const p of paths) {
      if (dir === p || dir.startsWith(p.endsWith('/') ? p : p + '/')) throw new Error(`Can't move ${posix.basename(p)} into itself`)
      if (posix.dirname(p) === dir) continue
      const to = posix.join(dir, posix.basename(p))
      if (await exists(sftp, to)) throw new Error(`${posix.basename(p)} already exists in ${dir}`)
      await promisify<void>((cb) => sftp.rename(p, to, cb))
    }
  }

  /**
   * A second SSH connection to the same host for file transfers, logged in the
   * way the terminal session was (same verified host key, same credentials).
   * Resolves null when that isn't possible, e.g. a one-time 2FA code.
   */
  private transferClient(s: Session): Promise<Client | null> {
    const login = s.login
    if (!login || s.transferUnavailable || s.ending) return Promise.resolve(null)
    if (s.transferConn) return s.transferConn

    const conn = new Promise<Client | null>((resolve) => {
      const c = new Client()
      let settled = false
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!ok) {
          s.transferUnavailable = true
          c.end()
        }
        resolve(ok ? c : null)
      }
      const timer = setTimeout(() => settle(false), CONNECT_TIMEOUT)
      c.on('ready', () => {
        c.setNoDelay(true)
        settle(true)
      })
      c.on('error', (err) => {
        if (!settled) console.warn('[transfer] falling back to the terminal connection:', err.message)
        settle(false)
      })
      c.on('close', () => {
        if (s.transferConn === conn) s.transferConn = undefined
        settle(false)
      })

      let method: AnyAuthMethod = login.method
      if (method.type === 'keyboard-interactive') {
        const answers = login.kbdAnswers ?? []
        method = { ...method, prompt: (_n, _i, _l, prompts, finish) => finish(prompts.length === answers.length ? answers : []) }
      }
      let offered = false
      try {
        c.connect({
          host: login.host,
          port: login.port,
          username: login.username,
          readyTimeout: 0,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 4,
          // Never talk to a different server than the one the user verified.
          hostVerifier: (key: Buffer) => hostKeyId(key) === login.hostKey,
          authHandler: (_left: unknown, _partial: unknown, next: NextAuthHandler) => {
            if (offered) return next(false as unknown as AnyAuthMethod)
            offered = true
            next(method)
          }
        })
      } catch {
        settle(false)
      }
    })
    s.transferConn = conn
    return conn
  }

  cancelTransfer(id: string): void {
    const t = this.transfers.get(id)
    if (!t || t.status !== 'running') return
    t.cancelled = true
    // Closing the transfer's own SFTP channels aborts the requests in flight.
    for (const c of t.channels) c.end()
  }

  private startTransfer(
    sessionId: string,
    direction: Transfer['direction'],
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
      cancelled: false,
      channels: []
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
    if (t.status !== 'running') return
    t.status = t.cancelled ? 'cancelled' : err ? 'error' : 'done'
    if (err && !t.cancelled) t.error = err.message
    this.emitTransfer(t)
    this.transfers.delete(t.id)
    this.lastEmit.delete(t.id)
  }

  private emitTransfer({ cancelled: _c, channels: _ch, ...t }: ActiveTransfer): void {
    this.bridge.send('transfer:update', t)
  }
}

// ------------------------------------------------------------------- helpers

/** Tags a downloaded file like a browser would, so Windows SmartScreen still checks it. */
async function markFromInternet(path: string): Promise<void> {
  if (process.platform !== 'win32') return
  await fsp.writeFile(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => {})
}

function promisify<T>(fn: (cb: (err: Error | null | undefined, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))))
}

/** "ssh-ed25519 SHA256:…", as stored in known hosts. */
function hostKeyId(key: Buffer): string {
  const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  const keyType = key.subarray(4, 4 + key.readUInt32BE(0)).toString()
  return `${keyType} ${fingerprint}`
}

/** "user@host" of a logged-in session, for transfer labels. */
function sessionLabel(s: Session): string {
  return s.login ? `${s.login.username}@${s.login.host}` : 'server'
}

/**
 * Streams one file from an SFTP channel to another, keeping several reads and
 * writes in flight (like fastGet/fastPut, but server to server).
 */
function pipeFile(
  src: SFTPWrapper,
  from: string,
  dst: SFTPWrapper,
  to: string,
  size: number,
  step: (bytes: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    src.open(from, 'r', (err, rh) => {
      if (err) return reject(err)
      dst.open(to, 'w', (err2, wh) => {
        if (err2) {
          src.close(rh, () => {})
          return reject(err2)
        }
        // Ranges still to copy; a short read puts its remainder back in the queue.
        const queue: [number, number][] = []
        let next = 0
        let copied = 0
        let active = 0
        let failure: Error | undefined
        let settled = false
        const settle = (): void => {
          if (settled || active > 0) return
          settled = true
          src.close(rh, () => {})
          dst.close(wh, (closeErr) => (failure ? reject(failure) : closeErr ? reject(closeErr) : resolve()))
        }
        const take = (): [number, number] | undefined => {
          if (queue.length) return queue.shift()
          if (next >= size) return undefined
          const range: [number, number] = [next, Math.min(CHUNK, size - next)]
          next += range[1]
          return range
        }
        const pump = (): void => {
          if (failure) return settle()
          let range: [number, number] | undefined
          while (active < CHUNKS_IN_FLIGHT && (range = take())) {
            const [off, len] = range
            const buf = Buffer.allocUnsafe(len)
            active++
            src.read(rh, buf, 0, len, off, (readErr, bytes) => {
              if (readErr || !bytes) {
                active--
                failure ??= readErr ?? new Error(`${posix.basename(from)} changed while copying`)
                return pump()
              }
              if (bytes < len) queue.push([off + bytes, len - bytes])
              dst.write(wh, buf, 0, bytes, off, (writeErr) => {
                active--
                if (writeErr) failure ??= writeErr
                else {
                  copied += bytes
                  step(copied)
                }
                pump()
              })
            })
          }
          if (active === 0 && !queue.length && next >= size) settle()
        }
        pump()
      })
    })
  })
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

function exists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => sftp.lstat(path, (err) => resolve(!err)))
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
