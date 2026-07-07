import {
  ambientForHour,
  careReminders,
  careStatuses,
  deviceReminders,
  clamp01,
  countByLaDay,
  countToday,
  dailyCounts,
  dayCells,
  filterWeightSeries,
  homeMood,
  laDayKey,
  laDayKeysBack,
  laDayStartMs,
  laHour,
  laPartsOf,
  litterFaultTimestamps,
  meanDailyVisits,
  mealsGoal,
  median,
  moodFor,
  offlineTimestamps,
  rollingMedian,
  SEED_BAND,
  streakDays,
  typicalDailyMeals,
  usualVisitsByNow,
  visitTimestamps,
  weightSamplesFromEvents,
  weightSummary,
} from './insights'
import type { EventOut } from './types'

// Minimal EventOut factory — only the fields the math reads.
const ev = (
  event_type: string,
  ts_utc: string,
  data: Record<string, unknown> = {},
): EventOut => ({
  id: 0,
  device_id: 'litterrobot',
  event_type,
  ts_utc,
  source: 'poll',
  data,
})

describe('LA timezone bucketing (T1 — the correctness trap)', () => {
  it('buckets a late-night PDT instant into its LA day, not UTC', () => {
    // 2026-07-07T05:40:00Z is 2026-07-06 22:40 PDT — still Monday in LA.
    expect(laDayKey('2026-07-07T05:40:00Z')).toBe('2026-07-06')
    expect(laHour('2026-07-07T05:40:00Z')).toBe(22)
  })

  it('rolls the LA day at LA midnight, not UTC midnight', () => {
    // 07:00Z in summer == 00:00 PDT.
    expect(laDayKey('2026-07-06T06:59:00Z')).toBe('2026-07-05')
    expect(laDayKey('2026-07-06T07:00:00Z')).toBe('2026-07-06')
    expect(laHour('2026-07-06T07:00:00Z')).toBe(0)
  })

  it('laPartsOf reports LA wall-clock parts', () => {
    const p = laPartsOf('2026-07-06T19:30:00Z') // 12:30 PDT
    expect(p).toMatchObject({ year: 2026, month: 7, day: 6, hour: 12, minute: 30 })
  })

  it('laDayStartMs = LA midnight in UTC, DST-aware', () => {
    // Summer (PDT = UTC−7): LA midnight Jul 6 == 07:00Z.
    expect(new Date(laDayStartMs('2026-07-06T20:00:00Z')).toISOString()).toBe(
      '2026-07-06T07:00:00.000Z',
    )
    // Winter (PST = UTC−8): LA midnight Jan 15 == 08:00Z.
    expect(new Date(laDayStartMs('2026-01-15T20:00:00Z')).toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    )
  })

  it('laDayKeysBack returns n consecutive LA days oldest→newest', () => {
    const keys = laDayKeysBack('2026-07-06T20:00:00Z', 4)
    expect(keys).toEqual(['2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06'])
  })

  it('laDayKeysBack steps cleanly across a spring-forward boundary', () => {
    // US DST began 2026-03-08. Stepping back over it must not double/skip days.
    const keys = laDayKeysBack('2026-03-09T20:00:00Z', 4)
    expect(keys).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09'])
  })
})

describe('numeric helpers', () => {
  it('clamp01', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(2)).toBe(1)
  })
  it('median odd/even/empty', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(Number.isNaN(median([]))).toBe(true)
  })
  it('rollingMedian smooths with a trailing window', () => {
    // window grows from the start, then trails.
    expect(rollingMedian([10, 12, 100], 7)).toEqual([10, 11, 12])
  })
})

