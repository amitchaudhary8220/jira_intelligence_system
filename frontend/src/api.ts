// Typed wrappers around the FastAPI backend (src/jira_pm/server.py).

export type Person = { account_id: string; name: string; role: string }
export type PeopleResponse = { me: string; me_name?: string; source: string; locked?: boolean; people: Person[] }
export type ToolCall = { tool: string; args: string }
export type ChatResponse = { session_id: string; answer: string; tools: ToolCall[]; as: string }

export type Issue = {
  key: string; summary: string; status: string; priority: string
  assignee: string; components: string[]; url: string
}

export type Dashboard = {
  generated_at: string
  jira_url: string
  seconds: number
  bug_days: number
  inactive_days: number
  sprint: {
    names: string[]; total: number; done: number; open: number
    pipeline: { status: string; count: number }[]
  }
  bugs: {
    reported: number; open: number; fixed_not_released: number; fixed: number; invalid: number
    trend: { week: string; count: number }[]
    by_feature: { feature: string; open: number; fixed_not_released: number; fixed: number; invalid: number; total: number }[]
    high_priority_open: Issue[]
  }
  team: {
    roster_size: number; roster_source: string; developers: number
    busy: number; free_with_queue: number; free_idle: number
    free_people: { name: string; role: string; queued_in_sprint: number; waiting_qa_release: number }[]
    workload: { name: string; active: number; queued: number }[]
    busy_people: { name: string; active: number; queued_in_sprint: number; waiting_qa_release: number }[]
    active_statuses: string[]
  }
  standards: {
    naming: {
      days: number; tickets_checked: number; compliant: number; compliance_pct: number | null
      by_rule: { rule: string; label: string; count: number }[]
      by_type: Record<string, { total: number; compliant_pct: number }>
      people_not_following: {
        name: string; created: number; violations: number; compliance_pct: number; top_problems: string[]
        examples: { key: string; type: string; title: string; problems: string[]; url: string }[]
      }[]
    }
    worklogs: {
      days: number; worklogs_checked: number; compliant: number; compliance_pct: number | null
      by_rule: { rule: string; label: string; count: number }[]
      people_not_following: {
        name: string; logs: number; violations: number; compliance_pct: number; top_problems: string[]
        examples: { key: string; time: string; note: string; problems: string[]; url: string }[]
      }[]
    }
  }
  activity: {
    inactive_count: number; active_count: number
    inactive: { name: string; role: string; open_assigned: number }[]
    busy_but_inactive: { name: string; active: number; issues: string[] }[]
  }
}

/**
 * The login gateway in front of the app (oauth2-proxy) answers with its sign-in PAGE (HTML, 401/403) once the session
 * is gone: signed out, expired, or a cached copy of this page started after sign-out. Reload, so the browser shows
 * that sign-in page instead of an error. The app's own errors are JSON, so they never trigger this.
 */
const NEVER = new Promise<never>(() => {})
function signedOutAtGateway(r: Response): boolean {
  const html = (r.headers?.get('content-type') ?? '').includes('text/html')
  if ((r.status === 401 || r.status === 403) && html) {
    window.location.reload()
    return true
  }
  return false
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (signedOutAtGateway(r)) return NEVER
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.detail ?? r.statusText)
  return data as T
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (signedOutAtGateway(r)) return NEVER
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.detail ?? `Backend not reachable (${r.status}). Is "make server" running?`)
  return data as T
}

export const getPeople = () => get<PeopleResponse>('/api/people')

export const getDashboard = (bugDays: number, refresh = false) =>
  get<Dashboard>(`/api/dashboard?bug_days=${bugDays}&refresh=${refresh}`)

/** history = earlier turns of this conversation; the server only uses it if it lost the conversation (restart). */
export const sendChat = (message: string, sessionId: string | null, meAccountId: string,
  history: { role: 'user' | 'bot'; text: string }[] = []) =>
  post<ChatResponse>('/api/chat', { message, session_id: sessionId, me_account_id: meAccountId, history })

// ------------------------------------------------------------------ saved chats (SQLite on the server)
// Only your last 5 chats are kept; asking in a 6th removes the one you used least recently (LRU).
export type SavedChat = { id: string; title: string; created_at: number; updated_at: number }   // seconds
export type SavedMessage = { role: 'user' | 'bot'; text: string; tools: ToolCall[]; seconds: number | null }
const meParam = (me: string) => (me ? `?me_account_id=${encodeURIComponent(me)}` : '')
export const listChats = (me: string) => get<SavedChat[]>(`/api/chats${meParam(me)}`)
export const getChat = (id: string, me: string) =>
  get<SavedChat & { messages: SavedMessage[] }>(`/api/chats/${encodeURIComponent(id)}${meParam(me)}`)
