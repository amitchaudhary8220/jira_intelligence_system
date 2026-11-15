import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getBugs, getDashboard, getPeople, getProjects, getSession, logout, type Session, type Dashboard, type DrillRequest, type Person, type Project } from './api'
import { BarList, Columns, Meter, SegmentedBar, Sparkline, StackedBars } from './components/charts'
import { AskBar, ChatPanel, useChat } from './components/ChatPanel'
import { Guide } from './components/Guide'
import { Login } from './components/Login'
import { Sprints } from './components/Sprints'
import { useTheme } from './components/useTheme'
import { IssueSheet } from './components/IssueSheet'
import { PeopleSheet, type PeopleGroup } from './components/PeopleSheet'
import { ProfileSheet } from './components/ProfileSheet'
import { TimeLog } from './components/TimeLog'
import { Card, Kpi, Skeleton, Status, type Tone } from './components/ui'

type Tab = 'overview' | 'sprints' | 'bugs' | 'people' | 'standards' | 'timelog' | 'guide'
const TABS: Tab[] = ['overview', 'sprints', 'bugs', 'people', 'standards', 'timelog', 'guide']
const BUG_WINDOWS = [7, 30, 90] as const

const weekLabel = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** "kavya iyer" -> "Kavya Iyer" (Jira names aren't always capitalised). */
const titleCase = (s: string) => s.replace(/(^|\s)(\p{L})/gu, (_, sp: string, c: string) => sp + c.toUpperCase())

/** The usual "sign out" icon: a door with an arrow leaving it (same stroke style as the other top-bar icons). */
const SignOutIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>
)

const ProfileIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
)

function greeting(name: string) {
  const h = new Date().getHours()
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  return name ? `${part}, ${name.split(' ')[0]}` : part
}

type Alert = { tone: Tone; title: string; detail: string; tab?: Tab; ask?: string }

/** The few things worth a PM's attention today, worst first. Pure rules over the dashboard data. */
function buildAlerts(d: Dashboard): Alert[] {
  const out: Alert[] = []
  const top = [...d.sprint.pipeline].sort((a, b) => b.count - a.count)[0]
  const highest = d.bugs.high_priority_open.filter((b) => b.priority === 'Highest').length
  if (d.bugs.high_priority_open.length)
    out.push({
      tone: highest ? 'critical' : 'warning',
      title: `${d.bugs.high_priority_open.length} high-priority bugs still open`,
      detail: highest ? `${highest} marked Highest` : 'All marked High',
      tab: 'bugs', ask: 'List the open Highest and High priority bugs and who owns them',
    })
  if (top && top.status !== 'To Do' && top.count > d.sprint.open * 0.2)
    out.push({
      tone: 'warning', title: `${top.count} issues stuck in “${top.status}”`,
      detail: `${Math.round((top.count / d.sprint.open) * 100)}% of open sprint work`,
      tab: 'overview', ask: `Which issues are waiting in "${top.status}" and for how long?`,
    })
  if (d.activity.busy_but_inactive.length)
    out.push({
      tone: 'warning', title: `${d.activity.busy_but_inactive.length} people busy on paper, quiet in Jira`,
      detail: `Active issues but no updates in ${d.inactive_days} days`,
      tab: 'people', ask: `Who has active issues but no Jira activity in the last ${d.inactive_days} days?`,
    })
  const naming = d.standards.naming.compliance_pct ?? 100
  if (naming < 85)
    out.push({
      tone: naming < 60 ? 'critical' : 'warning', title: `${100 - naming}% of new tickets break the naming standard`,
      detail: `${d.standards.naming.tickets_checked - d.standards.naming.compliant} of ${d.standards.naming.tickets_checked} titles`,
      tab: 'standards', ask: 'Who is not following the ticket naming standard? Suggest better titles.',
    })
  const wl = d.standards.worklogs.compliance_pct ?? 100
  if (wl < 85)
    out.push({
      tone: 'warning', title: `${100 - wl}% of worklogs have no real description`,
      detail: `e.g. just “[Dev]”, last ${d.standards.worklogs.days} days`,
      tab: 'standards', ask: 'Who logs time without a proper worklog description this week?',
    })
  if (d.team.free_idle)
    out.push({
      tone: 'info', title: `${d.team.free_idle} developers have nothing queued`,
      detail: 'Free to pick up work', tab: 'people', ask: 'Who is free right now and what could they pick up?',
    })
  return out
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionError, setSessionError] = useState('')
  const loadSession = useCallback(() => {
    getSession().then(setSession).catch((e: Error) => setSessionError(e.message))
  }, [])
  useEffect(() => { loadSession() }, [loadSession])

  if (!session) {
    return sessionError ? <div className="page"><div className="banner">{sessionError}</div></div> : <div className="page"><div className="skeleton" style={{ height: 200 }} /></div>
  }
  if (session.auth === 'password' && !session.user) return <Login onDone={loadSession} />
  if ((session.auth === 'proxy' || session.auth === 'cloudflare') && !session.user) {
    return <div className="page"><div className="banner">You are not signed in. Open this app through your company sign-in link.</div></div>
  }
  return <Dashboard session={session} />
}

