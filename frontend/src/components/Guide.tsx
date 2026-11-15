import { useEffect, useRef, useState } from 'react'
import { checkTitle, checkWorklog, getGuide, type CheckResult, type Guide as GuideData } from '../api'
import { Card } from './ui'
import { Status } from './ui'

/** Re-check what the user types, 300 ms after they stop typing. */
function useLiveCheck(text: string, run: (t: string) => Promise<CheckResult>) {
  const [result, setResult] = useState<CheckResult | null>(null)
  useEffect(() => {
    if (!text.trim()) { setResult(null); return }
    let alive = true
    const t = setTimeout(() => { run(text).then((r) => alive && setResult(r)).catch(() => alive && setResult(null)) }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [text, run])
  return result
}

function Verdict({ result, okText }: { result: CheckResult | null; okText: string }) {
  if (!result) return <p className="muted small verdict">Start typing to check it.</p>
  return (
    <div className="verdict" aria-live="polite">
      {result.ok && <Status tone="good">{okText}</Status>}
      {result.findings.map((f, i) => (
        <Status key={i} tone={f.severity === 'error' ? 'critical' : 'warning'}>{f.message}</Status>
      ))}
    </div>
  )
}

/** Copy text to the clipboard; the button says "Copied" for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {                                     // older browsers / no permission: fall back to a hidden textarea
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setDone(true)
    setTimeout(() => setDone(false), 1500)
  }
  return (
    <button type="button" className="copy-btn" onClick={copy} disabled={!text.trim()} aria-label={`Copy ${label}`}
      title={text.trim() ? `Copy ${label}` : `Type or click an example first`}>
      {done ? '✓ Copied' : 'Copy'}
    </button>
  )
}

/** "FB | Fix login" + "Add" -> "FB | Add login": put the verb at the start of the action part (after the LAST "|"),
 *  replacing a known verb. */
export function withVerb(title: string, verb: string, verbs: string[]): string {
  const cut = title.lastIndexOf('|')                // "iOS | Global Search | Add ..." -> module "iOS | Global Search"
  const [module, action] = cut >= 0 ? [title.slice(0, cut).trim(), title.slice(cut + 1).trim()] : ['', title.trim()]
  const words = action ? action.split(/\s+/) : []
  if (words.length && verbs.some((v) => v.toLowerCase() === words[0].toLowerCase())) words.shift()
  const newAction = [verb, ...words].join(' ') + (words.length ? '' : ' ')
  return module ? `${module} | ${newAction}` : (title.includes('|') ? `| ${newAction}` : newAction)
}

export function Guide({ ask }: { ask: (q: string) => void }) {
  const [g, setG] = useState<GuideData | null>(null)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [type, setType] = useState('Task')
  const [note, setNote] = useState('')
  useEffect(() => { getGuide().then(setG).catch((e: Error) => setError(e.message)) }, [])
  const titleResult = useLiveCheck(title, (t) => checkTitle(t, type))
  const noteResult = useLiveCheck(note, checkWorklog)
  const titleRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLInputElement>(null)
  // clicking a tag/example fills the matching checker box, shows it, and puts the cursor at the end (ready to edit or copy)
  const fill = (ref: React.RefObject<HTMLInputElement | null>, set: (v: string) => void, value: string) => {
    set(value)
    const el = ref.current
    if (!el) return
    el.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(value.length, value.length) })
  }
  const fillTitle = (value: string, issueType?: string) => { if (issueType) setType(issueType); fill(titleRef, setTitle, value) }
  const fillNote = (value: string) => fill(noteRef, setNote, value)

  if (error) return <div className="banner span-3">{error}</div>
  if (!g) return <div className="skeleton span-3" style={{ height: 300 }} />

  return (
    <>
      <section className="card span-3 guide-hero">
        <div>
          <p className="eyebrow">Team standard</p>
          <h2>How we name Jira tickets</h2>
          <p className="guide-core">“{g.core_rule}”</p>
        </div>
        <div className="formula" aria-label="Title formula">
          {g.formula.split(' + ').map((part, i) => (
            <span key={part}>{i > 0 && <b aria-hidden>+</b>}<em>{part}</em></span>
          ))}
        </div>
      </section>

      <Card className="checker" title="Check a ticket title" subtitle="Same rules the dashboard uses">
        <div className="checker-row">
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Issue type">
            {g.issue_types.map((t) => <option key={t}>{t}</option>)}
          </select>
          <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Ticket title"
            placeholder={g.formats.find((f) => f.type === type)?.good ?? 'Module | Add …'} />
          <CopyButton text={title} label="ticket title" />
        </div>
        <p className="muted small">Format for {type}: <code>{g.formats.find((f) => f.type === type)?.format}</code></p>
        <Verdict result={titleResult} okText="Follows the standard" />
        {titleResult && !titleResult.ok && (
          <button className="chip chip-ask" onClick={() => ask(`Rewrite this ${type} title to follow our naming standard, keep its meaning: "${title}"`)}>
            ✦ Suggest a better title
          </button>
        )}
      </Card>

      <Card className="checker span-2" title="Check a worklog note" subtitle={<>Format: <code>{g.worklog.format}</code></>}>
        <div className="checker-row">
          <input ref={noteRef} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Worklog note"
            placeholder={g.worklog.good[0]} />
          <CopyButton text={note} label="worklog note" />
        </div>
        <Verdict result={noteResult} okText="Good worklog" />
        <div className="chips-list">
          {g.worklog.categories.map((c) => (
            <button key={c} className="person-chip" onClick={() => fillNote(`[${c}] ${note.replace(/^\[[^\]]*\]\s*/, '')}`)}
              title={`Start with [${c}]`}>[{c}]</button>
          ))}
        </div>
      </Card>

      <Card className="span-3" title="Format by issue type" subtitle={`Base format: ${g.base_format}`}>
        <div className="table-wrap">
          <table className="guide-table">
            <thead><tr><th>Type</th><th>Format</th><th>What it should say</th><th>Good</th><th>Avoid</th></tr></thead>
            <tbody>
              {g.formats.map((f) => (
                <tr key={f.type}>
                  <td><b>{f.type}</b></td>
                  <td><code>{f.format}</code></td>
                  <td className="muted">{f.purpose}</td>
                  <td><button type="button" className="tag-btn" onClick={() => fillTitle(f.good, f.type)}
                    title="Put it in the title checker (then copy it)"><Status tone="good">{f.good}</Status></button></td>
                  <td><Status tone="critical">{f.avoid}</Status></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Always" subtitle="Every ticket">
        <ul className="rule-list">{g.do.map((d) => <li key={d}><Status tone="good">{d}</Status></li>)}</ul>
      </Card>
      <Card title="Never" subtitle="These fail the check">
        <ul className="rule-list">{g.dont.map((d) => <li key={d}><Status tone="critical">{d}</Status></li>)}</ul>
      </Card>
      <Card title="Sub-task checklist" subtitle="The most important area: sub-tasks drift into shorthand">
        <ul className="rule-list">{g.subtask_checklist.map((d) => <li key={d}><Status tone="info">{d}</Status></li>)}</ul>
      </Card>

      <Card className="span-2" title="Do / Don't" subtitle="Real examples from the standard">
        <div className="table-wrap">
          <table className="guide-table">
            <thead><tr><th>Do</th><th>Don't</th></tr></thead>
            <tbody>
              {g.examples.map((e) => (
                <tr key={e.do}><td><button type="button" className="tag-btn" onClick={() => fillTitle(e.do)}
                  title="Put it in the title checker (then copy it)"><Status tone="good">{e.do}</Status></button></td>
                  <td><Status tone="critical">{e.dont}</Status></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Worklogs" subtitle={g.worklog.note}>
        <ul className="rule-list">
          {g.worklog.good.map((w) => <li key={w}><button type="button" className="tag-btn" onClick={() => fillNote(w)}
            title="Put it in the worklog checker (then copy it)"><Status tone="good"><code>{w}</code></Status></button></li>)}
          {g.worklog.bad.map((w) => <li key={w}><Status tone="critical"><code>{w}</code></Status></li>)}
        </ul>
      </Card>

      <Card className="span-3" title="Action verbs the check accepts" subtitle="Start the action part of the title with one of these">
        <div className="chips-list verbs">{g.verbs.map((v) => (
          <button type="button" key={v} className="person-chip" onClick={() => fillTitle(withVerb(title, v, g.verbs))}
            title={`Start the title's action with "${v}"`}>{v}</button>
        ))}</div>
        <p className="hint">Click a verb or any green example to put it in the checker above, then press Copy.</p>
        <p className="hint">Source: {g.source}. Checks run on every ticket created in the chosen period; results are on the Standards tab.</p>
      </Card>
    </>
  )
}