export async function deleteChat(id: string, me: string): Promise<void> {
  const r = await fetch(`/api/chats/${encodeURIComponent(id)}${meParam(me)}`, { method: 'DELETE' })
  if (signedOutAtGateway(r)) return NEVER
  if (!r.ok && r.status !== 404) throw new Error(`Could not delete the chat (${r.status})`)   // 404: already gone
}

export const resetChat = (sessionId: string | null) =>
  post<{ ok: boolean }>('/api/reset', { message: '', session_id: sessionId })

// ------------------------------------------------------------------ naming guide + live checkers
export type Finding = { rule: string; severity: 'error' | 'warning'; message: string }
export type CheckResult = { ok: boolean; findings: Finding[] }
export type Guide = {
  source: string; core_rule: string; formula: string; base_format: string
  formats: { type: string; format: string; purpose: string; good: string; avoid: string }[]
  do: string[]; dont: string[]
  examples: { do: string; dont: string }[]
  subtask_checklist: string[]
  verbs: string[]; issue_types: string[]
  worklog: { format: string; note: string; good: string[]; bad: string[]; categories: string[] }
}

export const getGuide = () => get<Guide>('/api/standards/guide')
export const checkTitle = (title: string, issue_type: string) =>
  post<CheckResult>('/api/standards/check-title', { title, issue_type })
export const checkWorklog = (note: string) => post<CheckResult>('/api/standards/check-worklog', { note })

// ------------------------------------------------------------------ drill-down: click a chart -> its tickets
export type DrillKind = 'bugs_week' | 'bugs_feature' | 'bugs_state' | 'sprint_status' | 'person_active' | 'sprint_outcome'
  | 'naming_rule' | 'worklog_rule' | 'person_open'
export type DrillRequest = { kind: DrillKind; params: Record<string, string | number | null> }
/** A row in a click-through list. Naming lists add the creator + why the title fails; worklog lists add the note. */
export type DrillRow = Issue & { creator?: string; problems?: string[]; note?: string; time?: string; started?: string }
export type DrillResult = {
  title: string; total: number; issues: DrillRow[]; truncated: boolean; jql: string; jira_link: string; note: string | null
  ask_prompt?: string | null   // what "Ask about these" sends, when the list knows a better question than the default
}
export const drilldown = (req: DrillRequest) => post<DrillResult>('/api/drilldown', req)

// ------------------------------------------------------------------ projects + per-project bugs
export type Project = { key: string; name: string }
export const getProjects = () => get<Project[]>('/api/projects')
export const getBugs = (days: number, project: string) =>
  get<Dashboard['bugs'] & { project: Project | null }>(`/api/bugs?days=${days}&project=${encodeURIComponent(project)}`)

// ------------------------------------------------------------------ sprints
export type SprintInfo = { name: string; state: 'active' | 'closed'; start: string | null; end: string | null; boards: number; still_open_after_end: string[] }
export type Outcome = 'released' | 'done_after' | 'dev_complete' | 'in_progress' | 'not_started'
export type SprintDev = {
  name: string; role: string; issues: number; delivered: number; subtasks_done: number; not_delivered: number
  reopened: number; hours: number; bugs_in_their_work: number; delivered_types: Record<string, number>
}
export type SprintTester = { name: string; role: string; reported: number; valid: number; invalid: number; high_priority: number; fixed: number; invalid_pct: number }
export type SprintReport = {
  sprint: SprintInfo; as_of: string
  totals: Record<Outcome, number> & { in_sprint: number; not_delivered: number; carried_over: number; added_mid_sprint: number; reopened: number; delivered_pct: number | null }
  by_project: (Record<Outcome, number> & { project: string; total: number })[]
  developers: SprintDev[]; testers: SprintTester[]
  bugs_found: { reported: number; valid: number; invalid: number; linked_to_a_task: number }
  highlights: { title: string; name: string; value: number; unit: string }[]
  trend: { name: string; state: string; total: number; delivered: number; delivered_pct: number | null }[]
  notes: string[]           // sprint-level, shown on the Sprints tab
  people_notes?: string[]   // about the per-person numbers (hidden on the tab for now)
}
export const getSprints = () => get<SprintInfo[]>('/api/sprints')
export const getSprintReport = (sprint: string) => get<SprintReport>(`/api/sprint-report?sprint=${encodeURIComponent(sprint)}`)

