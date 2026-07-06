import { useEffect, useState } from 'react'
import { fmtCountdown, relTime } from '../format'
import type { DenModel, LitterState } from '../useInsights'
import { useInsights } from '../useInsights'
import type { WeightBand, WeightSummary } from '../insights'
import type { Devices } from '../types'
import GoalRing, { type RingSpec } from './GoalRing'
import PinsuAvatar from './PinsuAvatar'
import PixelCat from './PixelCat'
import Sparkline from './Sparkline'
import TickNumber from './TickNumber'

const DAY_MS = 86_400_000
// A weight trend only means something after a few weigh-ins (cold-start).
const MIN_WEIGHT_POINTS = 4

/** 🌙 The Den — insights overview (M5.7). The three MUST sections: the "Pinsu,
 *  right now" hero, the 2×2 vitals bento, and Weight Watch. Everything is
 *  cold-start-aware (the DB is only days deep) and honest about her normal. */
export default function Den({ devices }: { devices: Devices }) {
  // A gentle heartbeat so relTime / the mood / the meal countdown stay honest
  // without refetching (the hook only refetches on real device change).
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const model = useInsights(devices, nowMs)

  if (!model.hasData) {
    return (
      <section className="card den-empty">
        <h2>🌙 The Den</h2>
        <p className="muted">
          Pinsu's dashboard fills in as Cat HQ watches her day — weigh-ins,
          litter visits, meals. Connect a device on the Home tab to begin.
        </p>
      </section>
    )
  }

  return (
    <>
      <DenHero model={model} />
      <VitalsBento model={model} nowMs={nowMs} />
      <WeightWatch model={model} nowMs={nowMs} />
    </>
  )
}

// ── hero ───────────────────────────────────────────────────────────────────

function DenHero({ model }: { model: DenModel }) {
  const { weight, meals, ambient, mood, band } = model

  // Rings: meals is the always-bounded goal (inner). The visits ring (outer)
  // only appears once a 7-day baseline exists (owner Q4) — no fake target on
  // a cold DB. GoalRing draws rings[0] as the outer arc.
  const rings: RingSpec[] = []
  if (model.visitsDayTypical != null) {
    const target = Math.max(Math.round(model.visitsDayTypical), model.visitsToday, 1)
    rings.push({
      pct: model.visitsToday / target,
      color: 'var(--accent)',
      label: `Visits ${model.visitsToday} of ${target}`,
      glow: true,
    })
  }
  rings.push({
    pct: meals.pct,
    color: 'var(--ok)',
    label: `Meals ${meals.served} of ${meals.target}`,
  })

  const chip = bandChip(weight, band)
  const sentence = moodSentence(model)

  return (
    <section className="card den-hero">
      <div className={`den-scene den-amb-${ambient.phase}`} aria-hidden="true" />
      <div className={`den-celestial den-${ambient.celestial}`} aria-hidden="true" />
      <div className="den-hero-row">
        <GoalRing rings={rings} size={128} title="Pinsu's day">
          <PinsuAvatar className="den-hero-photo" />
        </GoalRing>
        <div className="den-hero-meta">
          <span className="den-name">Pinsu</span>
          <span className="den-mood">
            <PixelCat mood={mood.mood} size={15} />
            <span>{sentence}</span>
          </span>
          <span className="den-wpill">
            <b>
              {weight.current != null ? (
                <TickNumber value={weight.current} decimals={1} />
              ) : (
                '—'
              )}
              <small> lb</small>
            </b>
            <span className={chip.cls}>{chip.text}</span>
            {model.litter && <LitterChip litter={model.litter} />}
          </span>
        </div>
      </div>
      <div className="den-legend">
        {model.visitsDayTypical != null && (
          <span className="den-k">
            <span className="den-dot" style={{ background: 'var(--accent)' }} />
            Visits {model.visitsToday} / ~{Math.round(model.visitsDayTypical)}
          </span>
        )}
        {model.visitsDayTypical == null && (
          <span className="den-k">
            <span className="den-dot" style={{ background: 'var(--accent)' }} />
            {model.visitsToday} {model.visitsToday === 1 ? 'visit' : 'visits'} today
          </span>
        )}
        <span className="den-k">
          <span className="den-dot" style={{ background: 'var(--ok)' }} />
          Meals {meals.served} / {meals.target}
        </span>
      </div>
    </section>
  )
}

