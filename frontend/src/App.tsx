import { useEffect, useRef, useState } from 'react'
import { api, clearToken, getToken, setUnauthorizedHandler } from './api'
import { fmtUptime } from './format'
import { useLive, type ConnStatus } from './useLive'
import type { HealthInfo } from './types'
import FeederCard from './components/FeederCard'
import HealthBadge from './components/HealthBadge'
import HistoryView from './components/HistoryView'
import LitterCard from './components/LitterCard'
import Login from './components/Login'
import PixelCat from './components/PixelCat'

// The reconnect toast covers brief blips; the full-width banner is reserved
// for real outages (docs/05 Part B item 4).
const LONG_OFFLINE_MS = 60_000

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

/** Uptime + adapter health, expanded by tapping the header avatar. /health
 * is unauthenticated and local — cheap to poll while open. */
function HealthStrip({ conn }: { conn: ConnStatus }) {
  const [info, setInfo] = useState<HealthInfo | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stale = false
    const fetchIt = () =>
      api
        .health()
        .then((h) => {
          if (!stale) {
            setInfo(h)
            setFailed(false)
          }
        })
        .catch(() => !stale && setFailed(true))
    fetchIt()
    const t = setInterval(fetchIt, 30_000)
    return () => {
      stale = true
      clearInterval(t)
    }
  }, [])

  return (
    <div className="health-strip" role="region" aria-label="Backend health">
      {info ? (
        <>
          <span className="strip-item">
            up {fmtUptime(info.uptime_seconds)} · v{info.version} ({info.build})
          </span>
          <span className="strip-item">ws {conn}</span>
          {Object.entries(info.adapters).map(([name, health]) => (
            <span key={name} className="strip-item strip-adapter">
              {name.replace('plug_', '⚡')} <HealthBadge health={health} />
            </span>
          ))}
        </>
      ) : (
        <span className="strip-item muted">
          {failed ? 'backend unreachable' : 'loading…'}
        </span>
      )}
    </div>
  )
}

function SkeletonCard() {
  return (
    <section className="card skeleton" aria-hidden="true">
      <div className="sk sk-title" />
      <div className="sk sk-ring" />
      <div className="sk sk-line" />
      <div className="sk sk-line short" />
    </section>
  )
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const { devices, conn } = useLive()
  const [tab, setTab] = useState<'status' | 'history'>('status')
  const [stripOpen, setStripOpen] = useState(false)
  const [longOffline, setLongOffline] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const offlineSince = useRef<number | null>(null)
  const everLive = useRef(false)
  const droppedSinceLive = useRef(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (conn === 'live') {
      everLive.current = true
      offlineSince.current = null
      setLongOffline(false)
      if (droppedSinceLive.current) {
        droppedSinceLive.current = false
        setToast('Reconnected ✓') // dismissed by the toast effect below
      }
    } else {
      // 'offline' AND 'connecting' both count as "not connected": the WS
      // cycles offline→connecting→offline during an outage, so the banner
      // clock must run CONTINUOUSLY across reconnect attempts (resetting it
      // on each 'connecting' made the 60s banner unreachable). Only a real
      // prior 'live' arms the reconnect toast — a slow first connect is
      // "connecting", never "reconnected".
      if (everLive.current) droppedSinceLive.current = true
      if (offlineSince.current == null) offlineSince.current = Date.now()
      const elapsed = Date.now() - offlineSince.current
      if (elapsed >= LONG_OFFLINE_MS) setLongOffline(true)
      else timer = setTimeout(() => setLongOffline(true), LONG_OFFLINE_MS - elapsed)
    }
    return () => clearTimeout(timer)
  }, [conn])

  // Toast auto-dismiss lives in its own effect keyed on `toast`, so a second
  // drop within 3s of reconnecting can't clear the dismiss timer and strand
  // the toast on screen.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  // first snapshot not in yet → skeleton shimmer, not a flash of "not
  // configured". (A live hello with zero adapters means genuinely empty.)
  const booting = Object.keys(devices).length === 0 && conn !== 'live'

  return (
    <div className="shell">
      <header className="topbar">
        <button
          className="brand"
          onClick={() => setStripOpen((o) => !o)}
          aria-expanded={stripOpen}
          title="Uptime & adapter health"
        >
          <span className={`avatar conn-${conn}`}>
            <PixelCat />
          </span>
          <h1>Cat HQ</h1>
        </button>
        <div className="topbar-right">
          <button className="link" onClick={onLogout} title="Forget secret pass">
            lock up
          </button>
        </div>
      </header>

      {stripOpen && <HealthStrip conn={conn} />}

      {longOffline && (
        <div className="banner banner-warn">
          Connection lost — retrying… data may be stale.
        </div>
      )}

      <main className="content">
        <div className="pane" key={tab}>
          {tab === 'status' ? (
            booting ? (
              <>
                <SkeletonCard />
                <SkeletonCard />
              </>
            ) : (
              <>
                <LitterCard
                  entry={devices['litterrobot']}
                  plug={devices['plug_litterrobot']}
                />
                <FeederCard
                  entry={devices['feeder']}
                  plug={devices['plug_feeder']}
                />
              </>
            )
          ) : (
            <HistoryView />
          )}
        </div>
      </main>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      <nav className="tabbar">
        <button
          className={tab === 'status' ? 'tab active' : 'tab'}
          onClick={() => setTab('status')}
        >
          🏠 Home
        </button>
        <button
          className={tab === 'history' ? 'tab active' : 'tab'}
          onClick={() => setTab('history')}
        >
          🐾 Diary
        </button>
      </nav>
    </div>
  )
}
