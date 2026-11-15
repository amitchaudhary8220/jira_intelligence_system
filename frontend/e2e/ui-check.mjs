// Real-browser UI check against the LIVE server and REAL Jira data.
// Clicks every clickable thing on every tab, and checks that each number equals the length of the list it opens
// and matches the API. Uses your installed Google Chrome (no browser download).
//
//   make up            (server running)
//   make test-e2e      (or: cd frontend && npm run e2e)
//
// Screenshots go to frontend/e2e/screenshots/.

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE = process.env.UI_URL ?? 'http://127.0.0.1:8010'
const SHOTS = process.env.SHOTS_DIR ?? new URL('./screenshots/', import.meta.url).pathname
mkdirSync(SHOTS, { recursive: true })

// ------------------------------------------------------------------ tiny test kit
const results = []
const record = (ok, area, what, detail = '') => results.push({ ok, area, what, detail })
const check = (area, what, cond, detail = '') => record(Boolean(cond), area, what, detail)
const first = (s) => Number((String(s).match(/-?[\d,]+(\.\d+)?/)?.[0] ?? 'NaN').replace(/,/g, ''))
async function api(path) {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`)
  return r.json()
}
async function step(area, what, fn) {
  try { await fn() } catch (e) { record(false, area, what, String(e?.message ?? e).split('\n')[0].slice(0, 220)) }
}

// ------------------------------------------------------------------ page helpers
async function waitIdle(page) {
  // no grid/kpi/period/sprint loading states left
  await page.waitForFunction(() => !document.querySelector(
    '.grid.is-loading, .kpis.is-loading, .sprint-grid.is-loading, .segmented button.is-loading, .skeleton'), null, { timeout: 180000 })
}

async function openList(page, clickable) {
  await clickable.click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 60000 })
  await page.waitForFunction(() => {
    const d = document.querySelector('.sheet')
    return d && (d.querySelector('.sheet-head .card-sub') || d.querySelector('.banner'))
  }, null, { timeout: 180000 })
  const banner = dialog.locator('.banner')
  const err = (await banner.count()) ? await banner.innerText() : null
  const sub = err ? '' : await dialog.locator('.sheet-head .card-sub').innerText()
  const title = await dialog.locator('h2').innerText()
  const total = err ? NaN : first(sub.match(/^([\d,]+) tickets?/)?.[1] ?? 'NaN')
  const rows = await dialog.locator('.sheet-list > li').count()
  await page.getByRole('button', { name: 'Close list' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 15000 })
  return { title, total, rows, err }
}

async function checkList(page, area, what, clickable, expected) {
  await step(area, what, async () => {
    const got = await openList(page, clickable)
    const rowsOk = got.rows === Math.min(got.total, 200)
    check(area, what, !got.err && got.total === expected && rowsOk,
      got.err ? `error: ${got.err}` : `clicked number ${expected}, list says ${got.total} (${got.rows} rows shown) · "${got.title}"`)
  })
}

async function goTab(page, name) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: new RegExp(`^${name}`) }).click()
}

async function closeDrawer(page) {
  if (await page.locator('aside.drawer.open').count()) {
    await page.keyboard.press('Escape')
    await page.locator('aside.drawer.open').waitFor({ state: 'detached', timeout: 10000 })
  }
}

async function chatAnswer(page) {
  // wait for the typing dots to go away and a bot message to exist
  await page.waitForFunction(() => !document.querySelector('.msg.typing') && document.querySelectorAll('.msg.bot, .msg.error').length > 0,
    null, { timeout: 120000 })
  const last = page.locator('.chat-log .msg.bot, .chat-log .msg.error').last()
  return last.innerText()
}

const kpiValue = (scope, label) => scope.locator('button.kpi', { hasText: label }).first().locator('.kpi-value')
const labelNumber = (label, re) => first(label.match(re)?.[1] ?? 'NaN')

// ------------------------------------------------------------------ run
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const consoleErrors = []
const badResponses = []
const sentChats = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`))
page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`) })
// questions go to /api/chat/stream (or /api/chat as a fallback)
page.on('request', (r) => { if (/\/api\/chat(\/stream)?$/.test(r.url())) sentChats.push(JSON.parse(r.postData() ?? '{}')) })

const t0 = Date.now()
await page.goto(BASE)
await page.getByText('Where sprint work is sitting').waitFor({ timeout: 180000 })
await waitIdle(page)
const dash = await api('/api/dashboard?bug_days=30')
await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/01-overview.png`, fullPage: true })

