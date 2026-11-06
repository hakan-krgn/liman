import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chordFromEvent,
  chordMatches,
  findConflicts,
  formatChord,
  parseChord,
  renderShortcutTables,
  resolveBindings,
  SHORTCUTS
} from '../../src/renderer/src/shortcuts'

const press = (key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code?: string; altGr?: boolean } = {}) =>
  chordFromEvent({
    key,
    code: mods.code ?? '',
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
    getModifierState: (m) => m === 'AltGraph' && !!mods.altGr
  })

const matches = (key: string, chord: string, mods: Parameters<typeof press>[1] = {}): boolean => {
  const c = press(key, mods)
  return !!c && chordMatches(c, parseChord(chord))
}

describe('chords', () => {
  it('parses and prints them for each platform', () => {
    expect(formatChord(parseChord('Ctrl+Shift+k'), 'win')).toBe('Ctrl+Shift+K')
    expect(formatChord(parseChord('Cmd+Shift+G'), 'mac')).toBe('⇧⌘G')
    expect(formatChord(parseChord('Cmd+Alt+C'), 'mac')).toBe('⌥⌘C')
    expect(formatChord(parseChord('Alt+Up'), 'win')).toBe('Alt+↑')
    expect(formatChord(parseChord('Cmd+Backspace'), 'mac')).toBe('⌘⌫')
    expect(parseChord('Ctrl++')).toEqual(parseChord('Ctrl+Plus'))
    expect(() => parseChord('Hyper+K')).toThrow()
  })

  it('tells Shift apart for letters and named keys', () => {
    expect(matches('W', 'Ctrl+Shift+W', { ctrl: true, shift: true })).toBe(true)
    expect(matches('w', 'Ctrl+Shift+W', { ctrl: true })).toBe(false)
    expect(matches('Tab', 'Ctrl+Tab', { ctrl: true, shift: true })).toBe(false)
    expect(matches('ArrowLeft', 'Alt+Left', { alt: true })).toBe(true)
  })

  it('ignores Shift for punctuation, which some layouts need it for', () => {
    // Turkish layout: "=" is Shift+0.
    expect(matches('=', 'Ctrl+=', { ctrl: true, shift: true, code: 'Digit0' })).toBe(true)
    expect(matches('+', 'Ctrl+Plus', { ctrl: true, shift: true })).toBe(true)
    expect(matches('0', 'Ctrl+0', { ctrl: true, code: 'Digit0' })).toBe(true)
  })

  it('uses the key position for letters outside A–Z, and ignores AltGr', () => {
    expect(matches('ç', 'Cmd+Alt+C', { meta: true, alt: true, code: 'KeyC' })).toBe(true)
    expect(matches('ş', 'Ctrl+S', { ctrl: true, code: 'KeyS' })).toBe(true)
    expect(press('@', { ctrl: true, alt: true, altGr: true, code: 'KeyQ' })).toBeNull()
    expect(press('Shift', { shift: true })).toBeNull()
  })
})

describe('the shortcut list', () => {
  it('has unique ids and keys that parse', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length)
    for (const s of SHORTCUTS) for (const keys of [s.keys.win, s.keys.mac]) for (const k of keys) expect(() => parseChord(k)).not.toThrow()
  })

  it('never gives two actions of the same place the same keys', () => {
    expect(findConflicts(resolveBindings('win'))).toEqual([])
    expect(findConflicts(resolveBindings('mac'))).toEqual([])
  })

  it('applies changed keys on top of the defaults', () => {
    const b = resolveBindings('win', { 'files.refresh': ['Ctrl+Shift+R'], 'files.download': [] })
    expect(b.get('files.refresh')!.map((c) => formatChord(c, 'win'))).toEqual(['Ctrl+Shift+R'])
    expect(b.get('files.download')).toEqual([])
    expect(findConflicts(b)).toEqual([])
  })

  it('is documented in the README exactly as defined', () => {
    const path = join(__dirname, '../../README.md')
    const readme = readFileSync(path, 'utf8')
    const start = '<!-- shortcuts:start -->'
    const end = '<!-- shortcuts:end -->'
    const i = readme.indexOf(start)
    const j = readme.indexOf(end)
    expect(i).toBeGreaterThan(0)
    const table = `${start}\n\n${renderShortcutTables()}\n\n`
    // UPDATE_README=1 rewrites the section instead of comparing.
    if (process.env.UPDATE_README) writeFileSync(path, readme.slice(0, i) + table + readme.slice(j))
    else expect(readme.slice(i, j).replace(/\r\n/g, '\n')).toBe(table)
  })
})
