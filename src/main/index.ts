import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { store } from './store'
import { SessionManager } from './ssh'
import type { ConflictMode, HostInput, PromptRequest, PromptResponse, Settings } from '@shared/types'

let win: BrowserWindow | null = null
const pending = new Map<string, (res: PromptResponse) => void>()

const sessions = new SessionManager({
  send(channel, ...args) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  },
  ask(req: PromptRequest) {
    return new Promise((resolve) => {
      if (!win || win.isDestroyed()) return resolve(null)
      const id = randomUUID()
      pending.set(id, resolve)
      win.webContents.send('prompt:request', id, req)
    })
  }
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
      ? { trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarOverlay: { color: dark ? '#1a1b1e' : '#f6f6f7', symbolColor: dark ? '#e6e6e6' : '#1f1f1f', height: 44 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win?.show())
  // Dropping a file outside of a drop zone must never navigate the window away.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A renderer reload loses every terminal, so drop the SSH sessions behind them too.
  win.webContents.on('did-start-loading', () => sessions.disconnectAll())
  win.on('closed', () => {
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
    sessions.disconnectAll()
    win = null
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle('hosts:list', () => store.listHosts())
  ipcMain.handle('hosts:save', (_e, input: HostInput) => store.saveHost(input))
  ipcMain.handle('hosts:delete', (_e, id: string) => store.deleteHost(id))

  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => store.setSettings(patch))
  ipcMain.handle('window:titlebar', (_e, color: string, symbolColor: string) => {
    if (process.platform !== 'darwin' && win) win.setTitleBarOverlay({ color, symbolColor })
  })

  ipcMain.on('prompt:respond', (_e, id: string, res: PromptResponse) => {
    pending.get(id)?.(res)
    pending.delete(id)
  })

  ipcMain.on('ssh:connect', (_e, sessionId: string, hostId: string, cols: number, rows: number) =>
    sessions.connect(sessionId, hostId, cols, rows)
  )
  ipcMain.on('ssh:write', (_e, sessionId: string, data: string) => sessions.write(sessionId, data))
  ipcMain.on('ssh:resize', (_e, sessionId: string, cols: number, rows: number) =>
    sessions.resize(sessionId, cols, rows)
  )
  ipcMain.on('ssh:disconnect', (_e, sessionId: string) => sessions.disconnect(sessionId))
  ipcMain.handle('ssh:cwd', (_e, sessionId: string) => sessions.getCwd(sessionId))

  ipcMain.handle('sftp:list', (_e, sessionId: string, dir: string) => sessions.list(sessionId, dir))
  ipcMain.handle('sftp:mkdir', (_e, sessionId: string, path: string) => sessions.mkdir(sessionId, path))
  ipcMain.handle('sftp:rename', (_e, sessionId: string, from: string, to: string) =>
    sessions.rename(sessionId, from, to)
  )
  ipcMain.handle('sftp:remove', (_e, sessionId: string, paths: string[]) => sessions.remove(sessionId, paths))
  ipcMain.handle('sftp:prepareUpload', (_e, sessionId: string, paths: string[], dir?: string) =>
    sessions.prepareUpload(sessionId, paths, dir)
  )
  ipcMain.handle('sftp:upload', (_e, sessionId: string, paths: string[], dir: string, mode: ConflictMode) =>
    sessions.upload(sessionId, paths, dir, mode)
  )
  ipcMain.handle('sftp:download', (_e, sessionId: string, paths: string[]) => sessions.download(sessionId, paths))
  ipcMain.on('transfer:cancel', (_e, id: string) => sessions.cancelTransfer(id))

  ipcMain.handle('dialog:pickKey', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.on('shell:showItem', (_e, path: string) => shell.showItemInFolder(path))
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

app.setName('Liman')
// Lets development and tests run against a throwaway profile.
if (process.env.LIMAN_USER_DATA) app.setPath('userData', process.env.LIMAN_USER_DATA)
app.whenReady().then(() => {
  setupMenu()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
