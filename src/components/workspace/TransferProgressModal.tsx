import { ArrowDownToLine, ArrowUpToLine, Ban, CheckCircle2, LoaderCircle, RotateCcw, XCircle } from 'lucide-react'

import type { TransferProgressPayload } from '../../types/domain'

interface TransferProgressModalProps {
  items: TransferProgressPayload[]
  open: boolean
  embedded?: boolean
  onCancel?: (item: TransferProgressPayload) => void
  onRetry?: (item: TransferProgressPayload) => void
  onClose: () => void
}

function directionLabel(item: TransferProgressPayload) {
  if (item.purpose === 'drag-export') {
    return 'Prepare drag copy'
  }

  return item.direction === 'upload' ? 'Upload' : 'Download'
}

function StateIcon({ item }: { item: TransferProgressPayload }) {
  if (item.state === 'completed') {
    return <CheckCircle2 size={16} />
  }

  if (item.state === 'canceled') {
    return <Ban size={16} />
  }

  if (item.state === 'error') {
    return <XCircle size={16} />
  }

  return <LoaderCircle size={16} className="spinning" />
}

function progressPercent(item: TransferProgressPayload) {
  if (typeof item.totalBytes === 'number' && item.totalBytes > 0) {
    return Math.max(0, Math.min(100, Math.round((item.transferredBytes / item.totalBytes) * 100)))
  }

  return item.state === 'completed' ? 100 : null
}

function progressLabel(item: TransferProgressPayload, percent: number | null) {
  if (item.state === 'canceled') {
    return 'Canceled'
  }

  return percent === null ? 'Waiting for size…' : `${percent}%`
}

export function TransferProgressModal({ items, open, embedded = false, onCancel, onRetry, onClose }: TransferProgressModalProps) {
  if (!open) {
    return null
  }

  const busy = items.some((item) => item.state === 'queued' || item.state === 'running')

  return (
    <div className={embedded ? 'transfer-window-embedded' : 'modal-backdrop transfer-backdrop'} role="presentation">
      <div className="transfer-window" role="dialog" aria-modal="true" aria-labelledby="transfer-window-title">
        <div className="transfer-window-header">
          <div>
            <h2 id="transfer-window-title">File Transfer</h2>
            <p>{busy ? 'Transferring files…' : 'Transfer queue complete'}</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            Hide
          </button>
        </div>

        <div className="transfer-window-list">
          {items.length === 0 && (
            <div className="transfer-empty-row">Waiting for transfer details...</div>
          )}
          {items.map((item) => {
            const percent = progressPercent(item)
            const cancellable = item.state === 'queued' || item.state === 'running'
            const retryable = item.state === 'error' && item.retryable === true
            return (
            <div key={item.transferId} className={`transfer-row ${item.state}`}>
              <div className="transfer-row-icon">
                {item.direction === 'upload' ? <ArrowUpToLine size={16} /> : <ArrowDownToLine size={16} />}
              </div>
              <div className="transfer-row-copy">
                <div className="transfer-row-heading">
                  <strong>{item.fileName}</strong>
                  <span>{directionLabel(item)}</span>
                </div>
                <div className="transfer-row-meta">
                  <span>{item.message}</span>
                  <span>{item.remotePath}</span>
                </div>
                <div className="transfer-row-progress">
                  <div className="transfer-progress-track">
                    <div
                    className={`transfer-progress-fill ${percent === null ? 'indeterminate' : ''}`}
                    style={percent === null ? undefined : { width: `${percent}%` }}
                    />
                  </div>
                  <span>
                    {progressLabel(item, percent)}
                  </span>
                </div>
                {item.localPath && (
                  <div className="transfer-row-localpath">{item.localPath}</div>
                )}
              </div>
              <div className="transfer-row-actions">
                <div className={`transfer-row-state ${item.state}`}>
                  <StateIcon item={item} />
                </div>
                {cancellable && onCancel && (
                  <button type="button" onClick={() => onCancel(item)}>
                    Cancel
                  </button>
                )}
                {retryable && onRetry && (
                  <button className="retry" type="button" onClick={() => onRetry(item)}>
                    <RotateCcw size={12} />
                    Retry
                  </button>
                )}
              </div>
            </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
