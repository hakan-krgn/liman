import { useState } from 'react'
import { FolderSearch, X } from 'lucide-react'
import type { AuthType, Host, HostInput } from '@shared/types'
import { api, confirmDialog, errorMessage } from '../lib'
import { parseTarget } from './Sidebar'

interface Props {
  host?: Host
  prefill?: Partial<HostInput>
  onClose(): void
  onSaved(host: Host, connect: boolean): void
  onDeleted(id: string): void
}

const authOptions: { value: AuthType; label: string }[] = [
  { value: 'password', label: 'Password' },
  { value: 'key', label: 'SSH key' },
  { value: 'agent', label: 'Agent' }
]

export function HostForm({ host, prefill, onClose, onSaved, onDeleted }: Props): React.JSX.Element {
  const [f, setF] = useState<HostInput>({
    id: host?.id,
    name: host?.name ?? '',
    host: host?.host ?? prefill?.host ?? '',
    port: host?.port ?? prefill?.port ?? 22,
    username: host?.username ?? prefill?.username ?? '',
    authType: host?.authType ?? 'password',
    keyPath: host?.keyPath ?? '',
    group: host?.group ?? '',
    password: '',
    passphrase: ''
  })
  const [error, setError] = useState('')
  const set = <K extends keyof HostInput>(k: K, v: HostInput[K]): void => setF((x) => ({ ...x, [k]: v }))

  /** Splits "user@host:port" typed into the address field into all three fields. */
  const normalized = (x: HostInput): HostInput => {
    const t = parseTarget(x.host)
    if (!t || !(t.username || /:\d+$/.test(x.host.trim()))) return x
    return { ...x, host: t.host!, username: t.username || x.username, port: t.port ?? x.port }
  }

  // The saved password is tied to address, port and user; changing any of them drops it.
  const moved = !!host && (f.host.trim() !== host.host || Number(f.port) !== host.port || f.username.trim() !== host.username)

  const submit = async (connect: boolean): Promise<void> => {
    const v = normalized(f)
    setF(v)
    if (!v.host.trim()) return setError('Address is required')
    if (!v.username.trim()) return setError('Username is required')
    const port = Number(v.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setError('Port must be between 1 and 65535')
    try {
      const saved = await api.saveHost({ ...v, port, host: v.host.trim(), username: v.username.trim() })
      onSaved(saved, connect)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const remove = async (): Promise<void> => {
    if (!host) return
    if (!(await confirmDialog('Delete host?', `“${host.name}” will be removed from your list.`, 'Delete', true))) return
    await api.deleteHost(host.id)
    onDeleted(host.id)
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal host-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(true)
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-head">
          <h2>{host ? 'Edit host' : 'New host'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="grid">
          <label className="span2">
            <span>Address</span>
            <input
              autoFocus
              value={f.host}
              onChange={(e) => set('host', e.target.value)}
              onBlur={() => setF(normalized)}
              placeholder="192.168.1.10 or user@example.com"
              spellCheck={false}
            />
          </label>
          <label>
            <span>Port</span>
            <input type="number" value={f.port} min={1} max={65535} onChange={(e) => set('port', Number(e.target.value))} />
          </label>
          <label className="span2">
            <span>Username</span>
            <input value={f.username} onChange={(e) => set('username', e.target.value)} placeholder="root" spellCheck={false} />
          </label>
          <label>
            <span>Label</span>
            <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={f.host || 'Optional'} />
          </label>
        </div>

        <div className="segmented">
          {authOptions.map((o) => (
            <button
              type="button"
              key={o.value}
              className={f.authType === o.value ? 'on' : ''}
              onClick={() => set('authType', o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>

        {f.authType === 'password' && (
          <label>
            <span>Password</span>
            <input
              type="password"
              value={f.password}
              onChange={(e) => set('password', e.target.value)}
              placeholder={
                host?.hasPassword && !moved
                  ? '•••••••• (saved — leave empty to keep)'
                  : host?.hasPassword
                    ? 'Address changed — enter the password again'
                    : 'Ask every time if empty'
              }
            />
          </label>
        )}

        {f.authType === 'key' && (
          <>
            <label>
              <span>Private key</span>
              <div className="input-row">
                <input
                  value={f.keyPath}
                  onChange={(e) => set('keyPath', e.target.value)}
                  placeholder="~/.ssh/id_ed25519 (auto-detected if empty)"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const p = await api.pickKey()
                    if (p) set('keyPath', p)
                  }}
                >
                  <FolderSearch size={15} /> Browse
                </button>
              </div>
            </label>
            <label>
              <span>Passphrase</span>
              <input
                type="password"
                value={f.passphrase}
                onChange={(e) => set('passphrase', e.target.value)}
                placeholder={host?.hasPassphrase ? '•••••••• (saved)' : 'Only if the key is encrypted'}
              />
            </label>
          </>
        )}

        {f.authType === 'agent' && (
          <p className="note">
            Uses keys loaded into your SSH agent ({api.platform === 'win32' ? 'Windows OpenSSH Agent service' : 'ssh-agent / Keychain'}).
          </p>
        )}

        <label>
          <span>Group</span>
          <input value={f.group} onChange={(e) => set('group', e.target.value)} placeholder="Optional, e.g. Production" />
        </label>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-foot">
          {host && (
            <button type="button" className="btn ghost danger-text" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={() => void submit(false)}>
            Save
          </button>
          <button type="submit" className="btn primary">
            Save & connect
          </button>
        </div>
      </form>
    </div>
  )
}
