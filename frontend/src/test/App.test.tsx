// Clicks every filter and button of the real App against a fake backend.
// Run: npm test   (or `make test-ui` from the project root)

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SortTable } from '../components/ui'
import type { Dashboard } from '../api'

// ------------------------------------------------------------------ fake backend
const ME = 'acc-me'
const RAVI = 'acc-ravi'

function makeDash(days: number): Dashboard {
  const k = days === 7 ? 1 : days === 90 ? 3 : 2            // numbers change with the period
  return {
    generated_at: '2026-11-13T09:00:00Z', jira_url: 'https://x.atlassian.net', seconds: 1, bug_days: days, inactive_days: 7,
    sprint: {
      names: ['Q4 FY26 - Sprint 4'], total: 324, done: 15, open: 309,
      pipeline: [{ status: 'To Do', count: 46 }, { status: 'In Progress', count: 19 }, { status: 'Ready to deploy', count: 96 }],
    },
    bugs: {
      reported: 100 * k + 1, open: 10 * k + 2, fixed_not_released: 5, fixed: 7, invalid: 3,
      trend: Array.from({ length: 8 }, (_, i) => ({ week: `2026-09-${String(21 + i).padStart(2, '0')}`, count: 10 + i })),
      by_feature: [{ feature: 'Voter Module User Portal', open: 7, fixed_not_released: 5, fixed: 9, invalid: 1, total: 22 }],
      high_priority_open: [{ key: 'VO-1', summary: 'Slip printing broken', status: 'To Do', priority: 'Highest', assignee: 'Deepak', components: [], url: 'https://x/VO-1' }],
    },
    team: {
      roster_size: 48, roster_source: 'team.yaml', developers: 48, busy: 33, free_with_queue: 8, free_idle: 7,
      free_people: [{ name: 'Manoj Pillai', role: 'dev', queued_in_sprint: 0, waiting_qa_release: 0 }],
      workload: [{ name: 'Abhinandan', active: 19, queued: 2 }], active_statuses: ['In Progress', 'In Review'],
      busy_people: [{ name: 'Abhinandan', active: 19, queued_in_sprint: 2, waiting_qa_release: 0 }],
    },
    standards: {
      naming: { days, tickets_checked: 374, compliant: 262, compliance_pct: 70, by_rule: [{ rule: 'no_action_verb', label: "Doesn't start with an action verb", count: 68 }],
        by_type: { Bug: { total: 10, compliant_pct: 90 } },
        people_not_following: [{ name: 'Arjun Malhotra', created: 25, violations: 12, compliance_pct: 52, top_problems: ['x'],
          examples: [{ key: 'WEB-1', type: 'Task', title: 'Misc work', problems: ['vague'], url: 'https://x/WEB-1' }] }] },
      worklogs: { days, worklogs_checked: 64, compliant: 41, compliance_pct: 64, by_rule: [{ rule: 'no_description', label: 'Tag only', count: 21 }],
        people_not_following: [{ name: 'vijay.yadav', logs: 7, violations: 7, compliance_pct: 0, top_problems: [],
          examples: [{ key: 'SS-1', time: '25m', note: '[Code Review]', problems: [], url: 'https://x/SS-1' }] }] },
    },
    activity: {
      inactive_count: 19, active_count: 29, inactive: [{ name: 'Surabhi Sonam', role: 'dev', open_assigned: 0 }],
      busy_but_inactive: [{ name: 'Arjun Malhotra', active: 8, issues: ['WEB-315 (In Review)'] }],
    },
  }
}

type Call = { url: string; body?: Record<string, unknown> }
let calls: Call[] = []
type FakeUser = { email: string; name: string | null; account_id: string | null; jira_linked: boolean }
const fake = { session: { auth: 'none' as 'none' | 'password' | 'proxy', signedIn: false, user: undefined as FakeUser | undefined },
  noStream: false, streamEvents: null as unknown[] | null, hold: null as Promise<void> | null }

// fake server-side chat history (SQLite on the real server): 5 per person, least-recently-used goes
type FakeChat = { id: string; owner: string; title: string; used: number; messages: { role: 'user' | 'bot'; text: string; tools: unknown[]; seconds: number }[] }
let savedChats: FakeChat[] = []
let clock = 0
function saveExchange(owner: string, id: string, question: string, answer: string) {
  let c = savedChats.find((x) => x.id === id)
  if (!c) savedChats.push(c = { id, owner, title: question, used: 0, messages: [] })
  c.used = ++clock
  c.messages.push({ role: 'user', text: question, tools: [], seconds: 0 }, { role: 'bot', text: answer, tools: [], seconds: 1 })
  const mine = savedChats.filter((x) => x.owner === owner).sort((a, b) => b.used - a.used)
  savedChats = savedChats.filter((x) => x.owner !== owner || mine.indexOf(x) < 5)
}
const recentChats = (owner: string) => savedChats.filter((x) => x.owner === owner).sort((a, b) => b.used - a.used)

function json(data: unknown, ok = true, status?: number) {
  return Promise.resolve({ ok, status: status ?? (ok ? 200 : 500), json: () => Promise.resolve(data) } as Response)
}

