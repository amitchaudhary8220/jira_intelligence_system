import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { getTimeLog, saveDayReason, type TimeLog as TimeLogData, type TimeRow } from '../api'

// Calendar view of your own time log, like Tempo / Clockify: one square per day, colour = met / short / today / off.
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS_BACK = 12
/** 5.5 -> "5h 30m", 5 -> "5h", 0.25 -> "15m" (how time trackers like Tempo show it). */
const h = (hours: number) => {
  const mins = Math.round(hours * 60)
  const H = Math.floor(mins / 60), M = mins % 60
  return H && M ? `${H}h ${M}m` : H ? `${H}h` : `${M ? M + 'm' : '0h'}`
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const monthKey = (d: Date) => iso(d).slice(0, 7)
const addMonths = (key: string, n: number) => { const [y, m] = key.split('-').map(Number); return monthKey(new Date(y, m - 1 + n, 1)) }
const monthLabel = (key: string) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }
const longDay = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
const shortDay = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const LINKED = new Set(['made_up', 'comp_off'])                  // reasons that point at the day the extra time was worked
const TAG: Record<string, string> = { made_up: 'Made up', comp_off: 'Comp off' }   // short labels for the squares
const reasonText = (r: TimeRow['reason'], reasons: Record<string, string>) =>
  r ? `${reasons[r.reason] ?? r.reason}${r.other_day ? ` (${shortDay(r.other_day)})` : ''}${r.note ? ` · ${r.note}` : ''}` : ''


function statusLabel(r: TimeRow, need: number) {
  return {
    met: `${h(r.logged_hours)} logged${r.extra ? ` · ${h(r.extra)} extra` : ''}`,
    short: `${h(r.logged_hours)} of ${h(need)} · ${h(r.short_by)} short`,
    in_progress: `${h(r.logged_hours)} so far today`,
    weekend: r.logged_hours ? `Weekend · ${h(r.logged_hours)} extra` : 'Weekend · off',
  }[r.status]
}

