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
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  file = join(dir, 'liman.json')
  try {
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    data = { ...defaults, ...raw, settings: { ...defaults.settings, ...raw.settings } }
  } catch (err) {
    // Never silently overwrite a file we couldn't read: keep it next to the fresh one.
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      renameSync(file, backup)
    } catch {
      /* nothing to keep */
    }
    console.error(`[store] could not read ${file}, moved it to ${backup}:`, err)
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
  // On Linux without a keyring Electron falls back to a hard-coded key; treat that as unavailable.
  const plainText = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'
  if (!safeStorage.isEncryptionAvailable() || plainText) throw new Error('Secure storage is not available on this system')
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
    const host = String(input.host ?? '').trim()
    const username = String(input.username ?? '').trim()
    const port = Number(input.port)
    if (!host) throw new Error('Address is required')
    if (!username) throw new Error('Username is required')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535')
    if (!['password', 'key', 'agent'].includes(input.authType)) throw new Error('Unknown authentication type')

    // Only known fields are stored, whatever else the renderer sends.
    const next: StoredHost = {
      id: existing?.id ?? randomUUID(),
      name: String(input.name ?? '').trim() || host,
      host,
      port,
      username,
      authType: input.authType,
      keyPath: input.keyPath ? String(input.keyPath) : undefined,
      group: input.group ? String(input.group).trim() : undefined,
      password: existing?.password,
      passphrase: existing?.passphrase
    }
    // A saved password belongs to one server account: moving the host elsewhere drops it.
    const moved = existing && (existing.host !== host || existing.port !== port || existing.username !== username)
    if (moved || input.clearPassword || input.authType !== 'password') delete next.password
    if (input.password && input.authType === 'password') next.password = encrypt(input.password)
    if (input.passphrase) next.passphrase = encrypt(input.passphrase)
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