/** A streamed (Server-Sent Events) response, the way /api/chat/stream sends it. */
function sse(events: unknown[], { hold }: { hold?: Promise<void> } = {}) {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      for (const [i, e] of events.entries()) {
        if (hold && i === events.length - 1) await hold          // let a test look at the half-finished answer
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

beforeEach(() => {
  calls = []
  fake.session = { auth: 'none', signedIn: false, user: undefined }
  fake.noStream = false
  fake.streamEvents = null
  fake.hold = null
  window.history.replaceState(null, '', '/')        // tabs write #bugs etc. into the URL; start every test clean
  savedChats = []
  clock = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    if (url === '/api/session') {
      const s = fake.session
      return json({ auth: s.auth, env: 'development', user: s.signedIn ? (s.user ?? { email: 'amit@example.com', name: 'Amit Chaudhary', account_id: ME, jira_linked: true }) : null,
        can_pick_person: s.auth === 'none' })
    }
    if (url === '/api/login') {
      if (body?.password !== 'correct horse battery') return json({ detail: 'Wrong password' }, false)
      fake.session.signedIn = true
      return json({ ok: true })
    }
    if (url === '/api/logout') { fake.session.signedIn = false; return json({ ok: true }) }
    if (url.startsWith('/api/people')) {
      return json({ me: ME, source: 'team.yaml', people: [
        { account_id: ME, name: 'Amit Chaudhary', role: 'dev' }, { account_id: RAVI, name: 'Ravi Kumar Mehra', role: 'dev' }] })
    }
    if (url.startsWith('/api/dashboard')) {
      return json(makeDash(Number(new URL(url, 'http://t').searchParams.get('bug_days'))))
    }
    if (url === '/api/sprints') return json([
      { name: 'Q4 FY26 - Sprint 4', state: 'active', start: '2026-11-12', end: '2026-11-24', boards: 6, still_open_after_end: [] },
      { name: 'Q4 FY26 - Sprint 3', state: 'active', start: '2026-10-29', end: '2026-11-10', boards: 13, still_open_after_end: ['Data Entry'] }])
    if (url.startsWith('/api/sprint-report')) {
      const which = new URL(url, 'http://t').searchParams.get('sprint')
      const name = which === 'Q4 FY26 - Sprint 4' ? 'Q4 FY26 - Sprint 4' : 'Q4 FY26 - Sprint 3'
      return json({
        sprint: { name, state: 'active', start: '2026-10-29', end: '2026-11-10', boards: 13, still_open_after_end: name.endsWith('3') ? ['Data Entry'] : [] },
        as_of: 'sprint end (10 Nov)',
        totals: { in_sprint: 567, released: 183, done_after: 49, dev_complete: 188, in_progress: 69, not_started: 78, not_delivered: 384,
          carried_over: 178, added_mid_sprint: 25, reopened: 5, delivered_pct: name.endsWith('3') ? 32 : 6 },
        by_project: [{ project: 'WEB', released: 120, done_after: 28, dev_complete: 44, in_progress: 22, not_started: 6, total: 220 }],
        developers: [
          { name: 'Ravi Kumar Mehra', role: 'dev', issues: 67, delivered: 16, subtasks_done: 8, not_delivered: 43, reopened: 1, hours: 0, bugs_in_their_work: 2, delivered_types: {} },
          { name: 'Sneha Kulkarni', role: 'dev', issues: 64, delivered: 13, subtasks_done: 4, not_delivered: 47, reopened: 0, hours: 6.5, bugs_in_their_work: 0, delivered_types: {} }],
        testers: [{ name: 'lakshmi.raman', role: 'qa', reported: 11, valid: 11, invalid: 0, high_priority: 6, fixed: 4, invalid_pct: 0 }],
        bugs_found: { reported: 46, valid: 45, invalid: 1, linked_to_a_task: 21 },
        highlights: [{ title: 'Cleanest delivery', name: 'Sneha Kulkarni', value: 13, unit: 'tickets, 0 bugs found, 0 reopened' }],
        trend: [{ name: 'Q4 FY26 - Sprint 3', state: 'active', total: 567, delivered: 183, delivered_pct: 32 },
                { name: 'Q4 FY26 - Sprint 4', state: 'active', total: 324, delivered: 20, delivered_pct: 6 }],
        notes: ['Delivered = Released by the end date.'],
        people_notes: ["Developer 'delivered' counts top-level tickets.", "Bugs 'in their work' = linked bugs."],
      })
    }
    if (url === '/api/projects') return json([{ key: 'FB', name: 'Form Builder' }, { key: 'VO', name: 'Voter Outreach' }])
    if (url.startsWith('/api/bugs')) {
      const q = new URL(url, 'http://t').searchParams
      return json({ ...makeDash(Number(q.get('days'))).bugs, reported: 28, open: 8, project: { key: q.get('project'), name: 'Voter Outreach' } })
    }
    if (url === '/api/drilldown' && body?.kind === 'naming_rule') {
      return json({ title: `naming ${body.params.rule ?? body.params.person}`, total: 1, truncated: false, jql: 'key in (WEB-1)',
        jira_link: 'https://x/issues?jql=key%20in%20(WEB-1)', note: 'Charged to the person who created the ticket.',
        ask_prompt: 'Suggest better titles for these',
        issues: [{ key: 'WEB-1', summary: 'Misc work', status: 'To Do', priority: 'Medium', assignee: 'Ravi', components: [], url: 'https://x/WEB-1',
          creator: 'Arjun Malhotra', problems: ["Doesn't start with a verb", "Bucket word 'Misc'"] }] })
    }
    if (url === '/api/drilldown' && body?.kind === 'worklog_rule') {
      return json({ title: `worklogs ${body.params.rule ?? body.params.person}`, total: 2, truncated: false, jql: 'key in (SS-1)',
        jira_link: 'https://x', note: null, ask_prompt: null,
        issues: ['[Code Review]', '[Dev]'].map((note) => ({ key: 'SS-1', summary: 'Stats page', status: 'In Review', priority: '',
          assignee: 'vijay.yadav', components: [], url: 'https://x/SS-1', note, time: '25m', started: '12 Nov',
          problems: [`Only the tag ${note} - say what was done`] })) })
    }
    if (url === '/api/drilldown') {
      const issues = Array.from({ length: 8 }, (_, i) => ({
        key: `VO-${100 + i}`, summary: i === 0 ? 'Slip printing broken' : `Issue ${i}`, status: i % 2 ? 'To Do' : 'Ready to deploy',
        priority: i === 0 ? 'Highest' : 'Medium', assignee: i === 0 ? 'Deepak' : 'Ravi', components: [], url: `https://x/VO-${100 + i}` }))
      return json({ title: `drill ${body?.kind}`, total: issues.length, issues, truncated: false, jql: 'x', jira_link: 'https://x/issues?jql=x', note: null })
    }
    if (url.startsWith('/api/timelog/reason')) {
      return json({ day: body?.day, reason: body?.reason, note: body?.note ?? '', other_day: body?.other_day ?? null })
    }
    if (url.startsWith('/api/timelog')) {
      return json({ linked: true, from: '2026-11-02', to: '2026-11-15', days: 14, timezone: 'Asia/Kolkata', required_hours_per_day: 5,
        note: 'Required 5 h per working day (Monday to Friday). Saturday and Sunday are off.',
        reasons: { half_day: 'Half day', arrived_late: 'Arrived late', no_active_story: 'No active story', on_leave: 'On leave / holiday',
          made_up: 'Made up on another day', comp_off: 'Comp off (worked another day)', other: 'Other' },
        summary: { working_days: 2, days_met: 1, days_short: 1, logged_hours: 8.5, required_hours: 10, short_hours: 2 },
        today: '2026-11-15', month: '2026-11',
        rows: [
          { date: '2026-11-15', weekday: 'Sun', weekend: true, required_hours: 0, logged_hours: 0, short_by: 0, status: 'weekend', tickets: [], reason: null },
          { date: '2026-11-13', weekday: 'Fri', weekend: false, required_hours: 5, logged_hours: 3, short_by: 2, status: 'short', reason: null, editable: true,
            tickets: [{ key: 'FB-658', summary: 'Form | Add autosave', status: 'In Progress', type: 'Task', url: 'https://x/FB-658', hours: 3, notes: ['[Dev] autosave'] }] },
          { date: '2026-11-12', weekday: 'Thu', weekend: false, required_hours: 5, logged_hours: 6.5, short_by: 0, extra: 1.5, status: 'met', reason: null,
            tickets: [{ key: 'FB-650', summary: 'Form | Fix save', status: 'In Review', type: 'Bug', url: 'https://x/FB-650', hours: 5, notes: [] }] },
        ] })
    }
    if (url.startsWith('/api/profile')) {
      return json({ linked: true, name: 'Amit Chaudhary', email: 'amit@example.com', avatar: null, note: 'From live Jira.',
        fields: [{ label: 'Time zone', value: 'Asia/Kolkata', why: null },
                 { label: 'Job title', value: null, why: "Not in Jira's API, even with an admin token." }],
        right_now: { total: 3, by_stage: { being_worked_on: 1, not_started: 2 },
          issues: [{ key: 'FB-658', summary: 'Form | Add autosave', status: 'In Progress', priority: 'Medium', assignee: 'Amit', components: [], url: 'https://x/FB-658' }] },
        sprint: { assigned: 2, done: 1, not_done: 1 },
        last_30_days: { finished: 4, bugs_fixed: 1, bugs_reported: 0, tickets_created: 5, hours_logged: 49.4, worklogs: 18,
          worklog_quality_pct: 100, titles_checked: 5, title_standard_pct: 80 },
        top_features: [{ name: 'Form Builder', issues: 6 }], recent: [] })
    }
    if (url === '/api/standards/guide') {
      return json({ source: 'PDF', core_rule: 'QA must understand the title', formula: 'Verb + what is changing + where', base_format: 'x',
        formats: [{ type: 'Task', format: 'Module | Action and outcome', purpose: 'p', good: 'Login | Add recent searches', avoid: 'fix issue' },
                  { type: 'Bug', format: 'Module | What is broken', purpose: 'p', good: 'Magazine | Shared link opens unpublished magazine', avoid: 'bug' }],
        do: ['Start with a verb'], dont: ['Past tense'], examples: [{ do: 'Fix carousel timezone', dont: 'carousel fix' }],
        subtask_checklist: ['Starts with a clear verb'], verbs: ['Add', 'Fix'], issue_types: ['Task', 'Bug'],
        worklog: { format: '[Category] what you did', note: 'team convention', good: ['[Dev] Add filter'], bad: ['[Dev]'], categories: ['Dev', 'Testing'] } })
    }
    if (url === '/api/standards/check-title') {
      const ok = /\|/.test(String(body?.title))
      return json({ ok, findings: ok ? [] : [{ rule: 'missing_module', severity: 'error', message: "Missing 'Module | ' prefix" }] })
    }
    if (url === '/api/standards/check-worklog') {
      const ok = String(body?.note).length > 8
      return json({ ok, findings: ok ? [] : [{ rule: 'no_description', severity: 'error', message: 'Only the tag - say what was done' }] })
    }
    if (url.startsWith('/api/chats')) {
      const u = new URL(url, 'http://t')
      const owner = u.searchParams.get('me_account_id') ?? ME
      const id = decodeURIComponent(u.pathname.split('/')[3] ?? '')
      if (!id) return json(recentChats(owner).map(({ id, title, used }) => ({ id, title, created_at: used, updated_at: Date.now() / 1000 - 100 + used })))
      const c = savedChats.find((x) => x.id === id && x.owner === owner)
      if (!c) return json({ detail: 'Chat not found' }, false, 404)
      if (init?.method === 'DELETE') { savedChats = savedChats.filter((x) => x !== c); return json({ ok: true }) }
      c.used = ++clock                                               // opening = using it (LRU)
      return json({ id: c.id, title: c.title, created_at: 0, updated_at: Date.now() / 1000, messages: c.messages })
    }
    if (url === '/api/chat/stream') {
      if (fake.noStream) return json({ detail: 'Not Found' }, false, 404)
      if (body?.message === 'boom' && !(globalThis as Record<string, unknown>).__boomed) {
        (globalThis as Record<string, unknown>).__boomed = true
        return json({ detail: 'Jira error: timeout' }, false)
      }
      const answer = `answer to: ${body?.message}`
      const events = fake.streamEvents ?? [
        { type: 'start', session_id: String(body?.session_id ?? 's1'), as: 'x' },
        { type: 'status', text: 'Counting bugs in Form Builder (30 days)…' },
        { type: 'delta', text: answer },
        { type: 'done', answer, tools: [{ tool: 'person_issues', args: '{}' }], session_id: String(body?.session_id ?? 's1'), as: 'x' },
      ]
      if (!fake.streamEvents) saveExchange(String(body?.me_account_id ?? ME), String(body?.session_id), String(body?.message), answer)
      return Promise.resolve(sse(events, { hold: fake.hold ?? undefined }))
    }
    if (url.startsWith('/api/chat') && body?.message === 'boom' && !(globalThis as Record<string, unknown>).__boomed) {
      (globalThis as Record<string, unknown>).__boomed = true
      return json({ detail: 'Jira error: timeout' }, false)
    }
    if (url.startsWith('/api/chat')) {
      saveExchange(String(body?.me_account_id ?? ME), String(body?.session_id ?? 's1'), String(body?.message), `answer to: ${body?.message}`)
      return json({ session_id: 's1', answer: `answer to: ${body?.message}`, tools: [{ tool: 'person_issues', args: '{}' }], as: 'x' })
    }
    return json({ ok: true })
  }))
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
  try { localStorage.clear() } catch { /* ignore */ }
})

