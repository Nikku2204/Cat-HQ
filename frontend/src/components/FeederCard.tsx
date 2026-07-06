import { useEffect, useState } from 'react'
import { api } from '../api'
import { fmtCountdown, fmtDayTime, fmtTime } from '../format'
import type { DeviceEntry, EventOut, FeederAttrs } from '../types'
import ConfirmButton from './ConfirmButton'
import HealthBadge from './HealthBadge'
import TickNumber from './TickNumber'

// UI cap only — the backend allows up to 48, but 12 portions is already a
// full cup; anything more is a fat-cat incident, not a use case.
const MAX_UI_PORTIONS = 12

/** Today's feeds on a 24h strip: dot position = time of day, dot size =
 * portions, amber line = now (docs/05 Part B item 3). Plain divs — the
 * strip is responsive without SVG viewBox distortion. */
function FeedTimeline({ feeds }: { feeds: { ts: string; portions: number }[] }) {
  const now = new Date()
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const pct = (d: Date) =>
    Math.max(0, Math.min(100, ((d.getTime() - dayStart.getTime()) / 86_400_000) * 100))
  return (
    <div className="timeline" aria-label="Today's feeds on a 24-hour strip">
      <div className="timeline-track">
        {[6, 12, 18].map((h) => (
          <span
            key={h}
            className="timeline-tick"
            style={{ left: `${(h / 24) * 100}%` }}
          />
        ))}
        {feeds.map((f, i) => {
          const size = Math.min(18, 7 + f.portions * 2)
          return (
            <span
              key={i}
              className="timeline-dot"
              title={`${fmtTime(f.ts)} · ${f.portions}p`}
              style={{
                left: `${pct(new Date(f.ts))}%`,
                width: size,
                height: size,
              }}
            />
          )
        })}
        <span className="timeline-now" style={{ left: `${pct(now)}%` }} />
      </div>
      <div className="timeline-labels" aria-hidden="true">
        <span>12a</span>
        <span>6a</span>
        <span>12p</span>
        <span>6p</span>
        <span>12a</span>
      </div>
    </div>
  )
}

export default function FeederCard({ entry }: { entry?: DeviceEntry }) {
  const attrs = entry?.state?.attributes as FeederAttrs | undefined
  const todayCount = attrs?.today_feed_count
  const [portions, setPortions] = useState(1)
  const [feedLog, setFeedLog] = useState<EventOut[]>([])
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)
  // 30s heartbeat so the "next feed in…" countdown stays honest
  const [nowTick, setNowTick] = useState(() => Date.now())

  useEffect(() => {
    if (!attrs?.next_feed_time_utc) return
    const t = setInterval(() => setNowTick(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [attrs?.next_feed_time_utc])

  // Feed history comes from the local event log (history ingest runs every
  // ~10 min) — NOT from /devices/feeder/history, which would hit the
  // Petlibro cloud on every dashboard render. Refetches when the live
  // today_feed_count ticks up.
  useEffect(() => {
    if (!entry) return
    let stale = false
    api
      .events({ device: 'feeder', type: 'feed', limit: 60 })
      .then((r) => {
        if (!stale) setFeedLog(r.events)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
    // today_portions too: catches feeds when the count alone revisits an
    // already-rendered value (e.g. midnight reset then first feed)
  }, [entry != null, todayCount, attrs?.today_portions])

  if (!entry) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>Feeder</h2>
        </div>
        <p className="muted">Not configured — set PETLIBRO_* in .env</p>
      </section>
    )
  }

  const lastFeed = feedLog[0] ?? null
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const todayFeeds = feedLog
    .filter((e) => new Date(e.ts_utc).getTime() >= dayStart.getTime())
    .map((e) => ({ ts: e.ts_utc, portions: Number(e.data['portions'] ?? 0) }))
    .reverse()

  const feed = async () => {
    setNotice(null)
    try {
      await api.feed(portions)
      setNotice({
        text: `Dispensing ${portions} portion${portions > 1 ? 's' : ''} ✓`,
        ok: true,
      })
    } catch (err) {
      setNotice({ text: `Feed failed: ${(err as Error).message}`, ok: false })
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Feeder</h2>
        <HealthBadge health={entry.health} />
      </div>

      {attrs ? (
        <>
          {attrs.name && <p className="subtitle">{attrs.name}</p>}

          {/* warnings as glanceable chips, not full-width banners (item 3) */}
          {(attrs.online === false ||
            attrs.dispenser_blocked ||
            attrs.food_low ||
            (attrs.running_state && attrs.running_state !== 'IDLE')) && (
            <div className="warn-chips">
              {attrs.online === false && (
                <span className="wchip wchip-bad">📶 offline</span>
              )}
              {attrs.dispenser_blocked && (
                <span className="wchip wchip-bad">⚠️ blocked</span>
              )}
              {attrs.food_low && <span className="wchip wchip-warn">🍚 food low</span>}
              {attrs.running_state && attrs.running_state !== 'IDLE' && (
                <span className="wchip wchip-info">⚙️ dispensing…</span>
              )}
            </div>
          )}

          <FeedTimeline feeds={todayFeeds} />

          <dl className="meta">
            <div>
              <dt>Today</dt>
              <dd>
                <TickNumber value={attrs.today_feed_count ?? 0} /> feeds ·{' '}
                <TickNumber value={attrs.today_portions ?? 0} /> portions
              </dd>
            </div>
            <div>
              <dt>Last feed</dt>
              <dd>
                {lastFeed
                  ? `${fmtDayTime(lastFeed.ts_utc)} · ${String(
                      lastFeed.data['portions'] ?? '?',
                    )}p`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Next feed</dt>
              <dd>
                {attrs.next_feed_time_utc ? (
                  <>
                    <span className="countdown">
                      {fmtCountdown(attrs.next_feed_time_utc, nowTick)}
                    </span>{' '}
                    <span className="muted">
                      {fmtTime(attrs.next_feed_time_utc)} ·{' '}
                      {attrs.next_feed_portions ?? '?'}p
                    </span>
                  </>
                ) : attrs.today_all_skipped ? (
                  'skipped today'
                ) : (
                  'none'
                )}
              </dd>
            </div>
            <div>
              <dt>Portion</dt>
              <dd>≈ 1/12 cup each</dd>
            </div>
          </dl>

          <div className="feed-row">
            <div className="stepper">
              <button
                aria-label="fewer portions"
                onClick={() => setPortions((p) => Math.max(1, p - 1))}
                disabled={portions <= 1}
              >
                −
              </button>
              <span>{portions}</span>
              <button
                aria-label="more portions"
                onClick={() => setPortions((p) => Math.min(MAX_UI_PORTIONS, p + 1))}
                disabled={portions >= MAX_UI_PORTIONS}
              >
                +
              </button>
            </div>
            <ConfirmButton
              label={`Feed ${portions} portion${portions > 1 ? 's' : ''}`}
              confirmLabel="Tap again to dispense"
              onConfirm={feed}
              disabled={attrs.online === false || attrs.dispenser_blocked === true}
            />
          </div>
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
