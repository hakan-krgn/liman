import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Host, HostInput, Settings } from '@shared/types'

interface StoredHost extends Omit<Host, 'hasPassword' | 'hasPassphrase'> {
  password?: string // encrypted, base64
  passphrase?: string // encrypted, base64
}

interface StoreData {
  hosts: StoredHost[]
  settings: Settings
  /** "host:port" -> "ssh-ed25519 SHA256:..." */
  knownHosts: Record<string, string>
}

const defaults: StoreData = {
  hosts: [],
  settings: { theme: 'system', fontSize: 14 },
  knownHosts: {}
}

let data: StoreData
let file: string

function load(): StoreData {
  if (data) return data
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  file = join(dir, 'liman.json')
  try {
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    data = { ...defaults, ...raw, settings: { ...defaults.settings, ...raw.settings } }
  } catch {
    data = structuredClone(defaults)
  }
  return data
}

function save(): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

function encrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system')
  return safeStorage.encryptString(value).toString('base64')
}

function decrypt(value?: string): string | undefined {
  if (!value) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return undefined
  }
}

function toPublic({ password, passphrase, ...h }: StoredHost): Host {
  return { ...h, hasPassword: !!password, hasPassphrase: !!passphrase }
}

export const store = {
  listHosts(): Host[] {
    return load().hosts.map(toPublic)
  },

  saveHost(input: HostInput): Host {
    const d = load()
    const existing = input.id ? d.hosts.find((h) => h.id === input.id) : undefined
    const { password, passphrase, clearPassword, ...rest } = input
    const next: StoredHost = {
      ...rest,
      id: existing?.id ?? randomUUID(),
      name: rest.name.trim() || rest.host,
      port: Number(rest.port) || 22,
      password: existing?.password,
      passphrase: existing?.passphrase
    }
    if (password) next.password = encrypt(password)
    if (clearPassword || input.authType !== 'password') delete next.password
    if (passphrase) next.passphrase = encrypt(passphrase)
    if (input.authType !== 'key') {
      delete next.passphrase
      delete next.keyPath
    }
    if (existing) d.hosts[d.hosts.indexOf(existing)] = next
    else d.hosts.push(next)
    save()
    return toPublic(next)
  },

  deleteHost(id: string): void {
    const d = load()
    d.hosts = d.hosts.filter((h) => h.id !== id)
    save()
  },

  /** Full host record with decrypted secrets, main process only. */
  getHostSecrets(id: string): (Host & { password?: string; passphrase?: string }) | undefined {
    const h = load().hosts.find((x) => x.id === id)
    if (!h) return undefined
    return { ...toPublic(h), password: decrypt(h.password), passphrase: decrypt(h.passphrase) }
  },

  getSettings(): Settings {
    return load().settings
  },

  setSettings(patch: Partial<Settings>): Settings {
    const d = load()
    d.settings = { ...d.settings, ...patch }
    save()
    return d.settings
  },

  getKnownHost(key: string): string | undefined {
    return load().knownHosts[key]
  },

  setKnownHost(key: string, value: string): void {
    load().knownHosts[key] = value
    save()
  }
}
