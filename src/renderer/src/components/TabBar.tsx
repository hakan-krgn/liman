import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, Pencil, X, XSquare } from 'lucide-react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import type { Tab } from '../App'

interface Props {
  tabs: Tab[]
  activeId: string | null
  onActivate(id: string): void
  onClose(id: string): void
  onCloseOthers(id: string): void
  onRename(id: string, title: string): void
  onDuplicate(id: string): void
  /** New tab order after a drag. */
  onReorder(ids: string[]): void
  /** Bumped by the F2 shortcut to start renaming a tab. */
  renameRequest: { id: string; seq: number } | null
}

type Menu = { x: number; y: number; id: string }

/** Returns keyboard focus to the visible terminal. */
const focusTerminal = (): void => {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('.session[style*="flex"] .xterm-helper-textarea')?.focus()
  )
}

export function TabBar(p: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const menuEl = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  // A few pixels of movement before a drag starts, so clicks, double clicks and
  // middle clicks behave as usual.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

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

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    const ids = p.tabs.map((t) => t.id)
    p.onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))))
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragStart={({ active }) => p.onActivate(String(active.id))}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={p.tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {p.tabs.map((t) => (
              <SortableTab
                key={t.id}
                tab={t}
                active={t.id === p.activeId}
                editing={editing === t.id}
                onActivate={() => p.onActivate(t.id)}
                onClose={() => p.onClose(t.id)}
                onStartRename={() => setEditing(t.id)}
                onFinishRename={(value) => finishRename(t.id, value)}
                onMenu={(x, y) => {
                  p.onActivate(t.id)
                  setMenu({ x, y, id: t.id })
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
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

interface TabProps {
  tab: Tab
  active: boolean
  editing: boolean
  onActivate(): void
  onClose(): void
  onStartRename(): void
  onFinishRename(value: string | null): void
  onMenu(x: number, y: number): void
}

function SortableTab({ tab, active, editing, onActivate, onClose, onStartRename, onFinishRename, onMenu }: TabProps): React.JSX.Element {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: tab.id,
    disabled: editing
  })
  // Enter/Escape finish the rename; the blur that follows must not finish it again.
  const finished = useRef(false)
  useEffect(() => {
    if (editing) finished.current = false
  }, [editing])
  const finish = (value: string | null): void => {
    if (finished.current) return
    finished.current = true
    onFinishRename(value)
  }

  return (
    <div
      ref={setNodeRef}
      data-tab={tab.id}
      className={['tab', active && 'active', isDragging && 'lifted'].filter(Boolean).join(' ')}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      title={tab.title}
      {...attributes}
      {...listeners}
      tabIndex={-1}
      onMouseDown={(e) => {
        // Middle button: stop Chromium's autoscroll so the click below always closes.
        if (e.button === 1) e.preventDefault()
        else if (e.button === 0) onActivate()
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        onClose()
      }}
      onDoubleClick={onStartRename}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <span className={`status-dot ${tab.status}`} />
      {editing ? (
        <input
          className="tab-rename"
          autoFocus
          defaultValue={tab.title}
          spellCheck={false}
          onFocus={(e) => e.target.select()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') finish(e.currentTarget.value)
            else if (e.key === 'Escape') finish(null)
          }}
          onBlur={(e) => finish(e.currentTarget.value)}
        />
      ) : (
        <span className="tab-title">{tab.title}</span>
      )}
      <button
        className="tab-close"
        onPointerDown={(e) => e.button === 0 && e.stopPropagation()}
        onMouseDown={(e) => e.button === 0 && e.stopPropagation()}
        onClick={onClose}
        aria-label="Close tab"
      >
        <X size={13} />
      </button>
    </div>
  )
}
