import { useState, type FormEvent } from 'react'
import { checkToken, saveToken } from '../api'
import pinsuLogin from '../assets/pinsu-login.jpg'
import PinsuAvatar from './PinsuAvatar'

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
        setError('Token rejected — check CATHQ_AUTH_TOKEN in .env')
      }
    } catch {
      setError("Can't reach the backend — is it running?")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <PinsuAvatar className="login-photo" src={pinsuLogin} />
        <h1>Cat HQ</h1>
        <p className="muted">Paste the access token to connect.</p>
        <input
          type="password"
          inputMode="text"
          autoComplete="current-password"
          placeholder="access token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error && <p className="error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy || !value.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  )
}
