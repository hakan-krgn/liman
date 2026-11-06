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
  /** Settings › Updates: Windows downloads updates by itself unless this is off. */
  private autoDownload = true

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

  /** Gets the available version: downloads it (Windows) or opens its release page (macOS). */
  openDownload(): void {
    if (this.status.state !== 'available') return
    if (process.platform !== 'win32') return void shell.openExternal(this.status.url)
    this.set({ state: 'downloading', version: this.status.version, percent: 0 })
    autoUpdater.downloadUpdate().catch((err: Error) => {
      console.warn('[updater]', err.message)
      this.set({ state: 'idle' })
    })
  }

  /** Settings › Updates: download in the background, or only say a new version is out. */
  setAutoDownload(on: boolean): void {
    this.autoDownload = on
    if (process.platform === 'win32') autoUpdater.autoDownload = on
  }

  /** Settings › "Check now": the status after asking, or why asking failed. */
  async checkNow(): Promise<{ status: UpdateStatus; error?: string }> {
    if (!app.isPackaged) return { status: this.status, error: 'Only the installed app checks for updates.' }
    try {
      await this.check(true)
      return { status: this.status }
    } catch (err) {
      return { status: this.status, error: (err as Error).message }
    }
  }

  private set(status: UpdateStatus): void {
    this.status = status
    this.send(status)
  }

  private setupAutoUpdater(): void {
    autoUpdater.autoDownload = this.autoDownload
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = console
    autoUpdater.on('update-available', (info) =>
      this.set(
        this.autoDownload
          ? { state: 'downloading', version: info.version, percent: 0 }
          : { state: 'available', version: info.version, url: `${RELEASES_URL}/tag/v${info.version}` }
      )
    )
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

  /** Asks GitHub for a newer version; failures are only logged unless `report` is set. */
  private async check(report = false): Promise<void> {
    if (this.status.state === 'ready' || this.status.state === 'downloading') return
    try {
      if (process.platform === 'win32') {
        await autoUpdater.checkForUpdates()
        return
      }
      const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Liman/${app.getVersion()}` }
      })
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      const release = (await res.json()) as { tag_name?: string; html_url?: string }
      const version = release.tag_name?.replace(/^v/i, '')
      if (version && isNewerVersion(version, app.getVersion())) {
        const url = release.html_url?.startsWith(RELEASES_URL) ? release.html_url : RELEASES_URL
        this.set({ state: 'available', version, url })
      }
    } catch (err) {
      console.warn('[updater]', (err as Error).message)
      if (report) throw err
    }
  }
}
