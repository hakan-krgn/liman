import { useEffect, useRef, type RefObject } from 'react'
import { isMac } from './lib'
import { chordFromEvent, chordMatches, formatChord, resolveBindings, SHORTCUT_BY_ID, type Bindings, type Chord, type Scope } from './shortcuts'

/**
 * What a shortcut handler did:
 * - nothing / true: handled, the key goes no further;
 * - false: not handled, try the next action bound to the key (or let it through);
 * - 'pass': let the key through to where it was typed (e.g. F1 to htop).
 */
type Result = boolean | void | 'pass'
type Handler = (e: KeyboardEvent) => Result

interface Registration {
  run: Handler
  /** Only when the key was pressed inside this element (one files panel or terminal among several tabs). */
  scope?: RefObject<HTMLElement | null>
}

const handlers = new Map<string, Set<Registration>>()
let bindings: Bindings = resolveBindings(isMac ? 'mac' : 'win')

/** Applies the user's changed keys (from settings) on top of the defaults. */
export function setShortcutOverrides(overrides: Record<string, string[]> | undefined): void {
  bindings = resolveBindings(isMac ? 'mac' : 'win', overrides)
}

export function shortcutBindings(): Bindings {
  return bindings
}

/** The first chord of an action as this platform writes it ("Ctrl+C", "⌘C"), for menus and tooltips. */
export function keyHint(id: string): string {
  const chord = bindings.get(id)?.[0]
  return chord ? formatChord(chord, isMac ? 'mac' : 'win') : ''
}

/**
 * Runs each handler when the keys of its action are pressed (inside `scope`,
 * if given). Handlers may change on every render; the actions may not.
 */
export function useShortcuts(map: Record<string, Handler>, scope?: RefObject<HTMLElement | null>): void {
  const latest = useRef(map)
  latest.current = map
  const ids = Object.keys(map).join(' ')
  useEffect(() => {
    const regs = ids.split(' ').map((id) => {
      if (!SHORTCUT_BY_ID.has(id)) throw new Error(`Unknown shortcut ${id}`)
      const reg: Registration = {
        run: (e) => {
          const handler = latest.current[id]
          return handler ? handler(e) : false
        },
        scope
      }
      const set = handlers.get(id) ?? new Set()
      handlers.set(id, set.add(reg))
      return [set, reg] as const
    })
    return () => regs.forEach(([set, reg]) => set.delete(reg))
  }, [ids, scope])
}

/** The part of the window a key was pressed in. */
function scopeOf(target: HTMLElement): Scope | null {
  const el = target.closest?.('.sftp, .xterm, .sidebar')
  if (!el) return null
  return el.classList.contains('sftp') ? 'files' : el.classList.contains('xterm') ? 'terminal' : 'hosts'
}

/** Typing in a text field (the terminal's hidden input doesn't count). */
function isTyping(target: HTMLElement): boolean {
  if (target.classList?.contains('xterm-helper-textarea')) return false
  if (target.isContentEditable) return true
  if (target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes((target as HTMLInputElement).type)
}

/** In a text field only app-wide chords with Ctrl / ⌘ work, and never the ones that edit text. */
function allowedWhileTyping(c: Chord, scope: Scope): boolean {
  if (scope !== 'global' || !(c.ctrl || c.meta)) return false
  return !/^(A|C|V|X|Z|Y|Backspace|Delete|Left|Right|Home|End)$/.test(c.key) || c.shift
}

/** Installs the one keydown listener all shortcuts go through. */
export function installShortcutDispatcher(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    // Dialogs handle their own keys.
    if (document.querySelector('.overlay')) return
    const pressed = chordFromEvent(e)
    if (!pressed) return
    const target = e.target as HTMLElement
    const here = scopeOf(target)
    const typing = isTyping(target)

    const ids: string[] = []
    for (const [id, chords] of bindings) {
      const scope = SHORTCUT_BY_ID.get(id)!.scope
      if (scope !== 'global' && scope !== here) continue
      if (typing && !allowedWhileTyping(pressed, scope)) continue
      if (chords.some((c) => chordMatches(pressed, c))) ids.push(id)
    }
    // Where the focus is comes first, then the app-wide actions.
    ids.sort((a, b) => Number(SHORTCUT_BY_ID.get(a)!.scope === 'global') - Number(SHORTCUT_BY_ID.get(b)!.scope === 'global'))

    for (const id of ids) {
      const regs = [...(handlers.get(id) ?? [])]
        .filter((r) => !r.scope || r.scope.current?.contains(target))
        // A component's own handler before an app-wide one.
        .sort((a, b) => Number(!a.scope) - Number(!b.scope))
      for (const r of regs) {
        const result = r.run(e)
        if (result === 'pass') return
        if (result === false) continue
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}