// questions go to /api/chat/stream (or /api/chat when streaming isn't available)
const chatCalls = () => calls.filter((c) => c.url === '/api/chat/stream' || c.url === '/api/chat')
const dashCalls = () => calls.filter((c) => c.url.startsWith('/api/dashboard'))

async function renderApp() {
  render(<App />)
  await screen.findByText('Where sprint work is sitting')
  return userEvent.setup()
}

// ------------------------------------------------------------------ tests
describe('dashboard filters', () => {
  it('loads with the 30-day period and shows its numbers', async () => {
    await renderApp()
    expect(dashCalls()[0].url).toContain('bug_days=30')
    expect(screen.getByText('Bugs needing work · 30d')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Bugs needing work · 30d\s*22/ })).toBeInTheDocument()
  })

  it.each([[7, 12], [90, 32], [30, 22]])('period %id refetches and updates the numbers', async (days, open) => {
    const user = await renderApp()
    await user.click(within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: `${days}d` }))
    await waitFor(() => expect(dashCalls().at(-1)!.url).toContain(`bug_days=${days}`))
    expect(await screen.findByRole('button', { name: new RegExp(`Bugs needing work · ${days}d\\s*${open}`) })).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: `${days}d` }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('period filter is shown on Overview, Bugs and Standards, and explained on People', async () => {
    const user = await renderApp()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    for (const tab of [/^Bugs/, /^Standards/, /^Overview/]) {
      await user.click(within(nav).getByRole('button', { name: tab }))
      expect(screen.getByRole('group', { name: 'Period' })).toBeInTheDocument()
    }
    await user.click(within(nav).getByRole('button', { name: /^People/ }))
    expect(screen.queryByRole('group', { name: 'Period' })).not.toBeInTheDocument()
    expect(screen.getByText(/People: right now/)).toBeInTheDocument()
  })

  it('refresh forces a reload from Jira', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(dashCalls().at(-1)!.url).toContain('refresh=true'))
  })
})

describe('tabs, cards and shortcuts', () => {
  it('each tab shows its own cards and badge counts', async () => {
    const user = await renderApp()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('button', { name: /^Bugs\s*22$/ })).toBeInTheDocument()
    await user.click(within(nav).getByRole('button', { name: /^Bugs/ }))
    expect(screen.getByText(/Bugs by feature · last 30 days/)).toBeInTheDocument()
    await user.click(within(nav).getByRole('button', { name: /^People/ }))
    expect(screen.getByText('Developer availability')).toBeInTheDocument()
    expect(screen.getByText('Busy on paper, quiet in Jira')).toBeInTheDocument()
    await user.click(within(nav).getByRole('button', { name: /^Standards/ }))
    expect(screen.getByText('Ticket titles')).toBeInTheDocument()
    expect(screen.getByText('Worklogs')).toBeInTheDocument()
  })

  it('Table toggle swaps the chart for a table and back', async () => {
    const user = await renderApp()
    const card = screen.getByText('Where sprint work is sitting').closest('section')!
    await user.click(within(card).getByRole('button', { name: 'Table' }))
    const table = within(card).getByRole('table')
    expect(within(table).getByText('Ready to deploy')).toBeInTheDocument()
    expect(within(table).getByText('96')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Chart' }))
    expect(within(card).queryByRole('table')).not.toBeInTheDocument()
  })

  it('a card "Ask" opens the chat drawer and sends a question about that card', async () => {
    const user = await renderApp()
    const card = screen.getByText('Where sprint work is sitting').closest('section')!
    await user.click(within(card).getByRole('button', { name: 'Ask ↗' }))
    await waitFor(() => expect(chatCalls()).toHaveLength(1))
    expect(String(chatCalls()[0].body!.message)).toContain('Ready to deploy')
    expect(await screen.findByText(/answer to: .*Ready to deploy/)).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Ask Jira' })).toHaveClass('open')
  })

  it('briefing chips jump to the right tab', async () => {
    const user = await renderApp()
    // the same alert also appears in the Attention list; the first one is the briefing chip in the header
    await user.click(screen.getAllByRole('button', { name: /high-priority bugs still open/ })[0])
    expect(screen.getByText(/Bugs by feature/)).toBeInTheDocument()
  })

  it('Attention items ask the chat', async () => {
    const user = await renderApp()
    const card = screen.getByText('Attention').closest('section')!
    await user.click(within(card).getAllByRole('button')[0])
    await waitFor(() => expect(chatCalls()).toHaveLength(1))
  })

  it('KPI tiles are clickable shortcuts', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: /Developers free now/ }))
    expect(screen.getByText('Developer availability')).toBeInTheDocument()
  })
})

