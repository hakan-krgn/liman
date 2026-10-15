// Host ordering rules, shared by the store (main) and the sidebar (renderer) so a
// drop can be shown immediately and saved with exactly the same result.

type Grouped = { id: string; group?: string }

/** Group name of a host; '' when ungrouped. */
export const groupOf = (h: { group?: string }): string => h.group?.trim() || ''

/**
 * The order the sidebar shows: ungrouped hosts first, then each group (in order
 * of its first host) as one contiguous block.
 */
export function displayOrder<T extends { group?: string }>(hosts: T[]): T[] {
  const groups = new Map<string, T[]>([['', []]])
  for (const h of hosts) {
    const g = groupOf(h)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(h)
  }
  return [...groups.values()].flat()
}

/**
 * Moves a host into `group` ('' = ungrouped), placed before `beforeId`, or at
 * the end of that group when `beforeId` is null. Returns a new array.
 */
export function moveHostIn<T extends Grouped>(hosts: T[], id: string, group: string, beforeId: string | null): T[] {
  const list = displayOrder(hosts)
  const from = list.findIndex((h) => h.id === id)
  if (from < 0) throw new Error('Host not found')
  const host = { ...list[from], group: group.trim() || undefined }
  list.splice(from, 1)
  let at = beforeId ? list.findIndex((h) => h.id === beforeId) : -1
  if (at < 0) {
    const last = list.findLastIndex((h) => groupOf(h) === groupOf(host))
    at = last >= 0 ? last + 1 : list.length
  }
  list.splice(at, 0, host)
  return displayOrder(list)
}

/** Moves a whole group before `beforeGroup` (or to the end when null). Returns a new array. */
export function moveGroupIn<T extends Grouped>(hosts: T[], group: string, beforeGroup: string | null): T[] {
  const ordered = displayOrder(hosts)
  const block = ordered.filter((h) => groupOf(h) === group)
  const rest = ordered.filter((h) => groupOf(h) !== group)
  let at = beforeGroup === null ? -1 : rest.findIndex((h) => groupOf(h) === beforeGroup)
  if (at < 0) at = rest.length
  rest.splice(at, 0, ...block)
  return displayOrder(rest)
}
