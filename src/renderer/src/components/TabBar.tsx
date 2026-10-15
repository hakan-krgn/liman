import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, Pencil, X, XSquare } from 'lucide-react'
import type { Tab } from '../App'

interface Props {
  tabs: Tab[]
  activeId: string | null
  onActivate(id: string): void
  onClose(id: string): void
  onCloseOthers(id: string): void
  onRename(id: string, title: string): void
  onDuplicate(id: string): void
  /** Moves tab `id` next to `targetId` (after it when `after`). */
  onMove(id: string, targetId: string, after: boolean): void
  /** Bumped by the F2 shortcut to start renaming a tab. */
  renameRequest: { id: string; seq: number } | null
}

type Menu = { x: number; y: number; id: string }

const rightHalf = (e: React.DragEvent): boolean => {
  const r = e.currentTarget.getBoundingClientRect()
  return e.clientX > r.left + r.width / 2
}

/** Returns keyboard focus to the visible terminal. */
const focusTerminal = (): void => {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('.session[style*="flex"] .xterm-helper-textarea')?.focus()
  )
}

export function TabBar(p: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const menuEl = useRef<HTMLDivElement>(null)
  const dragging = useRef<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)

  useEffect(() => {
    if (p.renameRequest) setEditing(p.renameRequest.id)
  }, [p.renameRequest])

  // Keep the active tab in view when it changes or tabs are added.
  useEffect(() => {
    scroller.current
      ?.querySelector<HTMLElement>(`[data-tab="${p.activeId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [p.activeId, p.tabs.length])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  useLayoutEffect(() => {
    const el = menuEl.current
    if (!menu || !el) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))}px`
  }, [menu])

  const endDrag = (): void => {
    dragging.current = null
    setDropAt(null)
  }

  const finishRename = (id: string, value: string | null): void => {
    setEditing(null)
    const title = value?.trim()
    if (title) p.onRename(id, title)
    focusTerminal()
  }

  const menuAction = (fn: () => void) => (): void => {
    setMenu(null)
    fn()
  }

  return (
    <>
      <div
        className="tabs"
        ref={scroller}
        // A plain mouse wheel scrolls the tab strip sideways.
        onWheel={(e) => {
          const el = scroller.current
          if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY
        }}
      >
        {p.tabs.map((t) => (
          <div
            key={t.id}
            data-tab={t.id}
            className={[
              'tab',
              t.id === p.activeId && 'active',
              dropAt?.id === t.id && (dropAt.after ? 'drop-after' : 'drop-before')
            ]
              .filter(Boolean)
              .join(' ')}
            title={t.title}
            draggable={editing !== t.id}
            onMouseDown={(e) => {
              // Middle button: stop Chromium's autoscroll so the click below always closes.
              if (e.button === 1) e.preventDefault()
              else if (e.button === 0) p.onActivate(t.id)
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return
              e.preventDefault()
              p.onClose(t.id)
            }}
            onDoubleClick={() => setEditing(t.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              p.onActivate(t.id)
              setMenu({ x: e.clientX, y: e.clientY, id: t.id })
            }}
            onDragStart={(e) => {
              dragging.current = t.id
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('application/x-liman-tab', t.id)
            }}
            onDragOver={(e) => {
              if (!dragging.current) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropAt({ id: t.id, after: rightHalf(e) })
            }}
            onDrop={(e) => {
              const id = dragging.current
              if (!id) return
              e.preventDefault()
              const after = rightHalf(e)
              endDrag()
              if (id !== t.id) p.onMove(id, t.id, after)
            }}
            onDragEnd={endDrag}
          >
            <span className={`status-dot ${t.status}`} />
            {editing === t.id ? (
              <input
                className="tab-rename"
                autoFocus
                defaultValue={t.title}
                spellCheck={false}
                onFocus={(e) => e.target.select()}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') finishRename(t.id, e.currentTarget.value)
                  else if (e.key === 'Escape') finishRename(t.id, null)
                }}
                onBlur={(e) => editing === t.id && finishRename(t.id, e.currentTarget.value)}
              />
            ) : (
              <span className="tab-title">{t.title}</span>
            )}
            <button
              className="tab-close"
              onMouseDown={(e) => e.button === 0 && e.stopPropagation()}
              onClick={() => p.onClose(t.id)}
              aria-label="Close tab"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      {menu && (
        <div className="menu" ref={menuEl} style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={menuAction(() => setEditing(menu.id))}>
            <Pencil size={14} /> Rename
            <kbd className="menu-key">F2</kbd>
          </button>
          <button onClick={menuAction(() => p.onDuplicate(menu.id))}>
            <Copy size={14} /> Duplicate
          </button>
          <hr />
          <button onClick={menuAction(() => p.onClose(menu.id))}>
            <X size={14} /> Close
          </button>
          <button onClick={menuAction(() => p.onCloseOthers(menu.id))} disabled={p.tabs.length < 2}>
            <XSquare size={14} /> Close others
          </button>
        </div>
      )}
    </>
  )
}
