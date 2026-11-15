import { useState, type FormEvent } from 'react'
import { login } from '../api'

/** Shown when AUTH_MODE=password and nobody is signed in. */
export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await login(email, password)
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <span className="logo big-logo" aria-hidden>◆</span>
        <h1>Jira Pulse</h1>
        <p className="muted">Sign in with your work email and the team password.</p>
        <label>Work email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