// ------------------------------------------------------------------ sign-in
export type Session = {
  auth: 'none' | 'password' | 'proxy' | 'cloudflare'; env: string
  user: { email: string; name: string | null; account_id: string | null; jira_linked: boolean } | null
  can_pick_person: boolean
  logout_url?: string | null      // the login gateway's sign-out page (proxy / cloudflare)
}
export const getSession = () => get<Session>('/api/session')

// ------------------------------------------------------------------ your time log (5 h per working day)
export type TimeTicket = { key: string; summary: string; status: string; type: string; url: string; hours: number; notes: string[] }
export type DayReason = { reason: string; note: string; other_day?: string | null }
export type TimeRow = {
  date: string; weekday: string; weekend: boolean; required_hours: number; logged_hours: number; short_by: number; extra?: number
  status: 'met' | 'short' | 'in_progress' | 'weekend'; tickets: TimeTicket[]; reason: DayReason | null; editable?: boolean
  covers?: { days: string[]; hours: number; over_claimed: boolean }   // this day's extra time made up for these short days
}
export type TimeLog = {
  linked: boolean; rows: TimeRow[]; reasons: Record<string, string>; note: string
  from?: string; to?: string; days?: number; today?: string; month?: string; timezone?: string; required_hours_per_day?: number
  summary?: { working_days: number; today_in_progress?: boolean; days_met: number; days_short: number; logged_hours: number; required_hours: number; short_hours: number; extra_hours?: number; days_over?: number; made_up_days?: number; made_up_hours?: number }
}
const meQuery = (me: string, first: boolean) => (me ? `${first ? '?' : '&'}me_account_id=${encodeURIComponent(me)}` : '')
export const getTimeLog = (month: string, me: string) => get<TimeLog>(`/api/timelog?month=${month}${meQuery(me, false)}`)
export async function saveDayReason(day: string, reason: string | null, note: string, me: string,
  otherDay: string | null = null): Promise<DayReason & { day: string }> {
  const r = await fetch('/api/timelog/reason', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day, reason, note, other_day: otherDay, me_account_id: me || null }),
  })
  if (signedOutAtGateway(r)) return NEVER
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not save the reason')
  return data
}

// ------------------------------------------------------------------ your profile (Jira identity + your Jira activity)
export type ProfileField = { label: string; value: string | null; why: string | null }
export type Profile = {
  linked: boolean; name: string | null; email: string | null; avatar: string | null; fields: ProfileField[]; note: string
  right_now?: { total: number; by_stage: Record<string, number>; issues: Issue[] }
  sprint?: { assigned: number; done: number; not_done: number }
  last_30_days?: { finished: number | null; bugs_fixed: number | null; bugs_reported: number | null; tickets_created: number | null
    hours_logged: number; worklogs: number; worklog_quality_pct: number | null; titles_checked: number; title_standard_pct: number | null }
  top_features?: { name: string; issues: number }[]
  recent?: Issue[]
}
export const getProfile = (me: string) => get<Profile>(`/api/profile${me ? `?me_account_id=${encodeURIComponent(me)}` : ''}`)
export const login = (email: string, password: string) => post<{ ok: boolean }>('/api/login', { email, password })
export const logout = () => post<{ ok: boolean }>('/api/logout', {})

// ------------------------------------------------------------------ streaming chat (Server-Sent Events)
export type StreamEvent =
  | { type: 'start'; session_id: string; as: string }
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'retry'; text: string }
  | { type: 'done'; answer: string; tools: ToolCall[]; session_id: string; as: string }
  | { type: 'error'; detail: string }

/** POST /api/chat/stream and call onEvent for each event. Resolves with the final answer. */
export async function streamChat(message: string, sessionId: string | null, meAccountId: string,
  history: { role: 'user' | 'bot'; text: string }[], onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
  const r = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message, session_id: sessionId, me_account_id: meAccountId, history }),
  })
  if (signedOutAtGateway(r)) return NEVER
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => ({}))
    const err = new Error(data.detail ?? r.statusText) as Error & { status?: number }
    err.status = r.status
    throw err
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: ChatResponse | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut
    while ((cut = buffer.indexOf('\n\n')) >= 0) {                  // one SSE event per blank-line-separated block
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const line = block.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      const ev = JSON.parse(line.slice(6)) as StreamEvent
      if (ev.type === 'error') throw new Error(ev.detail)
      if (ev.type === 'done') final = { session_id: ev.session_id, answer: ev.answer, tools: ev.tools, as: ev.as }
      onEvent(ev)
    }
  }
  if (!final) throw new Error('The answer was cut off - please try again')
  return final
}
