import type { HostInput } from './types'

/** "user@host:port" -> host fields, for quick connect from the search box. */
export function parseTarget(text: string): Partial<HostInput> | null {
  const m = text.trim().match(/^(?:([^@\s]+)@)?([\w.-]+|\[[\da-f:]+\])(?::(\d+))?$/i)
  if (!m || !m[2].includes('.') && !m[1]) return null
  return { username: m[1] ?? '', host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : 22 }
}
