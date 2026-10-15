import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  ConflictMode,
  Host,
  HostInput,
  PromptRequest,
  PromptResponse,
  RemoteEntry,
  SessionStatusEvent,
  Settings,
  Transfer
} from '@shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  platform: process.platform,

  listHosts: (): Promise<Host[]> => ipcRenderer.invoke('hosts:list'),
  saveHost: (input: HostInput): Promise<Host> => ipcRenderer.invoke('hosts:save', input),
  deleteHost: (id: string): Promise<void> => ipcRenderer.invoke('hosts:delete', id),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
  setTitleBar: (color: string, symbolColor: string): Promise<void> =>
    ipcRenderer.invoke('window:titlebar', color, symbolColor),

  connect: (sessionId: string, hostId: string, cols: number, rows: number): void =>
    ipcRenderer.send('ssh:connect', sessionId, hostId, cols, rows),
  write: (sessionId: string, data: string): void => ipcRenderer.send('ssh:write', sessionId, data),
  resize: (sessionId: string, cols: number, rows: number): void =>
    ipcRenderer.send('ssh:resize', sessionId, cols, rows),
  disconnect: (sessionId: string): void => ipcRenderer.send('ssh:disconnect', sessionId),
  getCwd: (sessionId: string): Promise<string> => ipcRenderer.invoke('ssh:cwd', sessionId),
  onData: (cb: (sessionId: string, data: Uint8Array) => void) => on('ssh:data', cb),
  onStatus: (cb: (e: SessionStatusEvent) => void) => on('ssh:status', cb),

  list: (sessionId: string, dir: string): Promise<{ path: string; entries: RemoteEntry[] }> =>
    ipcRenderer.invoke('sftp:list', sessionId, dir),
  mkdir: (sessionId: string, path: string): Promise<void> => ipcRenderer.invoke('sftp:mkdir', sessionId, path),
  rename: (sessionId: string, from: string, to: string): Promise<void> =>
    ipcRenderer.invoke('sftp:rename', sessionId, from, to),
  remove: (sessionId: string, paths: string[]): Promise<void> => ipcRenderer.invoke('sftp:remove', sessionId, paths),
  prepareUpload: (sessionId: string, paths: string[], dir?: string): Promise<{ dir: string; conflicts: string[] }> =>
    ipcRenderer.invoke('sftp:prepareUpload', sessionId, paths, dir),
  upload: (sessionId: string, paths: string[], dir: string, mode: ConflictMode): Promise<void> =>
    ipcRenderer.invoke('sftp:upload', sessionId, paths, dir, mode),
  download: (sessionId: string, paths: string[]): Promise<void> =>
    ipcRenderer.invoke('sftp:download', sessionId, paths),
  cancelTransfer: (id: string): void => ipcRenderer.send('transfer:cancel', id),
  onTransfer: (cb: (t: Transfer) => void) => on('transfer:update', cb),

  onPrompt: (cb: (id: string, req: PromptRequest) => void) => on('prompt:request', cb),
  respondPrompt: (id: string, res: PromptResponse): void => ipcRenderer.send('prompt:respond', id, res),
  /** Main cancelled a prompt (its session went away); the dialog should close. */
  onPromptCancel: (cb: (id: string) => void) => on('prompt:cancel', cb),

  pickKey: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickKey'),
  showItem: (path: string): void => ipcRenderer.send('shell:showItem', path),
  /** Absolute path of a file dropped from the OS (Explorer / Finder / desktop). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
