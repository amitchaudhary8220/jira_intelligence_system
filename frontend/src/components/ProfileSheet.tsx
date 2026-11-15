import { useEffect, useState } from 'react'
import { getProfile, type Profile } from '../api'

const STAGES: { key: string; label: string; tone: string }[] = [
  { key: 'being_worked_on', label: 'Being worked on', tone: 'info' },
  { key: 'not_started', label: 'Not started', tone: 'neutral' },
  { key: 'waiting_for_release', label: 'Waiting for release', tone: 'warning' },
]

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
const show = (v: number | null | undefined, suffix = '') => (v === null || v === undefined ? '—' : `${v}${suffix}`)

/** Your own profile: what Jira knows about you + what you do in Jira. Fields the Jira token can't read stay empty
 *  ("—") with the reason, and fill in by themselves with a stronger token. */
export function ProfileSheet({ open, me, onClose }: { open: boolean; me: string; onClose: () => void }) {
  const [p, setP] = useState<Profile | null>(null)
  const [error, setError] = useState('')
  const [avatarOk, setAvatarOk] = useState(true)

  useEffect(() => {
    if (!open) return
    setError('')
    getProfile(me).then((d) => { setP(d); setAvatarOk(true) }).catch((e: Error) => setError(e.message))
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, me, onClose])

  if (!open) return null
  const name = p?.name ?? p?.email ?? ''
  const d = p?.last_30_days
  const filled = p?.fields.filter((f) => f.value !== null).length ?? 0

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet profile" role="dialog" aria-modal="true" aria-label="Your profile" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <div className="profile-id">
            {p?.avatar && avatarOk
              ? <img className="profile-avatar" src={p.avatar} alt="" referrerPolicy="no-referrer" onError={() => setAvatarOk(false)} />
              : <span className="profile-avatar profile-initials" aria-hidden>{name ? initials(name) : '?'}</span>}
            <div>
              <h2>{p ? (p.name ?? 'No Jira account linked') : 'Your profile'}</h2>
              <p className="card-sub">{p?.email ?? (error ? '' : 'Loading…')}</p>
            </div>
          </div>
          <div className="card-actions">
            <button className="chip" onClick={onClose} aria-label="Close profile">✕</button>
          </div>
        </header>

        <div className="profile-body">
          {error && <div className="banner">{error}</div>}
          {!p && !error && <div className="skeleton" style={{ height: 240 }} />}

          {p && !p.linked && <p className="profile-note">{p.note}</p>}

          {p?.linked && p.right_now && (
            <section aria-label="Right now">
              <h3 className="profile-h">Right now <span className="muted">· {p.right_now.total} assigned, not finished</span></h3>
              <div className="profile-stages">
                {STAGES.map((s) => (
                  <div key={s.key} className={`profile-stage tone-${s.tone}`}>
                    <strong>{p.right_now!.by_stage[s.key] ?? 0}</strong><span>{s.label}</span>
                  </div>
                ))}
              </div>
              {p.right_now.issues.length > 0 && (
                <ul className="profile-issues">
                  {p.right_now.issues.map((i) => (
                    <li key={i.key}><a href={i.url} target="_blank" rel="noreferrer"><span className="sheet-key">{i.key}</span>
                      <span className="profile-issue-title">{i.summary}</span><span className="muted small">{i.status}</span></a></li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {p?.linked && p.sprint && d && (
            <section aria-label="Numbers">
              <h3 className="profile-h">This sprint and the last 30 days</h3>
              <div className="profile-stats">
                <div><strong>{p.sprint.assigned}</strong><span>In this sprint</span></div>
                <div><strong>{p.sprint.done}</strong><span>Done this sprint</span></div>
                <div><strong>{show(d.finished)}</strong><span>Finished · 30 days</span></div>
                <div><strong>{show(d.bugs_fixed)}</strong><span>Bugs fixed · 30 days</span></div>
                <div><strong>{show(d.bugs_reported)}</strong><span>Bugs reported · 30 days</span></div>
                <div><strong>{show(d.tickets_created)}</strong><span>Tickets created · 30 days</span></div>
                <div><strong>{d.hours_logged}h</strong><span>Logged · {d.worklogs} worklogs</span></div>
                <div><strong>{show(d.worklog_quality_pct, '%')}</strong><span>Worklogs described</span></div>
                <div><strong>{show(d.title_standard_pct, '%')}</strong><span>Titles on standard · {d.titles_checked}</span></div>
              </div>
            </section>
          )}

          {p?.linked && (p.top_features?.length ?? 0) > 0 && (
            <section aria-label="Features">
              <h3 className="profile-h">Features you work on most <span className="muted">· last 90 days</span></h3>
              <div className="chips-list">
                {p.top_features!.map((f) => <span key={f.name} className="person-chip">{f.name} · {f.issues}</span>)}
              </div>
            </section>
          )}

          {p?.linked && (p.recent?.length ?? 0) > 0 && (
            <section aria-label="Recent activity">
              <h3 className="profile-h">Recently updated</h3>
              <ul className="profile-issues">
                {p.recent!.map((i) => (
                  <li key={i.key}><a href={i.url} target="_blank" rel="noreferrer"><span className="sheet-key">{i.key}</span>
                    <span className="profile-issue-title">{i.summary}</span><span className="muted small">{i.status}</span></a></li>
                ))}
              </ul>
            </section>
          )}

          {p && (
            <section aria-label="Profile details">
              <h3 className="profile-h">Profile details <span className="muted">· {filled} of {p.fields.length} available</span></h3>
              <dl className="profile-fields">
                {p.fields.map((f) => (
                  <div key={f.label} className={f.value === null ? 'empty' : ''}>
                    <dt>{f.label}</dt>
                    <dd>{f.value ?? '—'}{f.value === null && f.why && <small>{f.why}</small>}</dd>
                  </div>
                ))}
              </dl>
              <p className="hint">{p.note}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
