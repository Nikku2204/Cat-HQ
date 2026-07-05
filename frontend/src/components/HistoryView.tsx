import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { fmtDay, fmtTime, lrStatus } from '../format'
import type { EventOut } from '../types'

const PAGE = 50
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'litterrobot', label: 'Litter' },
  { key: 'feeder', label: 'Feeder' },
] as const
type FilterKey = (typeof FILTERS)[number]['key']

function describe(e: EventOut): { icon: string; text: string } {
  const d = e.data
  const s = (k: string) => String(d[k] ?? '?')
  switch (e.event_type) {
    case 'feed': {
      const p = Number(d['portions'] ?? 0)
      return { icon: '🍽️', text: `Fed ${p} portion${p === 1 ? '' : 's'}` }
    }
    case 'activity':
      return { icon: '📋', text: s('action') }
    case 'status_change':
      return { icon: '🔄', text: `${lrStatus(d['from'])} → ${lrStatus(d['to'])}` }
    case 'drawer_level_change':
      return { icon: '🗑️', text: `Waste drawer ${s('from')}% → ${s('to')}%` }
    case 'drawer_full':
      return {
        icon: '🗑️',
        text: d['to'] ? 'Waste drawer FULL' : 'Waste drawer emptied',
      }
    case 'litter_level_change':
      return { icon: '⏳', text: `Litter level ${s('from')} → ${s('to')}` }
    case 'pet_weight':
      return { icon: '⚖️', text: `Pinsu weighed ${s('to')} lb` }
    case 'connectivity':
      return { icon: '📶', text: d['to'] ? 'Back online' : 'Went offline' }
    case 'health_change': {
      const detail = d['detail'] ? ` — ${s('detail')}` : ''
      return { icon: '🩺', text: `Adapter ${s('from')} → ${s('to')}${detail}` }
    }
    case 'food_low':
      return { icon: '🍚', text: d['to'] ? 'Food low' : 'Food level OK again' }
    case 'dispenser_blocked':
      return { icon: '⚠️', text: d['to'] ? 'Dispenser blocked' : 'Dispenser cleared' }
    case 'running_state':
      return { icon: '⚙️', text: `Feeder ${s('from')} → ${s('to')}` }
    case 'feed_count_change':
      return { icon: '🍽️', text: `Feeds today: ${s('from')} → ${s('to')}` }
    default:
      return { icon: '•', text: `${e.event_type} ${JSON.stringify(d)}` }
  }
}

export default function HistoryView() {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [events, setEvents] = useState<EventOut[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)

  const load = useCallback(
    async (append: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const base = append && events.length > 0 ? events : []
        const r = await api.events({
          device: filter === 'all' ? undefined : filter,
          limit: PAGE,
          // `until` is inclusive — the boundary event comes back again and
          // is dropped by the id-dedupe below.
          until: append ? base[base.length - 1]?.ts_utc : undefined,
        })
        const seen = new Set(base.map((e) => e.id))
        const fresh = r.events.filter((e) => !seen.has(e.id))
        setEvents([...base, ...fresh])
        setExhausted(fresh.length === 0 || r.events.length < PAGE)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [filter, events],
  )

  useEffect(() => {
    setEvents([])
    setExhausted(false)
    let stale = false
    setLoading(true)
    setError(null)
    api
      .events({ device: filter === 'all' ? undefined : filter, limit: PAGE })
      .then((r) => {
        if (stale) return
        setEvents(r.events)
        setExhausted(r.events.length < PAGE)
      })
      .catch((err) => !stale && setError((err as Error).message))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [filter])

  let lastDay = ''
  return (
    <section className="history">
      <div className="chips">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? 'chip active' : 'chip'}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="banner banner-bad">{error}</div>}
      {!error && events.length === 0 && !loading && (
        <p className="muted center">No events yet.</p>
      )}

      <ul className="event-list">
        {events.map((e) => {
          const day = fmtDay(e.ts_utc)
          const header = day !== lastDay ? day : null
          lastDay = day
          const { icon, text } = describe(e)
          return (
            <li key={e.id}>
              {header && <div className="day-head">{header}</div>}
              <div className="event-row">
                <span className="event-icon">{icon}</span>
                <span className="event-text">{text}</span>
                <span className={`event-dev dev-${e.device_id}`}>
                  {e.device_id === 'litterrobot' ? 'litter' : e.device_id}
                </span>
                <span className="event-time">{fmtTime(e.ts_utc)}</span>
              </div>
            </li>
          )
        })}
      </ul>

      {!exhausted && events.length > 0 && (
        <button className="btn ghost" disabled={loading} onClick={() => load(true)}>
          {loading ? 'Loading…' : 'Load older'}
        </button>
      )}
    </section>
  )
}
