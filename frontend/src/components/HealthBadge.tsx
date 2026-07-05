import type { AdapterHealth } from '../types'
import { relTime } from '../format'

/** Per-device health badge — settled decision #4: fail loudly, never let
 * the UI imply fresh data when the adapter is struggling. */
export default function HealthBadge({ health }: { health?: AdapterHealth }) {
  if (!health) return null
  const title = [
    health.detail,
    health.last_success_utc
      ? `last success ${relTime(health.last_success_utc)}`
      : 'no successful call yet',
    health.consecutive_failures > 0
      ? `${health.consecutive_failures} consecutive failures`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className={`badge badge-${health.status}`} title={title}>
      <span className="dot" />
      {health.status}
    </span>
  )
}
