import { useEffect, useMemo, useState } from 'react'
import { drilldown, type DrillRequest, type DrillResult } from '../api'
import { Status, type Tone } from './ui'

const PRIORITY_TONE: Record<string, Tone> = { Highest: 'critical', High: 'warning' }

/** The tickets behind a clicked chart mark. Escape or the backdrop closes it. */
export function IssueSheet({ request, onClose, onAsk }: {
  request: DrillRequest | null; onClose: () => void; onAsk: (q: string) => void
}) {
  const [data, setData] = useState<DrillResult | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!request) return
    let alive = true
    setData(null); setError(''); setFilter('')
    drilldown(request).then((d) => alive && setData(d)).catch((e: Error) => alive && setError(e.message))
    return () => { alive = false }
  }, [request])

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, onClose])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!data || !q) return data?.issues ?? []
    return data.issues.filter((i) => [i.key, i.summary, i.status, i.assignee, i.priority, i.creator, i.note, ...(i.problems ?? [])]
      .join(' ').toLowerCase().includes(q))
  }, [data, filter])

  if (!request) return null
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={data?.title ?? 'Tickets'} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>{data?.title ?? 'Loading tickets…'}</h2>
            {data && (
              <p className="card-sub">
                {data.total} ticket{data.total === 1 ? '' : 's'}{data.truncated ? ' (first 200 shown)' : ''}
                {data.note && <> · {data.note}</>}
              </p>
            )}
          </div>
          <div className="card-actions">
            {data && <a className="chip" href={data.jira_link} target="_blank" rel="noreferrer">Open in Jira ↗</a>}
            {data && data.total > 0 && (
              <button className="chip chip-ask" onClick={() => {
                onAsk(data.ask_prompt ?? `Tell me about these tickets: ${data.title}. What stands out and what should I chase?`); onClose()
              }}>
                ✦ Ask about these
              </button>
            )}
            <button className="chip" onClick={onClose} aria-label="Close list">✕</button>
          </div>
        </header>
        {error && <div className="banner">{error}</div>}
        {!data && !error && <div className="skeleton" style={{ height: 220 }} />}
        {data && (
          <>
            {data.total > 6 && (
              <input className="sheet-filter" value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by key, title, status, person…" aria-label="Filter tickets" />
            )}
            {rows.length === 0 ? <p className="muted">No tickets{filter ? ' match that filter' : ''}.</p> : (
              <ul className="sheet-list">
                {rows.map((i, idx) => (
                  // worklog lists can show the same ticket several times, so the index is part of the key
                  <li key={`${i.key}-${idx}`}>
                    <a href={i.url} target="_blank" rel="noreferrer" className="sheet-row">
                      <span className="sheet-key">{i.key}</span>
                      <span className="sheet-body">
                        {i.note !== undefined && (
                          <span className="sheet-note">
                            <code>{i.note || '(empty note)'}</code>
                            <span className="muted small">{[i.time, i.started].filter(Boolean).join(' · ')}</span>
                          </span>
                        )}
                        <span className={`sheet-title ${i.note !== undefined ? 'muted' : ''}`}>{i.summary}</span>
                        <span className="sheet-meta">
                          {i.status && <span className="pill">{i.status}</span>}
                          {i.priority && (PRIORITY_TONE[i.priority]
                            ? <Status tone={PRIORITY_TONE[i.priority]}>{i.priority}</Status>
                            : <span className="muted small">{i.priority}</span>)}
                          <span className="muted small">
                            {i.creator ? `created by ${i.creator}` : i.note !== undefined ? `logged by ${i.assignee}` : i.assignee}
                          </span>
                        </span>
                        {i.problems && i.problems.length > 0 && <span className="sheet-problems">{i.problems.join(' · ')}</span>}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