describe('litter visits', () => {
  it('Cat Detected is authoritative; a LAGGED pet_weight never double-counts', () => {
    // Regression from live data 2026-07-06: the Whisker cloud updates
    // pet_weight_lbs lazily — the poll event landed 9 MINUTES after the
    // matching Cat Detected. It must NOT count as a second visit.
    const weights = [ev('pet_weight', '2026-07-06T02:35:01Z', { to: 12.79 })]
    const activity = [
      ev('activity', '2026-07-06T02:25:59Z', { action: 'Cat Detected' }),
      // non-visit activity is ignored
      ev('activity', '2026-07-06T02:40:00Z', { action: 'Clean Cycle Complete' }),
    ]
    expect(visitTimestamps(weights, activity)).toHaveLength(1)
  })

  it('a pet_weight NEWER than every Cat Detected counts (ingest-lag cover)', () => {
    // History ingest runs ~10-min behind; the freshest visit shows up as a
    // pet_weight change first. It counts until the vendor row lands.
    const weights = [ev('pet_weight', '2026-07-07T02:21:00Z', { to: 12.96 })]
    const activity = [
      ev('activity', '2026-07-06T23:46:27Z', { action: 'Cat Detected' }),
    ]
    const visits = visitTimestamps(weights, activity)
    expect(visits).toHaveLength(2)
    expect(visits).toEqual([...visits].sort((a, b) => a - b))
  })

  it('a pet_weight seconds after its Cat Detected never counts twice', () => {
    const weights = [ev('pet_weight', '2026-07-06T18:01:00Z', { to: 13.2 })]
    const activity = [
      ev('activity', '2026-07-06T18:00:30Z', { action: 'Cat Detected' }),
    ]
    expect(visitTimestamps(weights, activity)).toHaveLength(1)
  })

  it('a quick real revisit still counts once its own Cat Detected lands', () => {
    // Visit A 14:00, visit B 14:08 — once B's vendor row is ingested both
    // count, and B's lagged pet_weight (14:09) does not add a third.
    const weights = [ev('pet_weight', '2026-07-06T14:09:00Z', { to: 13.2 })]
    const activity = [
      ev('activity', '2026-07-06T14:00:00Z', { action: 'Cat Detected' }),
      ev('activity', '2026-07-06T14:08:00Z', { action: 'Cat Detected' }),
    ]
    expect(visitTimestamps(weights, activity)).toHaveLength(2)
  })

  it('with no Cat Detected at all (cold DB), pet_weight events carry visits', () => {
    const weights = [
      ev('pet_weight', '2026-07-06T18:00:00Z', { to: 13.2 }),
      ev('pet_weight', '2026-07-06T20:00:00Z', { to: 13.1 }),
    ]
    expect(visitTimestamps(weights, [])).toHaveLength(2)
  })

  it('countToday buckets in LA', () => {
    const visits = [
      new Date('2026-07-06T18:00:00Z').getTime(), // Jul 6 PDT
      new Date('2026-07-07T05:00:00Z').getTime(), // Jul 6 22:00 PDT — still today
      new Date('2026-07-07T08:00:00Z').getTime(), // Jul 7 01:00 PDT — tomorrow
    ]
    expect(countToday(visits, '2026-07-06T23:00:00Z')).toBe(2)
  })

  it('countByLaDay groups instants', () => {
    const m = countByLaDay([
      '2026-07-06T18:00:00Z',
      '2026-07-06T19:00:00Z',
      '2026-07-07T18:00:00Z',
    ])
    expect(m.get('2026-07-06')).toBe(2)
    expect(m.get('2026-07-07')).toBe(1)
  })

  it('usualVisitsByNow is null under the baseline, then averages by-hour', () => {
    // 3 prior days < MIN_BASELINE_DAYS(7) → cold-start null.
    const few = [
      new Date('2026-07-03T18:00:00Z').getTime(),
      new Date('2026-07-04T18:00:00Z').getTime(),
      new Date('2026-07-05T18:00:00Z').getTime(),
    ]
    expect(usualVisitsByNow(few, '2026-07-06T20:00:00Z')).toBeNull()

    // 7 prior days, 2 visits each before the current hour → mean 2.
    const many: number[] = []
    for (let d = 1; d <= 7; d++) {
      const day = `2026-07-0${d}`
      many.push(new Date(`${day}T15:00:00Z`).getTime()) // 08:00 PDT
      many.push(new Date(`${day}T17:00:00Z`).getTime()) // 10:00 PDT
      many.push(new Date(`${day}T23:00:00Z`).getTime()) // 16:00 PDT — after "now"
    }
    // "now" = Jul 8, 12:00 PDT (hour 12): counts the two morning visits/day.
    const usual = usualVisitsByNow(many, '2026-07-08T19:00:00Z')
    expect(usual).toBeCloseTo(2, 5)
  })

  it('meanDailyVisits is null under baseline, then the full-day mean', () => {
    const visits: number[] = []
    for (let d = 1; d <= 7; d++) {
      for (let i = 0; i < 3; i++) {
        visits.push(new Date(`2026-07-0${d}T${15 + i}:00:00Z`).getTime())
      }
    }
    expect(meanDailyVisits([visits[0]], '2026-07-08T19:00:00Z')).toBeNull()
    expect(meanDailyVisits(visits, '2026-07-08T19:00:00Z')).toBeCloseTo(3, 5)
  })
})

