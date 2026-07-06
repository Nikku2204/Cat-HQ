import { useState, type FormEvent } from 'react'
import { checkToken, saveToken } from '../api'
import pinsuBg from '../assets/pinsu-bg.jpg'

export default function Login({ onSuccess }: { onSuccess: (token: string) => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const token = value.trim()
    if (!token || busy) return
    setBusy(true)
    setError(null)
    try {
      if (await checkToken(token)) {
        saveToken(token)
        onSuccess(token)
      } else {
        setError('Wrong secret pass — check CATHQ_AUTH_TOKEN in .env')
      }
    } catch {
      setError("Can't reach Cat HQ — is the backend running?")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <img className="login-bg" src={pinsuBg} alt="" aria-hidden="true" />
      <div className="login-scrim" aria-hidden="true" />
      <form className="login-card" onSubmit={submit}>
        <h1>Cat HQ</h1>
        <p className="muted">Paste your secret pass to come in.</p>
        <input
          type="password"
          inputMode="text"
          autoComplete="current-password"
          placeholder="secret pass"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error && <p className="error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy || !value.trim()}>
          {busy ? 'Coming in…' : 'Come in'}
        </button>
      </form>
    </div>
  )
}
