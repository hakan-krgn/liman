// Helpers for remote (POSIX) paths and shell commands, shared by main and renderer.

/** Quotes a string as one POSIX shell word: 'it'\''s'. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** True when remote `path` is `dir` itself or somewhere below it. */
export function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)
}
