import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { store } from './store'
import { SessionManager } from './ssh'
import { Updater } from './updater'
import { DragOut } from './dragout'
import { ClipOut } from './clipout'
import { removeOldStandIns } from './standins'
import { findShells, LocalTerminals } from './localterm'
import { LOCAL_HOST_ID, type ClipEntry, type ConflictMode, type HostInput, type PromptResponse, type SessionStatusEvent, type Settings } from '@shared/types'

// Development-only switches; a packaged build ignores them so nobody can point
// the app at another renderer or profile through the environment.
const DEV_RENDERER_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
const DEV_USER_DATA = app.isPackaged ? undefined : process.env.LIMAN_USER_DATA
const APP_URL = DEV_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href

let win: BrowserWindow | null = null
const pending = new Map<string, { sessionId: string; resolve: (res: PromptResponse) => void }>()
/** Local paths of finished downloads; the only paths the renderer may reveal. */
const revealable = new Set<string>()

function resolvePrompts(filter: (sessionId: string) => boolean): void {
  for (const [id, p] of pending) {
    if (!filter(p.sessionId)) continue
    pending.delete(id)
    p.resolve(null)
    if (win && !win.isDestroyed()) win.webContents.send('prompt:cancel', id)
  }
}

/** Appends a timestamped line to logs/main.log (%APPDATA%\Liman\logs on Windows). */
function writeLog(line: string): void {
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'main.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* nowhere left to report */
  }
}

const sessions = new SessionManager({
  log: writeLog,
  send(channel, ...args) {
    if (channel === 'ssh:status') {
      const e = args[0] as SessionStatusEvent
      if (e.status === 'closed' || e.status === 'error') clipOut.sessionEnded(e.sessionId)
    }
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  },
  ask(sessionId, req) {
    return new Promise((resolve) => {
      if (!win || win.isDestroyed()) return resolve(null)
      const id = randomUUID()
      pending.set(id, { sessionId, resolve })
      win.webContents.send('prompt:request', id, req)
    })
  },
  cancelPrompts(sessionId) {
    resolvePrompts((s) => s === sessionId)
  }
})

/** Where downloads go: the folder chosen in Settings while it exists, otherwise Downloads. */
function downloadsDir(): string {
  const chosen = store.getSettings().downloadDir
  return chosen && existsSync(chosen) ? chosen : app.getPath('downloads')
}

/** Downloads remote entries over the stand-ins that were dropped or pasted for them. */
async function downloadOverStandIns(sessionId: string, remotes: string[], targets: string[]): Promise<void> {
  for (const t of targets) revealable.add(t)
  await sessions.download(sessionId, remotes, downloadsDir(), targets)
}
const dragOut = new DragOut(downloadOverStandIns, (line) => writeLog(line))
/** Terminals on this computer; they report like SSH sessions. */
const local = new LocalTerminals(
  (channel, ...args) => win && !win.isDestroyed() && win.webContents.send(channel, ...args),
  () => store.getSettings().localShell
)
const clipOut = new ClipOut({ download: downloadOverStandIns, log: writeLog })

const updater = new Updater((status) => {
  if (win && !win.isDestroyed()) win.webContents.send('update:status', status)
})

function isDark(): boolean {
  const { theme } = store.getSettings()
  return theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
}

function createWindow(): void {
  const dark = isDark()
  win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Liman',
    backgroundColor: dark ? '#141517' : '#ffffff',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 16 } }
      : { titleBarOverlay: { color: dark ? '#1a1b1e' : '#f6f6f7', symbolColor: dark ? '#e6e6e6' : '#1f1f1f', height: 48 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    }
  })

  win.once('ready-to-show', () => win?.show())
  // Dropping a file outside of a drop zone must never navigate the window away.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A renderer reload loses every terminal and dialog, so drop what was behind them.
  win.webContents.on('did-start-loading', () => {
    resolvePrompts(() => true)
    sessions.disconnectAll()
    local.closeAll()
  })
  // Pastes into Explorer / Finder happen while Liman is in the background.
  win.on('focus', () => clipOut.setFocused(true))
  win.on('blur', () => clipOut.setFocused(false))
  win.on('closed', () => {
    resolvePrompts(() => true)
    sessions.disconnectAll()
    local.closeAll()
    win = null
  })

  if (DEV_RENDERER_URL) void win.loadURL(DEV_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// ----------------------------------------------------------------------- IPC

/** Only our own window's top-level page, loaded from our own URL, may call in. */
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  return !!win && e.sender === win.webContents && frame === win.webContents.mainFrame && frame.url.startsWith(APP_URL)
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('Untrusted sender')
    return fn(...args)
  })
}

