/**
 * End-to-end tests for the SSH/SFTP engine against a real OpenSSH server.
 *
 * They run when LIMAN_TEST_SSH is set ("host:port"); CI starts a
 * linuxserver/openssh-server container for this. Locally:
 *
 *   docker run -d --name liman-ssh -p 127.0.0.1:2222:2222 -e PASSWORD_ACCESS=true \
 *     -e USER_NAME=tester -e USER_PASSWORD=test123 lscr.io/linuxserver/openssh-server
 *   LIMAN_TEST_SSH=127.0.0.1:2222 npm test
 */
import { Client } from 'ssh2'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PromptRequest, PromptResponse } from '@shared/types'
import { SessionManager } from '../../src/main/ssh'

const target = process.env.LIMAN_TEST_SSH
const [HOST, PORT] = (target ?? '127.0.0.1:2222').split(':')
const USER = process.env.LIMAN_TEST_USER ?? 'tester'
const PASSWORD = process.env.LIMAN_TEST_PASSWORD ?? 'test123'

// The engine reads hosts and known keys from the Electron-backed store; swap in memory.
const state = vi.hoisted(() => ({
  hosts: new Map<string, Record<string, unknown>>(),
  known: new Map<string, string>()
}))
vi.mock('../../src/main/store', () => ({
  store: {
    getHostSecrets: (id: string) => state.hosts.get(id),
    getKnownHost: (key: string) => state.known.get(key),
    setKnownHost: (key: string, value: string) => void state.known.set(key, value)
  }
}))

function addHost(id: string, extra: Record<string, unknown> = {}): string {
  state.hosts.set(id, {
    id,
    name: id,
    host: HOST,
    port: Number(PORT),
    username: USER,
    authType: 'password',
    password: PASSWORD,
    hasPassword: true,
    hasPassphrase: false,
    ...extra
  })
  return id
}