await step('Layout', 'composers contain their contents', async () => {
  // every box must be at least as tall as what is inside it (a CSS clash once squashed the top bar to 14 px)
  const boxes = await page.evaluate(() => [...document.querySelectorAll('form.composer')].map((f) => {
    const kids = [...f.children].map((k) => k.getBoundingClientRect())
    const r = f.getBoundingClientRect()
    return { h: r.height, top: r.top, bottom: r.bottom, ok: kids.every((k) => k.top >= r.top - 1 && k.bottom <= r.bottom + 1) }
  }))
  check('Layout', 'top ask bar holds its text box and buttons', boxes.length > 0 && boxes.every((b) => b.ok), JSON.stringify(boxes))
})

// ================================================================== OVERVIEW
await step('Overview', 'KPI tiles show the API numbers', async () => {
  check('Overview', 'Sprint progress = API', first(await kpiValue(page, 'Sprint progress').innerText()) === dash.sprint.done)
  check('Overview', 'Bugs needing work = API', first(await kpiValue(page, 'Bugs needing work').innerText()) === dash.bugs.open)
  check('Overview', 'Developers free = API',
    first(await kpiValue(page, 'Developers free now').innerText()) === dash.team.free_with_queue + dash.team.free_idle)
  check('Overview', 'Titles on standard = API', first(await kpiValue(page, 'Titles on standard').innerText()) === dash.standards.naming.compliance_pct)
})

const pipeCard = page.locator('section.card', { hasText: 'Where sprint work is sitting' })
await step('Overview', 'pipeline bars match the API', async () => {
  const labels = await pipeCard.getByRole('button', { name: /Show tickets$/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  for (const l of labels) {
    const status = l.split(':')[0]
    const apiCount = dash.sprint.pipeline.find((p) => p.status === status)?.count
    check('Overview', `pipeline "${status}" bar = API`, labelNumber(l, /: ([\d,]+)\. Show tickets$/) === apiCount, `bar ${l}, API ${apiCount}`)
  }
})
{
  const bars = pipeCard.getByRole('button', { name: /Show tickets$/ })
  const n = await bars.count()
  for (let i = 0; i < n; i++) {
    const l = await bars.nth(i).getAttribute('aria-label')
    await checkList(page, 'Overview', `pipeline bar "${l.split(':')[0]}" -> its list`, bars.nth(i), labelNumber(l, /: ([\d,]+)\. Show tickets$/))
  }
}

await step('Overview', 'pipeline Table toggle', async () => {
  await pipeCard.getByRole('button', { name: 'Table' }).click()
  const rows = await pipeCard.locator('table tbody tr').count()
  check('Overview', 'pipeline Table shows every status', rows === dash.sprint.pipeline.length, `${rows} rows vs ${dash.sprint.pipeline.length}`)
  await pipeCard.getByRole('button', { name: 'Chart' }).click()
  check('Overview', 'pipeline Chart comes back', (await pipeCard.locator('table').count()) === 0)
})

await step('Overview', 'briefing chips switch tabs', async () => {
  const chips = page.locator('.briefing button')
  const n = await chips.count()
  check('Overview', 'briefing shows up to 3 chips', n >= 1 && n <= 3, `${n} chips`)
  for (let i = 0; i < n; i++) {
    const text = await chips.nth(i).innerText()
    const want = /bug/i.test(text) ? 'Bugs' : /people|developers/i.test(text) ? 'People' : /naming|worklog/i.test(text) ? 'Standards' : 'Overview'
    await chips.nth(i).click()
    const active = await page.locator('nav.tabs > button[aria-pressed="true"]').innerText()
    check('Overview', `chip "${text.slice(0, 40)}" opens ${want}`, active.startsWith(want), `opened ${active}`)
    await goTab(page, 'Overview')
  }
})

await step('Overview', 'KPI tiles are shortcuts', async () => {
  for (const [label, want] of [['Bugs needing work', 'Bugs'], ['Developers free now', 'People'], ['Titles on standard', 'Standards']]) {
    await page.locator('button.kpi', { hasText: label }).click()
    const active = await page.locator('nav.tabs > button[aria-pressed="true"]').innerText()
    check('Overview', `tile "${label}" opens ${want}`, active.startsWith(want), `opened ${active}`)
    await goTab(page, 'Overview')
  }
})

await step('Overview', 'an Attention item asks the chat and gets an answer', async () => {
  const items = page.locator('section.card', { hasText: 'Attention' }).locator('ul.alerts button')
  check('Overview', 'Attention list has items', (await items.count()) > 0)
  const before = sentChats.length
  await items.first().click()
  await page.locator('aside.drawer.open').waitFor({ timeout: 10000 })
  const answer = await chatAnswer(page)
  check('Overview', 'Attention -> chat question sent', sentChats.length === before + 1)
  check('Overview', 'Attention -> chat answered', answer.length > 20 && !/^Error/.test(answer), answer.slice(0, 120))
  await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/02-chat-drawer.png` })
  await closeDrawer(page)
})

for (const d of [7, 90, 30]) {
  await step('Overview', `period ${d}d`, async () => {
    await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: `${d}d` }).click()
    await page.locator('button.kpi', { hasText: `Bugs needing work · ${d}d` }).waitFor({ timeout: 30000 })
    await waitIdle(page)
    const ad = await api(`/api/dashboard?bug_days=${d}`)
    check('Overview', `period ${d}d: bugs tile = API`, first(await kpiValue(page, `Bugs needing work · ${d}d`).innerText()) === ad.bugs.open)
    check('Overview', `period ${d}d: titles tile = API`, first(await kpiValue(page, 'Titles on standard').innerText()) === ad.standards.naming.compliance_pct)
  })
}

// ================================================================== BUGS
await goTab(page, 'Bugs')
await waitIdle(page)
await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/03-bugs.png`, fullPage: true })
for (const [label, key] of [['Reported', 'reported'], ['Need work', 'open'], ['Fixed, not released', 'fixed_not_released'], ['Invalid', 'invalid']]) {
  const tile = page.locator('button.kpi', { hasText: label }).first()
  await step('Bugs', `tile "${label}" = API`, async () => {
    check('Bugs', `tile "${label}" = API`, first(await tile.locator('.kpi-value').innerText()) === dash.bugs[key])
  })
  await checkList(page, 'Bugs', `tile "${label}" -> its list`, tile, dash.bugs[key])
}

const featCard = page.locator('section.card', { hasText: 'Bugs by feature' })
{
  const rows = featCard.locator('.barrow')
  const n = Math.min(await rows.count(), 3)
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i)
    const name = await row.locator('button.barlabel').innerText()
    const total = first(await row.locator('.barvalue').innerText())
    await checkList(page, 'Bugs', `feature "${name}" (all) -> its list`, row.locator('button.barlabel'), total)
    const segs = row.locator('button.seg')
    const m = await segs.count()
    for (let j = 0; j < m; j++) {
      const l = await segs.nth(j).getAttribute('aria-label')
      await checkList(page, 'Bugs', `segment "${l.replace(/\. Show tickets$/, '')}" -> its list`, segs.nth(j), labelNumber(l, /: ([\d,]+)\. Show tickets$/))
    }
  }
}

