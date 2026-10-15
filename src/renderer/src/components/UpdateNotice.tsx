import { useEffect, useState } from 'react'
import { ArrowDownToLine, Loader2, RotateCw } from 'lucide-react'
import type { UpdateStatus } from '@shared/types'
import { api } from '../lib'

/** A small card above "New host" while an update is on its way or ready. */
export function UpdateNotice(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    void api.getUpdate().then(setStatus)
    return api.onUpdate(setStatus)
  }, [])

  if (status.state === 'idle') return null

  if (status.state === 'downloading') {
    return (
      <div className="update-notice" title={`Downloading Liman ${status.version}`}>
        <Loader2 size={15} className="spin" />
        <span className="update-text">
          <strong>Updating to {status.version}</strong>
          <span>Downloading… {status.percent}%</span>
        </span>
      </div>
    )
  }

  const ready = status.state === 'ready'
  return (
    <button
      className="update-notice ready"
      onClick={() => (ready ? api.installUpdate() : api.openUpdate())}
      title={ready ? 'Restart Liman to finish updating' : 'Open the download page'}
    >
      {ready ? <RotateCw size={15} /> : <ArrowDownToLine size={15} />}
      <span className="update-text">
        <strong>Liman {status.version} is available</strong>
        <span>{ready ? 'Restart to update' : 'Download the new version'}</span>
      </span>
    </button>
  )
}
