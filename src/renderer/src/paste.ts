import { useEffect, useState } from 'react'
import type { ClipContent, ClipEntry } from '@shared/types'
import { baseName, parentOf } from '@shared/shell'
import { api, askConflicts, copyWithConfirm, uploadWithConfirm } from './lib'

// Copy, cut and paste of remote files. The system clipboard holds stand-ins
// (see main/clipout.ts), so Explorer and Finder can paste them too; here is
// what a paste inside Liman does with each kind of clipboard content.

/** "report.txt", or "3 items". */
export function describeItems(paths: string[]): string {
  return paths.length === 1 ? `“${baseName(paths[0])}”` : `${paths.length} items`
}

// --------------------------------------------------------------- the cut
// Cut rows are shown dimmed until they are pasted, the cut is cancelled, or
// something else is copied.

type Cut = { sessionId: string; paths: Set<string> } | null
let cut: Cut = null
const listeners = new Set<(c: Cut) => void>()

function setCut(c: Cut): void {
  cut = c
  for (const l of listeners) l(c)
}

/** Paths currently cut in `sessionId`, for dimming them. */
export function useCutPaths(sessionId: string | undefined): Set<string> | null {
  const [c, set] = useState<Cut>(cut)
  useEffect(() => {
    listeners.add(set)
    return () => void listeners.delete(set)
  }, [])
  return c && c.sessionId === sessionId ? c.paths : null
}

/** Copies (or cuts) remote entries to the system clipboard. */
export async function copyEntries(sessionId: string, entries: ClipEntry[], mode: 'copy' | 'cut'): Promise<void> {
  await api.copyRemote(sessionId, entries, mode)
  setCut(mode === 'cut' ? { sessionId, paths: new Set(entries.map((e) => e.path)) } : null)
}

/** Esc: forgets a cut. Returns whether there was one. */
export function cancelCut(): boolean {
  if (!cut) return false
  setCut(null)
  void api.releaseClipboard()
  return true
}

// Copying something else elsewhere ends the cut too.
window.addEventListener('focus', () => {
  if (!cut) return
  void api.inspectClipboard().then((c) => {
    if (c.kind !== 'liman' || c.mode !== 'cut') setCut(null)
  })
})

// ------------------------------------------------------------- the paste

/**
 * Pastes what the clipboard holds into `dir` on `sessionId`:
 * local files and screenshots are uploaded, Liman's own copies are copied
 * (or, for a cut on the same server, moved). Returns false if there was
 * nothing Liman can paste.
 */
export async function pasteInto(sessionId: string, dir: string, content: ClipContent): Promise<boolean> {
  switch (content.kind) {
    case 'files':
      await uploadWithConfirm(sessionId, content.paths, dir)
      return true
    case 'image':
      await uploadWithConfirm(sessionId, [await api.saveClipboardImage()], dir)
      return true
    case 'liman':
      // A cut pasted onto another server copies: its files never vanish from the first one.
      if (content.sessionId !== sessionId) await copyWithConfirm(content.sessionId, content.paths, sessionId, dir)
      else if (content.mode === 'cut') await moveHere(sessionId, content.paths, dir)
      else await copyHere(sessionId, content.paths, dir)
      return true
    default:
      return false
  }
}

async function moveHere(sessionId: string, paths: string[], dir: string): Promise<void> {
  const moving = paths.filter((p) => parentOf(p) !== dir)
  if (moving.length) {
    const mode = await askConflicts(await api.prepareCopy(sessionId, moving.map(baseName), dir))
    if (!mode) return
    await api.moveInto(sessionId, moving, dir, mode)
  }
  // The files are where they belong now; the clipboard no longer stands for them.
  setCut(null)
  await api.releaseClipboard()
}

async function copyHere(sessionId: string, paths: string[], dir: string): Promise<void> {
  const prep = await api.prepareCopy(sessionId, paths.map(baseName), dir)
  // A copy next to its original is named "x (copy)" by itself; only other clashes ask.
  const conflicts = prep.conflicts.filter((name) => !paths.some((p) => parentOf(p) === dir && baseName(p) === name))
  const mode = await askConflicts({ dir, conflicts })
  if (mode) await api.copyWithin(sessionId, paths, dir, mode)
}