describe('meals goal', () => {
  const feeds = (days: Record<string, number>): EventOut[] => {
    const out: EventOut[] = []
    for (const [day, n] of Object.entries(days)) {
      for (let i = 0; i < n; i++) {
        out.push(ev('feed', `${day}T${String(15 + i).padStart(2, '0')}:00:00Z`, { portions: 1 }))
      }
    }
    return out
  }

  it('typicalDailyMeals = mode of prior non-zero days (tie→higher)', () => {
    const events = feeds({
      '2026-07-01': 4,
      '2026-07-02': 4,
      '2026-07-03': 5,
      '2026-07-04': 3, // a skipped-slot day
    })
    expect(typicalDailyMeals(events, '2026-07-06T20:00:00Z')).toBe(4)
  })

  it('typicalDailyMeals is null below the min-days floor', () => {
    expect(typicalDailyMeals(feeds({ '2026-07-01': 4 }), '2026-07-06T20:00:00Z')).toBeNull()
  })

  it('cold-start goal uses served + one upcoming as the bound', () => {
    const today = feeds({ '2026-07-06': 3 }) // 3 served today, no history
    const g = mealsGoal({
      feedEvents: today,
      now: '2026-07-06T23:00:00Z',
      liveToday: 3,
      nextFeedUtc: '2026-07-07T01:00:00Z', // still upcoming
    })
    expect(g).toMatchObject({ served: 3, target: 4 })
    expect(g.pct).toBeCloseTo(0.75, 5)
  })

  it('warm goal uses the typical daily count as the denominator', () => {
    const events = feeds({
      '2026-07-01': 4,
      '2026-07-02': 4,
      '2026-07-03': 4,
      '2026-07-06': 2, // today so far
    })
    const g = mealsGoal({ feedEvents: events, now: '2026-07-06T20:00:00Z', liveToday: 2 })
    expect(g).toMatchObject({ served: 2, target: 4 })
  })

  it('never lets served exceed target (extra manual feed fills the ring)', () => {
    const events = feeds({ '2026-07-01': 4, '2026-07-02': 4, '2026-07-03': 4 })
    const g = mealsGoal({ feedEvents: events, now: '2026-07-06T20:00:00Z', liveToday: 5 })
    expect(g.target).toBe(5)
    expect(g.pct).toBe(1)
  })
})

