import { useEffect, useState } from 'react'
import { api } from '../api'
import { fmtCountdown, fmtDayTime, fmtTime } from '../format'
import type { DeviceEntry, EventOut, FeederAttrs, PlugAttrs } from '../types'
import foodMachine from '../assets/food-machine.jpg'
import ChutkuAvatar from './ChutkuAvatar'
import ConfirmButton from './ConfirmButton'
import HealthBadge from './HealthBadge'
import PowerZone from './PowerZone'
import Ring, { type RingMode } from './Ring'
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

export default function FeederCard({
  entry,
  plug,
}: {
  entry?: DeviceEntry
  plug?: DeviceEntry
}) {
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

  const plugAttrs = plug?.state?.attributes as PlugAttrs | undefined
  const plugIsOff = plugAttrs?.power_on === false
  const offlineBecausePlug = attrs?.online === false && plugIsOff

  if (!entry) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>🍽️ Food Machine</h2>
        </div>
        <p className="muted">No food machine yet — set PETLIBRO_* in .env</p>
        <PowerZone plugId="plug_feeder" plug={plug} />
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
        text: `Serving ${portions} snack${portions > 1 ? 's' : ''} ✓`,
        ok: true,
      })
    } catch (err) {
      setNotice({ text: `Couldn't serve: ${(err as Error).message}`, ok: false })
    }
  }

  // Machine ring, mirroring the litter card: green steady when ready, amber
  // sweep while serving, red when jammed, grey when offline.
  const ringMode: RingMode = !attrs
    ? 'off'
    : attrs.online === false
      ? 'off'
      : attrs.dispenser_blocked
        ? 'bad'
        : attrs.running_state && attrs.running_state !== 'IDLE'
          ? 'busy'
          : 'ok'
  const ringStatus = !attrs
    ? '—'
    : attrs.online === false
      ? 'Offline'
      : attrs.dispenser_blocked
        ? 'Jammed'
        : attrs.running_state && attrs.running_state !== 'IDLE'
          ? 'Serving…'
          : 'Ready'

  return (
    <section className="card">
      <div className="card-head">
        <h2>🍽️ Food Machine</h2>
        <HealthBadge health={entry.health} />
      </div>

      {attrs ? (
        <>
          {attrs.name && <p className="subtitle">{attrs.name}</p>}

          <div className="litter-visual">
            <div className="ring-block">
              <Ring mode={ringMode}>
                <ChutkuAvatar
                  className="ring-photo"
                  src={foodMachine}
                  alt="Chutku beside his food machine"
                />
              </Ring>
              <div className="ring-status">
                <span className="status-big">{ringStatus}</span>
              </div>
            </div>
          </div>

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
                <span className="wchip wchip-bad">⚠️ jammed</span>
              )}
              {attrs.food_low && <span className="wchip wchip-warn">🍚 low on food</span>}
              {attrs.running_state && attrs.running_state !== 'IDLE' && (
                <span className="wchip wchip-info">⚙️ serving…</span>
              )}
            </div>
          )}

          <FeedTimeline feeds={todayFeeds} />

          <dl className="meta">
            <div>
              <dt>Today</dt>
              <dd>
                <TickNumber value={attrs.today_feed_count ?? 0} /> snacks ·{' '}
                <TickNumber value={attrs.today_portions ?? 0} /> portions
              </dd>
            </div>
            <div>
              <dt>Last snack</dt>
              <dd>
                {lastFeed
                  ? `${fmtDayTime(lastFeed.ts_utc)} · ${String(
                      lastFeed.data['portions'] ?? '?',
                    )}p`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Next snack</dt>
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
              <dt>Snack size</dt>
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
              label={`Serve ${portions} snack${portions > 1 ? 's' : ''}`}
              confirmLabel="Tap again to serve"
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

      <PowerZone
        plugId="plug_feeder"
        plug={plug}
        autoExpand={offlineBecausePlug}
        hint={
          offlineBecausePlug
            ? 'Plug is off — that’s why the feeder is offline.'
            : undefined
        }
      />
    </section>
  )
}