describe('chat', () => {
  it('typing in the top bar asks, and Escape closes the drawer', async () => {
    const user = await renderApp()
    await user.type(screen.getByRole('textbox', { name: 'Ask Jira' }), 'kitne bugs hain{Enter}')
    await waitFor(() => expect(chatCalls()[0].body!.message).toBe('kitne bugs hain'))
    expect(chatCalls()[0].body!.me_account_id).toBe(ME)
    await user.keyboard('{Escape}')
    expect(document.querySelector('aside.drawer')).not.toHaveClass('open')
  })

  it('"I am" picker changes who "my tasks" means', async () => {
    const user = await renderApp()
    await user.selectOptions(screen.getByRole('combobox', { name: 'I am' }), RAVI)
    expect(screen.getByRole('heading', { name: /^Good (morning|afternoon|evening), Ravi$/ }).textContent).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: 'Ask Jira' }), 'what am I working on{Enter}')
    await waitFor(() => expect(chatCalls().at(-1)!.body!.me_account_id).toBe(RAVI))
  })

  it('the floating button opens the drawer', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    expect(screen.getByRole('complementary', { name: 'Ask Jira' })).toHaveClass('open')
  })
})

// ------------------------------------------------------------------ voice
class FakeRecognition {
  static last: FakeRecognition | null = null
  lang = ''
  interimResults = false
  continuous = false
  maxAlternatives = 1
  onresult: ((e: unknown) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => this.onend?.())
  abort = vi.fn()
  constructor() { FakeRecognition.last = this }
  say(text: string, final: boolean) {
    const result = Object.assign([{ transcript: text }], { isFinal: final })
    this.onresult?.({ resultIndex: 0, results: [result] })
  }
}

describe('voice search', () => {
  beforeEach(() => {
    FakeRecognition.last = null
    ;(window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition
  })

  it('speaking fills the box live and sends the question when you stop', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Ask by voice' }))
    const rec = FakeRecognition.last!
    expect(rec.start).toHaveBeenCalled()
    expect(rec.lang).toBe('en-IN')
    act(() => rec.say('form builder me', false))
    expect(screen.getByRole('textbox', { name: 'Ask Jira' })).toHaveValue('form builder me')
    act(() => { rec.say('form builder me kitne bugs hain', true); rec.onend!() })
    await waitFor(() => expect(chatCalls().at(-1)!.body!.message).toBe('form builder me kitne bugs hain'))
  })

  it('voice is English only for now and says so; typing says English or Hindi', async () => {
    localStorage.setItem('voiceLang', 'hi-IN')          // someone picked Hindi before: falls back to English
    const user = await renderApp()
    expect(screen.queryByRole('button', { name: /Voice language/ })).not.toBeInTheDocument()   // no switch any more
    expect(screen.getAllByText('Voice: English')[0]).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Ask Jira' })).toHaveAttribute('placeholder', expect.stringMatching(/English or Hindi/))
    expect(screen.getByRole('button', { name: 'Ask by voice' })).toHaveAttribute('title', 'Ask by voice (English only for now)')
    await user.click(screen.getByRole('button', { name: 'Ask by voice' }))
    expect(FakeRecognition.last!.lang).toBe('en-IN')
  })

  it('clicking the mic again stops listening', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Ask by voice' }))
    await user.click(screen.getByRole('button', { name: 'Stop listening' }))
    expect(FakeRecognition.last!.stop).toHaveBeenCalled()
    expect(chatCalls()).toHaveLength(0)            // nothing said -> nothing sent
  })

  it('a blocked microphone shows a helpful message', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Ask by voice' }))
    act(() => FakeRecognition.last!.onerror!({ error: 'not-allowed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Microphone is blocked')
  })

  it('if the recogniser ends with only in-progress words, they are still sent', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Ask by voice' }))
    const rec = FakeRecognition.last!
    act(() => { rec.say('who is free this week', false); rec.onend!() })   // never marked final
    await waitFor(() => expect(chatCalls().at(-1)!.body!.message).toBe('who is free this week'))
  })

  it('stops listening by itself after a short pause', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Ask by voice' }))
    const rec = FakeRecognition.last!
    vi.useFakeTimers()
    try {
      act(() => rec.say('kaun free hai', false))
      expect(rec.stop).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1300) })
      expect(rec.stop).toHaveBeenCalled()            // stop() -> onend -> the question is sent
    } finally {
      vi.useRealTimers()
    }
    await waitFor(() => expect(chatCalls().at(-1)!.body!.message).toBe('kaun free hai'))
  })

  it('browsers without speech recognition get a disabled mic with a hint', async () => {
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
    await renderApp()
    expect(screen.getByRole('button', { name: 'Voice search unavailable' })).toBeDisabled()
  })
})


// ------------------------------------------------------------------ drill-down
const drillCalls = () => calls.filter((c) => c.url === '/api/drilldown')

describe('click a chart to list its tickets', () => {
  it('a pipeline bar lists that status, filters, and closes with Escape', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Ready to deploy: 96. Show tickets' }))
    await waitFor(() => expect(drillCalls()[0].body).toEqual({ kind: 'sprint_status', params: { status: 'Ready to deploy' } }))
    const sheet = await screen.findByRole('dialog', { name: 'drill sprint_status' })
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(8)
    expect(within(sheet).getByRole('link', { name: 'Open in Jira ↗' })).toHaveAttribute('href', 'https://x/issues?jql=x')
    await user.type(within(sheet).getByRole('textbox', { name: 'Filter tickets' }), 'deepak')
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('bug feature segments, feature names, weeks and KPI tiles each ask for the right tickets', async () => {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /^Bugs/ }))
    const close = async () => { await screen.findByRole('dialog'); await user.click(screen.getByRole('button', { name: 'Close list' })) }

    await user.click(screen.getByRole('button', { name: 'Voter Module User Portal, Fixed, not released: 5. Show tickets' }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual(
      { kind: 'bugs_feature', params: { feature: 'Voter Module User Portal', days: 30, state: 'fixed_unreleased' } }))
    await close()

    await user.click(screen.getByRole('button', { name: 'Voter Module User Portal' }))
    await waitFor(() => expect(drillCalls().at(-1)!.body!.params).toMatchObject({ feature: 'Voter Module User Portal', state: null }))
    await close()

    await user.click(screen.getByRole('button', { name: /Week of 28 Sept.*Show tickets/ }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'bugs_week', params: { week: '2026-09-28' } }))
    await close()

    await user.click(screen.getByRole('button', { name: /^Invalid/ }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'bugs_state', params: { days: 30, state: 'invalid' } }))
  })

  it('a workload bar lists that person\'s active issues, and "Ask about these" hands over to chat', async () => {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /^People/ }))
    await user.click(screen.getByRole('button', { name: 'Abhinandan: 19. Show tickets' }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'person_active', params: { name: 'Abhinandan' } }))
    await user.click(await screen.findByRole('button', { name: '✦ Ask about these' }))
    await waitFor(() => expect(String(chatCalls().at(-1)!.body!.message)).toContain('drill person_active'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

// ------------------------------------------------------------------ naming guide
describe('naming guide', () => {
  it('opens from a shareable #guide link and shows the formats', async () => {
    window.history.replaceState(null, '', '/#guide')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'How we name Jira tickets' })).toBeInTheDocument()
    expect(within(screen.getAllByRole('table')[0]).getByText('Module | Action and outcome')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Period' })).not.toBeInTheDocument()
  })

  it('the title checker explains failures and offers an AI rewrite', async () => {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Naming guide' }))
    expect(window.location.hash).toBe('#guide')
    const input = await screen.findByRole('textbox', { name: 'Ticket title' })
    await user.type(input, 'fix issue')
    expect(await screen.findByText("Missing 'Module | ' prefix")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '✦ Suggest a better title' }))
    await waitFor(() => expect(String(chatCalls().at(-1)!.body!.message)).toContain('"fix issue"'))
    await user.clear(input)
    await user.type(input, 'Login | Add recent searches')
    expect(await screen.findByText('Follows the standard')).toBeInTheDocument()
  })

  it('worklog checker: category chips prefill, short notes fail, real notes pass', async () => {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Naming guide' }))
    await user.click(await screen.findByRole('button', { name: '[Dev]' }))
    const note = screen.getByRole('textbox', { name: 'Worklog note' })
    expect(note).toHaveValue('[Dev] ')
    expect(await screen.findByText('Only the tag - say what was done')).toBeInTheDocument()
    await user.type(note, 'Add version filter to report')
    expect(await screen.findByText('Good worklog')).toBeInTheDocument()
  })
})