describe('weight', () => {
  it('filterWeightSeries drops outliers but keeps timestamps aligned', () => {
    const series = [
      { ts: 1, lb: 13.0 },
      { ts: 2, lb: 13.1 },
      { ts: 3, lb: 6.5 }, // half-entry, >20% off → dropped
      { ts: 4, lb: 13.2 },
      { ts: 5, lb: 0 }, // empty scale → dropped
      { ts: 6, lb: 13.1 },
    ]
    const out = filterWeightSeries(series)
    expect(out.map((s) => s.ts)).toEqual([1, 2, 4, 6])
  })

  it('weightSummary: in-band, delta vs 30-day median, no false alarm', () => {
    const now = new Date('2026-07-06T20:00:00Z').getTime()
    const series = Array.from({ length: 10 }, (_, i) => ({
      ts: now - (9 - i) * 86_400_000,
      lb: 13.2 + (i % 2 === 0 ? -0.1 : 0.1),
    }))
    const s = weightSummary({ series, liveLb: 13.2, now })
    expect(s.current).toBe(13.2)
    expect(s.inBand).toBe(true)
    expect(s.concern).toBeNull()
    expect(s.reference).toBeGreaterThan(13)
    expect(s.reference).toBeLessThan(13.4)
    expect(Math.abs(s.deltaPct!)).toBeLessThan(2)
  })

  it('weightSummary uses the seed band and midpoint reference on cold start', () => {
    const now = new Date('2026-07-06T20:00:00Z').getTime()
    const series = [
      { ts: now - 86_400_000, lb: 13.0 },
      { ts: now, lb: 13.1 },
    ]
    const s = weightSummary({ series, liveLb: 13.1, now })
    // <5 recent samples → reference is the seed-band midpoint (13.25).
    expect(s.reference).toBeCloseTo((SEED_BAND.low + SEED_BAND.high) / 2, 5)
    expect(s.inBand).toBe(true)
  })

  it('flags a SUSTAINED multi-day dip below the band, once smoothed', () => {
    const now = new Date('2026-07-06T20:00:00Z').getTime()
    // Four straight days clearly under 12.5, trending down.
    const series = [
      { ts: now - 3 * 86_400_000, lb: 12.2 },
      { ts: now - 2 * 86_400_000, lb: 12.0 },
      { ts: now - 1 * 86_400_000, lb: 11.9 },
      { ts: now, lb: 11.8 },
    ]
    const s = weightSummary({ series, liveLb: 11.8, now })
    expect(s.inBand).toBe(false)
    expect(s.concern).toBe('weigh-in')
  })

  it('does NOT flag a single low reading among healthy weights', () => {
    const now = new Date('2026-07-06T20:00:00Z').getTime()
    const series = [
      { ts: now - 3 * 86_400_000, lb: 13.2 },
      { ts: now - 2 * 86_400_000, lb: 13.1 },
      { ts: now - 1 * 86_400_000, lb: 11.0 }, // one dip
      { ts: now, lb: 13.2 },
    ]
    expect(weightSummary({ series, liveLb: 13.2, now }).concern).toBeNull()
  })

  it('weightSamplesFromEvents reads data.to and sorts ascending', () => {
    const events = [
      ev('pet_weight', '2026-07-06T20:00:00Z', { to: 13.1 }),
      ev('pet_weight', '2026-07-06T18:00:00Z', { to: 13.3 }),
    ]
    const s = weightSamplesFromEvents(events)
    expect(s.map((x) => x.lb)).toEqual([13.3, 13.1])
  })
})

