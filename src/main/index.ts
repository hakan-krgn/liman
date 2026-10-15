import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { store } from './store'
import { SessionManager } from './ssh'
import { Updater } from './updater'
import type { ConflictMode, HostInput, PromptResponse, Settings } from '@shared/types'

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
  })
  win.on('closed', () => {
    resolvePrompts(() => true)
    sessions.disconnectAll()
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
  handle('settings:set', (patch) => store.setSettings(patch as Partial<Settings>))
  handle('window:titlebar', (bg, fg) => {
    if (process.platform !== 'darwin' && win) win.setTitleBarOverlay({ color: color(bg), symbolColor: color(fg) })
  })

  on('prompt:respond', (id, res) => {
    const p = pending.get(str(id))
    if (!p) return
    pending.delete(str(id))
    p.resolve(res === true || (Array.isArray(res) && res.every((x) => typeof x === 'string')) ? (res as PromptResponse) : null)
  })

  on('ssh:connect', (sessionId, hostId, cols, rows) => sessions.connect(str(sessionId), str(hostId), int(cols), int(rows)))
  on('ssh:write', (sessionId, data) => sessions.write(str(sessionId), str(data)))
  on('ssh:resize', (sessionId, cols, rows) => sessions.resize(str(sessionId), int(cols), int(rows)))
  on('ssh:disconnect', (sessionId) => sessions.disconnect(str(sessionId)))
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
    const target = await sessions.download(str(sessionId), strs(paths), app.getPath('downloads'))
    if (target) revealable.add(target)
  })
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
    if (value.length <= 1_000_000) clipboard.writeText(value)
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
      { role: 'appMenu' },
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
  updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