{
  const weeks = page.locator('section.card', { hasText: 'Reported per week' }).locator('button.colslot')
  const n = await weeks.count()
  check('Bugs', 'weekly chart has 8 clickable weeks', n === 8, `${n}`)
  for (let i = 0; i < n; i++) {
    const l = await weeks.nth(i).getAttribute('aria-label')
    const apiWeek = dash.bugs.trend[i]?.count
    check('Bugs', `week ${i + 1} column = API`, labelNumber(l, /: ([\d,]+) bugs reported/) === apiWeek, `${l} vs API ${apiWeek}`)
    await checkList(page, 'Bugs', `week "${l.split(':')[0]}" -> its list`, weeks.nth(i), labelNumber(l, /: ([\d,]+) bugs reported/))
  }
}

await step('Bugs', 'high-priority cards link to Jira', async () => {
  const hrefs = await page.locator('a.issue').evaluateAll((els) => els.map((e) => e.getAttribute('href')))
  check('Bugs', 'high-priority cards link to Jira', hrefs.length === dash.bugs.high_priority_open.length && hrefs.every((h) => h.startsWith(`${dash.jira_url}/browse/`)),
    `${hrefs.length} cards`)
})

await step('Bugs', 'project filter', async () => {
  const projects = await api('/api/projects')
  const per = await Promise.all(projects.map(async (p) => ({ ...p, b: await api(`/api/bugs?days=30&project=${p.key}`) })))
  const top = per.sort((a, b) => b.b.reported - a.b.reported).slice(0, 2)
  for (const p of top) {
    await page.getByRole('combobox', { name: 'Project' }).selectOption(p.key)
    await page.getByText(`Bugs by feature · last 30 days · ${p.name}`, { exact: false }).waitFor({ timeout: 60000 })
    await waitIdle(page)
    const tile = page.locator('button.kpi', { hasText: 'Need work' }).first()
    check('Bugs', `project ${p.key}: Reported tile = API`, first(await kpiValue(page, 'Reported').innerText()) === p.b.reported)
    check('Bugs', `project ${p.key}: Need work tile = API`, first(await tile.locator('.kpi-value').innerText()) === p.b.open)
    await checkList(page, 'Bugs', `project ${p.key}: Need work -> its list`, tile, p.b.open)
  }
  await page.getByRole('button', { name: '✕ Clear project' }).click()
  await waitIdle(page)
  check('Bugs', 'clearing the project restores all projects', first(await kpiValue(page, 'Reported').innerText()) === dash.bugs.reported)
})

