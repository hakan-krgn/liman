# Liman

A minimal SSH + SFTP client for Windows and macOS. Inspired by Termius, focused on being simple to use.

## Features

- **Drag-and-drop uploads:** Drop files or folders from the desktop, Explorer or Finder onto a terminal and they are uploaded to whatever directory that terminal is currently in. The target directory is shown before you drop.
- **SFTP panel:** Browse folders, drop onto a folder to upload into it, double-click to download (to your Downloads folder), rename, delete, create folders, and jump to the terminal's current directory.
- **Conflict handling:** If a file with the same name already exists you can choose *Keep both* (`file (1).txt`), *Replace* or *Cancel*.
- **Light / dark / system theme** and adjustable terminal font size.
- **Authentication:** password, SSH key (including passphrase-protected keys), SSH agent, and keyboard-interactive (2FA).
- **Security:** Host key fingerprints are confirmed on first connect and you are warned if they change. Passwords are encrypted with the operating system's keychain (`safeStorage`).
- Tabs, quick connect (type `user@host:port` in the search box and press Enter), right-click to copy / paste.

## Development

```bash
npm install
npm run dev          # run in development mode
npm run typecheck
npm run dist:win     # Windows installer (in release/)
npm run dist:mac     # macOS .dmg — must be run on macOS
```

## Shortcuts

| Action | Windows | macOS |
|---|---|---|
| Copy / Paste | Ctrl+C (with a selection) / Ctrl+V, or right-click | Cmd+C / Cmd+V |
| Close tab | Ctrl+Shift+W | Cmd+W |
| Switch tab | Ctrl+Tab, Ctrl+1…9 | Ctrl+Tab, Cmd+1…9 |

## How the terminal's directory is detected

The login shell is started so that its PID is known up front (`SHELL_BOOTSTRAP` in `src/main/ssh.ts`). When files are dropped, the working directory of the terminal's foreground process is read over a separate helper channel (`/proc` on Linux, `lsof` on macOS/BSD). Nothing is ever typed into your terminal. If that isn't possible, Liman falls back to the directory reported by the shell via OSC 7, and finally to the home directory.

## Performance notes

- Folder listings are cached per session and refreshed in the background; hovering a folder prefetches it.
- Directory reads are pipelined, and cwd lookups reuse one long-lived helper channel instead of opening a new one each time.
- Uploads and downloads move up to 8 files at once on their own SFTP channel, so cancelling a transfer never disturbs browsing.
- The terminal renders with WebGL (falling back to the DOM renderer) and Nagle's algorithm is disabled on the SSH socket.

## Project layout

```
src/main/      Electron main process: SSH/SFTP engine (ssh2), settings and host store
src/preload/   Safe API exposed to the renderer
src/renderer/  React UI (xterm.js terminal)
src/shared/    Shared types
```
