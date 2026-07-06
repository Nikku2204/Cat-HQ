// Unit tests for pure formatting helpers (docs/04-TESTING.md Phase 3).
// All wall-clock-dependent helpers run under fake timers pinned to a fixed
// mid-day instant so Today/Yesterday can never straddle midnight, and the
// relTime boundary math is exact. fmtTime/fmtDay(older)/fmtDayTime render via
// toLocale*String, so those assertions are deliberately loose (shape, not an
// exact locale string) to stay independent of the dev box's locale/timezone.

import {
  filterWeights,
  fmtCountdown,
  fmtDay,
  fmtDayTime,
  fmtTime,
  fmtUptime,
  isLrFault,
  lrStatus,
  LR_STATUS,
  relTime,
} from './format'

// Saturday 2026-07-04 12:00 *local* time — built with the local-time Date
// constructor so the "same calendar day" comparisons in fmtDay (toDateString
// is local) hold in any timezone.
const NOW = new Date(2026, 6, 4, 12, 0, 0)

/** ISO string for `seconds` before the (faked) current instant. */
const isoAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('fmtDay', () => {
  it('renders the current calendar day as "Today" (even near its edges)', () => {
    expect(fmtDay(new Date(2026, 6, 4, 12, 0).toISOString())).toBe('Today')
    expect(fmtDay(new Date(2026, 6, 4, 0, 0, 1).toISOString())).toBe('Today')
    expect(fmtDay(new Date(2026, 6, 4, 23, 59, 59).toISOString())).toBe('Today')
  })

  it('renders the previous calendar day as "Yesterday"', () => {
    expect(fmtDay(new Date(2026, 6, 3, 23, 59, 59).toISOString())).toBe('Yesterday')
    expect(fmtDay(new Date(2026, 6, 3, 0, 0, 1).toISOString())).toBe('Yesterday')
  })

  it('renders anything older as a locale date (never Today/Yesterday)', () => {
    const older = fmtDay(new Date(2026, 6, 2, 12, 0).toISOString())
    expect(older).not.toBe('Today')
    expect(older).not.toBe('Yesterday')
    // weekday-short / month-short / numeric-day: assert the stable part —
    // the day-of-month digit — rather than a locale-exact string.
    expect(older).toMatch(/\b2\b/)
  })

  it('two days is already "older", not Yesterday (no off-by-one)', () => {
    expect(fmtDay(new Date(2026, 6, 2, 23, 59).toISOString())).not.toBe('Yesterday')
  })
})

describe('relTime', () => {
  it('returns "—" for null and undefined', () => {
    expect(relTime(null)).toBe('—')
    expect(relTime(undefined)).toBe('—')
  })

  it('returns "—" for an empty string (falsy guard)', () => {
    expect(relTime('')).toBe('—')
  })

  it('59s ago is still "just now"; 60s ago becomes "1m ago"', () => {
    expect(relTime(isoAgo(59))).toBe('just now')
    expect(relTime(isoAgo(60))).toBe('1m ago')
  })

  it('minutes cap at 59m; exactly 1h flips to hours', () => {
    expect(relTime(isoAgo(3599))).toBe('59m ago')
    expect(relTime(isoAgo(3600))).toBe('1h ago')
  })

  it('hours cap at 23h; exactly 1d flips to days', () => {
    expect(relTime(isoAgo(86399))).toBe('23h ago')
    expect(relTime(isoAgo(86400))).toBe('1d ago')
  })

  it('floors within a bucket (90s → 1m, 2.5d → 2d)', () => {
    expect(relTime(isoAgo(90))).toBe('1m ago')
    expect(relTime(isoAgo(86400 * 2.5))).toBe('2d ago')
  })

  it('clamps future timestamps to "just now" (never negative)', () => {
    expect(relTime(isoAgo(-300))).toBe('just now') // 5 minutes in the future
    expect(relTime(isoAgo(-86400 * 2))).toBe('just now') // 2 days in the future
  })
})

