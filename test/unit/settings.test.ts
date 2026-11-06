import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, TERMINAL_THEMES } from '../../src/shared/settings'
import { TERMINAL_THEME_LIST, terminalTheme } from '../../src/renderer/src/themes'

const merge = (patch: Record<string, unknown>) => mergeSettings(DEFAULT_SETTINGS, patch)

describe('settings rules', () => {
  it('takes valid values', () => {
    const s = merge({
      terminalTheme: 'nord',
      fontFamily: 'Cascadia Code',
      lineHeight: 1.43,
      cursorStyle: 'block',
      scrollback: 50_000,
      rightClick: 'menu',
      bell: 'sound',
      conflictDefault: 'keepBoth',
      downloadDir: 'D:\\Downloads\\Liman',
      keepaliveSeconds: 0,
      autoReconnect: false
    })
    expect(s).toMatchObject({
      terminalTheme: 'nord',
      fontFamily: 'Cascadia Code',
      lineHeight: 1.45,
      cursorStyle: 'block',
      scrollback: 50_000,
      rightClick: 'menu',
      bell: 'sound',
      conflictDefault: 'keepBoth',
      downloadDir: 'D:\\Downloads\\Liman',
      keepaliveSeconds: 0,
      autoReconnect: false
    })
    expect(merge({ downloadDir: '/home/me/dl' }).downloadDir).toBe('/home/me/dl')
  })

  it('keeps the previous value for anything that is not valid', () => {
    const s = merge({
      terminalTheme: 'neon',
      cursorStyle: 'triangle',
      bell: true,
      autoUpdate: 'yes',
      scrollback: 'lots',
      lineHeight: null,
      downloadDir: 'relative/path',
      connectTimeoutSeconds: ''
    })
    expect(s).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps numbers into their range', () => {
    expect(merge({ fontSize: 2, scrollback: 10, lineHeight: 9, reconnectAttempts: 1e6, keepaliveSeconds: -5, connectTimeoutSeconds: 1 })).toMatchObject({
      fontSize: 8,
      scrollback: 1_000,
      lineHeight: 2,
      reconnectAttempts: 100,
      keepaliveSeconds: 0,
      connectTimeoutSeconds: 5
    })
  })

  it('keeps a font name from reaching CSS as anything else', () => {
    expect(merge({ fontFamily: 'Evil", serif; color: red' }).fontFamily).toBe('Evil serif color red')
  })

  it('drops unknown keys and cleans changed shortcuts', () => {
    const s = merge({ nonsense: 1, shortcuts: { 'files.refresh': ['F5', 7], 'Bad Id!': ['F1'] } })
    expect(s).not.toHaveProperty('nonsense')
    expect(s.shortcuts).toEqual({ 'files.refresh': ['F5'] })
  })
})

describe('terminal colour presets', () => {
  it('exist for every theme setting, with all 21 colours', () => {
    expect(TERMINAL_THEME_LIST.map((t) => t.id)).toEqual([...TERMINAL_THEMES])
    for (const id of TERMINAL_THEMES) {
      for (const app of ['light', 'dark'] as const) {
        const t = terminalTheme(id, app)
        const keys = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'black', 'red', 'green', 'yellow']
        keys.push('blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue')
        keys.push('brightMagenta', 'brightCyan', 'brightWhite')
        for (const k of keys) expect(t[k as keyof typeof t], `${id} ${app} ${k}`).toMatch(/^(#[0-9a-f]{6}|rgba\(.+\))$/)
      }
    }
  })

  it('follow the app theme only for Liman', () => {
    expect(terminalTheme('liman', 'light').background).toBe('#ffffff')
    expect(terminalTheme('liman', 'dark').background).toBe('#141517')
    expect(terminalTheme('nord', 'light')).toEqual(terminalTheme('nord', 'dark'))
    expect(terminalTheme('gone', 'dark')).toEqual(terminalTheme('liman', 'dark'))
  })
})
