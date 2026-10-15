export type AuthType = 'password' | 'key' | 'agent'

/** Host as seen by the renderer. Secrets never leave the main process. */
export interface Host {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  keyPath?: string
  group?: string
  hasPassword: boolean
  hasPassphrase: boolean
}

/** Payload for creating/updating a host. Empty secret strings keep the stored value. */
export interface HostInput extends Omit<Host, 'id' | 'hasPassword' | 'hasPassphrase'> {
  id?: string
  password?: string
  passphrase?: string
  clearPassword?: boolean
}

export type ThemeMode = 'system' | 'light' | 'dark'

export interface Settings {
  theme: ThemeMode
  fontSize: number
}

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
  message?: string
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  mtime: number
}

export type ConflictMode = 'replace' | 'keepBoth'

export interface Transfer {
  id: string
  sessionId: string
  direction: 'up' | 'down'
  label: string
  target: string
  total: number
  done: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  error?: string
}

export type PromptRequest =
  | {
      kind: 'hostkey'
      host: string
      fingerprint: string
      keyType: string
      /** Set when a different key was stored before (possible MITM). */
      previous?: string
    }
  | {
      kind: 'auth'
      host: string
      title: string
      instructions?: string
      prompts: { prompt: string; echo: boolean }[]
    }

export type PromptResponse = boolean | string[] | null