describe('care streaks (device/owner actions only)', () => {
  const day = (d: string) => new Date(`${d}T18:00:00Z`).getTime()

  it('streakDays counts clean days back to first-observed, no over-claiming', () => {
    // No bad events; observing since Jul 4 → "3d" on Jul 6, not 120.
    const first = day('2026-07-04')
    expect(streakDays([], '2026-07-06T20:00:00Z', first)).toBe(3)
  })

  it('streakDays is 0 when today already had a fault', () => {
    expect(streakDays([day('2026-07-06')], '2026-07-06T20:00:00Z')).toBe(0)
  })

  it('streakDays breaks at the most recent bad day', () => {
    const bad = [day('2026-07-04')]
    // clean Jul 5, Jul 6 → streak 2.
    expect(streakDays(bad, '2026-07-06T20:00:00Z')).toBe(2)
  })

  it('dayCells marks bad days and pre-observation days', () => {
    const cells = dayCells([day('2026-07-05')], '2026-07-06T20:00:00Z', 4, day('2026-07-04'))
    expect(cells.map((c) => c.key)).toEqual([
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
    ])
    expect(cells[0].pre).toBe(true) // Jul 3 — before observing
    expect(cells[2].bad).toBe(true) // Jul 5 — a fault
    expect(cells[3].bad).toBe(false)
  })

  it('litterFaultTimestamps picks fault codes + health errors', () => {
    const sc = [
      ev('status_change', '2026-07-06T10:00:00Z', { to: 'PD' }),
      ev('status_change', '2026-07-06T11:00:00Z', { to: 'RDY' }), // not a fault
    ]
    const hc = [ev('health_change', '2026-07-06T12:00:00Z', { to: 'error' })]
    expect(litterFaultTimestamps(sc, hc)).toHaveLength(2)
  })

  it('offlineTimestamps picks connectivity-false + health errors', () => {
    const conn = [
      ev('connectivity', '2026-07-06T10:00:00Z', { to: false }),
      ev('connectivity', '2026-07-06T11:00:00Z', { to: true }),
    ]
    const hc = [ev('health_change', '2026-07-06T12:00:00Z', { to: 'error' })]
    expect(offlineTimestamps(conn, hc)).toHaveLength(2)
  })
})

describe('mood + ambient', () => {
  it('an outage is always neutral + factual, never a sad Chutku', () => {
    const m = moodFor({
      laHourNow: 3,
      minsSinceSeen: 600,
      inBand: true,
      anyOffline: true,
      visitsToday: 0,
    })
    expect(m.mood).toBe('neutral')
  })

  it('just-visited beats the night rule', () => {
    const m = moodFor({
      laHourNow: 3,
      minsSinceSeen: 2,
      inBand: true,
      anyOffline: false,
      visitsToday: 5,
    })
    expect(m.mood).toBe('justVisited')
  })

  it('deep night with no recent visit → sleepy', () => {
    const m = moodFor({
      laHourNow: 3,
      minsSinceSeen: 200,
      inBand: true,
      anyOffline: false,
      visitsToday: 2,
    })
    expect(m.mood).toBe('sleepy')
  })

  it('sparse morning defaults to the calm "quiet so far"', () => {
    const m = moodFor({
      laHourNow: 8,
      minsSinceSeen: 300,
      inBand: true,
      anyOffline: false,
      visitsToday: 0,
    })
    expect(m.mood).toBe('quiet')
  })

  it('ambient tracks the local hour with the right celestial body', () => {
    expect(ambientForHour(3)).toEqual({ phase: 'night', celestial: 'moon' })
    expect(ambientForHour(7)).toEqual({ phase: 'dawn', celestial: 'sun' })
    expect(ambientForHour(13)).toEqual({ phase: 'day', celestial: 'sun' })
    expect(ambientForHour(19)).toEqual({ phase: 'dusk', celestial: 'sun' })
    expect(ambientForHour(23)).toEqual({ phase: 'night', celestial: 'moon' })
  })
})

