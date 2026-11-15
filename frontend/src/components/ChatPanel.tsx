import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { deleteChat, getChat, listChats, sendChat, streamChat, type SavedChat, type SavedMessage, type ToolCall } from '../api'
import { useSpeech, VOICE_LANGS } from './useSpeech'

type Message =
  | { role: 'user'; text: string }
  | { role: 'bot'; text: string; tools: ToolCall[]; seconds: number; id?: string; streaming?: boolean; status?: string }
  | { role: 'error'; text: string; question: string }

const SUGGESTIONS = [
  'What am I working on?',
  'How many bugs in Form Builder this month?',
  'What did we deliver in the last sprint?',
  'Which developers are free right now?',
  'Who is not following the ticket naming standard?',
  'Form builder me kitne open bugs hain?',
]

export type Conversation = {
  id: string; me: string; title: string; createdAt: number; updatedAt: number   // updatedAt = last used (ms)
  messages: Message[]; loaded: boolean                                        // loaded = messages fetched
}

// Chats are saved on the server (SQLite), per person. Only the last MAX_CHATS are kept: asking in a new chat when
// you already have 5 removes the LEAST RECENTLY USED one (opening a chat counts as using it). The server enforces
// this; the same rule runs here so the sidebar updates at once.
export const MAX_CHATS = 5
const OLD_BROWSER_STORE = 'jiraPulse.chats.v1'      // chats used to live in localStorage: clean that copy up
/** Keep the MAX_CHATS most recently used chats. */
export function capChats(all: Conversation[]): Conversation[] {
  return [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS)
}
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `c${Date.now()}${Math.random().toString(36).slice(2)}`)
const titleOf = (q: string) => { const t = q.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 57)}…` : t }
const fromSaved = (s: SavedChat, me: string, prev?: Conversation): Conversation => ({
  id: s.id, me, title: s.title, createdAt: s.created_at * 1000, updatedAt: s.updated_at * 1000,
  messages: prev?.messages ?? [], loaded: prev?.loaded ?? false,
})
const toMessages = (saved: SavedMessage[]): Message[] => saved.map((m) => (m.role === 'user'
  ? { role: 'user', text: m.text }
  : { role: 'bot', text: m.text, tools: m.tools ?? [], seconds: m.seconds ?? 0 }))

/** Chat state lives in a hook so dashboard cards can push questions into it. */
export function useChat(me: string) {
  const [all, setAll] = useState<Conversation[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const allRef = useRef(all)
  const currentRef = useRef(currentId)
  const meRef = useRef(me)
  allRef.current = all
  currentRef.current = currentId
  meRef.current = me

  useEffect(() => { try { localStorage.removeItem(OLD_BROWSER_STORE) } catch { /* blocked storage */ } }, [])

  /** Re-read the list from the server. Keeps messages already loaded, and a brand-new chat not saved yet. */
  const refresh = useCallback(async () => {
    const who = meRef.current
    let saved: SavedChat[]
    try {
      saved = await listChats(who)
    } catch {
      return                                   // older server / offline: keep what we have in memory
    }
    if (meRef.current !== who) return          // switched person meanwhile
    setAll((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]))
      const ids = new Set(saved.map((s) => s.id))
      const unsaved = prev.filter((c) => !ids.has(c.id) && c.id === currentRef.current)   // first answer pending/failed
      return capChats([...unsaved, ...saved.map((s) => fromSaved(s, who, byId.get(s.id)))])
    })
  }, [])

  // switching "I am" = that person's chats; start them on a fresh chat
  useEffect(() => {
    setAll([])
    setCurrentId(null)
    if (me) void refresh()
  }, [me, refresh])

  const conversations = useMemo(() => [...all].sort((a, b) => b.updatedAt - a.updatedAt), [all])
  const current = conversations.find((c) => c.id === currentId) ?? null
  const update = (id: string, fn: (c: Conversation) => Conversation) => setAll((list) => list.map((c) => (c.id === id ? fn(c) : c)))

  const ask = useCallback(async (text: string) => {
    const question = text.trim()
    if (!question) return
    let id = currentRef.current
    const prior = (id && allRef.current.find((c) => c.id === id)?.messages) || []
    if (!id) {
      id = newId()
      const now = Date.now()
      const conv: Conversation = { id, me, title: titleOf(question), createdAt: now, updatedAt: now, messages: [], loaded: true }
      setAll((list) => capChats([conv, ...list]))            // a 6th chat pushes out the least recently used
      setCurrentId(id)
      currentRef.current = id
    }
    const convId = id
    update(convId, (c) => ({ ...c, updatedAt: Date.now(), messages: [...c.messages, { role: 'user', text: question }] }))
    setBusyId(convId)
    const started = performance.now()
    const botId = newId()
    // the answer bubble appears at once and fills in: live status, then text as it arrives
    const patchBot = (fn: (m: Extract<Message, { role: 'bot' }>) => Extract<Message, { role: 'bot' }>) =>
      update(convId, (c) => ({ ...c, messages: c.messages.map((m) => (m.role === 'bot' && m.id === botId ? fn(m) : m)) }))
    update(convId, (c) => ({ ...c, messages: [...c.messages,
      { role: 'bot', id: botId, text: '', tools: [], seconds: 0, streaming: true, status: 'Thinking…' }] }))
    const history = prior.flatMap((m) => (m.role === 'error' ? [] : [{ role: m.role, text: m.text }])).slice(-20)
    try {
      let r
      try {
        r = await streamChat(question, convId, me, history, (ev) => {
          if (ev.type === 'status') patchBot((m) => ({ ...m, status: ev.text }))
          else if (ev.type === 'delta') patchBot((m) => ({ ...m, text: m.text + ev.text }))
          else if (ev.type === 'retry') patchBot((m) => ({ ...m, text: '', status: ev.text }))
        })
      } catch (e) {
        const status = (e as { status?: number }).status
        if (status !== 404 && status !== 405) throw e        // only fall back when streaming isn't available
        r = await sendChat(question, convId, me, history)
      }
      const done = r
      patchBot((m) => ({ ...m, text: done.answer, tools: done.tools, streaming: false, status: undefined,
        seconds: (performance.now() - started) / 1000 }))
      update(convId, (c) => ({ ...c, updatedAt: Date.now() }))
      void refresh()                                          // the server saved it (and may have dropped the LRU chat)
    } catch (e) {
      update(convId, (c) => ({ ...c, messages: [...c.messages.filter((m) => !(m.role === 'bot' && m.id === botId)),
        { role: 'error', text: (e as Error).message, question }] }))
    } finally {
      setBusyId(null)
    }
  }, [me, refresh])

  const newChat = useCallback(() => setCurrentId(null), [])
  const open = useCallback(async (id: string) => {
    setCurrentId(id)
    const conv = allRef.current.find((c) => c.id === id)
    if (!conv || busyId === id) return
    update(id, (c) => ({ ...c, updatedAt: Date.now() }))      // opening counts as using it (LRU)
    try {
      const saved = await getChat(id, meRef.current)           // also marks it used on the server
      update(id, (c) => (c.loaded && c.messages.length >= saved.messages.length ? c
        : { ...c, title: saved.title, messages: toMessages(saved.messages), loaded: true }))
    } catch {
      if (!conv.loaded) {                                      // gone on the server (deleted elsewhere / expired)
        setAll((list) => list.filter((c) => c.id !== id))
        if (currentRef.current === id) setCurrentId(null)
      }
    }
  }, [busyId])
  const remove = useCallback(async (id: string) => {
    setAll((list) => list.filter((c) => c.id !== id))
    if (currentRef.current === id) setCurrentId(null)
    try { await deleteChat(id, meRef.current) } catch { /* shows again on the next refresh */ }
    void refresh()
  }, [refresh])

  // the chat that asking in a NEW chat would remove (only when you already have MAX_CHATS)
  const wouldRemove = currentId === null && conversations.length >= MAX_CHATS ? conversations[conversations.length - 1] : null

  return {
    messages: current?.messages ?? [],
    loading: current !== null && !current.loaded,
    busy: busyId !== null,                       // one question at a time
    thinkingHere: busyId !== null && busyId === currentId,
    ask, reset: newChat, newChat, open, remove, conversations, currentId, busyId, wouldRemove,
  }
}

// ------------------------------------------------------------------ icons
const Icon = {
  mic: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  send: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg>,
  copy: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>,
  check: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5 9-11" /></svg>,
  expand: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>,
  shrink: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>,
  plus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>,
  close: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>,
  history: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
  down: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12l7 7 7-7" /></svg>,
}

// ------------------------------------------------------------------ voice
/** Mic button + language switch. Speaking fills the box live; the question is sent when you stop. */
function VoiceControls({ voice, busy }: { voice: ReturnType<typeof useSpeech>; busy: boolean }) {
  if (!voice.supported) {
    return (
      <button type="button" className="icon-round" disabled title="Voice search works in Chrome and Edge" aria-label="Voice search unavailable">
        {Icon.mic}
      </button>
    )
  }
  const current = VOICE_LANGS.find((l) => l.id === voice.lang) ?? VOICE_LANGS[0]
  return (
    <>
      <span className="lang-chip" title={`Voice works in ${current.label} only for now. Typing works in English or Hindi.`}>
        Voice: {current.label}
      </span>
      <button type="button" className={`icon-round mic ${voice.listening ? 'on' : ''}`} onClick={voice.toggle} disabled={busy}
        aria-pressed={voice.listening} aria-label={voice.listening ? 'Stop listening' : 'Ask by voice'}
        title={voice.listening ? 'Listening… click to stop' : `Ask by voice (${current.label} only for now)`}>
        {Icon.mic}
      </button>
    </>
  )
}

// ------------------------------------------------------------------ composer (shared by the top bar and the chat)
/**
 * A message box like ChatGPT / Claude: grows with the text (up to `maxRows` lines, then scrolls),
 * Enter sends, Shift+Enter adds a line, and Enter while an input method is composing (e.g. Hindi typing) does not send.
 */
function Composer({ label, placeholder, busy, onSend, maxRows = 8, variant, autoFocus }: {
  label: string; placeholder: string; busy: boolean; onSend: (text: string) => void
  maxRows?: number; variant: 'bar' | 'chat'; autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const voice = useSpeech((spoken) => { setText(''); onSend(spoken) })
  const shown = voice.listening ? voice.interim : text

  useLayoutEffect(() => {                       // grow / shrink with the content
    const el = ref.current
    if (!el) return
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22
    const max = line * maxRows
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [shown, maxRows])

  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])

  const send = () => {
    if (!text.trim() || busy || voice.listening) return
    onSend(text)
    setText('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    // class names are prefixed (composer--top / composer--chat): a bare `.bar` already styles the chart bars
    <div className={`composer-wrap composer-wrap--${variant === 'bar' ? 'top' : 'chat'}`}>
      <form className={`composer composer--${variant === 'bar' ? 'top' : 'chat'} ${voice.listening ? 'listening' : ''}`} onSubmit={(e) => { e.preventDefault(); send() }}>
        {variant === 'bar' && <span className="askbar-icon" aria-hidden>✦</span>}
        <textarea
          ref={ref}
          rows={1}
          value={shown}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          readOnly={voice.listening}
          placeholder={voice.listening ? 'Listening… speak in English, e.g. “how many bugs are open in Form Builder?”' : placeholder}
          aria-label={label}
          enterKeyHint="send"
        />
        <div className="composer-actions">
          <VoiceControls voice={voice} busy={busy} />
          <button type="submit" className="icon-round send" aria-label="Send" title="Send (Enter) · new line: Shift+Enter"
            disabled={busy || !text.trim() || voice.listening}>
            {busy ? <span className="send-spinner" aria-hidden /> : Icon.send}
          </button>
        </div>
      </form>
      {voice.error && (
        <div className="voice-error" role="alert">
          {voice.error} <button type="button" onClick={voice.clearError} aria-label="Dismiss">✕</button>
        </div>
      )}
      {variant === 'chat' && <p className="composer-hint">Enter to send · Shift+Enter for a new line · type in English or Hindi, speak in English</p>}
    </div>
  )
}

/** The top "Ask Jira" bar: type (multi-line is fine) or speak; opens the conversation. */
export function AskBar({ onAsk, busy }: { onAsk: (q: string) => void; busy: boolean }) {
  return (
    <div className="askbar-wrap">
      <Composer variant="bar" label="Ask Jira" placeholder="Ask Jira anything… in English or Hindi" busy={busy} onSend={onAsk} maxRows={5} />
    </div>
  )
}

// ------------------------------------------------------------------ messages
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked: nothing to do */ }
  }
  return (
    <button type="button" className="msg-action" onClick={copy} aria-label={copied ? 'Copied' : 'Copy answer'}>
      {copied ? Icon.check : Icon.copy}<span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

function BotMessage({ m }: { m: Extract<Message, { role: 'bot' }> }) {
  if (m.streaming) {
    return (
      <div className="msg bot typing turn" aria-label="Checking Jira">
        <div className="avatar thinking" aria-hidden>✦</div>
        <div className="bot-body">
          <div className="stream-status" aria-live="polite"><span className="typing-dots"><span /><span /><span /></span><em>{m.status}</em></div>
          {m.text && <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown></div>}
        </div>
      </div>
    )
  }
  return (
    <div className="msg bot turn">
      <div className="avatar" aria-hidden>✦</div>
      <div className="bot-body">
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
              table: (props) => <div className="md-table"><table {...props} /></div>,
            }}>
            {m.text}
          </Markdown>
        </div>
        <div className="msg-actions">
          <CopyButton text={m.text} />
          <details className="tools">
            <summary>{m.seconds.toFixed(1)}s · {m.tools.length} Jira lookup{m.tools.length === 1 ? '' : 's'}</summary>
            {m.tools.map((t, j) => <code key={j}>{t.tool}({t.args})</code>)}
          </details>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ history sidebar
function dayGroup(ts: number): string {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const day = 86400000
  if (ts >= start.getTime()) return 'Today'
  if (ts >= start.getTime() - day) return 'Yesterday'
  if (ts >= start.getTime() - 7 * day) return 'Previous 7 days'
  return 'Older'
}

function HistoryList({ chat, onPicked }: { chat: ReturnType<typeof useChat>; onPicked: () => void }) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const list = chat.conversations
  const groups: { label: string; items: Conversation[] }[] = []
  for (const c of list) {
    const label = dayGroup(c.updatedAt)
    const g = groups.find((x) => x.label === label) ?? groups[groups.push({ label, items: [] }) - 1]
    g.items.push(c)
  }
  return (
    <nav className="history" aria-label="Chat history">
      <button type="button" className="history-new" onClick={() => { chat.newChat(); onPicked() }}>{Icon.plus}<span>New chat</span></button>
      {chat.conversations.length === 0 && <p className="history-empty">Your chats will appear here.</p>}
      <p className="history-note" role="note">
        Only your last {MAX_CHATS} chats are kept. Starting a new one when you have {MAX_CHATS} removes the one
        you used least recently.
      </p>
      {groups.map((g) => (
        <div key={g.label} className="history-group">
          <h4>{g.label}</h4>
          <ul>
            {g.items.map((c) => (
              <li key={c.id} className={c.id === chat.currentId ? 'active' : ''} onMouseLeave={() => setConfirming(null)}>
                <button type="button" className="history-item" aria-current={c.id === chat.currentId ? 'true' : undefined}
                  onClick={() => { chat.open(c.id); onPicked() }} title={c.title}>
                  {chat.busyId === c.id && <span className="history-busy" aria-label="answering" />}
                  {c.title}
                </button>
                <button type="button" className={`history-del ${confirming === c.id ? 'confirm' : ''}`}
                  aria-label={confirming === c.id ? `Confirm delete: ${c.title}` : `Delete chat: ${c.title}`}
                  onClick={() => (confirming === c.id ? chat.remove(c.id) : setConfirming(c.id))}>
                  {confirming === c.id ? 'Delete?' : Icon.trash}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

// ------------------------------------------------------------------ the conversation panel
export function ChatPanel({ chat, meName, asLabel, open, onClose }: {
  chat: ReturnType<typeof useChat>; meName: string; asLabel?: string; open: boolean; onClose: () => void
}) {
  const logRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)       // slide-over in the side panel; always shown full screen
  const [atBottom, setAtBottom] = useState(true)
  const { messages, busy, ask, newChat, thinkingHere } = chat
  const firstName = meName.split(' ')[0]

  const scrollToBottom = (smooth = true) =>
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })

  // follow new messages, unless you scrolled up to read something
  useEffect(() => { if (atBottom) scrollToBottom() }, [messages, busy, open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { scrollToBottom(false); setAtBottom(true) }, [chat.currentId])  // opened another chat: show its end

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onScroll = () => {
    const el = logRef.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  return (
    <>
      <div className={`scrim ${open ? 'show' : ''}`} onClick={onClose} aria-hidden />
      <aside className={`drawer ${open ? 'open' : ''} ${expanded ? 'expanded' : ''} ${historyOpen ? 'history-open' : ''}`} aria-label="Ask Jira" aria-hidden={!open}>
        <header className="drawer-head">
          <div className="drawer-title">
            <span className="avatar small" aria-hidden>✦</span>
            <div>
              <h2>Ask Jira</h2>
              <p className="card-sub">Live Jira data · asking as {asLabel || meName || '…'}</p>
            </div>
          </div>
          <div className="card-actions">
            <button className="icon-btn ghost history-toggle" onClick={() => setHistoryOpen((v) => !v)} aria-pressed={historyOpen}
              aria-label="Chat history" title="Chat history">{Icon.history}</button>
            <button className="icon-btn ghost" onClick={() => { newChat(); setHistoryOpen(false) }} disabled={!messages.length} aria-label="New chat" title="New chat">{Icon.plus}</button>
            <button className="icon-btn ghost expand-btn" onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? 'Exit full screen' : 'Expand chat'} title={expanded ? 'Exit full screen' : 'Full screen'}>
              {expanded ? Icon.shrink : Icon.expand}
            </button>
            <button className="icon-btn ghost" onClick={onClose} aria-label="Close" title="Close (Esc)">{Icon.close}</button>
          </div>
        </header>

        <div className="chat-body">
        <HistoryList chat={chat} onPicked={() => setHistoryOpen(false)} />
        {historyOpen && !expanded && <div className="history-scrim" onClick={() => setHistoryOpen(false)} aria-hidden />}
        <div className="chat-main">
        <div className="chat-log" ref={logRef} onScroll={onScroll} aria-live="polite">
          <div className="chat-column">
            {chat.loading && <p className="chat-loading">Loading chat…</p>}
            {messages.length === 0 && !chat.loading && (
              <div className="chat-empty">
                <div className="avatar big" aria-hidden>✦</div>
                <h3>How can I help{firstName ? `, ${firstName}` : ''}?</h3>
                <p>Ask about tasks, bugs, sprints, people or naming standards.</p>
                <p className="lang-note">Type in <b>English or Hindi</b>. Voice works in <b>English</b> only for now.</p>
                {chat.wouldRemove && (
                  <p className="chat-limit" role="note">
                    You have {MAX_CHATS} saved chats. Asking here removes the least recently used one:{' '}
                    <b>{chat.wouldRemove.title}</b>
                  </p>
                )}
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => ask(s)} disabled={busy}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="msg user turn"><div className="bubble">{m.text}</div></div>
              ) : m.role === 'error' ? (
                <div key={i} className="msg error turn">
                  <div className="avatar" aria-hidden>!</div>
                  <div className="bot-body">
                    <p><b>Something went wrong.</b> {m.text}</p>
                    <div className="msg-actions">
                      <button type="button" className="msg-action" onClick={() => ask(m.question)} disabled={busy}>↻ <span>Retry</span></button>
                    </div>
                  </div>
                </div>
              ) : (
                <BotMessage key={i} m={m} />
              ),
            )}
            {thinkingHere && !messages.some((m) => m.role === 'bot' && m.streaming) && (
              <div className="msg bot typing turn" aria-label="Checking Jira">
                <div className="avatar thinking" aria-hidden>✦</div>
                <div className="typing-dots"><span /><span /><span /><em>Checking Jira…</em></div>
              </div>
            )}
          </div>
        </div>

        {!atBottom && messages.length > 0 && (
          <button className="jump-latest" onClick={() => { scrollToBottom(); setAtBottom(true) }} aria-label="Jump to latest">{Icon.down}</button>
        )}

        <div className="chat-footer">
          <div className="chat-column">
            <Composer variant="chat" label="Your question" placeholder={messages.length ? 'Ask a follow-up…' : 'Message Ask Jira…'}
              busy={busy} onSend={ask} autoFocus={open} />
          </div>
        </div>
        </div>
        </div>
      </aside>
    </>
  )
}
