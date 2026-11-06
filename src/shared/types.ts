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

/** The host id of a tab with a terminal on this computer instead of a server. */
export const LOCAL_HOST_ID = 'local'

/** A shell this computer can run in a local terminal. */
export interface LocalShell {
  path: string
  args: string[]
  /** "PowerShell 7", "Git Bash", "zsh", … */
  label: string
}

/** Everything the Settings window changes (defaults and rules: shared/settings.ts). */
export interface Settings {
  // Appearance
  theme: ThemeMode
  /** A preset from shared/settings.ts TERMINAL_THEMES; 'liman' follows the app's light / dark theme. */
  terminalTheme: string
  /** A font installed on this computer; '' is the built-in JetBrains Mono. */
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'bar' | 'block' | 'underline'
  cursorBlink: boolean

  // Terminal
  scrollback: number
  /** Show typing before a distant server echoes it. */
  instantTyping: boolean
  /** Copy text as soon as it is selected. */
  copyOnSelect: boolean
  /** Right click copies the selection or pastes, or opens a menu. */
  rightClick: 'copyPaste' | 'menu'
  /** Ask before pasting several lines (each line would run as a command). */
  confirmMultilinePaste: boolean
  bell: 'off' | 'visual' | 'sound'
  /** The shell of local terminals (its path); '' is this computer's usual one. */
  localShell: string

  // Files
  showHidden: boolean
  /** What to do when a file being uploaded or copied already exists. */
  conflictDefault: 'ask' | ConflictMode
  /** Where downloads go; '' is the system's Downloads folder. */
  downloadDir: string
  confirmDelete: boolean

  // Connection
  /** Reconnect by itself when a connection drops. */
  autoReconnect: boolean
  reconnectAttempts: number
  /** 0 turns keepalives off. */
  keepaliveSeconds: number
  connectTimeoutSeconds: number

  // Updates
  /** Windows: download updates in the background (otherwise just tell). */
  autoUpdate: boolean

  /** Sidebar groups the user folded away. */
  collapsedGroups: string[]
  /** Keys the user changed: action id -> chords ("Ctrl+Shift+K"); [] turns an action off. */
  shortcuts?: Record<string, string[]>
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

/** A remote file or folder put on the clipboard or dragged out of a files panel. */
export interface ClipEntry {
  path: string
  isDir: boolean
}

/** What the system clipboard holds, as far as a paste in Liman is concerned. */
export type ClipContent =
  /** Remote entries copied (or cut) in a Liman files panel. */
  | { kind: 'liman'; sessionId: string; paths: string[]; mode: 'copy' | 'cut' }
  /** Local files, e.g. copied in Explorer or Finder. */
  | { kind: 'files'; paths: string[] }
  /** An image, e.g. a screenshot. */
  | { kind: 'image' }
  | { kind: 'none' }

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