// ================================================================== PEOPLE
await goTab(page, 'People')
await waitIdle(page)
await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/04-people.png`, fullPage: true })
{
  const bars = page.locator('section.card', { hasText: 'Heaviest workload' }).getByRole('button', { name: /Show tickets$/ })
  const n = await bars.count()
  check('People', 'workload bars are clickable', n === dash.team.workload.length, `${n} bars vs ${dash.team.workload.length}`)
  for (let i = 0; i < n; i++) {
    const l = await bars.nth(i).getAttribute('aria-label')
    const apiActive = dash.team.workload.find((w) => w.name === l.split(':')[0])?.active
    check('People', `workload "${l.split(':')[0]}" = API`, labelNumber(l, /: ([\d,]+)\. Show tickets$/) === apiActive)
    await checkList(page, 'People', `workload "${l.split(':')[0]}" -> its list`, bars.nth(i), labelNumber(l, /: ([\d,]+)\. Show tickets$/))
  }
}
{
  const parts = page.locator('section.card', { hasText: 'Developer availability' }).getByRole('button', { name: /Show them$/ })
  const n = await parts.count()
  check('People', 'availability bar parts are clickable', n >= 1, `${n} parts`)
  const apiCount = { 'Busy': dash.team.busy, 'Free, has To Do': dash.team.free_with_queue, 'Free, nothing queued': dash.team.free_idle }
  for (let i = 0; i < n; i++) {
    const l = await parts.nth(i).getAttribute('aria-label')
    const label = l.split(':')[0]
    const expected = labelNumber(l, /: ([\d,]+) people/)
    await step('People', `availability "${label}" -> people list`, async () => {
      await parts.nth(i).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor({ timeout: 10000 })
      const listed = await dialog.locator('.sheet-list > li').count()
      check('People', `availability "${label}" = API`, expected === apiCount[label], `bar ${expected}, API ${apiCount[label]}`)
      check('People', `availability "${label}" lists ${expected} people`, listed === expected, `${listed} listed`)
      const firstPerson = dialog.locator('button.person-row').first()
      if (await firstPerson.count()) {
        const pl = await firstPerson.getAttribute('aria-label')
        await firstPerson.click()                        // a person -> their tickets
        const sheet = page.getByRole('dialog')
        await page.waitForFunction(() => document.querySelector('.sheet .sheet-head .card-sub, .sheet .banner'), null, { timeout: 120000 })
        const title = await sheet.locator('h2').innerText()
        check('People', `"${pl.split(':')[0]}" -> their tickets`, title.startsWith(pl.split(':')[0]), title)
        await page.getByRole('button', { name: 'Close list' }).click()
      } else {
        await page.getByRole('button', { name: 'Close list' }).click()
      }
      await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 10000 })
    })
  }
}
await step('People', 'availability bar adds up', async () => {
  const t = dash.team
  check('People', 'busy + free = developers', t.busy + t.free_with_queue + t.free_idle === t.developers)
})
await step('People', 'busy-on-paper ticket links go to Jira', async () => {
  const hrefs = await page.locator('section.card', { hasText: 'Busy on paper' }).locator('a').evaluateAll((els) => els.map((e) => e.getAttribute('href')))
  check('People', 'busy-on-paper links go to Jira', hrefs.every((h) => h.startsWith(`${dash.jira_url}/browse/`)), `${hrefs.length} links`)
})

// ================================================================== STANDARDS
await goTab(page, 'Standards')
await waitIdle(page)
await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/05-standards.png`, fullPage: true })
{
  const titles = page.locator('section.card', { hasText: 'Ticket titles' })
  const bars = titles.getByRole('button', { name: /Show tickets$/ })
  const n = await bars.count()
  for (let i = 0; i < n; i++) {
    const l = await bars.nth(i).getAttribute('aria-label')
    const rule = dash.standards.naming.by_rule.find((r) => r.label === l.split(':')[0])
    check('Standards', `title problem "${l.split(':')[0]}" = API`, labelNumber(l, /: ([\d,]+)\. Show tickets$/) === rule?.count)
    await checkList(page, 'Standards', `title problem "${l.split(':')[0]}" -> its list`, bars.nth(i), labelNumber(l, /: ([\d,]+)\. Show tickets$/))
  }
  const people = titles.getByRole('button', { name: /titles that break the standard$/ })
  const m = await people.count()
  check('Standards', 'title offenders are clickable', m > 0, `${m}`)
  for (let i = 0; i < m; i++) {
    const l = await people.nth(i).getAttribute('aria-label')
    await checkList(page, 'Standards', `person "${l.split(':')[0]}" bad titles -> list`, people.nth(i), labelNumber(l, /show all ([\d,]+) titles/))
  }
  const wl = page.locator('section.card', { hasText: 'Worklogs' }).last()
  const wbars = wl.getByRole('button', { name: /Show tickets$/ })
  for (let i = 0; i < (await wbars.count()); i++) {
    const l = await wbars.nth(i).getAttribute('aria-label')
    await checkList(page, 'Standards', `worklog problem "${l.split(':')[0]}" -> its list`, wbars.nth(i), labelNumber(l, /: ([\d,]+)\. Show tickets$/))
  }
  const wpeople = wl.getByRole('button', { name: /worklogs without a description$/ })
  for (let i = 0; i < (await wpeople.count()); i++) {
    const l = await wpeople.nth(i).getAttribute('aria-label')
    await checkList(page, 'Standards', `person "${l.split(':')[0]}" bad worklogs -> list`, wpeople.nth(i), labelNumber(l, /show all ([\d,]+) worklogs/))
  }
  await step('Standards', 'example ticket links go to Jira', async () => {
    const hrefs = await titles.locator('a.example').evaluateAll((els) => els.map((e) => e.getAttribute('href')))
    check('Standards', 'example ticket links go to Jira', hrefs.length > 0 && hrefs.every((h) => h.startsWith(`${dash.jira_url}/browse/`)), `${hrefs.length}`)
  })
}

