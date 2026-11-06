import { Fragment, useEffect } from 'react'
import { X } from 'lucide-react'
import { isMac } from '../lib'
import { SCOPE_TITLES, shortcutRows, type Scope } from '../shortcuts'

/** F1: every keyboard shortcut, grouped by where it works. */
export function ShortcutSheet({ onClose }: { onClose(): void }): React.JSX.Element {
  const rows = shortcutRows()
  // Esc or F1 again closes it, wherever the focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'F1') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal shortcut-sheet"
        role="dialog"
        aria-label="Keyboard shortcuts"
      >
        <div className="modal-head">
          <h2>Keyboard shortcuts</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="sheet-columns">
          {(Object.keys(SCOPE_TITLES) as Scope[]).map((scope) => (
            <section key={scope}>
              <h3>{SCOPE_TITLES[scope]}</h3>
              <dl>
                {rows
                  .filter((r) => r.scope === scope)
                  .map((r) => (
                    <Fragment key={r.label}>
                      <dt>{r.label}</dt>
                      <dd>{keys(isMac ? r.mac : r.win)}</dd>
                    </Fragment>
                  ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Keys written as Markdown ("`Ctrl+C` / `F5`"): code spans become key caps. */
function keys(markdown: string): React.ReactNode {
  return markdown.split('`').map((part, i) => (i % 2 ? <kbd key={i}>{part}</kbd> : part))
}