export function TimeLog({ me }: { me: string }) {
  const thisMonth = monthKey(new Date())
  const [month, setMonth] = useState(thisMonth)
  const [data, setData] = useState<TimeLogData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)           // phones: the day details slide up as a bottom sheet

  const load = useCallback(() => {
    setLoading(true)
    getTimeLog(month, me)
      .then((d) => { setData(d); setError(''); setSelected((s) => (s && s.startsWith(month) ? s : d.rows[0]?.date ?? null)) })
      .catch((e: Error) => setError(e.message)).finally(() => setLoading(false))
  }, [month, me])
  useEffect(() => { load() }, [load])
  useEffect(() => {                                            // Esc closes the bottom sheet
    if (!sheetOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheetOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetOpen])

  const byDate = useMemo(() => new Map((data?.rows ?? []).map((r) => [r.date, r])), [data])
  const cells = useMemo(() => {
    const [y, m] = month.split('-').map(Number)
    const first = new Date(y, m - 1, 1)
    const count = new Date(y, m, 0).getDate()
    const lead = (first.getDay() + 6) % 7                    // Monday-first grid
    const out: (string | null)[] = Array(lead).fill(null)
    for (let d = 1; d <= count; d++) out.push(iso(new Date(y, m - 1, d)))
    while (out.length % 7) out.push(null)
    return out
  }, [month])

  const pick = (day: string) => { setSelected(day); setSheetOpen(true) }
  // Arrow keys move between days like a real calendar: left/right = one day, up/down = one week
  const onCellKey = (e: ReactKeyboardEvent, day: string) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
    if (!step) return
    e.preventDefault()
    const d = new Date(day + 'T00:00:00'); d.setDate(d.getDate() + step)
    const target = iso(d)
    if (!byDate.has(target)) return                          // outside this month, or a future day
    setSelected(target)
    document.querySelector<HTMLButtonElement>(`[data-date="${target}"]`)?.focus()
  }

  const onSaved = (day: string, reason: TimeRow['reason']) =>
    setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.date === day ? { ...r, reason } : r)) } : d))

  if (error) return <div className="banner span-3">{error}</div>
  if (!data) return <div className="skeleton span-3" style={{ height: 420 }} />
  const need = data.required_hours_per_day ?? 5
  const s = data.summary
  const sel = selected ? byDate.get(selected) : undefined
  const oldest = addMonths(thisMonth, -(MONTHS_BACK - 1))

  return (
    <>
      <section className="card span-3 timelog-head">
        <div>
          <h2>Your time log</h2>
          <p className="card-sub">{need}h a day, Monday to Friday · Saturday and Sunday are off{data.timezone ? ` · ${data.timezone}` : ''}</p>
        </div>
        <div className="timelog-nav" aria-busy={loading}>
          <button type="button" className="icon-btn" onClick={() => setMonth((m) => addMonths(m, -1))} disabled={month <= oldest}
            aria-label="Previous month">‹</button>
          <strong className="timelog-month" aria-live="polite">{monthLabel(month)}</strong>
          <button type="button" className="icon-btn" onClick={() => setMonth((m) => addMonths(m, 1))} disabled={month >= thisMonth}
            aria-label="Next month">›</button>
          {month !== thisMonth && <button type="button" className="chip" onClick={() => setMonth(thisMonth)}>This month</button>}
        </div>
      </section>

      {!data.linked && <div className="banner span-3">{data.note}</div>}

      {data.linked && s && (
        <section className="span-3 timelog-stats" aria-label="Month summary">
          <div className="card"><strong>{s.days_met} / {s.working_days}</strong><span>working days with {need}h or more{s.today_in_progress ? ' · today in progress' : ''}</span></div>
          <div className="card"><strong>{h(s.logged_hours)}</strong><span>logged this month{s.extra_hours ? ` · ${h(s.extra_hours)} extra on ${s.days_over} ${s.days_over === 1 ? 'day' : 'days'}` : ''}</span></div>
          <div className="card"><strong className={s.short_hours ? 'bad' : 'good'}>{h(s.short_hours)}</strong><span>short of the requirement · {s.days_short} {s.days_short === 1 ? 'day' : 'days'}{s.made_up_hours ? ` · ${h(s.made_up_hours)} made up` : ''}</span></div>
          <div className="card"><strong>{data.rows.filter((r) => r.status === 'short' && r.reason).length} / {s.days_short}</strong><span>short days with a reason</span></div>
        </section>
      )}

      {data.linked && (
        <div className="span-3 cal-layout">
        <section className="card cal-main" aria-label={`Calendar for ${monthLabel(month)}`}>
          <div className="cal-grid cal-head" aria-hidden>{WEEKDAYS.map((w) => <span key={w} className={w === 'Sat' || w === 'Sun' ? 'off' : ''}>{w}</span>)}</div>
          <div className="cal-grid">
            {cells.map((day, i) => {
              if (!day) return <span key={`pad-${i}`} className="cal-cell pad" aria-hidden />
              const r = byDate.get(day)
              const num = Number(day.slice(8))
              if (!r) return <span key={day} className={`cal-cell future ${[5, 6].includes(i % 7) ? 'weekend' : ''}`} aria-hidden><span className="cal-num">{num}</span></span>
              const pct = r.weekend ? 0 : Math.min(100, Math.round((r.logged_hours / (need || 1)) * 100))
              return (
                <button key={day} type="button" data-date={day} onClick={() => pick(day)} onKeyDown={(e) => onCellKey(e, day)}
                  aria-pressed={selected === day}
                  className={`cal-cell ${r.status} ${selected === day ? 'selected' : ''} ${day === data.today ? 'today' : ''}`}
                  aria-label={`${longDay(day)}: ${statusLabel(r, need)}${r.reason ? `. Reason: ${reasonText(r.reason, data.reasons)}` : ''}${r.covers ? `. Makes up for ${r.covers.days.map(shortDay).join(', ')}` : ''}`}>
                  <span className="cal-num">{num}</span>
                  {r.reason && <span className={`cal-reason ${LINKED.has(r.reason.reason) ? 'linked' : ''}`}>{TAG[r.reason.reason] ?? data.reasons[r.reason.reason] ?? r.reason.reason}</span>}
                  {!r.reason && !!r.extra && <span className={`cal-extra ${r.covers ? 'used' : ''}`}>+{h(r.extra)}{r.covers ? ' ↺' : ''}</span>}
                  <span className="cal-hours">
                    <span className="full">{r.weekend && !r.logged_hours ? 'Off' : h(r.logged_hours)}</span>
                    <span className="compact" aria-hidden>{r.weekend && !r.logged_hours ? 'Off' : `${+r.logged_hours.toFixed(1)}h`}</span>
                  </span>
                  {!r.weekend && <span className="cal-bar" aria-hidden><i style={{ width: `${pct}%` }} /></span>}
                </button>
              )
            })}
          </div>
          <div className="cal-legend" aria-hidden>
            <span><i className="met" />{need}h or more</span><span><i className="short" />Short</span>
            <span><i className="today" />Today</span><span><i className="weekend" />Weekend (off)</span>
            <span className="cal-keys">Tip: arrow keys move between days</span>
          </div>
        </section>
        {/* Desktop: a panel beside the calendar (both visible). Phones: a bottom sheet over the calendar. */}
        <div className={`cal-sheet-backdrop ${sheetOpen ? 'open' : ''}`} onClick={() => setSheetOpen(false)} aria-hidden />
        <aside className={`cal-side ${sheetOpen ? 'open' : ''}`}>
          {sel ? <DayDetail key={sel.date} row={sel} need={need} reasons={data.reasons} me={me} onSaved={onSaved}
                    candidates={data.rows.filter((x) => (x.extra ?? 0) > 0 && x.date !== sel.date)} onPick={pick}
                    onClose={() => setSheetOpen(false)} />
               : <section className="card cal-detail cal-empty"><p className="muted">Click a day to see its tickets and hours.</p></section>}
        </aside>
        </div>
      )}
      {data.linked && <p className="hint span-3">{data.note} Reasons are saved in Jira Pulse only (never written to Jira), only you can see yours, and they can be changed for the last 62 days.</p>}
    </>
  )
}