describe('naming guide: click a tag to fill the checker, then copy', () => {
  async function openGuide() {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Naming guide' }))
    await screen.findByRole('textbox', { name: 'Ticket title' })
    return user
  }

  it('a verb starts the action part, replacing the old verb and keeping the module', async () => {
    const user = await openGuide()
    const input = screen.getByRole('textbox', { name: 'Ticket title' })
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(input).toHaveValue('Add ')
    await user.clear(input)
    await user.type(input, 'Login | Fix recent searches')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(input).toHaveValue('Login | Add recent searches')
    await user.clear(input)
    await user.type(input, 'iOS | Global Search | Add shimmer')
    await user.click(screen.getByRole('button', { name: 'Fix' }))
    expect(input).toHaveValue('iOS | Global Search | Fix shimmer')          // module with several parts stays intact
  })

  it('a green example fills the checker with its issue type, and Copy puts it on the clipboard', async () => {
    const user = await openGuide()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await user.click(screen.getByRole('button', { name: /Magazine \| Shared link opens unpublished magazine/ }))
    expect(screen.getByRole('textbox', { name: 'Ticket title' })).toHaveValue('Magazine | Shared link opens unpublished magazine')
    expect(screen.getByRole('combobox', { name: 'Issue type' })).toHaveValue('Bug')
    expect(await screen.findByText('Follows the standard')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy ticket title' }))
    expect(writeText).toHaveBeenCalledWith('Magazine | Shared link opens unpublished magazine')
    expect(screen.getByRole('button', { name: 'Copy ticket title' })).toHaveTextContent('✓ Copied')
  })

  it('worklog: an example fills the note box; a category swaps the tag and keeps the text', async () => {
    const user = await openGuide()
    await user.click(screen.getByRole('button', { name: '[Dev] Add filter' }))
    const note = screen.getByRole('textbox', { name: 'Worklog note' })
    expect(note).toHaveValue('[Dev] Add filter')
    await user.click(screen.getByRole('button', { name: '[Testing]' }))
    expect(note).toHaveValue('[Testing] Add filter')
    expect(screen.getByRole('button', { name: 'Copy worklog note' })).toBeEnabled()
  })
})


describe('time log calendar: 5 h per working day, weekends off, reasons for short days', () => {
  it('shows the month as day squares; clicking a short day shows its tickets and saves a reason', async () => {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Time log' }))
    expect(await screen.findByText('Your time log')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Period' })).not.toBeInTheDocument()
    expect(calls.some((c) => /\/api\/timelog\?month=\d{4}-\d{2}/.test(c.url))).toBe(true)
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled()          // no future months
    expect(screen.getByText('8h 30m')).toBeInTheDocument()                               // hours shown as h + m
    const short = screen.getByRole('button', { name: /13 November: 3h of 5h · 2h short/ })
    expect(screen.getByRole('button', { name: /12 November: 6h 30m logged · 1h 30m extra/ })).toBeInTheDocument()
    expect(screen.getByText('+1h 30m')).toBeInTheDocument()                               // overtime tag on the square
    expect(screen.getByRole('button', { name: /15 November: Weekend · off/ })).toBeInTheDocument()
    await user.click(short)
    const detail = screen.getByRole('region', { name: /Details for .*13 November/ })
    expect(within(detail).getByRole('link', { name: 'FB-658' })).toHaveAttribute('href', 'https://x/FB-658')
    expect(within(detail).getByText('[Dev] autosave')).toBeInTheDocument()
    await user.selectOptions(within(detail).getByRole('combobox', { name: 'Reason for 2026-11-13' }), 'half_day')
    await user.type(within(detail).getByRole('textbox', { name: 'Note for 2026-11-13' }), 'doctor visit')
    await user.click(within(detail).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/timelog/reason' && c.body?.reason === 'half_day' && c.body?.note === 'doctor visit')).toBe(true))
    expect(await within(detail).findByText(/Half day · doctor visit/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /13 November: .*Reason: Half day/ })).toBeInTheDocument()   // tag on the square
    // arrow keys move between days; Esc closes the (phone) sheet without losing the calendar
    screen.getByRole('button', { name: /13 November/ }).focus()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('button', { name: /12 November/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: /Details for .*12 November/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /12 November/ })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Close day details' }))
    expect(document.querySelector('.cal-side')).not.toHaveClass('open')
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/timelog?month=')).length).toBeGreaterThan(1))
  })

  it('a short day can point at the day the extra time was worked (made up / comp off)', async () => {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Time log' }))
    await user.click(await screen.findByRole('button', { name: /13 November: 3h of 5h/ }))
    const detail = screen.getByRole('region', { name: /Details for .*13 November/ })
    await user.selectOptions(within(detail).getByRole('combobox', { name: 'Reason for 2026-11-13' }), 'made_up')
    const which = within(detail).getByRole('combobox', { name: 'Day the extra time was worked for 2026-11-13' })
    expect(which).toHaveDisplayValue(/12 Nov · \+1h 30m extra/)                // suggests the days with extra time
    await user.click(within(detail).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/timelog/reason' && c.body?.reason === 'made_up' && c.body?.other_day === '2026-11-12')).toBe(true))
    expect(await within(detail).findByText(/Made up on another day \(.*12 Nov\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /13 November: .*Reason: Made up on another day/ })).toBeInTheDocument()
  })
})


describe('bugs project filter', () => {
  it('picking a project loads that project, scopes drill-downs, and can be cleared', async () => {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /^Bugs/ }))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Project' }), 'VO')
    await waitFor(() => expect(calls.some((c) => c.url === '/api/bugs?days=30&project=VO')).toBe(true))
    expect(await screen.findByRole('button', { name: /^Need work\s*8/ })).toBeInTheDocument()
    expect(screen.getByText(/Bugs by feature · last 30 days · Voter Outreach/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Need work/ }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'bugs_state', params: { days: 30, state: 'open', project: 'VO' } }))
    await user.click(await screen.findByRole('button', { name: 'Close list' }))
    await user.click(screen.getByRole('button', { name: '✕ Clear project' }))
    expect(await screen.findByRole('button', { name: /^Need work\s*22/ })).toBeInTheDocument()   // back to all projects
  })
})


