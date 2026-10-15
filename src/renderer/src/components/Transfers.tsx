import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowLeftRight, ArrowUp, Check, X } from 'lucide-react'
import type { Transfer } from '@shared/types'
import { api, formatBytes } from '../lib'

export function Transfers(): React.JSX.Element | null {
  const [items, setItems] = useState<Transfer[]>([])
  const started = useRef(new Map<string, number>())

  const dismiss = (id: string): void => {
    setItems((xs) => xs.filter((x) => x.id !== id))
    started.current.delete(id)
  }

  useEffect(
    () =>
      api.onTransfer((t) => {
        if (!started.current.has(t.id)) started.current.set(t.id, Date.now())
        setItems((xs) => (xs.some((x) => x.id === t.id) ? xs.map((x) => (x.id === t.id ? t : x)) : [...xs, t]))
        if (t.status === 'done' || t.status === 'cancelled') setTimeout(() => dismiss(t.id), t.direction === 'down' ? 6000 : 3000)
      }),
    []
  )

  if (!items.length) return null

  return (
    <div className="transfers">
      {items.map((t) => {
        const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.status === 'done' ? 100 : 0
        const secs = (Date.now() - (started.current.get(t.id) ?? Date.now())) / 1000
        const speed = secs > 0.5 ? t.done / secs : 0
        const Icon = t.direction === 'up' ? ArrowUp : t.direction === 'copy' ? ArrowLeftRight : ArrowDown
        const route = t.direction === 'copy' ? `${t.sourceHost} → ${t.targetHost}:${t.target}` : t.target
        return (
          <div key={t.id} className={`transfer ${t.status}`}>
            <div className="transfer-icon">
              {t.status === 'done' ? <Check size={15} /> : t.status === 'error' ? <AlertCircle size={15} /> : <Icon size={15} />}
            </div>
            <div className="transfer-body">
              <div className="transfer-title">
                <span className="label">{t.label}</span>
                {t.status === 'running' && <span className="pct">{Math.floor(pct)}%</span>}
              </div>
              <div
                className={`transfer-sub ${t.status === 'done' && t.direction === 'down' ? 'clickable' : ''}`}
                onClick={() => t.status === 'done' && t.direction === 'down' && api.showItem(t.target)}
                title={route}
              >
                {t.status === 'error'
                  ? t.error
                  : t.status === 'cancelled'
                    ? 'Cancelled'
                    : t.status === 'done'
                      ? t.direction === 'down'
                        ? 'Saved — show in folder'
                        : t.direction === 'copy'
                          ? `Copied to ${t.targetHost}:${t.target}`
                          : `Uploaded to ${t.target}`
                      : `${formatBytes(t.done)} of ${formatBytes(t.total)}${speed ? ` · ${formatBytes(speed)}/s` : ''}${
                          t.direction === 'copy' ? ` · ${t.sourceHost} → ${t.targetHost}` : ''
                        }`}
              </div>
              {t.status === 'running' && (
                <div className="bar">
                  <div style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
            <button
              className="icon-btn"
              onClick={() => (t.status === 'running' ? api.cancelTransfer(t.id) : dismiss(t.id))}
              title={t.status === 'running' ? 'Cancel' : 'Dismiss'}
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