describe("homeMood — Chutku's homepage mood ladder", () => {
  const NOW = new Date('2026-07-06T20:00:00Z').getTime()
  const MIN = 60_000
  const HOUR = 3_600_000
  const goodLitter = {
    online: true,
    fault: false,
    litterPct: 90,
    drawerFull: false,
  }
  const goodFeeder = { online: true, nextFeedUtc: null }
  const base = {
    now: NOW,
    litter: goodLitter,
    feeder: goodFeeder,
    lastFeedMs: NOW - 5 * HOUR,
    lastCycleMs: NOW - 2 * HOUR,
  }

  it('just ate → the happiest boy alive, with the celebration', () => {
    const m = homeMood({ ...base, lastFeedMs: NOW - 10 * MIN })
    expect(m.kind).toBe('fed')
    expect(m.pose).toBe('happy')
    expect(m.animate).toBe(true)
  })

  it('meal within ~30m → the pre-dinner starvation scam', () => {
    const m = homeMood({
      ...base,
      feeder: { online: true, nextFeedUtc: new Date(NOW + 20 * MIN).toISOString() },
    })
    expect(m.kind).toBe('scheming')
    expect(m.pose).toBe('alert')
    expect(m.title).toContain('20m')
    expect(m.animate).toBe(false)
  })

  it('just ate BEATS meal-soon (a full belly cannot beg convincingly)', () => {
    const m = homeMood({
      ...base,
      lastFeedMs: NOW - 5 * MIN,
      feeder: { online: true, nextFeedUtc: new Date(NOW + 25 * MIN).toISOString() },
    })
    expect(m.kind).toBe('fed')
  })

  it('meal >35m away is not yet scam o’clock', () => {
    const m = homeMood({
      ...base,
      feeder: { online: true, nextFeedUtc: new Date(NOW + 90 * MIN).toISOString() },
    })
    expect(m.kind).toBe('happy')
  })

  it('clean box + recent scoop + plenty of sand → royal approval', () => {
    expect(homeMood(base).kind).toBe('happy')
  })

  it('no scoop in 24h AND low sand → UNIMPRESSED, with both actions', () => {
    const m = homeMood({
      ...base,
      litter: { ...goodLitter, litterPct: 15 },
      lastCycleMs: NOW - 30 * HOUR,
    })
    expect(m.kind).toBe('litterGrump')
    expect(m.pose).toBe('grumpy')
    expect(m.title).toContain('30h')
    expect(m.sub).toMatch(/litter.*Scoop/i)
  })

  it('litter grievances OUTRANK the just-ate joy (action first)', () => {
    const m = homeMood({
      ...base,
      lastFeedMs: NOW - 5 * MIN,
      litter: { ...goodLitter, litterPct: 10 },
    })
    expect(m.kind).toBe('litterLow')
    expect(m.title).toContain('10%')
  })

  it('a full drawer earns grumpy opinions', () => {
    const m = homeMood({ ...base, litter: { ...goodLitter, drawerFull: true } })
    expect(m.kind).toBe('drawerFull')
    expect(m.pose).toBe('grumpy')
  })

  it('stale box alone → a nudge toward Scoop now', () => {
    const m = homeMood({ ...base, lastCycleMs: NOW - 26 * HOUR })
    expect(m.kind).toBe('staleBox')
    expect(m.sub).toContain('Scoop now')
  })

  it('a fault stays PLAIN and points at the card — never cute', () => {
    const m = homeMood({ ...base, litter: { ...goodLitter, fault: true } })
    expect(m.kind).toBe('fault')
    expect(m.pose).toBe('awake')
    expect(m.animate).toBe(false)
  })

  it('offline devices are reported plainly, never a sad cat', () => {
    const m = homeMood({
      ...base,
      litter: { ...goodLitter, online: false },
      feeder: { ...goodFeeder, online: false },
    })
    expect(m.kind).toBe('offline')
    expect(m.title).toContain('litter box')
    expect(m.title).toContain('feeder')
    expect(m.pose).toBe('awake')
  })

  it('unknown history never grumps — cold start lands neutral', () => {
    const m = homeMood({
      now: NOW,
      litter: { online: true, fault: false, litterPct: null, drawerFull: false },
      feeder: goodFeeder,
      lastFeedMs: null,
      lastCycleMs: null,
    })
    expect(m.kind).toBe('neutral')
  })
})

describe('dailyCounts', () => {
  it('excludes today by default', () => {
    const events = [
      ev('feed', '2026-07-05T18:00:00Z'),
      ev('feed', '2026-07-05T19:00:00Z'),
      ev('feed', '2026-07-06T18:00:00Z'), // today
    ]
    expect(dailyCounts(events, '2026-07-06T20:00:00Z')).toEqual([2])
  })
})