function on(channel: string, fn: (...args: unknown[]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!trusted(e)) return
    try {
      fn(...args)
    } catch (err) {
      console.error(`[ipc] ${channel}:`, err)
    }
  })
}

/** Remote entries from the renderer: `{path, isDir}` objects, at least one. */
function clipEntries(v: unknown): ClipEntry[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 100_000) throw new TypeError('Expected entries')
  return v.map((x) => {
    if (!x || typeof x.path !== 'string' || typeof x.isDir !== 'boolean') throw new TypeError('Expected an entry')
    return { path: x.path, isDir: x.isDir }
  })
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new TypeError('Expected a string')
  return v
}
function strs(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new TypeError('Expected a list of strings')
  return v
}
function int(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 10_000) throw new TypeError('Expected a size')
  return v as number
}
function color(v: unknown): string {
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw new TypeError('Expected a hex colour')
  return v
}

function registerIpc(): void {
  handle('hosts:list', () => store.listHosts())
  handle('hosts:save', (input) => store.saveHost(input as HostInput))
  handle('hosts:delete', (id) => store.deleteHost(str(id)))
  handle('hosts:move', (id, group, beforeId) => store.moveHost(str(id), str(group), beforeId === null ? null : str(beforeId)))
  handle('hosts:moveGroup', (group, before) => store.moveGroup(str(group), before === null ? null : str(before)))

  handle('settings:get', () => store.getSettings())
  handle('settings:set', (patch) => {
    const next = store.setSettings(patch as Partial<Settings>)
    updater.setAutoDownload(next.autoUpdate)
    return next
  })
  handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged }))
  handle('update:check', () => updater.checkNow())
  on('shell:openLogs', () => void shell.openPath(app.getPath('logs')))
  handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win!, { title: 'Choose a folder for downloads', properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('window:titlebar', (bg, fg) => {
    if (process.platform !== 'darwin' && win) win.setTitleBarOverlay({ color: color(bg), symbolColor: color(fg) })
  })

  on('prompt:respond', (id, res) => {
    const p = pending.get(str(id))
    if (!p) return
    pending.delete(str(id))
    p.resolve(res === true || (Array.isArray(res) && res.every((x) => typeof x === 'string')) ? (res as PromptResponse) : null)
  })

  // A tab on LOCAL_HOST_ID is a terminal on this computer; everything else is SSH.
  on('ssh:connect', (sessionId, hostId, cols, rows) =>
    hostId === LOCAL_HOST_ID
      ? void local.open(str(sessionId), int(cols), int(rows))
      : sessions.connect(str(sessionId), str(hostId), int(cols), int(rows))
  )
  on('ssh:write', (sessionId, data) =>
    local.has(str(sessionId)) ? local.write(str(sessionId), str(data)) : sessions.write(str(sessionId), str(data))
  )
  on('ssh:resize', (sessionId, cols, rows) =>
    local.has(str(sessionId)) ? local.resize(str(sessionId), int(cols), int(rows)) : sessions.resize(str(sessionId), int(cols), int(rows))
  )
  on('ssh:disconnect', (sessionId) => (local.has(str(sessionId)) ? local.close(str(sessionId)) : sessions.disconnect(str(sessionId))))
  handle('local:shells', () => findShells())
  handle('ssh:cwd', (sessionId) => sessions.getCwd(str(sessionId)))

  handle('sftp:list', (sessionId, dir) => sessions.list(str(sessionId), str(dir)))
  handle('sftp:mkdir', (sessionId, path) => sessions.mkdir(str(sessionId), str(path)))
  handle('sftp:rename', (sessionId, from, to) => sessions.rename(str(sessionId), str(from), str(to)))
  handle('sftp:remove', (sessionId, paths) => sessions.remove(str(sessionId), strs(paths)))
  handle('sftp:prepareUpload', (sessionId, paths, dir) =>
    sessions.prepareUpload(str(sessionId), strs(paths), dir === undefined ? undefined : str(dir))
  )
  handle('sftp:upload', (sessionId, paths, dir, mode) =>
    sessions.upload(str(sessionId), strs(paths), str(dir), mode === 'keepBoth' ? 'keepBoth' : ('replace' satisfies ConflictMode))
  )
  handle('sftp:download', async (sessionId, paths) => {
    const target = await sessions.download(str(sessionId), strs(paths), downloadsDir())
    if (target) revealable.add(target)
  })
  handle('sftp:prepareCopy', (sessionId, names, dir) =>
    sessions.prepareCopy(str(sessionId), strs(names), dir === undefined ? undefined : str(dir))
  )
  handle('sftp:copyBetween', (fromId, paths, toId, dir, mode) =>
    sessions.copyBetween(str(fromId), strs(paths), str(toId), str(dir), mode === 'keepBoth' ? 'keepBoth' : 'replace')
  )
  handle('sftp:copyWithin', (sessionId, paths, dir, mode) =>
    sessions.copyWithin(str(sessionId), strs(paths), str(dir), mode === 'keepBoth' ? 'keepBoth' : 'replace')
  )
  handle('sftp:moveInto', (sessionId, paths, dir, mode) =>
    sessions.moveInto(str(sessionId), strs(paths), str(dir), mode === 'keepBoth' || mode === 'replace' ? mode : undefined)
  )
  on('transfer:cancel', (id) => sessions.cancelTransfer(str(id)))

  handle('dialog:pickKey', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  handle('update:get', () => updater.current)
  on('update:install', () => updater.install())
  on('update:open', () => updater.openDownload())
  // Text a remote program copied (OSC 52). Write-only: nothing ever reads the clipboard for a server.
  on('clipboard:write', (text) => {
    const value = str(text)
    if (value.length <= 1_000_000) void clipboard.writeText(value).catch(() => {})
  })
  // Copy / cut in a files panel, and pastes inside Liman.
  handle('clipboard:copyRemote', (sessionId, entries, mode) =>
    clipOut.copy(str(sessionId), clipEntries(entries), mode === 'cut' ? 'cut' : 'copy')
  )
  handle('clipboard:inspect', () => clipOut.inspect())
  handle('clipboard:saveImage', () => clipOut.saveImage())
  handle('clipboard:release', () => clipOut.release())
  // Dragging remote files onto the desktop: stand-ins are made synchronously during dragstart.
  // Setting returnValue sends the reply at once, so it's set exactly once.
  ipcMain.on('dragout:prepare', (e, sessionId: unknown, entries: unknown) => {
    let result: ReturnType<DragOut['prepare']> | null = null
    try {
      if (trusted(e) && typeof sessionId === 'string' && Array.isArray(entries) && entries.length > 0) {
        result = dragOut.prepare(sessionId, clipEntries(entries))
      }
    } catch (err) {
      writeLog(`drag to desktop: ${(err as Error).message}`)
    }
    e.returnValue = result
  })
  on('dragout:begin', (token) => {
    if (!win) return
    const contents = win.webContents
    void dragOut.begin(str(token), contents, () => !contents.isDestroyed() && contents.send('dragout:ended'))
  })
  on('shell:showItem', (path) => {
    if (revealable.has(str(path))) shell.showItemInFolder(str(path))
  })
}

/**
 * Terminal users rely on keys like Ctrl+W and Ctrl+R, so Windows/Linux get no menu at all.
 * macOS keeps a minimal one for Cmd+C / Cmd+V / Cmd+Q; Cmd+W is handled by the app (close tab).
 */
function setupMenu(): void {
  if (process.platform !== 'darwin') return Menu.setApplicationMenu(null)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          // ⌘, reaches the page first and opens Settings there; this is for the menu itself.
          { label: 'Settings…', accelerator: 'Cmd+,', click: () => win?.webContents.send('menu:settings') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const])
        ]
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
    ])
  )
}

/** The UI only needs the clipboard; every other permission request is refused. */
function setupPermissions(): void {
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

app.setName('Liman')

/**
 * Last resort: a stray error in the main process must not pop Electron's crash
 * dialog over a working app (other sessions are fine). Keep it in logs/main.log.
 */
function logMainError(kind: string, err: unknown): void {
  console.error(`[main] ${kind}:`, err)
  writeLog(`${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
}
process.on('uncaughtException', (err) => logMainError('uncaughtException', err))
process.on('unhandledRejection', (reason) => logMainError('unhandledRejection', reason))
// Lets development and tests run against a throwaway profile.
if (DEV_USER_DATA) app.setPath('userData', DEV_USER_DATA)

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
})

app.whenReady().then(() => {
  setupMenu()
  setupPermissions()
  registerIpc()
  createWindow()
  updater.setAutoDownload(store.getSettings().autoUpdate)
  updater.start()
  void removeOldStandIns()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Stand-ins left on the clipboard would paste as placeholder files once Liman is gone.
let clipboardCleared = false
app.on('before-quit', (e) => {
  if (clipboardCleared || !clipOut.active) return
  e.preventDefault()
  clipboardCleared = true
  void clipOut.dispose().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
