import { useEffect, useState } from 'react'
import { getSprintReport, getSprints, type DrillRequest, type SprintInfo, type SprintReport } from '../api'
import { Columns, Meter, StackedBars } from './charts'
import { Card, Kpi, Skeleton, SortTable, Status } from './ui'

const OUTCOME_SERIES = [
  { key: 'released', label: 'Released', color: 'var(--series-1)' },
  { key: 'dev_complete', label: 'Dev done, not released', color: 'var(--series-2)' },
  { key: 'in_progress', label: 'Still in progress', color: 'var(--series-3)' },
  { key: 'done_after', label: 'Finished after the sprint', color: 'var(--series-4)' },
  { key: 'not_started', label: 'Not started', color: 'var(--neutral-fill)' },
] as const

const short = (name: string) => name.replace(/^Q\d FY\d+\s*[-–]\s*/, '')

// Per-person sprint stats (Developers, Testers, Highlights) are hidden for now, at the PM's request.
// The API still returns them, so set this to true to bring the three cards back.
const SHOW_PEOPLE_STATS = false

export function Sprints({ ask, drill }: { ask: (q: string) => void; drill: (r: DrillRequest) => void }) {
  const [sprints, setSprints] = useState<SprintInfo[]>([])
  const [sprint, setSprint] = useState('last')
  const [report, setReport] = useState<SprintReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { getSprints().then(setSprints).catch((e: Error) => setError(e.message)) }, [])
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    getSprintReport(sprint).then((r) => alive && setReport(r)).catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [sprint])

  const name = report?.sprint.name ?? ''
  const open = (params: Record<string, string | number | null>) => drill({ kind: 'sprint_outcome', params: { sprint: name, ...params } })
  const t = report?.totals

  return (
    <>
      <div className="scope-bar span-3">
        <label className="field">
          <span className="muted small">Sprint</span>
          <select value={sprint} onChange={(e) => setSprint(e.target.value)} aria-label="Sprint">
            <option value="current">Current sprint</option>
            <option value="last">Last sprint</option>
            {sprints.map((s) => <option key={s.name} value={s.name}>{s.name}{s.state === 'active' ? ' (running)' : ''}</option>)}
          </select>
        </label>
        {report && <span className="muted small">{report.sprint.name} · judged at {report.as_of}</span>}
        {loading && <span className="muted small" aria-live="polite">Loading sprint…</span>}
      </div>
      {error && <div className="banner span-3">{error}</div>}
      {report && report.sprint.still_open_after_end.length > 0 && (
        <div className="banner warn span-3">
          <Status tone="warning">{report.sprint.still_open_after_end.length} boards never closed this sprint after it ended: {report.sprint.still_open_after_end.join(', ')}</Status>
        </div>
      )}

      {!report || !t ? (
        <>
          <div className="kpis">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={150} />)}</div>
          <Skeleton h={300} />
        </>
      ) : (
        <div className={`sprint-grid ${loading ? 'is-loading' : ''}`}>
          <div className="kpis">
            <Kpi label="Delivered" value={t.delivered_pct ?? '–'} unit="%" foot={<>{t.released} of {t.in_sprint} tickets released</>}
              onClick={() => open({ outcome: 'released' })}>
              <Meter value={t.released} max={t.in_sprint} label="Delivered" />
            </Kpi>
            <Kpi label="Not delivered" value={t.not_delivered}
              foot={<>{t.dev_complete} dev done · {t.in_progress} in progress · {t.not_started} not started</>}
              onClick={() => open({ outcome: 'not_delivered' })} />
            <Kpi label="Carried to next sprint" value={t.carried_over} foot={<>{t.done_after} finished after the sprint</>}
              onClick={() => open({ flag: 'carried_over' })} />
            <Kpi label="Added mid-sprint" value={t.added_mid_sprint} foot={<>{t.reopened} reopened during the sprint</>}
              onClick={() => open({ flag: 'added_mid_sprint' })} />
          </div>

          <div className="grid">
            <Card className="span-2" title="Where the sprint's work ended up" subtitle="By project · click a segment to see its tickets"
              onAsk={() => ask(`What failed to get delivered in ${name} and why? Which projects slipped most?`)}
              table={{ columns: ['Project', 'Released', 'Dev done', 'In progress', 'After sprint', 'Not started', 'Total'],
                rows: report.by_project.map((p) => [p.project, p.released, p.dev_complete, p.in_progress, p.done_after, p.not_started, p.total]) }}>
              <StackedBars rows={report.by_project.slice(0, 10).map((p) => ({ label: p.project, ...p }))}
                series={OUTCOME_SERIES.map((s) => ({ ...s }))}
                onSelect={(project, key) => open({ project, outcome: key })} />
            </Card>
            <Card title="Delivered % by sprint" subtitle="Click a sprint to open it"
              table={{ columns: ['Sprint', 'Delivered', 'Total', '%'], rows: report.trend.map((x) => [x.name, x.delivered, x.total, x.delivered_pct ?? '–']) }}>
              <Columns rows={report.trend.map((x) => ({ id: x.name, label: short(x.name), value: x.delivered_pct ?? 0,
                tip: `${x.name}: ${x.delivered} of ${x.total} delivered${x.state === 'active' ? ' (running)' : ''}` }))}
                unit="% delivered" action="Open sprint" onSelect={(r) => r.id && setSprint(r.id)} />
            </Card>

            {SHOW_PEOPLE_STATS && (<>
            <Card className="span-3" title="Highlights" subtitle="A leader per metric, not one combined score">
              {report.highlights.length === 0 ? <p className="muted">No highlights yet.</p> : (
                <div className="highlights">
                  {report.highlights.map((h) => (
                    <div key={h.title} className="highlight">
                      <span className="muted small">{h.title}</span>
                      <b>{h.name}</b>
                      <span className="small">{h.value} {h.unit}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="hint">Hours reward logging, ticket counts ignore size (story points aren't used), and bug counts depend on how hard the area is. Use these to start a conversation, not as a verdict.</p>
            </Card>

            <Card className="span-2" title="Developers" subtitle="Click a name to see their tickets in this sprint · click a column to sort"
              onAsk={() => ask(`In ${name}, which developers delivered the most with the fewest bugs and reopens?`)}>
              <SortTable rows={report.developers} initial="delivered" onRow={(r) => open({ person: r.name })}
                rowLabel={(r) => `${r.name}: show sprint tickets`}
                cols={[
                  { key: 'name', label: 'Person' },
                  { key: 'delivered', label: 'Delivered', num: true },
                  { key: 'subtasks_done', label: 'Sub-tasks', num: true },
                  { key: 'not_delivered', label: 'Not delivered', num: true },
                  { key: 'hours', label: 'Hours logged', num: true },
                  { key: 'bugs_in_their_work', label: 'Bugs in their work', num: true },
                  { key: 'reopened', label: 'Reopened', num: true },
                ]} />
            </Card>
            <Card title="Testers" subtitle={`${report.bugs_found.valid} valid bugs found during the sprint`}
              onAsk={() => ask(`Which testers found the most valid and high-priority bugs in ${name}?`)}>
              <SortTable rows={report.testers} initial="valid"
                cols={[
                  { key: 'name', label: 'Person' },
                  { key: 'valid', label: 'Valid bugs', num: true },
                  { key: 'high_priority', label: 'High+', num: true },
                  { key: 'invalid_pct', label: 'Invalid %', num: true },
                ]} />
            </Card>
            </>)}
          </div>
        </div>
      )}
    </>
  )
}