// ================================================================== SPRINTS
await goTab(page, 'Sprints')
await page.getByText("Where the sprint's work ended up").waitFor({ timeout: 180000 })
await waitIdle(page)
await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/06-sprints.png`, fullPage: true })
await step('Sprints', 'removed cards stay removed', async () => {
  for (const h of ['Developers', 'Testers', 'Highlights', 'How this is measured']) {
    check('Sprints', `"${h}" card is not shown`, (await page.getByRole('heading', { name: h, exact: true }).count()) === 0)
  }
})

async function sprintTiles(label) {
  await step('Sprints', `${label}: tiles open matching lists`, async () => {
    const delivered = page.locator('button.kpi', { hasText: 'Delivered' }).first()
    const released = first((await delivered.locator('.kpi-foot').innerText()).match(/([\d,]+) of/)?.[1] ?? 'NaN')
    await checkList(page, 'Sprints', `${label}: Delivered tile -> released list`, delivered, released)
    for (const t of ['Not delivered', 'Carried to next sprint', 'Added mid-sprint']) {
      const tile = page.locator('button.kpi', { hasText: t }).first()
      await checkList(page, 'Sprints', `${label}: "${t}" tile -> its list`, tile, first(await tile.locator('.kpi-value').innerText()))
    }
    const segs = page.locator('section.card', { hasText: "Where the sprint's work ended up" }).locator('.barrow').first().locator('button.seg')
    for (let j = 0; j < (await segs.count()); j++) {
      const l = await segs.nth(j).getAttribute('aria-label')
      await checkList(page, 'Sprints', `${label}: segment "${l.replace(/\. Show tickets$/, '')}" -> its list`, segs.nth(j), labelNumber(l, /: ([\d,]+)\. Show tickets$/))
    }
  })
}

await step('Sprints', 'every option in the sprint dropdown', async () => {
  const select = page.getByRole('combobox', { name: 'Sprint' })
  const options = await select.locator('option').evaluateAll((els) => els.map((e) => ({ value: e.value, text: e.textContent })))
  check('Sprints', 'dropdown lists Current, Last and every sprint', options.length >= 3, `${options.length} options`)
  for (const o of options) {
    const report = await api(`/api/sprint-report?sprint=${encodeURIComponent(o.value)}`)
    await select.selectOption(o.value)
    await page.locator('.scope-bar', { hasText: `${report.sprint.name} · judged at` }).waitFor({ timeout: 180000 })
    await waitIdle(page)
    const shownPct = first(await kpiValue(page, 'Delivered').innerText())
    const scope = await page.locator('.scope-bar').first().innerText()
    const pctOk = report.totals.delivered_pct === null ? true : shownPct === report.totals.delivered_pct
    check('Sprints', `option "${o.text}" loads the right sprint`, scope.includes(report.sprint.name) && pctOk,
      `shows ${shownPct}% · API ${report.totals.delivered_pct}% · "${report.sprint.name}"`)
  }
})

for (const which of ['last', 'current']) {
  const expected = (await api(`/api/sprint-report?sprint=${which}`)).sprint.name
  await page.getByRole('combobox', { name: 'Sprint' }).selectOption(which)
  // wait until the NEW sprint is on screen (the old one stays visible, dimmed, while loading)
  await page.locator('.scope-bar', { hasText: `${expected} · judged at` }).waitFor({ timeout: 180000 })
  await waitIdle(page)
  await sprintTiles(which === 'last' ? 'Last sprint' : 'Current sprint')
}

await step('Sprints', 'trend columns switch the sprint', async () => {
  const cols = page.locator('section.card', { hasText: 'Delivered % by sprint' }).locator('button.colslot')
  const n = await cols.count()
  check('Sprints', 'trend has clickable sprints', n >= 2, `${n}`)
  const l = await cols.nth(0).getAttribute('aria-label')
  const name = l.split(':')[0]
  await cols.nth(0).click()
  await page.waitForFunction(() => !document.body.innerText.includes('Loading sprint…'), null, { timeout: 180000 })
  const value = await page.getByRole('combobox', { name: 'Sprint' }).inputValue()
  check('Sprints', `trend column "${name}" selects it`, value === name, `dropdown now "${value}"`)
})

// ================================================================== NAMING GUIDE
await goTab(page, 'Naming guide')
await page.getByRole('heading', { name: 'How we name Jira tickets' }).waitFor({ timeout: 60000 })
await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/07-guide.png`, fullPage: true })
await step('Guide', 'title checker', async () => {
  const input = page.getByRole('textbox', { name: 'Ticket title' })
  await input.fill('fix issue')
  await page.locator('.verdict .status-critical').first().waitFor({ timeout: 10000 })
  check('Guide', 'bad title shows reasons', (await page.locator('.verdict .status-critical').count()) >= 1)
  await input.fill('Login | Add recent searches to global search')
  await page.getByText('Follows the standard').waitFor({ timeout: 10000 })
  check('Guide', 'good title passes', true)
  await input.fill('fix issue')
  await page.getByRole('button', { name: '✦ Suggest a better title' }).click()
  await page.locator('aside.drawer.open').waitFor({ timeout: 10000 })
  const answer = await chatAnswer(page)
  check('Guide', '"Suggest a better title" gets an answer', answer.length > 10, answer.slice(0, 120))
  await closeDrawer(page)
})
await step('Guide', 'worklog checker + category chips', async () => {
  await page.getByRole('button', { name: '[Dev]', exact: true }).click()
  check('Guide', '[Dev] chip prefills the note', (await page.getByRole('textbox', { name: 'Worklog note' }).inputValue()) === '[Dev] ')
  await page.getByText(/say what was done/).waitFor({ timeout: 10000 })
  await page.getByRole('textbox', { name: 'Worklog note' }).fill('[Dev] Add version filter to submissions report')
  await page.getByText('Good worklog').waitFor({ timeout: 10000 })
  check('Guide', 'a real worklog passes', true)
})

