import type { ITheme } from '@xterm/xterm'
import type { TerminalThemeId } from '@shared/settings'

// Terminal colour presets (Settings › Appearance). Liman's own follows the app's
// light / dark theme; the others are the same whatever the app looks like.

const LIMAN = {
  light: {
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#24292f',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(9, 105, 218, 0.22)',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#7d4e00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f'
  },
  dark: {
    background: '#141517',
    foreground: '#e3e4e8',
    cursor: '#e3e4e8',
    cursorAccent: '#141517',
    selectionBackground: 'rgba(124, 140, 255, 0.32)',
    black: '#3f4451',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d7dae0',
    brightBlack: '#5c6370',
    brightRed: '#ff7b86',
    brightGreen: '#b1e18b',
    brightYellow: '#efd089',
    brightBlue: '#67cdff',
    brightMagenta: '#e48bff',
    brightCyan: '#63d4e0',
    brightWhite: '#ffffff'
  }
} satisfies Record<'light' | 'dark', ITheme>

/** A palette: background, foreground, cursor, selection, then the 16 ANSI colours from black to bright white. */
function palette(bg: string, fg: string, cursor: string, selection: string, ansi: string[]): ITheme {
  const [black, red, green, yellow, blue, magenta, cyan, white, ...bright] = ansi
  const [brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = bright
  return {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: bg,
    selectionBackground: selection,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite
  }
}

export const TERMINAL_THEME_LIST: { id: TerminalThemeId; label: string; theme: ITheme | typeof LIMAN }[] = [
  { id: 'liman', label: 'Liman (follows the app)', theme: LIMAN },
  {
    id: 'one-dark',
    label: 'One Dark',
    theme: palette('#282c34', '#abb2bf', '#528bff', '#3e4451', [
      '#3f4451', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
      '#5c6370', '#ef7b85', '#a9d58a', '#efcd8c', '#74bdf7', '#d38cec', '#66c5d1', '#ffffff'
    ])
  },
  {
    id: 'dracula',
    label: 'Dracula',
    theme: palette('#282a36', '#f8f8f2', '#f8f8f2', '#44475a', [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'
    ])
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    theme: palette('#002b36', '#839496', '#93a1a1', '#073642', [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#586e75', '#cb4b16', '#93a700', '#c89b00', '#4ba3e3', '#6c71c4', '#3cb5ab', '#fdf6e3'
    ])
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    theme: palette('#fdf6e3', '#586e75', '#586e75', '#eee8d5', [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#93a1a1',
      '#586e75', '#cb4b16', '#718200', '#9c7500', '#1f74b0', '#6c71c4', '#228a82', '#657b83'
    ])
  },
  {
    id: 'nord',
    label: 'Nord',
    theme: palette('#2e3440', '#d8dee9', '#d8dee9', '#434c5e', [
      '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#d0747c', '#b4cd9e', '#f0d7a3', '#94b1cf', '#c39fbd', '#8fbcbb', '#eceff4'
    ])
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    theme: palette('#282828', '#ebdbb2', '#ebdbb2', '#504945', [
      '#3c3836', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'
    ])
  }
]

/** The colours of preset `id` (an unknown one falls back to Liman's) for the app's current theme. */
export function terminalTheme(id: string, appTheme: 'light' | 'dark'): ITheme {
  const preset = TERMINAL_THEME_LIST.find((t) => t.id === id)?.theme ?? LIMAN
  return 'light' in preset ? preset[appTheme] : preset
}