describe('sprints tab', () => {
  async function openSprints() {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Sprints' }))
    await screen.findByText('Where the sprint\'s work ended up')
    return user
  }

  it('shows the last sprint by default with delivery numbers and the open-board warning', async () => {
    await openSprints()
    expect(calls.some((c) => c.url === '/api/sprint-report?sprint=last')).toBe(true)
    expect(screen.getByRole('button', { name: /^Delivered\s*32\s*%/ })).toBeInTheDocument()
    expect(screen.getByText(/boards never closed this sprint/)).toHaveTextContent('Data Entry')
    expect(screen.queryByRole('group', { name: 'Period' })).not.toBeInTheDocument()
  })

  it('per-person cards and the measurement notes are not shown', async () => {
    await openSprints()
    for (const title of ['Developers', 'Testers', 'Highlights']) {
      expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument()
    }
    expect(screen.queryByText('Sneha Kulkarni')).not.toBeInTheDocument()      // names from the API aren't shown
    expect(screen.queryByText('lakshmi.raman')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'How this is measured' })).not.toBeInTheDocument()   // removed
    expect(screen.queryByText(/Delivered = Released by the end date/)).not.toBeInTheDocument()
  })

  it('every number opens its tickets', async () => {
    const user = await openSprints()
    const close = async () => user.click(await screen.findByRole('button', { name: 'Close list' }))
    await user.click(screen.getByRole('button', { name: /^Not delivered\s*384/ }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'sprint_outcome', params: { sprint: 'Q4 FY26 - Sprint 3', outcome: 'not_delivered' } }))
    await close()
    await user.click(screen.getByRole('button', { name: /^Carried to next sprint/ }))
    await waitFor(() => expect(drillCalls().at(-1)!.body!.params).toMatchObject({ flag: 'carried_over' }))
    await close()
    await user.click(screen.getByRole('button', { name: 'WEB, Dev done, not released: 44. Show tickets' }))
    await waitFor(() => expect(drillCalls().at(-1)!.body!.params).toMatchObject({ project: 'WEB', outcome: 'dev_complete' }))
  })

  it('switching sprint (picker or trend column) reloads the report', async () => {
    const user = await openSprints()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sprint' }), 'Q4 FY26 - Sprint 4')
    await waitFor(() => expect(calls.at(-1)!.url).toBe('/api/sprint-report?sprint=Q4%20FY26%20-%20Sprint%204'))
    expect(await screen.findByRole('button', { name: /^Delivered\s*6\s*%/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Q4 FY26 - Sprint 3: 183 of 567 delivered.*Open sprint/ }))
    await waitFor(() => expect(calls.at(-1)!.url).toBe('/api/sprint-report?sprint=Q4%20FY26%20-%20Sprint%203'))
  })

})

// The sortable table is parked with the hidden per-person cards; test it directly so turning them back on is safe.
describe('SortTable', () => {
  it('sorts by any column, toggling direction, and row clicks report the row', async () => {
    const onRow = vi.fn()
    const rows = [{ name: 'Ravi', delivered: 16, hours: 0 }, { name: 'Sneha', delivered: 13, hours: 6.5 }]
    render(<SortTable rows={rows} initial="delivered" onRow={onRow} rowLabel={(r) => `${r.name}: open`}
      cols={[{ key: 'name', label: 'Person' }, { key: 'delivered', label: 'Delivered', num: true }, { key: 'hours', label: 'Hours logged', num: true }]} />)
    const user = userEvent.setup()
    const first = () => screen.getAllByRole('row')[1].textContent
    expect(first()).toContain('Ravi')                                          // most delivered first
    await user.click(screen.getByRole('button', { name: 'Hours logged' }))
    expect(first()).toContain('Sneha')                                      // most hours first
    await user.click(screen.getByRole('button', { name: /Hours logged/ }))
    expect(first()).toContain('Ravi')                                          // ascending
    await user.click(screen.getByRole('button', { name: 'Sneha: open' }))
    expect(onRow).toHaveBeenCalledWith(rows[1])
  })
})


describe('standards: click a problem or a person to list the tickets', () => {
  async function openStandards() {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /^Standards/ }))
    await screen.findByText('Ticket titles')
    return user
  }

  it('a title problem lists its tickets with the reasons and who created them', async () => {
    const user = await openStandards()
    await user.click(screen.getByRole('button', { name: "Doesn't start with an action verb: 68. Show tickets" }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'naming_rule', params: { days: 30, rule: 'no_action_verb' } }))
    const sheet = await screen.findByRole('dialog', { name: 'naming no_action_verb' })
    expect(within(sheet).getByText('Misc work')).toBeInTheDocument()
    expect(within(sheet).getByText('created by Arjun Malhotra')).toBeInTheDocument()
    expect(within(sheet).getByText("Doesn't start with a verb · Bucket word 'Misc'")).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: '✦ Ask about these' }))
    await waitFor(() => expect(chatCalls().at(-1)!.body!.message).toBe('Suggest better titles for these'))   // list-specific question
  })

  it('a person under "Not following it" lists all their bad titles', async () => {
    const user = await openStandards()
    await user.click(screen.getByRole('button', { name: 'Arjun Malhotra: show all 12 titles that break the standard' }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'naming_rule', params: { days: 30, person: 'Arjun Malhotra' } }))
  })

  it('worklog problems and people list the worklogs, showing each note', async () => {
    const user = await openStandards()
    await user.click(screen.getByRole('button', { name: 'Tag only: 21. Show tickets' }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'worklog_rule', params: { days: 30, rule: 'no_description' } }))
    const sheet = await screen.findByRole('dialog', { name: 'worklogs no_description' })
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(2)          // same ticket twice: both rows render
    expect(within(sheet).getByText('[Code Review]')).toBeInTheDocument()
    expect(within(sheet).getAllByText('logged by vijay.yadav')).toHaveLength(2)
    await user.click(within(sheet).getByRole('button', { name: 'Close list' }))
    await user.click(screen.getByRole('button', { name: 'vijay.yadav: show all 7 worklogs without a description' }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'worklog_rule', params: { days: 30, person: 'vijay.yadav' } }))
  })

  it('the period filter carries into the lists', async () => {
    const user = await openStandards()
    await user.click(within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: '90d' }))
    await waitFor(() => expect(dashCalls().at(-1)!.url).toContain('bug_days=90'))
    expect(await screen.findAllByText(/last 90 days/)).toHaveLength(2)        // both cards follow the period
    await user.click(screen.getByRole('button', { name: "Doesn't start with an action verb: 68. Show tickets" }))
    await waitFor(() => expect(drillCalls().at(-1)!.body!.params).toEqual({ days: 90, rule: 'no_action_verb' }))
  })
})