// ================================================================== CHAT, "I AM", REFRESH
await goTab(page, 'Overview')
await waitIdle(page)
await step('Chat', 'ask bar -> answer, New chat, Escape, floating button', async () => {
  await page.getByRole('textbox', { name: 'Ask Jira' }).fill('How many developers are free today?')
  await page.keyboard.press('Enter')
  await page.locator('aside.drawer.open').waitFor({ timeout: 10000 })
  const answer = await chatAnswer(page)
  const expectFree = dash.team.free_with_queue + dash.team.free_idle
  check('Chat', 'answer uses the live number', answer.includes(String(expectFree)), `expected ${expectFree} · "${answer.slice(0, 100)}"`)
  await page.getByRole('button', { name: 'New chat' }).click()
  check('Chat', 'New chat clears the conversation', (await page.locator('.chat-log .msg').count()) === 0)
  await closeDrawer(page)
  check('Chat', 'Escape closes the drawer', (await page.locator('aside.drawer.open').count()) === 0)
  await page.getByRole('button', { name: 'Open Ask Jira' }).click()
  check('Chat', 'floating button opens the drawer', (await page.locator('aside.drawer.open').count()) === 1)
  await closeDrawer(page)
})
await step('Chat', 'multi-line composer like ChatGPT/Claude', async () => {
  await page.getByRole('button', { name: 'Open Ask Jira' }).click()
  await page.locator('aside.drawer.open').waitFor({ timeout: 10000 })
  const box = page.getByRole('textbox', { name: 'Your question' })
  const h1 = await box.evaluate((el) => el.getBoundingClientRect().height)
  await box.click()
  await page.keyboard.type('How many bugs in Form Builder')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('and how many are still open?')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('Answer in a short table please')
  const h3 = await box.evaluate((el) => el.getBoundingClientRect().height)
  const lineH = await box.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
  check('Chat', 'the box grows one line per line', Math.abs((h3 - h1) - 2 * lineH) <= 2, `1 line ${h1}px -> 3 lines ${h3}px (line ${lineH}px)`)
  check('Chat', 'Shift+Enter keeps the text (no send)', (await box.inputValue()).split('\n').length === 3)
  await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/11-chat-multiline.png` })
  await page.keyboard.press('Enter')
  const answer = await chatAnswer(page)
  check('Chat', 'Enter sends all 3 lines as one message', sentChats.at(-1)?.message.split('\n').length === 3)
  check('Chat', 'multi-line question gets an answer', answer.length > 20, answer.slice(0, 100))
  const bubble = await page.locator('.msg.user .bubble').last().innerText()
  check('Chat', 'your bubble keeps the line breaks', bubble.split('\n').length === 3, JSON.stringify(bubble))
  const h0 = await box.evaluate((el) => el.getBoundingClientRect().height)
  check('Chat', 'the box shrinks back after sending', Math.abs(h0 - h1) <= 2, `${h0}px`)
  for (let i = 0; i < 12; i++) await page.keyboard.type(`line ${i}\n`.replace('\n', ''), { delay: 0 }), await page.keyboard.press('Shift+Enter')
  const hMax = await box.evaluate((el) => [el.getBoundingClientRect().height, getComputedStyle(el).overflowY])
  check('Chat', 'very long text stops growing and scrolls', hMax[0] <= 22 * 8 + 16 && hMax[1] === 'auto', `${hMax[0]}px, overflow ${hMax[1]}`)
  await box.fill('')
  await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/12-chat-answer.png` })
  // chat history: New chat keeps the old conversation in the sidebar; opening it brings it back
  const asked = sentChats.at(-1)?.message
  await page.locator('.drawer-head').getByRole('button', { name: 'New chat' }).click()
  check('Chat', 'New chat starts empty', (await page.locator('.chat-log .msg').count()) === 0)
  await page.getByRole('button', { name: 'Chat history' }).click()
  const items = page.locator('.history .history-item')
  await page.locator('.drawer.history-open .history').waitFor({ timeout: 5000 })
  check('Chat', 'history lists the earlier chat', (await items.count()) >= 1 && (await items.first().innerText()).startsWith('How many bugs in Form Builder'),
    await items.first().innerText())
  await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/14-chat-history-panel.png` })
  await items.first().click()
  const restored = await page.locator('.msg.user .bubble').first().innerText()
  check('Chat', 'opening it restores the conversation', restored === asked, JSON.stringify(restored))
  await page.getByRole('button', { name: 'Expand chat' }).click()
  await page.waitForTimeout(500)                    // the drawer widens with a short animation
  check('Chat', 'full screen shows the history sidebar', await page.locator('.drawer.expanded .history').isVisible())
  const w = await page.locator('aside.drawer').evaluate((el) => el.getBoundingClientRect().width)
  check('Chat', 'full screen fills the window', w >= 1430, `${w}px`)
  await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/13-chat-fullscreen.png` })
  await page.getByRole('button', { name: 'Exit full screen' }).click()
  await closeDrawer(page)
})
await step('Chat', 'history is saved on the server (SQLite) and says only 5 are kept', async () => {
  await page.evaluate(() => localStorage.removeItem('jiraPulse.chats.v1'))
  await page.reload()
  await page.locator('.hero h1').waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: 'Open Ask Jira' }).click()
  await page.getByRole('button', { name: 'Chat history' }).click()
  const items = page.locator('.history .history-item')
  await items.first().waitFor({ timeout: 10000 })
  const n = await items.count()
  check('Chat', 'after a reload the chats come back from the server', n >= 1, `${n} chats`)
  check('Chat', 'never more than 5 chats in the sidebar', n <= 5, `${n}`)
  const note = await page.locator('.history-note').innerText()
  check('Chat', 'sidebar tells you only the last 5 are kept (least recently used goes)',
    note.includes('Only your last 5 chats are kept') && note.includes('least recently'), note)
  const fromServer = await page.evaluate(async () => (await (await fetch('/api/chats')).json()).length)
  check('Chat', 'sidebar count matches the server', fromServer === n, `server ${fromServer}, sidebar ${n}`)
  await items.first().click()
  await page.locator('.msg.user .bubble').first().waitFor({ timeout: 10000 })
  check('Chat', 'opening a saved chat loads its messages from the server', (await page.locator('.msg.bot').count()) >= 1)
  await closeDrawer(page)
})
await step('Home', 'clicking the Jira Pulse logo goes to the home page', async () => {
  const tabs = page.getByRole('navigation', { name: 'Sections' })
  await tabs.getByRole('button', { name: /^Standards/ }).click()
  check('Home', 'moved off the home page first', page.url().endsWith('#standards'), page.url())
  await page.evaluate(() => window.scrollTo(0, 600))
  await page.getByRole('link', { name: 'Jira Pulse home' }).click()
  await page.waitForTimeout(600)
  check('Home', 'logo opens Overview', (await tabs.getByRole('button', { name: 'Overview' }).getAttribute('aria-pressed')) === 'true')
  check('Home', 'URL is clean (no #tab)', !page.url().includes('#'), page.url())
  check('Home', 'scrolled back to the top', (await page.evaluate(() => window.scrollY)) < 50)
})
await step('Chat', '"I am" picker changes who "my" means', async () => {
  const picker = page.getByRole('combobox', { name: 'I am' })
  const original = await picker.inputValue()
  const options = await picker.locator('option').evaluateAll((els) => els.map((e) => ({ value: e.value, text: e.textContent })))
  const other = options.find((o) => o.value !== original)
  await picker.selectOption(other.value)
  const h1 = await page.locator('.hero h1').innerText()
  check('Chat', 'greeting switches to the chosen person', h1.includes(other.text.split(' ')[0]), h1)
  await page.getByRole('textbox', { name: 'Ask Jira' }).fill('what am I working on?')
  await page.keyboard.press('Enter')
  await chatAnswer(page)
  check('Chat', 'chat request is sent as the chosen person', sentChats.at(-1)?.me_account_id === other.value)
  await closeDrawer(page)
  await picker.selectOption(original)
})
await step('Overview', 'Refresh re-reads Jira', async () => {
  const req = page.waitForRequest((r) => r.url().includes('/api/dashboard') && r.url().includes('refresh=true'), { timeout: 10000 })
  await page.getByRole('button', { name: 'Refresh' }).click()
  await req
  await waitIdle(page)
  check('Overview', 'Refresh sends refresh=true and reloads', true)
})

