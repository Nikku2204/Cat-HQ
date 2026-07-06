import { useEffect, useState } from 'react'
import { api } from '../api'
import {
  filterWeights,
  fmtDayTime,
  isLrFault,
  LR_BUSY_CODES,
  lrStatus,
  relTime,
} from '../format'
import type { DeviceEntry, EventOut, LitterAttrs, PlugAttrs } from '../types'
import ConfirmButton from './ConfirmButton'
import Gauge from './Gauge'
import HealthBadge from './HealthBadge'
import PinsuAvatar from './PinsuAvatar'
import PowerZone from './PowerZone'
import Ring, { type RingMode } from './Ring'
import Sparkline from './Sparkline'
import Tube from './Tube'

function isCleanCycleEvent(e: EventOut): boolean {
  return (
    (e.event_type === 'activity' &&
      /clean cycle complete/i.test(String(e.data['action'] ?? ''))) ||
    (e.event_type === 'status_change' && e.data['to'] === 'CCC')
  )
}

export default function LitterCard({
  entry,
  plug,
}: {
  entry?: DeviceEntry
  plug?: DeviceEntry
}) {
  const attrs = entry?.state?.attributes as LitterAttrs | undefined
  const statusCode = attrs?.status_code
  const [lastCycle, setLastCycle] = useState<EventOut | null>(null)
  const [presence, setPresence] = useState<{
    lastVisit: string | null
    weights: number[]
  }>({ lastVisit: null, weights: [] })
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  // The event log is local SQLite — cheap to requery. Keyed on cycle_count
  // (increments exactly once per clean cycle, even if the intermediate
  // status transitions were never rendered). Type-filtered queries so
  // chatty telemetry can't push the last cycle out of the window.
  useEffect(() => {
    if (!entry) return
    let stale = false
    Promise.all([
      api.events({ device: 'litterrobot', type: 'status_change', limit: 20 }),
      api.events({ device: 'litterrobot', type: 'activity', limit: 20 }),
    ])
      .then(([sc, act]) => {
        if (stale) return
        const newest = [...sc.events, ...act.events]
          .filter(isCleanCycleEvent)
          .sort((a, b) => (a.ts_utc < b.ts_utc ? 1 : -1))[0]
        setLastCycle(newest ?? null)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [entry != null, attrs?.cycle_count])

  // Pinsu presence + weight trend (docs/05 Part B item 2). Every pet_weight
  // event IS a visit (the scale fires when the cat steps in); "Cat Detected"
  // activity rows cover visits the scale didn't log. Refetches when the live
  // weight or cycle count moves.
  useEffect(() => {
    if (!entry) return
    let stale = false
    Promise.all([
      api.events({ device: 'litterrobot', type: 'pet_weight', limit: 30 }),
      api.events({ device: 'litterrobot', type: 'activity', limit: 30 }),
    ])
      .then(([w, act]) => {
        if (stale) return
        const catSeen = act.events.filter((e) =>
          /cat detected/i.test(String(e.data['action'] ?? '')),
        )
        const lastVisit =
          [w.events[0]?.ts_utc, catSeen[0]?.ts_utc]
            .filter((t): t is string => Boolean(t))
            .sort()
            .pop() ?? null
        const chrono = [...w.events]
          .reverse()
          .map((e) => Number(e.data['to'] ?? NaN))
        setPresence({ lastVisit, weights: filterWeights(chrono).slice(-14) })
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [entry != null, attrs?.pet_weight_lbs, attrs?.cycle_count])

  const plugAttrs = plug?.state?.attributes as PlugAttrs | undefined
  const plugIsOff = plugAttrs?.power_on === false
  const offlineBecausePlug = attrs?.is_online === false && plugIsOff

  if (!entry) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>🚽 Litter Box</h2>
        </div>
        <p className="muted">No litter box yet — set WHISKER_* in .env</p>
        <PowerZone plugId="plug_litterrobot" plug={plug} />
      </section>
    )
  }

  const fault = isLrFault(statusCode)
  const cycling = statusCode === 'CCP'
  const drawerPct = attrs?.waste_drawer_level_pct
  const litterPct = attrs?.litter_level_pct
  const ringMode: RingMode = !attrs
    ? 'off'
    : attrs.is_online === false
      ? 'off'
      : fault
        ? 'bad'
        : LR_BUSY_CODES.has(String(statusCode ?? ''))
          ? 'busy'
          : 'ok'

  const clean = async () => {
    setNotice(null)
    try {
      await api.clean()
      setNotice({ text: 'Scooping now ✓', ok: true })
    } catch (err) {
      setNotice({ text: `Couldn't scoop: ${(err as Error).message}`, ok: false })
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>🚽 Litter Box</h2>
        <HealthBadge health={entry.health} />
      </div>

      {attrs ? (
        <>
          <div className="litter-visual">
            <div className="ring-block">
              <Ring mode={ringMode}>
                <PinsuAvatar className="ring-photo" />
              </Ring>
              <div className={fault ? 'ring-status fault' : 'ring-status'}>
                {fault ? (
                  <>
                    <span className="status-code">{String(statusCode)}</span>
                    <span className="status-big">{lrStatus(statusCode)}</span>
                  </>
                ) : (
                  <span className="status-big">
                    {attrs.status_text ?? statusCode ?? '—'}
                  </span>
                )}
                <span className="ring-flags">
                  {attrs.is_sleeping && <span title="Sleep mode active">💤</span>}
                  {attrs.is_online === false && (
                    <span className="pill pill-bad">offline</span>
                  )}
                </span>
              </div>
            </div>
            <div className="litter-levels">
              <Gauge
                label="Drawer"
                pct={drawerPct}
                tone={
                  attrs.is_waste_drawer_full
                    ? 'bad'
                    : drawerPct != null && drawerPct >= 85
                      ? 'warn'
                      : 'ok'
                }
              />
              <Tube
                label="Litter"
                pct={litterPct}
                tone={
                  litterPct != null && litterPct < 15
                    ? 'bad'
                    : litterPct != null && litterPct < 30
                      ? 'warn'
                      : 'ok'
                }
              />
            </div>
          </div>

          <div className="presence-row">
            <span aria-hidden="true">🐾</span>
            <span>
              Pinsu visited{' '}
              {presence.lastVisit ? relTime(presence.lastVisit) : '—'}
            </span>
            {presence.weights.length >= 2 && (
              <span className="weight-spark">
                <Sparkline values={presence.weights} />
                <span className="muted">
                  {presence.weights[presence.weights.length - 1].toFixed(1)} lb
                </span>
              </span>
            )}
          </div>

          <dl className="meta">
            <div>
              <dt>Last scoop</dt>
              <dd>{lastCycle ? fmtDayTime(lastCycle.ts_utc) : '—'}</dd>
            </div>
            <div>
              {/* cycle_count is lifetime; cycle_capacity is per-drawer — not a fraction */}
              <dt>Scoops (lifetime)</dt>
              <dd>{attrs.cycle_count ?? '—'}</dd>
            </div>
            <div>
              <dt>Pinsu weighed</dt>
              <dd>
                {attrs.pet_weight_lbs ? `${attrs.pet_weight_lbs.toFixed(1)} lb` : '—'}
              </dd>
            </div>
            <div>
              <dt>Box seen</dt>
              <dd>{relTime(attrs.last_seen_utc)}</dd>
            </div>
          </dl>

          <ConfirmButton
            label={cycling ? 'Scooping…' : 'Scoop now'}
            confirmLabel="Tap again to scoop"
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

      <PowerZone
        plugId="plug_litterrobot"
        plug={plug}
        autoExpand={fault || offlineBecausePlug}
        hint={
          offlineBecausePlug
            ? 'Plug is off — that’s why the robot is offline.'
            : undefined
        }
      />
    </section>
  )
}
