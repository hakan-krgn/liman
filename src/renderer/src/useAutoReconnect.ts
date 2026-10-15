import { useCallback, useEffect, useRef, useState } from 'react'
import type { Tab } from './App'

/** Seconds to wait before each retry; the last value repeats. */
const DELAYS = [1, 2, 5, 10, 20, 30]
/** About five minutes of trying in total. */
const MAX_ATTEMPTS = 14
/** Failures retrying cannot fix. */
const PERMANENT = /authentication|host key|host not found/i

export interface Retry {
  attempt: number
  /** When the next try starts; null while a try is in progress. */
  at: number | null
}

/**
 * Reconnects a tab whose connection dropped by itself (sleep/wake, Wi-Fi or
 * VPN changes, a server restart), backing off between tries and retrying right
 * away when the network comes back.
 */
export function useAutoReconnect(
  tab: Tab,
  reconnect: () => void,
  onRestored: () => void
): { retry: Retry | null; stop(): void; now(): void } {
  const [retry, setRetry] = useState<Retry | null>(null)
  const current = useRef(retry)
  current.current = retry
  const actions = useRef({ reconnect, onRestored })
  actions.current = { reconnect, onRestored }

  useEffect(() => {
    const r = current.current
    if (tab.status === 'connecting') return
    if (tab.status === 'connected') {
      if (r) {
        setRetry(null)
        actions.current.onRestored()
      }
      return
    }
    const droppedNow = tab.status === 'closed' && tab.lost
    const retryFailed = r !== null && tab.status === 'error' && !PERMANENT.test(tab.message ?? '')
    if (!droppedNow && !retryFailed) {
      if (r) setRetry(null)
      return
    }
    const attempt = (r?.attempt ?? 0) + 1
    if (attempt > MAX_ATTEMPTS) return setRetry(null)
    const delay = DELAYS[Math.min(attempt - 1, DELAYS.length - 1)] * 1000
    setRetry({ attempt, at: Date.now() + delay })
  }, [tab.status, tab.message, tab.lost, tab.attempt])

  const now = useCallback(() => {
    setRetry((r) => (r ? { ...r, at: null } : r))
    actions.current.reconnect()
  }, [])

  // Fire the scheduled try.
  useEffect(() => {
    if (!retry?.at) return
    const timer = setTimeout(now, Math.max(0, retry.at - Date.now()))
    return () => clearTimeout(timer)
  }, [retry?.at, now])

  // Network back (e.g. after waking up): don't wait for the timer.
  useEffect(() => {
    const onOnline = (): void => {
      if (current.current?.at) now()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [now])

  const stop = useCallback(() => setRetry(null), [])
  return { retry, stop, now }
}