// ================================================================== PHONE + DARK MODE
await step('Layout', 'phone width (390 px)', async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const p = await phone.newPage()
  await p.goto(BASE)
  await p.getByText('Where sprint work is sitting').waitFor({ timeout: 180000 })
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('Layout', 'no sideways scrolling on a phone', overflow <= 1, `page is ${overflow}px wider than the screen`)
  await p.waitForTimeout(600); await p.screenshot({ path: `${SHOTS}/08-phone-overview.png`, fullPage: true })
  await p.getByRole('button', { name: 'Open Ask Jira' }).click()
  await p.locator('aside.drawer.open').waitFor({ timeout: 10000 })
  const w = await p.locator('aside.drawer').evaluate((el) => el.getBoundingClientRect().width)
  check('Layout', 'chat drawer fills the phone width', Math.abs(w - 390) <= 1, `${w}px`)
  await p.waitForTimeout(600); await p.screenshot({ path: `${SHOTS}/09-phone-chat.png` })
  await phone.close()
})
await step('Layout', 'dark mode', async () => {
  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const p = await dark.newPage()
  await p.goto(BASE)
  await p.getByText('Where sprint work is sitting').waitFor({ timeout: 180000 })
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor)
  check('Layout', 'dark mode uses the dark page colour', bg === 'rgb(13, 13, 13)', bg)
  await p.waitForTimeout(600); await p.screenshot({ path: `${SHOTS}/10-dark-overview.png`, fullPage: true })
  await dark.close()
})

