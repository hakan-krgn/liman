import { app, nativeImage, type WebContents } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { createStandIns, dropFolders, findStandIns, MARKER_FILE, removeStandIns, type StandIns, type StandInEntry } from './standins'

/** What the renderer passes when rows start being dragged out of a files panel. */
export type DragOutEntry = StandInEntry

interface Pending extends StandIns {
  sessionId: string
}

/** How long to look for dropped stand-ins after the drag ends. */
const LOOK_FOR = process.platform === 'darwin' ? 60_000 : 6_000

/** 32 px app icon, shown while dragging when the system has no icon for the file. */
const ICON = nativeImage.createFromDataURL('data:image/png;base64,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')

/**
 * Dragging remote files onto the desktop or a folder.
 *
 * An OS drag needs real files the moment it starts, which remote files aren't.
 * So Liman drags stand-ins (see standins.ts). When the drag ends it looks for
 * them on the desktop and in open Explorer / Finder windows, and downloads the
 * real content exactly where each one landed.
 */
export class DragOut {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly download: (sessionId: string, remotePaths: string[], targets: string[]) => Promise<unknown>,
    private readonly log: (line: string) => void
  ) {}

  /** Creates the stand-ins for a drag. Synchronous: it runs during dragstart. */
  prepare(sessionId: string, entries: DragOutEntry[]): { token: string; files: string[] } {
    const s = createStandIns('liman-drag', entries)
    this.pending.set(s.token, { ...s, sessionId })
    setTimeout(() => this.forget(s.token), 10 * 60_000).unref()
    return { token: s.token, files: s.files }
  }

  /** Runs the OS drag, then downloads into wherever the stand-ins were dropped. */
  async begin(token: string, sender: WebContents, onDragEnd: () => void): Promise<void> {
    const p = this.pending.get(token)
    if (!p) return
    try {
      // Windows returns once the drop happened; macOS returns at once and we keep looking.
      sender.startDrag({ file: p.files[0], files: p.files, icon: await dragIcon(p.files[0]) })
      // On macOS the drag is still going; the renderer notices its end itself.
      if (process.platform !== 'darwin') onDragEnd()
      const found = await this.locate(p)
      if (found.size === 0) return
      const remotes: string[] = []
      const targets: string[] = []
      for (const [i, target] of found) {
        if (p.entries[i].isDir) await fsp.rm(join(target, MARKER_FILE), { force: true })
        remotes.push(p.entries[i].path)
        targets.push(target)
      }
      await this.download(p.sessionId, remotes, targets)
    } catch (err) {
      this.log(`drag to desktop failed: ${(err as Error).message}`)
    } finally {
      this.forget(token)
    }
  }

  private forget(token: string): void {
    const p = this.pending.get(token)
    if (!p) return
    this.pending.delete(token)
    removeStandIns(p)
  }

  /** Finds the dropped copies of the stand-ins: entry index -> path where it landed. */
  private async locate(p: Pending): Promise<Map<number, string>> {
    const found = new Map<number, string>()
    const deadline = Date.now() + LOOK_FOR
    let folders: string[] = []
    let lastFolders = 0
    while (Date.now() < deadline && found.size < p.files.length) {
      // Open windows change rarely; ask again every couple of seconds.
      if (Date.now() - lastFolders > 2000) {
        folders = await dropFolders()
        lastFolders = Date.now()
      }
      for (const [i, hit] of await findStandIns(folders, p)) if (!found.has(i)) found.set(i, hit)
      if (found.size < p.files.length) await new Promise((r) => setTimeout(r, 400))
    }
    return found
  }
}

/** The icon the system shows for this kind of file or folder. */
async function dragIcon(path: string): Promise<Electron.NativeImage> {
  const icon = await app.getFileIcon(path, { size: 'normal' }).catch(() => null)
  return icon && !icon.isEmpty() ? icon : ICON
}