// ── vitals bento ─────────────────────────────────────────────────────────

function VitalsBento({ model, nowMs }: { model: DenModel; nowMs: number }) {
  const { weight, meals, band } = model
  const wSpark = weight.cleaned.slice(-14).map((s) => s.lb)

  // weight comparison, colored strictly by band membership
  let wCmp: { cls: string; text: string }
  if (weight.current == null) {
    wCmp = { cls: 'mut', text: 'awaiting first weigh-in' }
  } else if (weight.inBand) {
    wCmp = { cls: 'ok', text: 'in her normal range' }
  } else {
    const dir = weight.current < band.low ? 'below' : 'above'
    wCmp = { cls: 'warn', text: `${dir} her normal range` }
  }

  const visitTarget =
    model.visitsDayTypical != null ? Math.max(model.visitsDayTypical, 1) : null

  return (
    <section aria-label="Pinsu's vitals">
      <div className="den-seclabel den-seclabel-loose">
        Pinsu's vitals · today vs usual
      </div>
      <div className="den-bento">
        {/* Weight */}
        <div className="den-tile">
          <span className="den-tlabel">Weight</span>
          <span className="den-tval">
            {weight.current != null ? weight.current.toFixed(1) : '—'}
            <small> lb</small>
          </span>
          <span className={`den-tcmp ${wCmp.cls}`}>{wCmp.text}</span>
          {wSpark.length >= 2 ? (
            <Sparkline
              values={wSpark}
              width={96}
              height={26}
              className="den-chart"
              title={`14-visit weight trend, now ${weight.current?.toFixed(1)} lb`}
            />
          ) : (
            <span className="den-learning">still learning her normal</span>
          )}
        </div>

        {/* Visits today */}
        <div className="den-tile">
          <span className="den-tlabel">Visits today</span>
          <span className="den-tval">{model.visitsToday}</span>
          {model.usualVisits != null ? (
            <span className="den-tcmp mut">
              usually {model.usualVisits.toFixed(model.usualVisits < 10 ? 1 : 0)} by
              now
            </span>
          ) : (
            <span className="den-tcmp mut">still learning her routine</span>
          )}
          {visitTarget != null ? (
            <div className="den-minifill" title={`${model.visitsToday} of ~${Math.round(visitTarget)}`}>
              <i
                style={{
                  width: `${Math.min(100, (model.visitsToday / visitTarget) * 100)}%`,
                  background: 'var(--accent)',
                }}
              />
            </div>
          ) : (
            <div className="den-minifill den-minifill-empty" aria-hidden="true" />
          )}
        </div>

        {/* Meals */}
        <div className="den-tile">
          <span className="den-tlabel">Meals</span>
          <span className="den-tval">
            {meals.served}
            <small className="mut"> / {meals.target}</small>
          </span>
          <span className="den-tcmp mut">
            {model.nextFeedUtc
              ? `next ${fmtCountdown(model.nextFeedUtc, nowMs)}`
              : meals.served >= meals.target
                ? 'all served today'
                : 'no more scheduled'}
          </span>
          <div className="den-minifill">
            <i style={{ width: `${meals.pct * 100}%`, background: 'var(--ok)' }} />
          </div>
        </div>

        {/* Care streak */}
        <div className="den-tile">
          <span className="den-tlabel">Care streak</span>
          <span className="den-tval den-tval-sm">
            Feeder {model.feederOnlineStreak}d
            <br />
            <span className="mut den-sub">no faults {model.noFaultStreak}d</span>
          </span>
          <div className="den-streak" aria-hidden="true">
            {model.careCells.map((c) => (
              <i
                key={c.key}
                className={c.pre ? 'pre' : c.bad ? 'off' : ''}
                title={`${c.key}: ${c.bad ? 'a fault/outage' : c.pre ? 'before watching' : 'all good'}`}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

// ── weight watch ─────────────────────────────────────────────────────────

function WeightWatch({ model, nowMs }: { model: DenModel; nowMs: number }) {
  const [range, setRange] = useState<30 | 90>(30)
  const { weight, band } = model

  const cutoff = nowMs - range * DAY_MS
  const start = weight.cleaned.findIndex((s) => s.ts >= cutoff)
  const from = start >= 0 ? start : weight.cleaned.length
  const wCleaned = weight.cleaned.slice(from)
  const wSmoothed = weight.smoothed.slice(from)
  const values = wCleaned.map((s) => s.lb)
  const medianValues = wSmoothed.map((s) => s.lb)
  const enough = values.length >= MIN_WEIGHT_POINTS
  const chip = bandChip(weight, band)

  return (
    <section className="card" aria-label="Weight watch">
      <div className="den-headrow">
        <span className="den-seclabel">Weight watch</span>
        <div className="den-toggle" role="group" aria-label="Weight range">
          <button
            className={range === 30 ? 'on' : ''}
            onClick={() => setRange(30)}
            aria-pressed={range === 30}
          >
            30d
          </button>
          <button
            className={range === 90 ? 'on' : ''}
            onClick={() => setRange(90)}
            aria-pressed={range === 90}
          >
            90d
          </button>
        </div>
      </div>

      <div className="den-weight-now">
        <b>
          {weight.current != null ? (
            <TickNumber value={weight.current} decimals={1} />
          ) : (
            '—'
          )}
          <small> lb</small>
        </b>
        <span className={chip.cls}>{chip.text}</span>
      </div>

      {enough ? (
        <>
          <Sparkline
            values={values}
            medianValues={medianValues}
            band={band}
            markers
            width={300}
            height={64}
            className="den-chart"
            title={`Weight over ${range} days`}
            desc={`Currently ${weight.current?.toFixed(1)} lb, ${
              weight.inBand ? 'within' : 'outside'
            } Pinsu's normal band of ${band.low}–${band.high} lb.`}
          />
          <div className="den-chart-axis">
            <span>{range}d ago</span>
            <span className="ok">shaded = Pinsu's normal</span>
            <span>today</span>
          </div>
          {weight.concern === 'weigh-in' && (
            <p className="den-nudge" role="status">
              Her weight's trended a little low for a few days — might be worth a
              weigh-in when you get a chance. Just a heads-up, not a diagnosis.
            </p>
          )}
        </>
      ) : (
        <p className="den-cold">
          Still learning Pinsu's normal. Her weight trend appears here after a
          few weigh-ins — she steps on the built-in scale each visit. Healthy
          range set to {band.low}–{band.high} lb.
        </p>
      )}
    </section>
  )
}

// ── shared bits ──────────────────────────────────────────────────────────

/** Weight chip: reassuring green in-band, calm amber out — color ONLY signals
 *  band membership, never raw direction (docs/06 health rule 1). */
function bandChip(
  w: WeightSummary,
  band: WeightBand,
): { cls: string; text: string } {
  if (w.current == null) {
    return { cls: 'den-chip den-chip-mut', text: 'no weigh-in yet' }
  }
  if (w.inBand) {
    return { cls: 'den-chip den-chip-ok', text: 'in range' }
  }
  const dir = w.current < band.low ? '▼' : '▲'
  const pct = w.deltaPct != null ? Math.abs(w.deltaPct).toFixed(0) : '?'
  return { cls: 'den-chip den-chip-warn', text: `${dir} ${pct}% vs normal` }
}

/** One plain-language mood line, assembled at render. Outage → factual suffix,
 *  never a sad Pinsu. */
function moodSentence(model: DenModel): string {
  const { mood, lastVisitMs, anyOffline } = model
  const parts: string[] = [mood.phrase + (mood.emoji ? ` ${mood.emoji}` : '')]
  if (lastVisitMs != null) {
    parts.push(`last seen ${relTime(new Date(lastVisitMs).toISOString())}`)
  }
  if (anyOffline) parts.push('a device is offline')
  return parts.join(' · ')
}

function LitterChip({ litter }: { litter: LitterState }) {
  const cls = !litter.online
    ? 'den-chip den-chip-mut'
    : litter.cycling
      ? 'den-chip den-chip-info'
      : 'den-chip den-chip-ok'
  return <span className={cls}>{litter.text}</span>
}