/** Runs a command on the server over a separate connection (test setup only). */
function remote(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    c.on('ready', () =>
      c.exec(cmd, (err, ch) => {
        if (err) return reject(err)
        let out = ''
        ch.on('data', (d: Buffer) => (out += d))
        ch.stderr.on('data', () => {})
        ch.on('close', () => {
          c.end()
          resolve(out)
        })
      })
    )
    c.on('error', reject)
    c.connect({ host: HOST, port: Number(PORT), username: USER, password: PASSWORD })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!target)('SSH engine against a real server', () => {
  const statuses = new Map<string, string[]>()
  const lost = new Map<string, boolean | undefined>()
  const prompts: PromptRequest[] = []
  let answer: (req: PromptRequest) => PromptResponse = () => null
  const manager = new SessionManager({
    send(channel, ...args) {
      if (channel !== 'ssh:status') return
      const e = args[0] as { sessionId: string; status: string; message?: string; lost?: boolean }
      if (e.status === 'closed') lost.set(e.sessionId, e.lost)
      statuses.set(e.sessionId, [...(statuses.get(e.sessionId) ?? []), e.message ? `${e.status}:${e.message}` : e.status])
    },
    async ask(_sessionId, req) {
      prompts.push(req)
      return req.kind === 'hostkey' ? true : answer(req)
    },
    cancelPrompts() {}
  })

  const waitFor = async (sessionId: string, pred: (s: string) => boolean, ms = 15_000): Promise<string[]> => {
    for (let t = 0; t < ms; t += 50) {
      if ((statuses.get(sessionId) ?? []).some(pred)) break
      await sleep(50)
    }
    return statuses.get(sessionId) ?? []
  }

  const local = mkdtempSync(join(tmpdir(), 'liman-test-'))
  const base = `/tmp/liman-test-${process.pid}`
  const SID = 'main'

  beforeAll(async () => {
    await remote(`rm -rf ${base} && mkdir -p ${base}`)
    addHost('main')
    manager.connect(SID, 'main', 100, 30)
    expect(await waitFor(SID, (s) => s === 'connected')).toContain('connected')
    await sleep(1000) // let the login shell start
  })

  afterAll(async () => {
    manager.disconnectAll()
    await remote(`rm -rf ${base}`).catch(() => {})
    rmSync(local, { recursive: true, force: true })
  })

  it('asks to trust the host key only on first contact', async () => {
    expect(prompts.filter((p) => p.kind === 'hostkey')).toHaveLength(1)
    addHost('again')
    manager.connect('again', 'again', 80, 24)
    await waitFor('again', (s) => s === 'connected')
    expect(prompts.filter((p) => p.kind === 'hostkey')).toHaveLength(1)
    manager.disconnect('again')
    expect(await waitFor('again', (s) => s === 'closed')).toContain('closed')
  })

  it("follows the terminal's working directory, including nested shells", async () => {
    manager.write(SID, `mkdir -p "${base}/dröp zone" && cd "${base}/dröp zone"\n`)
    await sleep(700)
    expect(await manager.getCwd(SID)).toBe(`${base}/dröp zone`)
    manager.write(SID, `sh\ncd ${base}\n`)
    await sleep(700)
    expect(await manager.getCwd(SID)).toBe(base)
    manager.write(SID, `exit\n`)
    await sleep(500)
    expect(await manager.getCwd(SID)).toBe(`${base}/dröp zone`)
  })

  it('uploads files and folders, skipping local symlinks', async () => {
    const src = join(local, 'project')
    mkdirSync(join(src, 'assets'), { recursive: true })
    writeFileSync(join(src, 'index.html'), '<h1>hi</h1>')
    writeFileSync(join(src, 'assets', 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7))
    const secret = join(local, 'secret')
    mkdirSync(secret)
    writeFileSync(join(secret, 'id_rsa'), 'SECRET')
    symlinkSync(secret, join(src, 'linked'), 'junction')

    const prep = await manager.prepareUpload(SID, [src])
    expect(prep).toEqual({ dir: `${base}/dröp zone`, conflicts: [] })
    await manager.upload(SID, [src], prep.dir, 'replace')

    // Bulk data went over a second connection, not the terminal's.
    const internals = manager as unknown as {
      sessions: Map<string, { client: Client; transferConn?: Promise<Client | null> }>
    }
    const session = internals.sessions.get(SID)!
    const transferClient = await session.transferConn
    expect(transferClient).toBeInstanceOf(Client)
    expect(transferClient).not.toBe(session.client)

    const tree = (await remote(`cd "${prep.dir}" && find . | sort`)).trim().split('\n')
    expect(tree).toEqual(['.', './project', './project/assets', './project/assets/big.bin', './project/index.html'])
    expect((await manager.prepareUpload(SID, [src])).conflicts).toEqual(['project'])
  })

  it('keeps both copies when asked', async () => {
    const file = join(local, 'notes.txt')
    writeFileSync(file, 'v1')
    const dir = `${base}/keep`
    await remote(`mkdir -p ${dir}`)
    await manager.upload(SID, [file], dir, 'keepBoth')
    await manager.upload(SID, [file], dir, 'keepBoth')
    const names = (await manager.list(SID, dir)).entries.map((e) => e.name)
    expect(names).toEqual(['notes (1).txt', 'notes.txt'])
  })

  it('lists large folders completely, in natural order', async () => {
    await remote(`mkdir -p ${base}/many && cd ${base}/many && for i in $(seq 1 1234); do : > f$i; done && mkdir zdir`)
    const { path, entries } = await manager.list(SID, `${base}/many/`)
    expect(path).toBe(`${base}/many`)
    expect(entries).toHaveLength(1235)
    expect(entries[0]).toMatchObject({ name: 'zdir', isDir: true })
    expect(entries.slice(1, 4).map((e) => e.name)).toEqual(['f1', 'f2', 'f3'])
  })

  it('downloads safely: hostile names stay inside, symlink loops are skipped', async () => {
    const evil = `${base}/evil`
    await remote(
      `mkdir -p ${evil}/sub && printf ok > ${evil}/sub/fine.txt && ` +
        `printf pwned > '${evil}/..\\..\\escaped.txt' && ln -s . ${evil}/loop && ln -s .. ${evil}/sub/up`
    )
    const out = join(local, 'downloads')
    mkdirSync(out)
    const result = await manager.download(SID, [evil], out)
    expect(result).toBe(join(out, 'evil'))

    const files: string[] = []
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (n.includes(':')) continue
        if (statSync(p).isDirectory()) walk(p)
        else files.push(relative(out, p).split(/[\\/]/).join('/'))
      }
    }
    walk(out)
    expect(files.sort()).toEqual(['evil/.._.._escaped.txt', 'evil/sub/fine.txt'])
    expect(existsSync(join(dirname(out), 'escaped.txt'))).toBe(false)
    expect(readFileSync(join(out, 'evil', 'sub', 'fine.txt'), 'utf8')).toBe('ok')
  })

  it('gives parallel downloads of the same file different names', async () => {
    await remote(`printf A > ${base}/same.txt`)
    const out = join(local, 'same')
    mkdirSync(out)
    const [a, b] = await Promise.all([
      manager.download(SID, [`${base}/same.txt`], out),
      manager.download(SID, [`${base}/same.txt`], out)
    ])
    expect(new Set([a, b])).toEqual(new Set([join(out, 'same.txt'), join(out, 'same (1).txt')]))
  })

  it('downloads into exact targets, replacing dropped stand-ins', async () => {
    await remote(`mkdir -p ${base}/drag/site/css && printf body > ${base}/drag/site/css/a.css && printf real > ${base}/drag/one.txt`)
    const drop = join(local, 'drop')
    mkdirSync(join(drop, 'site (2)'), { recursive: true })
    writeFileSync(join(drop, 'one.txt'), 'stand-in')
    const result = await manager.download(SID, [`${base}/drag/one.txt`, `${base}/drag/site`], join(local, 'unused'), [
      join(drop, 'one.txt'),
      join(drop, 'site (2)')
    ])
    expect(result).toBe(drop)
    expect(readFileSync(join(drop, 'one.txt'), 'utf8')).toBe('real')
    expect(readFileSync(join(drop, 'site (2)', 'css', 'a.css'), 'utf8')).toBe('body')
    await remote(`rm -rf ${base}/drag`)
  })

  it('renames, creates and recursively removes', async () => {
    await manager.mkdir(SID, `${base}/newdir`)
    await manager.rename(SID, `${base}/same.txt`, `${base}/renamed.txt`)
    await manager.remove(SID, [`${base}/many`, `${base}/evil`])
    const names = (await manager.list(SID, base)).entries.map((e) => e.name)
    expect(names).toEqual(['dröp zone', 'keep', 'newdir', 'renamed.txt'])
  })

  it('copies files and folders between two sessions, byte for byte', async () => {
    addHost('peer')
    manager.connect('peer', 'peer', 80, 24)
    expect(await waitFor('peer', (x) => x === 'connected')).toContain('connected')

    const src = `${base}/relay-src`
    await remote(
      `mkdir -p ${src}/nested/deeper && cd ${src} && ` +
        `head -c 5242881 /dev/urandom > big.bin && printf 'hi' > small.txt && : > empty && ` +
        `printf '#!/bin/sh\\necho ok\\n' > run.sh && chmod 755 run.sh && ` +
        `seq 1 50 | while read i; do printf "$i" > nested/f$i; done && printf deep > nested/deeper/x.txt && ` +
        `printf 'ü' > 'nested/çiçek ğüş.txt' && ln -s .. nested/loop`
    )
    const sums = (dir: string): Promise<string> =>
      remote(`cd ${dir} && find . -type f -exec md5sum {} + | sort -k 2`)

    const dst = `${base}/relay-dst`
    await remote(`mkdir -p ${dst}`)
    expect(await manager.prepareCopy('peer', ['relay-src'], dst)).toEqual({ dir: dst, conflicts: [] })
    await manager.copyBetween(SID, [src], 'peer', dst, 'replace')

    expect(await sums(`${dst}/relay-src`)).toBe(await sums(src))
    expect((await remote(`stat -c %a ${dst}/relay-src/run.sh`)).trim()).toBe('755')
    expect((await remote(`test -e ${dst}/relay-src/nested/loop && echo yes || echo no`)).trim()).toBe('no')

    // Same names again: keep both.
    expect((await manager.prepareCopy('peer', ['relay-src'], dst)).conflicts).toEqual(['relay-src'])
    await manager.copyBetween(SID, [`${src}/small.txt`], 'peer', `${dst}/relay-src`, 'keepBoth')
    expect((await remote(`cat '${dst}/relay-src/small (1).txt'`)).trim()).toBe('hi')

    // Defaults to the destination terminal's folder.
    manager.write('peer', `cd ${dst}\n`)
    await sleep(600)
    expect((await manager.prepareCopy('peer', ['x'])).dir).toBe(dst)
    manager.disconnect('peer')
  })

  it('moves entries into another folder on the same server', async () => {
    const dir = `${base}/move`
    await remote(`mkdir -p ${dir}/target ${dir}/a && printf 1 > ${dir}/one.txt`)
    await manager.moveInto(SID, [`${dir}/one.txt`, `${dir}/a`], `${dir}/target`)
    expect((await remote(`cd ${dir} && find . | sort`)).trim().split('\n')).toEqual([
      '.',
      './target',
      './target/a',
      './target/one.txt'
    ])
    await expect(manager.moveInto(SID, [`${dir}/target`], `${dir}/target/a`)).rejects.toThrow(/into itself/)
    await remote(`printf 2 > ${dir}/one.txt`)
    await expect(manager.moveInto(SID, [`${dir}/one.txt`], `${dir}/target`)).rejects.toThrow(/already exists/)
  })

  it('applies a resize that happens while connecting', async () => {
    addHost('resize')
    manager.connect('resize', 'resize', 80, 24)
    manager.resize('resize', 132, 40)
    await waitFor('resize', (s) => s === 'connected')
    await sleep(1000)
    manager.write('resize', `stty size > ${base}/size.txt\n`)
    await sleep(700)
    expect((await remote(`cat ${base}/size.txt`)).trim()).toBe('40 132')
    manager.disconnect('resize')
  })

  it('survives the connection dropping while the shell is being opened', async () => {
    // Regression: ssh2 hands the pending shell request an error when the socket
    // dies, and opening the fallback shell then threw "Not connected" in main.
    addHost('drop')
    const uncaught: unknown[] = []
    const record = (e: unknown): void => void uncaught.push(e)
    process.on('uncaughtException', record)
    try {
      manager.connect('drop', 'drop', 80, 24)
      const internals = manager as unknown as { sessions: Map<string, { client: Client }> }
      const client = internals.sessions.get('drop')!.client as Client & { _sock: { destroy(): void } }
      // Our own 'ready' handler runs first and asks for the shell; then the socket dies.
      client.once('ready', () => client._sock.destroy())
      const s = await waitFor('drop', (x) => x.startsWith('closed') || x.startsWith('error'))
      await sleep(300)
      expect(uncaught).toEqual([])
      expect(s).not.toContain('connected')
      expect(s.at(-1)).toMatch(/^(closed|error)/)
    } finally {
      process.off('uncaughtException', record)
    }
  })

  it('tells a dropped connection apart from `exit` and from closing the tab', async () => {
    addHost('exit')
    manager.connect('exit', 'exit', 80, 24)
    await waitFor('exit', (x) => x === 'connected')
    await sleep(800)
    manager.write('exit', 'exit\n')
    expect(await waitFor('exit', (x) => x === 'closed')).toContain('closed')
    expect(lost.get('exit')).toBe(false)

    addHost('user')
    manager.connect('user', 'user', 80, 24)
    await waitFor('user', (x) => x === 'connected')
    manager.disconnect('user')
    await waitFor('user', (x) => x === 'closed')
    expect(lost.get('user')).toBe(false)

    addHost('drop2')
    manager.connect('drop2', 'drop2', 80, 24)
    await waitFor('drop2', (x) => x === 'connected')
    await sleep(800)
    // The server side of this one session goes away (like a reboot or a firewall reset).
    manager.write('drop2', 'kill -9 $PPID\n')
    const s = await waitFor('drop2', (x) => x.startsWith('closed'))
    expect(lost.get('drop2')).toBe(true)
    expect(s.at(-1)).toMatch(/^closed:Connection lost/)
  })

  it('stops at the first cancelled password prompt', async () => {
    addHost('nopw', { password: undefined, hasPassword: false })
    answer = () => null
    const before = prompts.length
    manager.connect('nopw', 'nopw', 80, 24)
    expect(await waitFor('nopw', (s) => s.startsWith('error'))).toContain('error:Authentication cancelled')
    expect(prompts.length - before).toBe(1)
  })

  it('reports a wrong saved password as an authentication failure', async () => {
    addHost('wrong', { password: 'not-the-password' })
    answer = (req) => (req.kind === 'auth' ? ['still-wrong'] : null)
    manager.connect('wrong', 'wrong', 80, 24)
    const s = await waitFor('wrong', (x) => x.startsWith('error'), 30_000)
    expect(s.at(-1)).toBe('error:Authentication failed')
  })
})
