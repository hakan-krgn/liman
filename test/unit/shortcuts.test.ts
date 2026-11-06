import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkChord,
  chordFromEvent,
  chordMatches,
  chordText,
  currentKeys,
  findConflicts,
  formatChord,
  parseChord,
  renderShortcutTables,
  resolveBindings,
  SHORTCUTS,
  shortcutRows,
  withChord,
  withDefault,
  withoutChord
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

describe('changing keys', () => {
  const win = resolveBindings('win')
  const check = (id: string, text: string, platform: 'win' | 'mac' = 'win') => checkChord(id, parseChord(text), platform, resolveBindings(platform))

  it('writes chords the way they are read back', () => {
    for (const text of ['Ctrl+Shift+K', 'Alt+Left', 'F5', 'Ctrl+Plus', 'Cmd+Alt+C', 'Ctrl+,']) expect(chordText(parseChord(text))).toBe(text)
  })

  it("refuses the system's keys, Esc, and plain letters", () => {
    expect(check('files.refresh', 'Alt+F4').error).toMatch(/Windows/)
    expect(check('files.refresh', 'Cmd+R').error).toMatch(/Windows key/)
    expect(check('files.refresh', 'Cmd+Q', 'mac').error).toMatch(/macOS/)
    expect(check('files.refresh', 'Escape').error).toMatch(/Esc/)
    expect(check('files.refresh', 'R').error).toMatch(/typed/)
    expect(check('files.refresh', 'Shift+R').error).toMatch(/typed/)
    expect(check('files.refresh', 'F6')).toEqual({ conflicts: [] })
  })

  it('warns when the terminal would lose a key and finds clashes in the same place', () => {
    expect(check('tab.close', 'Ctrl+W').warning).toMatch(/shell/)
    expect(check('files.refresh', 'Ctrl+W').warning).toBeUndefined()
    expect(check('files.refresh', 'Ctrl+Shift+N').conflicts).toEqual(['files.newFolder'])
    // F2 in the panel and F2 for the tab are different places: no clash.
    expect(check('files.rename', 'F2').conflicts).toEqual([])
    expect(win.get('tab.rename')).toBeDefined()
  })

  it('stores only what differs from the defaults', () => {
    let o = withChord({}, 'win', 'files.refresh', 'Ctrl+Shift+Y')
    expect(o).toEqual({ 'files.refresh': ['Ctrl+Shift+Y'] })
    o = withChord(o, 'win', 'files.refresh', 'F5', -1)
    expect(currentKeys('files.refresh', 'win', o)).toEqual(['Ctrl+Shift+Y', 'F5'])
    o = withoutChord(o, 'win', 'files.refresh', 0)
    expect(o).toEqual({ 'files.refresh': ['F5'] })
    // Back to the defaults: nothing stored.
    o = withChord(o, 'win', 'files.refresh', 'Ctrl+R', -1)
    expect(o).toEqual({})
    expect(withDefault({ 'files.refresh': ['F6'] }, 'files.refresh')).toEqual({})
  })

  it('takes a key away from the action that had it', () => {
    const o = withChord({}, 'win', 'files.refresh', 'Ctrl+Shift+N', undefined, ['files.newFolder'])
    expect(o).toEqual({ 'files.refresh': ['Ctrl+Shift+N'], 'files.newFolder': [] })
    expect(findConflicts(resolveBindings('win', o))).toEqual([])
    // The F1 list and Settings show the changed keys.
    const row = shortcutRows(o).find((r) => r.label === 'Refresh')!
    expect(row.win).toBe('`Ctrl+Shift+N`')
    expect(shortcutRows(o).find((r) => r.label === 'New folder')!.win).toBe('')
  })

  it('keeps Esc and the numbered tabs fixed', () => {
    expect(SHORTCUTS.filter((x) => x.fixed).map((x) => x.id)).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `tab.goto${i + 1}`),
      'files.escape'
    ])
  })
})