function Dashboard({ session }: { session: Session }) {
  const [people, setPeople] = useState<Person[]>([])
  const [me, setMe] = useState('')
  const [data, setData] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bugDays, setBugDays] = useState<number>(30)
  const [tab, setTabState] = useState<Tab>(() => {
    const h = window.location.hash.replace('#', '') as Tab
    return TABS.includes(h) ? h : 'overview'
  })
  const setTab = useCallback((t: Tab) => {
    setTabState(t)
    window.history.replaceState(null, '', t === 'overview' ? window.location.pathname : `#${t}`)
  }, [])
  const [chatOpen, setChatOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const closeProfile = useCallback(() => setProfileOpen(false), [])
  const [drillReq, setDrillReq] = useState<DrillRequest | null>(null)
  const closeDrill = useCallback(() => setDrillReq(null), [])
  const chat = useChat(me)
  const theme = useTheme()

  useEffect(() => {
    getPeople()
      .then((d) => {
        const list = d.people.some((p) => p.account_id === d.me)
          ? d.people
          : [{ account_id: d.me, name: d.me_name || 'Me', role: 'unknown' }, ...d.people]   // signed in: their own name
        setPeople(list)
        setMe(d.me)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const lastLoad = useRef(0)
  // quiet = background reload: no spinner, and a failed background try doesn't replace the page with an error
  const load = useCallback((refresh = false, quiet = false) => {
    if (!quiet) setLoading(true)
    getDashboard(bugDays, refresh)
      .then((d) => { setData(d); setError(''); lastLoad.current = Date.now() })
      .catch((e: Error) => { if (!quiet) setError(e.message) })
      .finally(() => { if (!quiet) setLoading(false) })
  }, [bugDays])
  useEffect(() => { load() }, [load])
  // Stay current without clicking Refresh: every 2 minutes while the tab is visible, and when you come back to it.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad.current > 60_000) load(false, true)
    }
    const id = setInterval(tick, 120_000)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick) }
  }, [load])

  const ask = (q: string) => { setChatOpen(true); chat.ask(q) }
  const closeChat = useCallback(() => setChatOpen(false), [])
  // the logo = home: Overview tab, lists and chat closed, back at the top (Cmd/Ctrl-click still opens a new tab)
  const goHome = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    setTab('overview')
    setDrillReq(null)
    setChatOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  // Whose name to greet. Signed in: the Jira name if their email is linked to a Jira account, otherwise no name
  // (never the "Me (token owner)" placeholder). No login (local dev): whoever is picked in "I am".
  const meName = session.user
    ? (session.user.jira_linked && session.user.name ? titleCase(session.user.name) : '')
    : people.find((p) => p.account_id === me)?.name ?? ''
  const alerts = useMemo(() => (data ? buildAlerts(data) : []), [data])
  const bottleneck = useMemo(() => data && [...data.sprint.pipeline].sort((a, b) => b.count - a.count)[0], [data])

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'sprints', label: 'Sprints' },
    { id: 'bugs', label: 'Bugs', badge: data?.bugs.open },
    { id: 'people', label: 'People', badge: data ? data.team.free_with_queue + data.team.free_idle : undefined },
    { id: 'standards', label: 'Standards', badge: data?.standards.naming.people_not_following.length },
    { id: 'timelog', label: 'Time log' },
    { id: 'guide', label: 'Naming guide' },
  ]

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Jira Pulse home" onClick={goHome}>
          <span className="logo" aria-hidden>◆</span>
          <span className="brand-name">Jira Pulse</span>
        </a>
        <AskBar onAsk={ask} busy={chat.busy} />
        <div className="top-actions">
          {session.can_pick_person ? (
            <select value={me} onChange={(e) => setMe(e.target.value)} aria-label="I am">
              {people.map((p) => <option key={p.account_id} value={p.account_id}>{p.name}</option>)}
            </select>
          ) : (
            <button type="button" className="signed-in" onClick={() => setProfileOpen(true)} aria-label="Your profile"
              title={`${session.user?.email ?? ''} · open your profile`}>
              {session.user?.name ?? session.user?.email}
              {session.user && !session.user.jira_linked && <small className="muted"> (no Jira account linked)</small>}
            </button>
          )}
          {session.can_pick_person && (
            <button type="button" className="icon-btn" onClick={() => setProfileOpen(true)} title="Profile" aria-label="Your profile">
              {ProfileIcon}
            </button>
          )}
          {session.auth === 'password' && (
            <button className="icon-btn" title="Sign out" aria-label="Sign out"
              onClick={() => { logout().finally(() => window.location.reload()) }}>{SignOutIcon}</button>
          )}
          {session.auth !== 'password' && session.logout_url && (
            // a gateway owns the sign-in (Google via oauth2-proxy, Cloudflare Access), so its sign-out page ends the session
            <a className="icon-btn" href={session.logout_url} title="Sign out" aria-label="Sign out">{SignOutIcon}</a>
          )}
          <button className="icon-btn theme-btn" onClick={theme.next} aria-label={`Theme: ${theme.theme}`}
            title={`Theme: ${theme.theme === 'system' ? 'follows your system' : theme.theme} (click to change)`}>
            <span aria-hidden>{theme.theme === 'system' ? '◐' : theme.theme === 'light' ? '☀' : '☾'}</span>
          </button>
          <button className="icon-btn" onClick={() => load(true)} disabled={loading} title="Refresh from Jira" aria-label="Refresh">
            <span className={loading ? 'spin' : ''}>↻</span>
          </button>
        </div>
      </header>

      <main className="page">
        {error && <div className="banner">{error}</div>}

        <section className="hero">
          <div>
            <h1>{greeting(meName)}</h1>
            <p className="hero-sub">
              {data
                ? <>{data.sprint.names[0] ?? 'No active sprint'} · {data.sprint.open} open issues · updated {new Date(data.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
                : 'Reading your Jira…'}
            </p>
          </div>
          {alerts.length > 0 && (
            <div className="briefing">
              {alerts.slice(0, 3).map((a) => (
                <button key={a.title} className={`brief brief-${a.tone}`} onClick={() => a.tab && setTab(a.tab)}>
                  <Status tone={a.tone}>{a.title}</Status>
                </button>
              ))}
            </div>
          )}
        </section>

        <nav className="tabs" aria-label="Sections">
          {tabs.map((t) => (
            <button key={t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}{t.badge != null && <span className="badge">{t.badge}</span>}
            </button>
          ))}
          {tab === 'guide' || tab === 'sprints' || tab === 'timelog' ? null : tab !== 'people' ? (
            <div className="period" title="Applies to bugs, ticket titles and worklogs">
              <span className="muted small" aria-live="polite">{loading && data ? `Loading ${bugDays} days…` : 'Period'}</span>
              <div className="segmented" role="group" aria-label="Period" aria-busy={loading}>
                {BUG_WINDOWS.map((d) => (
                  <button key={d} aria-pressed={bugDays === d} onClick={() => setBugDays(d)}
                    className={loading && bugDays === d ? 'is-loading' : ''}>{d}d</button>
                ))}
              </div>
            </div>
          ) : (
            <span className="period muted small">People: right now · activity over 7 days</span>
          )}
        </nav>

        {tab === 'guide' ? (
          <div className="grid" key="guide"><Guide ask={ask} /></div>
        ) : tab === 'sprints' ? (
          <div className="grid" key="sprints"><Sprints ask={ask} drill={setDrillReq} /></div>
        ) : tab === 'timelog' ? (
          <div className="grid" key="timelog"><TimeLog me={me} /></div>
        ) : !data ? (
          <div className="grid">
            <div className="kpis">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={150} />)}</div>
            <Skeleton h={320} /><Skeleton h={320} />
          </div>
        ) : (
          <div className={`grid ${loading ? 'is-loading' : ''}`} key={tab}>
            {tab === 'overview' && <Overview d={data} alerts={alerts} bottleneck={bottleneck} ask={ask} drill={setDrillReq} setTab={setTab} bugDays={data.bug_days} />}
            {/* labels and click-throughs use the period of the data on screen, never a period still loading */}
            {tab === 'bugs' && <Bugs d={data} ask={ask} drill={setDrillReq} bugDays={data.bug_days} />}
            {tab === 'people' && <PeopleTab d={data} ask={ask} drill={setDrillReq} />}
            {tab === 'standards' && <Standards d={data} ask={ask} drill={setDrillReq} setTab={setTab} />}
          </div>
        )}
      </main>

      {!chatOpen && (
        <button className="fab" onClick={() => setChatOpen(true)} aria-label="Open Ask Jira">
          ✦ Ask Jira{chat.messages.length > 0 && <span className="badge">{chat.messages.filter((m) => m.role === 'bot').length}</span>}
        </button>
      )}
      <ChatPanel chat={chat} meName={meName} asLabel={meName || session.user?.email || ''} open={chatOpen} onClose={closeChat} />
      <ProfileSheet open={profileOpen} me={me} onClose={closeProfile} />
      {/* a fresh sheet per click, so the previous list's title/count can never flash up */}
      <IssueSheet key={drillReq ? JSON.stringify(drillReq) : 'closed'} request={drillReq} onClose={closeDrill} onAsk={ask} />
    </div>
  )
}

