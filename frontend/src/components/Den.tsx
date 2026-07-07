import { useEffect, useRef, useState } from 'react'
import { fmtCountdown, prefersReducedMotion, relTime } from '../format'
import type { DenModel, LitterState } from '../useInsights'
import { useInsights } from '../useInsights'
import type { WeightBand, WeightSummary } from '../insights'
import type { Devices } from '../types'
import GoalRing, { type RingSpec } from './GoalRing'
import type { FilterKey } from './HistoryView'
import ChutkuAvatar from './ChutkuAvatar'
import PixelCat from './PixelCat'
import Sparkline from './Sparkline'
import TickNumber from './TickNumber'

const DAY_MS = 86_400_000
// A weight trend only means something after a few weigh-ins (cold-start).
const MIN_WEIGHT_POINTS = 4

/** 🌙 The Den — insights overview (M5.7). The three MUST sections: the "Chutku,
 *  right now" hero, the 2×2 vitals bento, and Weight Watch. Everything is
 *  cold-start-aware (the DB is only days deep) and honest about his normal.
 *  Every vitals tile taps through to its story: weight → the Weight Watch
 *  card, the rest → the Diary pre-filtered to that metric. */
export default function Den({
  devices,
  onOpenDiary,
}: {
  devices: Devices
  onOpenDiary?: (filter: FilterKey) => void
}) {
  // A gentle heartbeat so relTime / the mood / the meal countdown stay honest
  // without refetching (the hook only refetches on real device change).
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const model = useInsights(devices, nowMs)
  const weightRef = useRef<HTMLElement | null>(null)

  if (!model.hasData) {
    return (
      <section className="card den-empty">
        <h2>🌙 The Den</h2>
        <p className="muted">
          Chutku's dashboard fills in as Cat HQ watches his day — weigh-ins,
          litter visits, meals. Connect a device on the Home tab to begin.
        </p>
      </section>
    )
  }

  return (
    <>
      <DenHero model={model} />
      <VitalsBento
        model={model}
        nowMs={nowMs}
        onOpenDiary={onOpenDiary}
        onOpenWeight={() =>
          weightRef.current?.scrollIntoView({
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            block: 'start',
          })
        }
      />
      <WeightWatch model={model} nowMs={nowMs} sectionRef={weightRef} />
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
        <GoalRing rings={rings} size={128} title="Chutku's day">
          <ChutkuAvatar className="den-hero-photo" />
        </GoalRing>
        <div className="den-hero-meta">
          <span className="den-name">Chutku</span>
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

function VitalsBento({
  model,
  nowMs,
  onOpenDiary,
  onOpenWeight,
}: {
  model: DenModel
  nowMs: number
  onOpenDiary?: (filter: FilterKey) => void
  onOpenWeight: () => void
}) {
  const { weight, meals, band } = model
  const wSpark = weight.cleaned.slice(-14).map((s) => s.lb)

  // weight comparison, colored strictly by band membership
  let wCmp: { cls: string; text: string }
  if (weight.current == null) {
    wCmp = { cls: 'mut', text: 'awaiting first weigh-in' }
  } else if (weight.inBand) {
    wCmp = { cls: 'ok', text: 'in his normal range' }
  } else {
    const dir = weight.current < band.low ? 'below' : 'above'
    wCmp = { cls: 'warn', text: `${dir} his normal range` }
  }

  const visitTarget =
    model.visitsDayTypical != null ? Math.max(model.visitsDayTypical, 1) : null

  return (
    <section aria-label="Chutku's vitals">
      <div className="den-seclabel den-seclabel-loose">
        Chutku's vitals · today vs usual
      </div>
      <div className="den-bento">
        {/* Weight → the Weight Watch card below */}
        <button
          className="den-tile"
          onClick={onOpenWeight}
          aria-label="Weight — open Weight Watch"
        >
          <span className="den-go" aria-hidden="true">
            ›
          </span>
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
            <span className="den-learning">Cat HQ is still learning his normal</span>
          )}
        </button>

        {/* Visits today → Diary, litter only */}
        <button
          className="den-tile"
          onClick={() => onOpenDiary?.('litterrobot')}
          aria-label="Visits today — open the litter diary"
        >
          <span className="den-go" aria-hidden="true">
            ›
          </span>
          <span className="den-tlabel">Visits today</span>
          <span className="den-tval">{model.visitsToday}</span>
          {model.usualVisits != null ? (
            <span className="den-tcmp mut">
              usually ~{Math.round(model.usualVisits)} by now
            </span>
          ) : (
            <span className="den-tcmp mut">Cat HQ is still learning his routine</span>
          )}
          {visitTarget != null && (
            <div className="den-minifill" title={`${model.visitsToday} of ~${Math.round(visitTarget)}`}>
              <i
                style={{
                  width: `${Math.min(100, (model.visitsToday / visitTarget) * 100)}%`,
                  background: 'var(--accent)',
                }}
              />
            </div>
          )}
        </button>

        {/* Meals → Diary, food only */}
        <button
          className="den-tile"
          onClick={() => onOpenDiary?.('feeder')}
          aria-label="Meals — open the food diary"
        >
          <span className="den-go" aria-hidden="true">
            ›
          </span>
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
        </button>

        {/* Care streak → the full Diary (faults + outages live there) */}
        <button
          className="den-tile"
          onClick={() => onOpenDiary?.('all')}
          aria-label="Care streak — open the diary"
        >
          <span className="den-go" aria-hidden="true">
            ›
          </span>
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
        </button>
      </div>
    </section>
  )
}

// ── weight watch ─────────────────────────────────────────────────────────

function WeightWatch({
  model,
  nowMs,
  sectionRef,
}: {
  model: DenModel
  nowMs: number
  sectionRef?: React.RefObject<HTMLElement | null>
}) {
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
    <section className="card" aria-label="Weight watch" ref={sectionRef}>
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
            } Chutku's normal band of ${band.low}–${band.high} lb.`}
          />
          <div className="den-chart-axis">
            <span>{range}d ago</span>
            <span className="ok">shaded = Chutku's normal</span>
            <span>today</span>
          </div>
          {weight.concern === 'weigh-in' && (
            <p className="den-nudge" role="status">
              His weight's trended a little low for a few days — might be worth a
              weigh-in when you get a chance. Just a heads-up, not a diagnosis.
            </p>
          )}
        </>
      ) : (
        <p className="den-cold">
          Chutku's an old pro at all this — it's Cat HQ that's still learning
          his normal. His trend appears after a few more weigh-ins (he weighs
          in every visit). Healthy range set to {band.low}–{band.high} lb.
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
 *  never a sad Chutku. */
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
