// Monospaced fonts the terminal can use (Settings › Appearance › Font).

/** The terminal's own fallback chain; JetBrains Mono ships with Liman. */
export const TERMINAL_FONT = '"JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace'

const CANDIDATES = [
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'Fira Code',
  'Fira Mono',
  'Source Code Pro',
  'Hack',
  'IBM Plex Mono',
  'Roboto Mono',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Menlo',
  'Monaco',
  'SF Mono',
  'Courier New'
]

/** The font-family value for xterm: the chosen font first, Liman's chain behind it. */
export function terminalFont(family: string): string {
  return family ? `"${family}", ${TERMINAL_FONT}` : TERMINAL_FONT
}

let installed: string[] | null = null

/**
 * Which of the usual monospaced fonts are installed: text drawn in a missing
 * font falls back to the generic one, so its width gives it away.
 */
export function installedMonospaceFonts(): string[] {
  if (installed) return installed
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return []
  const sample = 'mmmmmmmmmmlli1WW@#'
  const width = (font: string): number => {
    ctx.font = `20px ${font}`
    return ctx.measureText(sample).width
  }
  const bases = ['monospace', 'serif', 'sans-serif'].map((b) => [b, width(b)] as const)
  installed = CANDIDATES.filter((name) => bases.some(([base, w]) => width(`"${name}", ${base}`) !== w))
  return installed
}
