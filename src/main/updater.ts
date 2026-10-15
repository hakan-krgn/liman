import { app, net, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { isNewerVersion } from './util'

const OWNER = 'hakan-krgn'
const REPO = 'liman'
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`
const FIRST_CHECK = 5_000
const INTERVAL = 6 * 60 * 60 * 1000

/**
 * Keeps the app up to date from GitHub Releases.
 *
 * Windows: electron-updater downloads the new installer in the background, checks
 * its SHA-512 against the release's latest.yml and installs on restart or quit.
 * macOS: installing in place needs a Developer ID signature, so until the app is
 * signed we only tell the user and open the release page for them.
 */
export class Updater {
  private status: UpdateStatus = { state: 'idle' }

  constructor(private send: (status: UpdateStatus) => void) {}

  get current(): UpdateStatus {
    return this.status
  }

  start(): void {
    if (!app.isPackaged) return
    if (process.platform === 'win32') this.setupAutoUpdater()
    setTimeout(() => void this.check(), FIRST_CHECK)
    setInterval(() => void this.check(), INTERVAL)
  }

  /** Restarts into the downloaded update (Windows): silent install, then relaunch. */
  install(): void {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall(true, true)
  }

  /** Opens the release page of the available version (macOS). */
  openDownload(): void {
    if (this.status.state === 'available') void shell.openExternal(this.status.url)
  }

  private set(status: UpdateStatus): void {
    this.status = status
    this.send(status)
  }

  private setupAutoUpdater(): void {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = console
    autoUpdater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('download-progress', (p) => {
      if (this.status.state === 'downloading') this.set({ ...this.status, percent: Math.floor(p.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version }))
    // Offline, rate-limited or a release without installers: try again next round.
    autoUpdater.on('error', (err) => {
      console.warn('[updater]', err.message)
      if (this.status.state === 'downloading') this.set({ state: 'idle' })
    })
  }

  private async check(): Promise<void> {
    if (this.status.state === 'ready' || this.status.state === 'downloading') return
    try {
      if (process.platform === 'win32') {
        await autoUpdater.checkForUpdates()
        return
      }
      const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Liman/${app.getVersion()}` }
      })
      if (!res.ok) return
      const release = (await res.json()) as { tag_name?: string; html_url?: string }
      const version = release.tag_name?.replace(/^v/i, '')
      if (version && isNewerVersion(version, app.getVersion())) {
        const url = release.html_url?.startsWith(RELEASES_URL) ? release.html_url : RELEASES_URL
        this.set({ state: 'available', version, url })
      }
    } catch (err) {
      console.warn('[updater]', (err as Error).message)
    }
  }
}
