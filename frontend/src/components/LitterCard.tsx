import { useEffect, useState } from 'react'
import { api } from '../api'
import { fmtDayTime, relTime } from '../format'
import type { DeviceEntry, EventOut, LitterAttrs } from '../types'
import Bar from './Bar'
import ConfirmButton from './ConfirmButton'
import HealthBadge from './HealthBadge'

function isCleanCycleEvent(e: EventOut): boolean {
  return (
    (e.event_type === 'activity' &&
      /clean cycle complete/i.test(String(e.data['action'] ?? ''))) ||
    (e.event_type === 'status_change' && e.data['to'] === 'CCC')
  )
}

export default function LitterCard({ entry }: { entry?: DeviceEntry }) {
  const attrs = entry?.state?.attributes as LitterAttrs | undefined
  const statusCode = attrs?.status_code
  const [lastCycle, setLastCycle] = useState<EventOut | null>(null)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  // The event log is local SQLite — cheap to requery on every status change.
  useEffect(() => {
    if (!entry) return
    let stale = false
    api
      .events({ device: 'litterrobot', limit: 30 })
      .then((r) => {
        if (!stale) setLastCycle(r.events.find(isCleanCycleEvent) ?? null)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [entry != null, statusCode])

  if (!entry) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>Litter-Robot</h2>
        </div>
        <p className="muted">Not configured — set WHISKER_* in .env</p>
      </section>
    )
  }

  const cycling = statusCode === 'CCP'
  const drawerPct = attrs?.waste_drawer_level_pct
  const litterPct = attrs?.litter_level_pct

  const clean = async () => {
    setNotice(null)
    try {
      await api.clean()
      setNotice({ text: 'Clean cycle started ✓', ok: true })
    } catch (err) {
      setNotice({ text: `Clean failed: ${(err as Error).message}`, ok: false })
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Litter-Robot</h2>
        <HealthBadge health={entry.health} />
      </div>

      {attrs ? (
        <>
          <div className="status-line">
            <span className="status-big">
              {attrs.status_text ?? attrs.status_code ?? '—'}
            </span>
            {attrs.is_sleeping && <span title="Sleep mode active">💤</span>}
            {attrs.is_online === false && <span className="pill pill-bad">offline</span>}
          </div>

          <Bar
            label="Waste drawer"
            pct={drawerPct}
            tone={
              attrs.is_waste_drawer_full
                ? 'bad'
                : drawerPct != null && drawerPct >= 85
                  ? 'warn'
                  : 'ok'
            }
          />
          <Bar
            label="Litter level"
            pct={litterPct}
            tone={
              litterPct != null && litterPct < 15
                ? 'bad'
                : litterPct != null && litterPct < 30
                  ? 'warn'
                  : 'ok'
            }
          />

          <dl className="meta">
            <div>
              <dt>Last cycle</dt>
              <dd>{lastCycle ? fmtDayTime(lastCycle.ts_utc) : '—'}</dd>
            </div>
            <div>
              <dt>Cycles</dt>
              <dd>
                {attrs.cycle_count ?? '—'}
                {attrs.cycle_capacity ? ` / ${attrs.cycle_capacity}` : ''}
              </dd>
            </div>
            <div>
              <dt>Pinsu weighed</dt>
              <dd>
                {attrs.pet_weight_lbs ? `${attrs.pet_weight_lbs.toFixed(1)} lb` : '—'}
              </dd>
            </div>
            <div>
              <dt>Robot seen</dt>
              <dd>{relTime(attrs.last_seen_utc)}</dd>
            </div>
          </dl>

          <ConfirmButton
            label={cycling ? 'Cycle in progress…' : 'Start clean cycle'}
            confirmLabel="Tap again to cycle the globe"
            onConfirm={clean}
            disabled={cycling || attrs.is_online === false}
          />
          {notice && (
            <p className={notice.ok ? 'notice ok' : 'notice error'}>{notice.text}</p>
          )}
        </>
      ) : (
        <p className="muted">
          No data — {entry.health.detail || 'adapter disconnected'}
        </p>
      )}
    </section>
  )
}