describe('care log — cadence statuses + reminders (owner tasks)', () => {
  // 20:00Z = 13:00 LA (PDT): daytime; PLAY/PET nudges are evening-gated.
  const NOON = new Date('2026-07-06T20:00:00Z').getTime()
  // 02:00Z next day = 19:00 LA — evening.
  const EVENING = new Date('2026-07-07T02:00:00Z').getTime()
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const care = (task: string, ts: number) =>
    ev('care', new Date(ts).toISOString(), { task })

  it('brush: due until logged today, then done', () => {
    const before = careStatuses([], NOON).find((s) => s.key === 'brush')!
    expect(before).toMatchObject({ due: true, done: false })
    const after = careStatuses([care('brush', NOON - HOUR)], NOON).find(
      (s) => s.key === 'brush',
    )!
    expect(after).toMatchObject({ due: false, done: true })
  })

  it('nails: never logged = neutral (not overdue), >30d = due', () => {
    const never = careStatuses([], NOON).find((s) => s.key === 'nails')!
    expect(never).toMatchObject({ due: false, done: false, lastMs: null })
    const recent = careStatuses([care('nails', NOON - 10 * DAY)], NOON).find(
      (s) => s.key === 'nails',
    )!
    expect(recent.done).toBe(true)
    const overdue = careStatuses([care('nails', NOON - 35 * DAY)], NOON).find(
      (s) => s.key === 'nails',
    )!
    expect(overdue).toMatchObject({ due: true, done: false })
  })

  it('play: not nagged at midday, due in the evening, done once logged', () => {
    expect(careStatuses([], NOON).find((s) => s.key === 'play')!.due).toBe(false)
    expect(careStatuses([], EVENING).find((s) => s.key === 'play')!.due).toBe(true)
    const done = careStatuses([care('play', EVENING - HOUR)], EVENING).find(
      (s) => s.key === 'play',
    )!
    expect(done.done).toBe(true)
  })

  it('pets: counts today in LA, 3+ = done, behind by late afternoon = due', () => {
    const two = [care('pet', EVENING - 5 * HOUR), care('pet', EVENING - 2 * HOUR)]
    const s = careStatuses(two, EVENING).find((x) => x.key === 'pet')!
    expect(s).toMatchObject({ countToday: 2, done: false, due: true })
    const three = careStatuses(
      [...two, care('pet', EVENING - HOUR)],
      EVENING,
    ).find((x) => x.key === 'pet')!
    expect(three).toMatchObject({ countToday: 3, done: true, due: false })
  })

  it('careReminders renders friendly lines for the due ones', () => {
    const statuses = careStatuses(
      [care('nails', EVENING - 40 * DAY), care('pet', EVENING - HOUR)],
      EVENING,
    )
    const rems = careReminders(statuses, EVENING)
    const texts = rems.map((r) => r.text).join(' | ')
    expect(texts).toContain('Brush his hair today')
    expect(texts).toContain('Nail trim — 40d since the last one')
    expect(texts).toContain('Evening playtime')
    expect(texts).toContain('Pets: 1 of 3 today')
  })

  it('deviceReminders: factual list from live device states', () => {
    const rems = deviceReminders({
      litter: { online: true, fault: false, litterPct: 18, drawerFull: true },
      feeder: { online: false, foodLow: true, blocked: false },
    })
    const texts = rems.map((r) => r.text).join(' | ')
    expect(texts).toContain('Empty the waste drawer')
    expect(texts).toContain('Top up the litter (18%)')
    expect(texts).toContain('Food machine is offline')
    expect(texts).toContain('Refill the food machine')
    expect(rems.every((r) => r.kind === 'device')).toBe(true)
  })

  it('all-good devices produce zero reminders', () => {
    expect(
      deviceReminders({
        litter: { online: true, fault: false, litterPct: 90, drawerFull: false },
        feeder: { online: true, foodLow: false, blocked: false },
      }),
    ).toHaveLength(0)
  })
})