/* ------------------------------------------------------------------ tabs */

type TabProps = { d: Dashboard; ask: (q: string) => void; drill: (r: DrillRequest) => void }

function Overview({ d, alerts, bottleneck, ask, drill, setTab, bugDays }: TabProps & {
  alerts: Alert[]; bottleneck: { status: string; count: number } | null; setTab: (t: Tab) => void; bugDays: number
}) {
  const free = d.team.free_with_queue + d.team.free_idle
  return (
    <>
      <div className="kpis">
        <Kpi label="Sprint progress" value={d.sprint.done} unit={` / ${d.sprint.total} done`}
          foot={<>{d.sprint.open} still open</>} onClick={() => ask('Summarise the current sprint: what is in progress and what is stuck?')}>
          <Meter value={d.sprint.done} max={d.sprint.total} label="Sprint done" />
        </Kpi>
        <Kpi label={`Bugs needing work · ${bugDays}d`} value={d.bugs.open}
          foot={<>{d.bugs.reported} reported · {d.bugs.fixed_not_released} fixed, not released</>} onClick={() => setTab('bugs')}>
          <Sparkline values={d.bugs.trend.map((w) => w.count)} labels={d.bugs.trend.map((w) => `wk ${weekLabel(w.week)}`)} />
        </Kpi>
        <Kpi label="Developers free now" value={free} unit={` / ${d.team.developers}`}
          foot={<>{d.team.free_idle} with nothing queued</>} onClick={() => setTab('people')}>
          <Meter value={free} max={d.team.developers} label="Developers free" />
        </Kpi>
        <Kpi label="Titles on standard" value={d.standards.naming.compliance_pct ?? '–'} unit="%"
          foot={<>Worklogs: {d.standards.worklogs.compliance_pct ?? '–'}% described</>} onClick={() => setTab('standards')}>
          <Meter value={d.standards.naming.compliance_pct ?? 0} max={100} label="Naming compliance" />
        </Kpi>
      </div>

      <Card
        className="span-2"
        title="Where sprint work is sitting"
        subtitle={bottleneck && <>Biggest queue: <b>{bottleneck.status}</b> · {bottleneck.count} issues</>}
        onAsk={() => ask(`Which issues are sitting in "${bottleneck?.status}" in the current sprint?`)}
        table={{ columns: ['Status', 'Issues'], rows: d.sprint.pipeline.map((p) => [p.status, p.count]) }}
      >
        <BarList
          rows={d.sprint.pipeline.filter((p) => p.count > 0).map((p) => ({ label: p.status, value: p.count }))}
          highlight={bottleneck?.status}
          tipLabel={(r) => <><b>{r.label}</b><br />{r.value} open issues</>}
          onSelect={(r) => drill({ kind: 'sprint_status', params: { status: r.label } })}
        />
      </Card>

      <Card title="Attention" subtitle="Click one to dig in">
        {alerts.length === 0 ? <p className="muted">All clear today. 🎉</p> : (
          <ul className="alerts">
            {alerts.map((a) => (
              <li key={a.title}>
                <button onClick={() => (a.ask ? ask(a.ask) : a.tab && setTab(a.tab))}>
                  <Status tone={a.tone}>{a.title}</Status>
                  <span className="alert-detail">{a.detail}</span>
                  <span className="alert-go" aria-hidden>Ask ↗</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}

function Bugs({ d: dash, ask, drill, bugDays }: TabProps & { bugDays: number }) {
  // Project filter: "" = all projects (comes with the dashboard); otherwise fetch that project's bugs.
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState(() => { try { return localStorage.getItem('bugProject') ?? '' } catch { return '' } })
  const [projBugs, setProjBugs] = useState<(Dashboard['bugs'] & { project: Project | null }) | null>(null)
  const [projLoading, setProjLoading] = useState(false)
  useEffect(() => { getProjects().then(setProjects).catch(() => setProjects([])) }, [])
  useEffect(() => {
    try { localStorage.setItem('bugProject', project) } catch { /* fine */ }
    if (!project) { setProjBugs(null); return }
    let alive = true
    setProjLoading(true)
    getBugs(bugDays, project).then((b) => alive && setProjBugs(b)).catch(() => alive && setProjBugs(null))
      .finally(() => alive && setProjLoading(false))
    return () => { alive = false }
  }, [project, bugDays])
  const scoped = project ? (projBugs ?? null) : dash.bugs
  // name the project whose numbers are ON SCREEN (while another one loads, the old numbers stay, dimmed)
  const projectName = project ? projBugs?.project?.name : undefined
  const loadingName = projects.find((p) => p.key === project)?.name
  const d = { ...dash, bugs: scoped ?? dash.bugs }
  const withProject = (params: Record<string, string | number | null>) => (project ? { ...params, project } : params)
  const bugs = (state: string | null) => drill({ kind: 'bugs_state', params: withProject({ days: bugDays, state }) })
  return (
    <>
      <div className="scope-bar span-3">
        <label className="field">
          <span className="muted small">Project</span>
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
          </select>
        </label>
        {projLoading && <span className="muted small" aria-live="polite">Loading {loadingName ?? project}…</span>}
        {project && !projLoading && <button className="chip" onClick={() => setProject('')}>✕ Clear project</button>}
      </div>
      <div className={`kpis ${projLoading ? 'is-loading' : ''}`}>
        <Kpi label={`Reported · ${bugDays}d`} value={d.bugs.reported} foot="All projects · click to list" onClick={() => bugs(null)} />
        <Kpi label="Need work" value={d.bugs.open} foot="To Do, In Progress, In QA…" onClick={() => bugs('open')} />
        <Kpi label="Fixed, not released" value={d.bugs.fixed_not_released} foot="Ready to deploy / on staging" onClick={() => bugs('fixed_unreleased')} />
        <Kpi label="Invalid" value={d.bugs.invalid} foot="Duplicate / not a bug" onClick={() => bugs('invalid')} />
      </div>
      <Card
        className="span-2"
        title={`Bugs by feature · last ${bugDays} days${projectName ? ` · ${projectName}` : ''}`}
        subtitle="Top 10 features by valid bugs"
        onAsk={() => ask(`Break down the bugs in ${d.bugs.by_feature[0]?.feature ?? 'the top feature'} for the last ${bugDays} days`)}
        table={{
          columns: ['Feature', 'Open', 'Fixed, not released', 'Fixed', 'Invalid', 'Total'],
          rows: d.bugs.by_feature.map((f) => [f.feature, f.open, f.fixed_not_released, f.fixed, f.invalid, f.total]),
        }}
      >
        <StackedBars
          rows={d.bugs.by_feature.map((f) => ({ label: f.feature, ...f }))}
          series={[
            { key: 'open', label: 'Open', color: 'var(--series-1)' },
            { key: 'fixed_not_released', label: 'Fixed, not released', color: 'var(--series-2)' },
            { key: 'fixed', label: 'Fixed', color: 'var(--series-3)' },
            { key: 'invalid', label: 'Invalid', color: 'var(--neutral-fill)' },
          ]}
          onSelect={(feature, key) => drill({ kind: 'bugs_feature', params: withProject({
            feature, days: bugDays, state: key === 'fixed_not_released' ? 'fixed_unreleased' : key }) })}
        />
      </Card>
      <Card title="Reported per week" subtitle="Last 8 weeks"
        table={{ columns: ['Week of', 'Bugs'], rows: d.bugs.trend.map((w) => [weekLabel(w.week), w.count]) }}
        onAsk={() => ask('Which features had the most bugs reported this week?')}>
        <Columns onSelect={(r) => r.id && drill({ kind: 'bugs_week', params: withProject({ week: r.id }) })}
          rows={d.bugs.trend.map((w, i) => ({
          id: w.week, label: weekLabel(w.week), value: w.count,
          tip: `Week of ${weekLabel(w.week)}${i === d.bugs.trend.length - 1 ? ' (so far)' : ''}`,
        }))} />
      </Card>
      <Card className="span-3" title="High-priority bugs still open"
        onAsk={() => ask('List the open Highest and High priority bugs and who owns them')}>
        {d.bugs.high_priority_open.length === 0 ? <p className="muted">None in this window.</p> : (
          <div className="issue-grid">
            {d.bugs.high_priority_open.map((b) => (
              <a key={b.key} className="issue" href={b.url} target="_blank" rel="noreferrer">
                <Status tone={b.priority === 'Highest' ? 'critical' : 'warning'}>{b.priority}</Status>
                <span className="issue-title">{b.summary}</span>
                <span className="muted small">{b.key} · {b.status} · {b.assignee}</span>
              </a>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}

function PeopleTab({ d, ask, drill }: TabProps) {
  const [group, setGroup] = useState<PeopleGroup | null>(null)
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const openGroup = (label: string) => {
    if (label === 'Busy') {
      setGroup({ title: 'Busy developers', subtitle: `something in ${d.team.active_statuses.join(' / ')}`,
        people: d.team.busy_people.map((p) => ({ name: p.name,
          detail: `${plural(p.active, 'active issue')} · ${p.queued_in_sprint} To Do in sprint`,
          drill: { kind: 'person_active', params: { name: p.name } } })) })
    } else if (label === 'Free, has To Do') {
      setGroup({ title: 'Free, with To Do in the sprint', subtitle: 'nothing active, but work is queued',
        people: d.team.free_people.filter((p) => p.queued_in_sprint > 0).map((p) => ({ name: p.name,
          detail: `${p.queued_in_sprint} To Do in sprint${p.waiting_qa_release ? ` · ${p.waiting_qa_release} waiting for QA/release` : ''}`,
          drill: { kind: 'person_open', params: { name: p.name } } })) })
    } else {
      setGroup({ title: 'Free, nothing queued', subtitle: 'no active work and nothing in the sprint',
        people: d.team.free_people.filter((p) => p.queued_in_sprint === 0).map((p) => ({ name: p.name,
          detail: p.waiting_qa_release ? `${p.waiting_qa_release} waiting for QA/release` : 'nothing open in the sprint',
          drill: { kind: 'person_open', params: { name: p.name } } })) })
    }
  }
  const link = (text: string) => (
    <a key={text} href={`${d.jira_url}/browse/${text.split(' ')[0]}`} target="_blank" rel="noreferrer">{text}</a>
  )
  return (
    <>
      <Card className="span-2" title="Developer availability"
        subtitle={<>Busy = something in {d.team.active_statuses.join(', ')}</>}
        onAsk={() => ask('Who is free right now and what could they pick up?')}
        table={{ columns: ['Free developer', 'To Do in sprint', 'Waiting QA/release'],
          rows: d.team.free_people.map((p) => [p.name, p.queued_in_sprint, p.waiting_qa_release]) }}>
        <SegmentedBar onSelect={openGroup} parts={[
          { label: 'Busy', value: d.team.busy, color: 'var(--series-1)' },
          { label: 'Free, has To Do', value: d.team.free_with_queue, color: 'var(--series-2)' },
          { label: 'Free, nothing queued', value: d.team.free_idle, color: 'var(--series-3)' },
        ]} />
        <PeopleSheet group={group} onClose={() => setGroup(null)} onDrill={drill} />
        <div className="chips-list">
          {d.team.free_people.map((p) => (
            <span key={p.name} className="person-chip">
              {p.name}<small>{p.queued_in_sprint ? `${p.queued_in_sprint} To Do` : 'idle'}</small>
            </span>
          ))}
        </div>
        {d.team.free_people.every((p) => p.role === 'unknown') && (
          <p className="hint">Roles aren't set yet, so QA and PMs count as developers. Set them in team.yaml.</p>
        )}
      </Card>
      <Card title="Heaviest workload" subtitle="Active issues per person"
        table={{ columns: ['Person', 'Active', 'To Do'], rows: d.team.workload.map((w) => [w.name, w.active, w.queued]) }}
        onAsk={() => ask(`What is ${d.team.workload[0]?.name ?? 'the busiest person'} working on?`)}>
        <BarList rows={d.team.workload.map((w) => ({ label: w.name, value: w.active, note: `${w.queued} To Do` }))}
          tipLabel={(r) => <><b>{r.label}</b><br />{r.value} active · {r.note}</>}
          onSelect={(r) => drill({ kind: 'person_active', params: { name: r.label } })} />
      </Card>
      <Card className="span-2" title="Busy on paper, quiet in Jira"
        subtitle={`Active issues assigned, but no Jira updates in ${d.inactive_days} days`}
        onAsk={() => ask(`Who has active issues but no Jira activity in the last ${d.inactive_days} days?`)}>
        {d.activity.busy_but_inactive.length === 0 ? <p className="muted">Nobody. 👍</p> : (
          <ul className="rows">
            {d.activity.busy_but_inactive.map((p) => (
              <li key={p.name}>
                <span className="row-main"><b>{p.name}</b><span className="muted"> · {p.active} active</span></span>
                <span className="keys">{p.issues.slice(0, 3).map(link)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`No Jira activity · ${d.inactive_days}d`} subtitle={`${d.activity.inactive_count} of ${d.team.roster_size} people`}
        onAsk={() => ask(`Who had no Jira activity in the last ${d.inactive_days} days?`)}>
        <ul className="rows compact">
          {d.activity.inactive.map((p) => (
            <li key={p.name}><span>{p.name}</span><span className="muted">{p.open_assigned} open</span></li>
          ))}
        </ul>
        <p className="hint">Leave and meetings don't show in Jira. A prompt to check in, not a verdict.</p>
      </Card>
    </>
  )
}

function Standards({ d, ask, drill, setTab }: TabProps & { setTab: (t: Tab) => void }) {
  const n = d.standards.naming
  const w = d.standards.worklogs
  const tone = (pct: number | null): Tone => (pct == null ? 'info' : pct >= 85 ? 'good' : pct >= 60 ? 'warning' : 'critical')
  return (
    <>
      <Card className="span-2 std-card" title="Ticket titles"
        subtitle={<>Jira Ticket Naming Convention Standard · last {n.days} days · <a href="#guide" onClick={(e) => { e.preventDefault(); setTab('guide') }}>Read the guide →</a></>}
        onAsk={() => ask('Who is not following the ticket naming standard? Suggest better titles.')}
        table={{ columns: ['Person', 'Created', 'Bad titles', 'OK %', 'Main problem'],
          rows: n.people_not_following.map((p) => [p.name, p.created, p.violations, p.compliance_pct, p.top_problems[0] ?? '']) }}>
        <Score pct={n.compliance_pct} tone={tone(n.compliance_pct)} text={`${n.compliant} of ${n.tickets_checked} titles follow the standard`} />
        <div className="std-split">
          <div>
            <h3>Most common problems</h3>
            <BarList rows={n.by_rule.slice(0, 6).map((r) => ({ id: r.rule, label: r.label, value: r.count }))}
              onSelect={(r) => drill({ kind: 'naming_rule', params: { days: n.days, rule: r.id ?? null } })}
              tipLabel={(r) => <><b>{r.label}</b><br />{r.value} tickets</>} />
          </div>
          <div>
            <h3>Not following it</h3>
            <ul className="rows">
              {n.people_not_following.slice(0, 6).map((p) => (
                <li key={p.name} className="stacked">
                  <button type="button" className="row-main linklike" aria-label={`${p.name}: show all ${p.violations} titles that break the standard`}
                    onClick={() => drill({ kind: 'naming_rule', params: { days: n.days, person: p.name } })}>
                    <b>{p.name}</b><span className="muted"> · {p.violations}/{p.created} titles</span>
                  </button>
                  {p.examples[0] && (
                    <a className="example" href={p.examples[0].url} target="_blank" rel="noreferrer">
                      {p.examples[0].key} “{p.examples[0].title}”
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
      <Card title="Worklogs" subtitle={`[Category] what was done · last ${w.days} days`}
        onAsk={() => ask('Who logs time without a proper worklog description this week?')}
        table={{ columns: ['Person', 'Worklogs', 'Bad', 'OK %'], rows: w.people_not_following.map((p) => [p.name, p.logs, p.violations, p.compliance_pct]) }}>
        <Score pct={w.compliance_pct} tone={tone(w.compliance_pct)} text={`${w.compliant} of ${w.worklogs_checked} worklogs described`} />
        {w.by_rule.length > 0 && (
          <>
            <h3>Most common problems</h3>
            <BarList rows={w.by_rule.map((r) => ({ id: r.rule, label: r.label, value: r.count }))}
              tipLabel={(r) => <><b>{r.label}</b><br />{r.value} worklogs</>}
              onSelect={(r) => drill({ kind: 'worklog_rule', params: { days: w.days, rule: r.id ?? null } })} />
            <h3 className="spaced">Logging time without a description</h3>
          </>
        )}
        <ul className="rows">
          {w.people_not_following.slice(0, 6).map((p) => (
            <li key={p.name} className="stacked">
              <button type="button" className="row-main linklike" aria-label={`${p.name}: show all ${p.violations} worklogs without a description`}
                onClick={() => drill({ kind: 'worklog_rule', params: { days: w.days, person: p.name } })}>
                <b>{p.name}</b><span className="muted"> · {p.violations}/{p.logs}</span>
              </button>
              {p.examples[0] && <span className="example"><code>{p.examples[0].note}</code> on {p.examples[0].key}</span>}
            </li>
          ))}
        </ul>
        <p className="hint">Good: <code>[Dev] Add version filter to report</code> · Bad: <code>[Dev]</code></p>
      </Card>
    </>
  )
}

function Score({ pct, tone, text }: { pct: number | null; tone: Tone; text: ReactNode }) {
  return (
    <div className="score">
      <span className="score-num">{pct ?? '–'}<small>%</small></span>
      <div className="score-side">
        <Status tone={tone}>{tone === 'good' ? 'On track' : tone === 'warning' ? 'Needs work' : tone === 'critical' ? 'Off track' : 'No data'}</Status>
        <span className="muted small">{text}</span>
        <Meter value={pct ?? 0} max={100} />
      </div>
    </div>
  )
}
