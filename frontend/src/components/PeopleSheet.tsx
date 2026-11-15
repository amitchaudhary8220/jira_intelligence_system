import { useEffect, useMemo, useState } from 'react'
import type { DrillRequest } from '../api'

export type PeopleGroup = {
  title: string
  subtitle?: string
  people: { name: string; detail: string; drill?: DrillRequest }[]
}

/** The people behind one part of the availability bar. Click a person to see their tickets. */
export function PeopleSheet({ group, onClose, onDrill }: {
  group: PeopleGroup | null; onClose: () => void; onDrill: (r: DrillRequest) => void
}) {
  const [filter, setFilter] = useState('')
  useEffect(() => {
    if (!group) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [group, onClose])
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (group?.people ?? []).filter((p) => !q || `${p.name} ${p.detail}`.toLowerCase().includes(q))
  }, [group, filter])
  if (!group) return null

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={group.title} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>{group.title}</h2>
            <p className="card-sub">{group.people.length} {group.people.length === 1 ? 'person' : 'people'}{group.subtitle ? ` · ${group.subtitle}` : ''}</p>
          </div>
          <div className="card-actions">
            <button className="chip" onClick={onClose} aria-label="Close list">✕</button>
          </div>
        </header>
        {group.people.length > 6 && (
          <input className="sheet-filter" value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name…" aria-label="Filter people" />
        )}
        {rows.length === 0 ? <p className="muted">Nobody{filter ? ' matches that filter' : ''}.</p> : (
          <ul className="sheet-list">
            {rows.map((p) => (
              <li key={p.name}>
                {p.drill ? (
                  <button type="button" className="sheet-row person-row" onClick={() => { onClose(); onDrill(p.drill!) }}
                    aria-label={`${p.name}: ${p.detail}. Show their tickets`}>
                    <span className="person-name">{p.name}</span>
                    <span className="muted small">{p.detail}</span>
                    <span className="person-go" aria-hidden>Tickets →</span>
                  </button>
                ) : (
                  <div className="sheet-row person-row">
                    <span className="person-name">{p.name}</span>
                    <span className="muted small">{p.detail}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
