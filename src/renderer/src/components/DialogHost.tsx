import { useEffect, useState } from 'react'
import { subscribeDialogs, type DialogSpec, type DialogResult } from '../lib'

type Open = DialogSpec & { id: number; resolve: (r: DialogResult) => void }

export function DialogHost(): React.JSX.Element | null {
  const [dialogs, setDialogs] = useState<Open[]>([])
  useEffect(() => subscribeDialogs(setDialogs), [])
  const top = dialogs[dialogs.length - 1]
  if (!top) return null
  return <Dialog key={top.id} d={top} />
}

function Dialog({ d }: { d: Open }): React.JSX.Element {
  const [inputs, setInputs] = useState(() => (d.input ?? []).map((i) => i.value))
  const primary = [...d.buttons].reverse().find((b) => b.variant === 'primary') ?? d.buttons[d.buttons.length - 1]
  const cancel = d.cancelValue ?? d.buttons.find((b) => b.variant === 'ghost')?.value ?? primary.value
  const done = (value: string): void => d.resolve({ value, inputs })

  return (
    <div className="overlay dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && done(cancel)}>
      <form
        className="modal dialog"
        onSubmit={(e) => {
          e.preventDefault()
          done(primary.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            done(cancel)
          }
        }}
      >
        <h2>{d.title}</h2>
        {d.message && <div className="dialog-msg">{d.message}</div>}
        {d.input?.map((spec, i) => (
          <input
            key={i}
            autoFocus={i === 0}
            type={spec.secret ? 'password' : 'text'}
            placeholder={spec.placeholder}
            value={inputs[i]}
            spellCheck={false}
            onFocus={(e) => !spec.secret && e.target.select()}
            onChange={(e) => setInputs((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
          />
        ))}
        <div className="modal-foot">
          <span className="spacer" />
          {d.buttons.map((b) => (
            <button
              key={b.value}
              type={b === primary ? 'submit' : 'button'}
              className={`btn ${b.variant ?? ''}`}
              autoFocus={!d.input?.length && b === primary}
              onClick={b === primary ? undefined : () => done(b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </form>
    </div>
  )
}