describe('developer availability bar', () => {
  it('each part lists its people, and a person opens their tickets', async () => {
    const user = await renderApp()
    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /^People/ }))
    await user.click(screen.getByRole('button', { name: 'Busy: 33 people. Show them' }))
    const busy = screen.getByRole('dialog', { name: 'Busy developers' })
    expect(within(busy).getByText('19 active issues · 2 To Do in sprint')).toBeInTheDocument()
    await user.click(within(busy).getByRole('button', { name: /^Abhinandan: .*Show their tickets$/ }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'person_active', params: { name: 'Abhinandan' } }))
    await user.click(await screen.findByRole('button', { name: 'Close list' }))

    await user.click(screen.getByRole('button', { name: 'Free, nothing queued: 7 people. Show them' }))
    const idle = screen.getByRole('dialog', { name: 'Free, nothing queued' })
    expect(within(idle).getByText('Manoj Pillai')).toBeInTheDocument()
    await user.click(within(idle).getByRole('button', { name: /^Manoj Pillai: / }))
    await waitFor(() => expect(drillCalls().at(-1)!.body).toEqual({ kind: 'person_open', params: { name: 'Manoj Pillai' } }))
    await user.click(await screen.findByRole('button', { name: 'Close list' }))
    await user.click(screen.getByRole('button', { name: 'Free, has To Do: 8 people. Show them' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})


describe('chat composer and messages (ChatGPT/Claude style)', () => {
  async function openChat() {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    return { user, box: screen.getByRole('textbox', { name: 'Your question' }) }
  }

  it('Shift+Enter adds a new line, Enter sends the whole multi-line message', async () => {
    const { user, box } = await openChat()
    await user.type(box, 'Line one{Shift>}{Enter}{/Shift}Line two')
    expect(box).toHaveValue('Line one\nLine two')
    expect(chatCalls()).toHaveLength(0)                       // nothing sent yet
    await user.keyboard('{Enter}')
    await waitFor(() => expect(chatCalls()[0].body!.message).toBe('Line one\nLine two'))
    expect(box).toHaveValue('')
    const bubble = document.querySelector('.msg.user .bubble') as HTMLElement
    expect(bubble.textContent).toBe('Line one\nLine two')    // line breaks kept (white-space: pre-wrap)
  })

  it('the top ask bar is multi-line too', async () => {
    const user = await renderApp()
    const bar = screen.getByRole('textbox', { name: 'Ask Jira' })
    expect(bar.tagName).toBe('TEXTAREA')
    await user.type(bar, 'bugs in{Shift>}{Enter}{/Shift}form builder{Enter}')
    await waitFor(() => expect(chatCalls()[0].body!.message).toBe('bugs in\nform builder'))
  })

  it('Enter while an input method is composing (Hindi typing) does not send', async () => {
    const { box } = await openChat()
    fireEvent.change(box, { target: { value: 'फॉर्म' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(chatCalls()).toHaveLength(0)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(chatCalls()[0].body!.message).toBe('फॉर्म'))
  })

  it('send button is disabled until there is text', async () => {
    const { user, box } = await openChat()
    const send = within(screen.getByRole('complementary', { name: 'Ask Jira' })).getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    await user.type(box, 'hi')
    expect(send).toBeEnabled()
    await user.click(send)
    await waitFor(() => expect(chatCalls()[0].body!.message).toBe('hi'))
  })

  it('answers can be copied, and the chat can go full screen', async () => {
    const { user, box } = await openChat()
    await user.type(box, 'how many bugs?{Enter}')
    await screen.findByText('answer to: how many bugs?')
    await user.click(screen.getByRole('button', { name: 'Copy answer' }))
    expect(await navigator.clipboard.readText()).toBe('answer to: how many bugs?')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    const drawer = screen.getByRole('complementary', { name: 'Ask Jira' })
    await user.click(screen.getByRole('button', { name: 'Expand chat' }))
    expect(drawer).toHaveClass('expanded')
    await user.click(screen.getByRole('button', { name: 'Exit full screen' }))
    expect(drawer).not.toHaveClass('expanded')
  })

  it('a failed answer offers Retry, which asks the same question again', async () => {
    (globalThis as Record<string, unknown>).__boomed = false
    const { user, box } = await openChat()
    await user.type(box, 'boom{Enter}')
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(chatCalls()).toHaveLength(2))
    expect(chatCalls()[1].body!.message).toBe('boom')
    expect(await screen.findByText('answer to: boom')).toBeInTheDocument()
  })
})

describe('chat history sidebar (ChatGPT/Claude style)', () => {
  async function chatWith(question: string) {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), `${question}{Enter}`)
    await screen.findByText(`answer to: ${question}`)
    return user
  }
  const drawer = () => screen.getByRole('complementary', { name: 'Ask Jira' })
  const history = () => within(drawer()).getByRole('navigation', { name: 'Chat history' })
  const headerNewChat = () => within(document.querySelector('.drawer-head') as HTMLElement).getByRole('button', { name: 'New chat' })

  it('New chat keeps the old one in the list; opening it restores it and follow-ups continue it', async () => {
    const user = await chatWith('bugs in form builder?')
    const firstSession = chatCalls()[0].body!.session_id
    expect(firstSession).toBeTruthy()

    await user.click(headerNewChat())
    expect(document.querySelectorAll('.chat-log .msg')).toHaveLength(0)
    await user.click(within(drawer()).getByRole('button', { name: 'Chat history' }))
    expect(within(history()).getByText('Today')).toBeInTheDocument()
    await user.click(within(history()).getByRole('button', { name: 'bugs in form builder?' }))
    expect(screen.getByText('answer to: bugs in form builder?')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'and in voter module?{Enter}')
    await waitFor(() => expect(chatCalls()).toHaveLength(2))
    expect(chatCalls()[1].body!.session_id).toBe(firstSession)                  // same conversation
    expect(chatCalls()[1].body!.history).toEqual([                               // context, in case the server restarted
      { role: 'user', text: 'bugs in form builder?' }, { role: 'bot', text: 'answer to: bugs in form builder?' }])
  })

  it('a new question in a new chat starts a separate conversation', async () => {
    const user = await chatWith('first question')
    await user.click(headerNewChat())
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'second question{Enter}')
    await screen.findByText('answer to: second question')
    expect(chatCalls()[1].body!.session_id).not.toBe(chatCalls()[0].body!.session_id)
    expect(chatCalls()[1].body!.history).toEqual([])
    const titles = [...history().querySelectorAll('.history-item')].map((b) => b.textContent)
    expect(titles).toEqual(['second question', 'first question'])               // newest first
  })

  it('history survives a reload (it comes from the server, not the browser)', async () => {
    await chatWith('remember me?')
    cleanup()                                          // close the page...
    localStorage.clear()                               // ...even in another browser
    const user = await renderApp()                     // ...and open it again
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    await user.click(await within(history()).findByRole('button', { name: 'remember me?' }))
    expect(await screen.findByText('answer to: remember me?')).toBeInTheDocument()   // messages loaded from the server
    expect(calls.some((c) => c.url.startsWith('/api/chats/'))).toBe(true)
  })

  it('deleting a chat needs a second click to confirm', async () => {
    const user = await chatWith('delete me')
    await user.click(within(history()).getByRole('button', { name: 'Delete chat: delete me' }))
    expect(within(history()).getByRole('button', { name: 'delete me' })).toBeInTheDocument()   // not yet
    await user.click(within(history()).getByRole('button', { name: 'Confirm delete: delete me' }))
    expect(within(history()).queryByRole('button', { name: 'delete me' })).not.toBeInTheDocument()
    expect(document.querySelectorAll('.chat-log .msg')).toHaveLength(0)        // it was the open chat
    await waitFor(() => expect(savedChats).toHaveLength(0))                    // deleted on the server too
  })

  it('each "I am" person sees only their own chats', async () => {
    const user = await chatWith('my private question')
    await user.keyboard('{Escape}')
    await user.selectOptions(screen.getByRole('combobox', { name: 'I am' }), RAVI)
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    expect(within(history()).queryByRole('button', { name: 'my private question' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.selectOptions(screen.getByRole('combobox', { name: 'I am' }), ME)
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    expect(within(history()).getByRole('button', { name: 'my private question' })).toBeInTheDocument()
  })
})

describe('theme switch', () => {
  it('follows the system by default, then cycles Light -> Dark -> System and is remembered', async () => {
    document.documentElement.removeAttribute('data-theme')
    const user = await renderApp()
    const btn = () => screen.getByRole('button', { name: /^Theme: / })
    expect(btn()).toHaveAccessibleName('Theme: system')
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    await user.click(btn())
    expect(btn()).toHaveAccessibleName('Theme: light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    await user.click(btn())
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    cleanup()
    await renderApp()                                                     // reload: choice kept
    expect(screen.getByRole('button', { name: 'Theme: dark' })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Theme: dark' }))
    expect(document.documentElement).not.toHaveAttribute('data-theme')  // back to system
  })
})

describe('chat history keeps the last 5 chats (least recently used goes)', () => {
  const head = () => within(document.querySelector('.drawer-head') as HTMLElement)
  const titles = () => [...document.querySelectorAll('.history .history-item')].map((b) => b.textContent)
  async function fiveChats() {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    for (let i = 1; i <= 5; i++) {
      await user.type(screen.getByRole('textbox', { name: 'Your question' }), `question ${i}{Enter}`)
      await screen.findByText(`answer to: question ${i}`)
      await user.click(head().getByRole('button', { name: 'New chat' }))
    }
    return user
  }

  it('the sidebar says only the last 5 chats are kept', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    expect(screen.getByText(/Only your last 5 chats are kept/)).toHaveTextContent('removes the one you used least recently')
    void user
  })

  it('a 6th chat removes the oldest, and the new-chat screen warns which one first', async () => {
    const user = await fiveChats()
    expect(await screen.findByText(/Asking here removes the least recently used one/)).toHaveTextContent('question 1')
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'question 6{Enter}')
    await screen.findByText('answer to: question 6')
    await waitFor(() => expect(titles()).toEqual(['question 6', 'question 5', 'question 4', 'question 3', 'question 2']))
    expect(recentChats(ME).map((c) => c.title)).toEqual(['question 6', 'question 5', 'question 4', 'question 3', 'question 2'])
  })

  it('opening an old chat counts as using it, so a different chat is removed', async () => {
    const user = await fiveChats()
    await user.click(within(document.querySelector('.history') as HTMLElement).getByRole('button', { name: 'question 1' }))
    expect(await screen.findByText('answer to: question 1')).toBeInTheDocument()
    await waitFor(() => expect(titles()[0]).toBe('question 1'))                  // moved to the top
    await user.click(head().getByRole('button', { name: 'New chat' }))
    expect(await screen.findByText(/Asking here removes/)).toHaveTextContent('question 2')
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'question 6{Enter}')
    await screen.findByText('answer to: question 6')
    await waitFor(() => expect(titles()).toEqual(['question 6', 'question 1', 'question 5', 'question 4', 'question 3']))
  })

  it('no warning while you have fewer than 5', async () => {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    expect(screen.queryByText(/Asking here removes/)).not.toBeInTheDocument()
    void user
  })
})

describe('the Jira Pulse logo', () => {
  it('takes you home: Overview tab, clean URL, lists and chat closed', async () => {
    const user = await renderApp()
    const tabs = () => within(screen.getByRole('navigation', { name: 'Sections' }))
    await user.click(tabs().getByRole('button', { name: /^Bugs/ }))
    expect(window.location.hash).toBe('#bugs')
    expect(tabs().getByRole('button', { name: /^Bugs/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    const logo = screen.getByRole('link', { name: 'Jira Pulse home' })
    expect(logo).toHaveAttribute('href', '/')
    await user.click(logo)
    expect(tabs().getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true')
    expect(window.location.hash).toBe('')
    expect(document.querySelector('.drawer')).not.toHaveClass('open')                      // chat closed
  })
})


describe('sign-in', () => {
  it('password mode: sign-in screen first, wrong password shows an error, then the dashboard', async () => {
    fake.session = { auth: 'password', signedIn: false, user: undefined }
    render(<App />)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Work email'), 'amit@example.com')
    await user.type(screen.getByLabelText('Password'), 'nope')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password')
    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Where sprint work is sitting')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'I am' })).not.toBeInTheDocument()   // identity is fixed
    expect(screen.getByText('Amit Chaudhary', { selector: '.signed-in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('proxy (company SSO) mode: no picker, shows who is signed in, no sign-out button', async () => {
    fake.session = { auth: 'proxy', signedIn: true, user: undefined }
    render(<App />)
    await screen.findByText('Where sprint work is sitting')
    expect(screen.queryByRole('combobox', { name: 'I am' })).not.toBeInTheDocument()
    expect(screen.getByText('Amit Chaudhary', { selector: '.signed-in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })

  it('clicking your name opens your profile; fields the token cannot read show "—" with the reason', async () => {
    fake.session = { auth: 'proxy', signedIn: true, user: undefined }
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Your profile' }))
    const sheet = await screen.findByRole('dialog', { name: 'Your profile' })
    expect(await within(sheet).findByText('Asia/Kolkata')).toBeInTheDocument()
    expect(within(sheet).getByText(/Not in Jira's API/)).toBeInTheDocument()
    expect(within(sheet).getByText('1 of 2 available', { exact: false })).toBeInTheDocument()
    expect(within(sheet).getByText('Being worked on').previousSibling).toHaveTextContent('1')
    expect(within(sheet).getByText('49.4h')).toBeInTheDocument()
    expect(within(sheet).getByRole('link', { name: /FB-658/ })).toHaveAttribute('href', 'https://x/FB-658')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Your profile' })).not.toBeInTheDocument()
  })

  it('greets a signed-in colleague by their Jira first name, capitalised', async () => {
    fake.session = { auth: 'proxy', signedIn: true,
      user: { email: 'kavya.iyer@example.com', name: 'kavya iyer', account_id: RAVI, jira_linked: true } }
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/^Good (morning|afternoon|evening), Kavya$/)
  })

  it('no Jira account found for the email: greeting without a name, never "Me"', async () => {
    fake.session = { auth: 'proxy', signedIn: true,
      user: { email: 'new.joiner@example.com', name: null, account_id: null, jira_linked: false } }
    render(<App />)
    const h1 = await screen.findByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent(/^Good (morning|afternoon|evening)$/)
    expect(h1).not.toHaveTextContent('Me')
  })

  it('signed out at the login gateway (its sign-in page comes back): reload to it instead of showing an error', async () => {
    const reload = vi.fn()
    const realLocation = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      url === '/api/session'
        ? Promise.resolve({ ok: false, status: 403, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
            json: () => Promise.reject(new Error('not json')) } as unknown as Response)
        : realFetch(url, init)))
    try {
      render(<App />)
      await waitFor(() => expect(reload).toHaveBeenCalled())
      expect(screen.queryByText(/Backend not reachable/)).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
    }
  })

  it('proxy mode without a signed-in user explains how to get in', async () => {
    fake.session = { auth: 'proxy', signedIn: false, user: undefined }
    render(<App />)
    expect(await screen.findByText(/company sign-in link/)).toBeInTheDocument()
  })
})


describe('streamed answers', () => {
  async function ask(question: string) {
    const user = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Open Ask Jira' }))
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), `${question}{Enter}`)
    return user
  }

  it('shows what the agent is doing while it works, then the answer', async () => {
    let release!: () => void
    const hold = new Promise<void>((r) => { release = r })
    fake.streamEvents = [
      { type: 'start', session_id: 's1', as: 'x' },
      { type: 'status', text: 'Counting bugs in Form Builder (30 days)…' },
      { type: 'delta', text: 'In the last 30 days, ' },
      { type: 'done', answer: 'In the last 30 days, **12 bugs** were reported.', tools: [], session_id: 's1', as: 'x' },
    ]
    fake.hold = hold                                  // the stream pauses before its last event
    await ask('bugs in form builder?')
    expect(await screen.findByText('Counting bugs in Form Builder (30 days)…')).toBeInTheDocument()
    expect(screen.getByText('In the last 30 days,')).toBeInTheDocument()            // text so far
    release()
    expect(await screen.findByText('12 bugs')).toBeInTheDocument()                    // final markdown answer
    expect(screen.queryByText('Counting bugs in Form Builder (30 days)…')).not.toBeInTheDocument()
  })

  it('a retry (made-up numbers guard) replaces the streamed text with the checked answer', async () => {
    fake.streamEvents = [
      { type: 'delta', text: 'Form builder has 5 bugs' },                            // invented, no tool
      { type: 'retry', text: 'Double-checking with Jira…' },
      { type: 'done', answer: 'Form Builder has 7 open bugs.', tools: [{ tool: 'bugs_in_feature', args: '{}' }], session_id: 's1', as: 'x' },
    ]
    await ask('form builder me kitne bugs?')
    expect(await screen.findByText('Form Builder has 7 open bugs.')).toBeInTheDocument()
    expect(screen.queryByText('Form builder has 5 bugs')).not.toBeInTheDocument()
  })

  it('falls back to the normal request when streaming is not available', async () => {
    fake.noStream = true
    await ask('hello there')
    expect(await screen.findByText('answer to: hello there')).toBeInTheDocument()
    expect(calls.filter((c) => c.url === '/api/chat')).toHaveLength(1)
  })

  it('a stream error shows Retry', async () => {
    fake.streamEvents = [{ type: 'status', text: 'Thinking…' }, { type: 'error', detail: 'Jira error: timeout' }]
    await ask('anything')
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument()
    expect(screen.getByText(/Jira error: timeout/)).toBeInTheDocument()
  })
})
