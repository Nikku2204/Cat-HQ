import { useEffect, useState } from 'react'
import { clearToken, getToken, setUnauthorizedHandler } from './api'
import { useLive, type ConnStatus } from './useLive'
import Login from './components/Login'
import LitterCard from './components/LitterCard'
import FeederCard from './components/FeederCard'
import HistoryView from './components/HistoryView'

export default function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken())

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken()
      setTokenState(null)
    })
  }, [])

  if (!token) {
    return <Login onSuccess={(t) => setTokenState(t)} />
  }
  // key: remount (fresh WS with the new token) after re-login
  return <Dashboard key={token} onLogout={() => {
    clearToken()
    setTokenState(null)
  }} />
}

function ConnPill({ conn }: { conn: ConnStatus }) {
  const label = conn === 'live' ? 'live' : conn === 'connecting' ? 'connecting' : 'offline'
  return <span className={`conn conn-${conn}`}>{label}</span>
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const { devices, conn } = useLive()
  const [tab, setTab] = useState<'status' | 'history'>('status')

  return (
    <div className="shell">
      <header className="topbar">
        <h1>🐱 Cat HQ</h1>
        <div className="topbar-right">
          <ConnPill conn={conn} />
          <button className="link" onClick={onLogout} title="Forget token">
            log out
          </button>
        </div>
      </header>

      {conn === 'offline' && (
        <div className="banner banner-warn">
          Connection lost — retrying… data may be stale.
        </div>
      )}

      <main className="content">
        {tab === 'status' ? (
          <>
            <LitterCard entry={devices['litterrobot']} />
            <FeederCard entry={devices['feeder']} />
          </>
        ) : (
          <HistoryView />
        )}
      </main>

      <nav className="tabbar">
        <button
          className={tab === 'status' ? 'tab active' : 'tab'}
          onClick={() => setTab('status')}
        >
          Status
        </button>
        <button
          className={tab === 'history' ? 'tab active' : 'tab'}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </nav>
    </div>
  )
}
