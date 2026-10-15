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
  /** Sidebar groups the user folded away. */
  collapsedGroups: string[]
}

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
  message?: string
  /** The connection dropped on its own (not `exit`, not closed by the user): worth reconnecting. */
  lost?: boolean
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
  /** up: local → server, down: server → local, copy: server → server. */
  direction: 'up' | 'down' | 'copy'
  label: string
  target: string
  total: number
  done: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  /** For server-to-server copies: "user@host" of each side. */
  sourceHost?: string
  targetHost?: string
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
      /**
       * `server`: text chosen by the remote server (keyboard-interactive).
       * `app`: a prompt Liman itself shows (password, key passphrase).
       * The UI keeps the two visually distinct so a server can't impersonate the app.
       */
      source: 'server' | 'app'
      host: string
      title: string
      instructions?: string
      prompts: { prompt: string; echo: boolean }[]
    }

export type PromptResponse = boolean | string[] | null

/** What the app knows about a newer release. */
export type UpdateStatus =
  | { state: 'idle' }
  /** A newer version exists; on macOS it is downloaded from the release page. */
  | { state: 'available'; version: string; url: string }
  | { state: 'downloading'; version: string; percent: number }
  /** Downloaded and verified; installs on restart (or when the app quits). */
  | { state: 'ready'; version: string }