await step('Layout', 'theme switch (system default, light, dark)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })   // system says dark
  const p = await ctx.newPage()
  await p.goto(BASE)
  await p.getByText('Where sprint work is sitting').waitFor({ timeout: 180000 })
  const bg = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const btn = p.getByRole('button', { name: /^Theme: / })
  check('Layout', 'default theme follows the system (dark here)', (await btn.getAttribute('aria-label')) === 'Theme: system' && (await bg()) === 'rgb(13, 13, 13)', await bg())
  await btn.click()
  check('Layout', 'Light overrides a dark system', (await bg()) === 'rgb(246, 246, 243)', await bg())
  await p.waitForTimeout(600); await p.screenshot({ path: `${SHOTS}/15-theme-light.png` })
  await btn.click()
  check('Layout', 'Dark theme', (await bg()) === 'rgb(13, 13, 13)', await bg())
  await p.reload()
  await p.getByText('Where sprint work is sitting').waitFor({ timeout: 180000 })
  check('Layout', 'theme choice survives a reload', (await p.getByRole('button', { name: /^Theme: / }).getAttribute('aria-label')) === 'Theme: dark')
  await p.getByRole('button', { name: /^Theme: / }).click()
  check('Layout', 'back to System', (await p.getByRole('button', { name: /^Theme: / }).getAttribute('aria-label')) === 'Theme: system')
  await ctx.close()
})

// ================================================================== errors seen along the way
check('Health', 'no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '))
check('Health', 'no failed API calls', badResponses.length === 0, badResponses.slice(0, 5).join(' | '))

await browser.close()

// ------------------------------------------------------------------ report
const byArea = {}
for (const r of results) (byArea[r.area] ??= { ok: 0, bad: 0 })[r.ok ? 'ok' : 'bad']++
console.log(`\nUI check against ${BASE} - ${((Date.now() - t0) / 1000).toFixed(0)}s`)
for (const [area, c] of Object.entries(byArea)) console.log(`  ${area.padEnd(10)} ${String(c.ok).padStart(4)} passed  ${c.bad ? `${c.bad} FAILED` : ''}`)
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.log('\nFailures:')
  for (const f of failed) console.log(`  ✗ [${f.area}] ${f.what}\n      ${f.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