describe('lrStatus', () => {
  it('maps known LR4 codes to human text', () => {
    expect(lrStatus('RDY')).toBe('Ready')
    expect(lrStatus('CCP')).toBe('Clean cycle in progress')
    expect(lrStatus('CCC')).toBe('Clean cycle complete')
    expect(lrStatus('DFS')).toBe('Drawer full')
    expect(lrStatus('OFFLINE')).toBe('Offline')
  })

  it('every entry in the LR_STATUS table resolves through lrStatus', () => {
    for (const [code, text] of Object.entries(LR_STATUS)) {
      expect(lrStatus(code)).toBe(text)
    }
  })

  it('passes unknown codes through raw', () => {
    expect(lrStatus('ZZZ')).toBe('ZZZ')
    expect(lrStatus('rdy')).toBe('rdy') // lookup is case-sensitive
  })

  it('null/undefined render as an empty string', () => {
    expect(lrStatus(null)).toBe('')
    expect(lrStatus(undefined)).toBe('')
  })

  it('stringifies non-string codes (unknown input from event payloads)', () => {
    expect(lrStatus(42)).toBe('42')
    expect(lrStatus(0)).toBe('0') // 0 is not nullish → "0", not ""
  })
})

describe('fmtTime', () => {
  it('renders a local time containing the 2-digit minutes', () => {
    // 14:07 local; minute is '2-digit' so "07" appears in any locale.
    const out = fmtTime(new Date(2026, 6, 4, 14, 7).toISOString())
    expect(out).toContain('07')
    expect(out).toMatch(/\d/) // has an hour digit too
  })
})

describe('fmtDayTime', () => {
  it('is "<fmtDay> <fmtTime>" — Today-prefixed for a same-day timestamp', () => {
    const iso = new Date(2026, 6, 4, 9, 5).toISOString()
    const out = fmtDayTime(iso)
    expect(out).toMatch(/^Today /)
    expect(out).toContain('05') // the 2-digit minutes
    expect(out).toBe(`${fmtDay(iso)} ${fmtTime(iso)}`)
  })

  it('is Yesterday-prefixed for a previous-day timestamp', () => {
    expect(fmtDayTime(new Date(2026, 6, 3, 9, 5).toISOString())).toMatch(/^Yesterday /)
  })
})

// ── M5.5 UX v2 helpers ──────────────────────────────────────────────────

describe('fmtCountdown', () => {
  const at = (minutes: number) =>
    new Date(Date.now() + minutes * 60_000).toISOString()

  it('renders hours + minutes ("in 2h 14m")', () => {
    expect(fmtCountdown(at(134))).toBe('in 2h 14m')
  })

  it('renders bare minutes under an hour', () => {
    expect(fmtCountdown(at(45))).toBe('in 45m')
  })

  it('renders days past 24h', () => {
    expect(fmtCountdown(at(26 * 60))).toBe('in 1d 2h')
  })

  it('collapses to "now" once due (within 30s or past)', () => {
    expect(fmtCountdown(new Date(Date.now() + 10_000).toISOString())).toBe('now')
    expect(fmtCountdown(new Date(Date.now() - 60_000).toISOString())).toBe('now')
  })

  it('is "—" for missing or unparseable input', () => {
    expect(fmtCountdown(null)).toBe('—')
    expect(fmtCountdown(undefined)).toBe('—')
    expect(fmtCountdown('not-a-date')).toBe('—')
  })
})

describe('fmtUptime', () => {
  it('minutes / hours / days shapes', () => {
    expect(fmtUptime(59 * 60)).toBe('59m')
    expect(fmtUptime(3 * 3600 + 12 * 60)).toBe('3h 12m')
    expect(fmtUptime(26 * 3600)).toBe('1d 2h')
  })
})

describe('isLrFault', () => {
  it('flags the mechanical/user-intervention codes only', () => {
    for (const code of ['CSF', 'PD', 'OTF', 'BR']) expect(isLrFault(code)).toBe(true)
    for (const code of ['RDY', 'CCP', 'CCC', 'CST', 'DFS', '', null, undefined])
      expect(isLrFault(code)).toBe(false)
  })
})

describe('filterWeights', () => {
  it('drops samples >20% off the trailing median (scale noise)', () => {
    // 4.6 is a half-entry blip against a ~9.4 lb cat
    expect(filterWeights([9.4, 9.5, 4.6, 9.3, 9.6])).toEqual([9.4, 9.5, 9.3, 9.6])
  })

  it('drops zero / negative / non-finite samples outright', () => {
    expect(filterWeights([9.4, 0, 9.5, -1, NaN, 9.3])).toEqual([9.4, 9.5, 9.3])
  })

  it('keeps genuine gradual drift (each step within tolerance)', () => {
    const drift = [9.0, 9.2, 9.4, 9.7, 10.0, 10.3]
    expect(filterWeights(drift)).toEqual(drift)
  })

  it('passes through short series untouched (nothing to median against)', () => {
    expect(filterWeights([12, 3])).toEqual([12, 3])
  })
})
