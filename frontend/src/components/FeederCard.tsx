import { useEffect, useState } from 'react'
import { api } from '../api'
import { fmtDayTime, fmtTime } from '../format'
import type { DeviceEntry, EventOut, FeederAttrs } from '../types'
import ConfirmButton from './ConfirmButton'
import HealthBadge from './HealthBadge'

// UI cap only — the backend allows up to 48, but 12 portions is already a
// full cup; anything more is a fat-cat incident, not a use case.
const MAX_UI_PORTIONS = 12

export default function FeederCard({ entry }: { entry?: DeviceEntry }) {
  const attrs = entry?.state?.attributes as FeederAttrs | undefined
  const todayCount = attrs?.today_feed_count
  const [portions, setPortions] = useState(1)
  const [lastFeed, setLastFeed] = useState<EventOut | null>(null)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  // Last feed comes from the local event log (history ingest runs every
  // ~10 min) — NOT from /devices/feeder/history, which would hit the
  // Petlibro cloud on every dashboard render. Refetches when the live
  // today_feed_count ticks up.
  useEffect(() => {
    if (!entry) return
    let stale = false
    api
      .events({ device: 'feeder', type: 'feed', limit: 1 })
      .then((r) => {
        if (!stale) setLastFeed(r.events[0] ?? null)
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

          {attrs.online === false && (
            <div className="banner banner-bad">Feeder offline — check power/wifi</div>
          )}
          {attrs.dispenser_blocked && (
            <div className="banner banner-bad">Dispenser blocked!</div>
          )}
          {attrs.food_low && (
            <div className="banner banner-warn">Food low — refill the hopper</div>
          )}
          {attrs.running_state && attrs.running_state !== 'IDLE' && (
            <div className="banner banner-info">Dispensing…</div>
          )}

          <dl className="meta">
            <div>
              <dt>Today</dt>
              <dd>
                {attrs.today_feed_count ?? 0} feeds ·{' '}
                {attrs.today_portions ?? 0} portions
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
              <dt>Next scheduled</dt>
              <dd>
                {attrs.next_feed_time_utc
                  ? `${fmtTime(attrs.next_feed_time_utc)} · ${
                      attrs.next_feed_portions ?? '?'
                    }p`
                  : attrs.today_all_skipped
                    ? 'skipped today'
                    : 'none'}
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