function DayDetail({ row, need, reasons, me, onSaved, onClose, candidates, onPick }: {
  row: TimeRow; need: number; reasons: Record<string, string>; me: string; onSaved: (day: string, r: TimeRow['reason']) => void
  onClose: () => void; candidates: TimeRow[]; onPick: (day: string) => void
}) {
  const canExplain = (row.status === 'short' || row.status === 'in_progress') && row.editable !== false
  return (
    <section className="card cal-detail" aria-label={`Details for ${longDay(row.date)}`}>
      <span className="cal-grabber" aria-hidden />
      <div className="cal-detail-head">
        <h3>{longDay(row.date)}</h3>
        <button type="button" className="chip cal-close" onClick={onClose} aria-label="Close day details">✕</button>
        <span className={`timelog-pill ${row.status}`}>{row.status === 'met' ? '✓ ' : row.status === 'short' ? '✕ ' : ''}{statusLabel(row, need)}</span>
      </div>
      {row.tickets.length ? (
        <ul className="timelog-tickets">
          {row.tickets.map((t) => (
            <li key={t.key}>
              <a href={t.url} target="_blank" rel="noreferrer"><span className="sheet-key">{t.key}</span></a>
              <span className="timelog-ticket-title">{t.summary}<small className="muted"> · {t.status}</small>
                {t.notes.length > 0 && <small className="timelog-notes">{t.notes.join(' · ')}</small>}</span>
              <span className="timelog-hours">{h(t.hours)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{row.weekend ? 'Weekend: nothing needed.' : 'No time logged on this day.'}</p>}
      {row.covers && (
        <div className={`cal-covers ${row.covers.over_claimed ? 'warn' : ''}`}>
          <span>{h(row.extra ?? 0)} extra here made up for{' '}
            {row.covers.days.map((d, i) => <span key={d}>{i > 0 && ', '}<button type="button" className="link-btn" onClick={() => onPick(d)}>{shortDay(d)}</button></span>)}
            {' '}({h(row.covers.hours)} short in total).</span>
          {row.covers.over_claimed && <b role="alert">More time is claimed than was extra on this day.</b>}
        </div>
      )}
      {canExplain && <ReasonEditor row={row} reasons={reasons} me={me} onSaved={onSaved} candidates={candidates} />}
      {!canExplain && row.reason && (
        <p className="timelog-reason saved">Reason: <b>{reasonText(row.reason, reasons)}</b>
          {row.editable === false && <small className="muted"> (older than 62 days: read-only)</small>}</p>
      )}
    </section>
  )
}

function ReasonEditor({ row, reasons, me, onSaved, candidates }: {
  row: TimeRow; reasons: Record<string, string>; me: string; onSaved: (day: string, r: TimeRow['reason']) => void
  candidates: TimeRow[]
}) {
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState(row.reason?.reason ?? '')
  const [note, setNote] = useState(row.reason?.note ?? '')
  const [otherDay, setOtherDay] = useState(row.reason?.other_day ?? candidates[0]?.date ?? '')
  const [typed, setTyped] = useState(false)                      // "Another date…" chosen: show a date field
  const linked = LINKED.has(reason)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (value: string | null) => {
    setBusy(true); setError('')
    try {
      const saved = await saveDayReason(row.date, value, value ? note : '', me, value && LINKED.has(value) ? otherDay || null : null)
      onSaved(row.date, saved.reason ? { reason: saved.reason, note: saved.note, other_day: saved.other_day ?? null } : null)
      setEditing(false)
      if (!value) { setReason(''); setNote('') }
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  if (row.reason && !editing) {
    return (
      <div className="timelog-reason saved">
        <span>Reason: <b>{reasonText(row.reason, reasons)}</b></span>
        <button type="button" className="chip" onClick={() => setEditing(true)}>Edit</button>
        <button type="button" className="chip" onClick={() => save(null)} disabled={busy} aria-label={`Remove the reason for ${row.date}`}>Remove</button>
      </div>
    )
  }
  return (
    <form className="timelog-reason" onSubmit={(e) => { e.preventDefault(); if (reason) save(reason) }}>
      <label className="muted small" htmlFor={`reason-${row.date}`}>Why less than required?</label>
      <select id={`reason-${row.date}`} value={reason} onChange={(e) => setReason(e.target.value)} aria-label={`Reason for ${row.date}`}>
        <option value="">Choose a reason…</option>
        {Object.entries(reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      {linked && (candidates.length && !typed ? (
        <select value={otherDay} aria-label={`Day the extra time was worked for ${row.date}`}
          onChange={(e) => (e.target.value === '__other' ? (setTyped(true), setOtherDay('')) : setOtherDay(e.target.value))}>
          {candidates.map((c) => <option key={c.date} value={c.date}>{shortDay(c.date)} · +{h(c.extra ?? 0)} extra</option>)}
          <option value="__other">Another date…</option>
        </select>
      ) : (
        <input type="date" value={otherDay}
          onChange={(e) => setOtherDay(e.target.value)} aria-label={`Day the extra time was worked for ${row.date}`} />
      ))}
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} aria-label={`Note for ${row.date}`}
        placeholder={reason === 'other' ? 'Write the reason (required)' : 'Note (optional)'} />
      <button type="submit" className="chip chip-ask" disabled={busy || !reason || (reason === 'other' && !note.trim()) || (linked && !otherDay)}>Save</button>
      {editing && <button type="button" className="chip" onClick={() => setEditing(false)}>Cancel</button>}
      {error && <span className="timelog-error" role="alert">{error}</span>}
    </form>
  )
}
