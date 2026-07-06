// Timestamps arrive as ISO-8601 UTC; render in the device's local timezone
// (the owner's phone is already in the household timezone).

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function fmtDay(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export function fmtDayTime(iso: string): string {
  return `${fmtDay(iso)} ${fmtTime(iso)}`
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Live countdown ("in 2h 14m") to an ISO instant; 'now' once due. */
export function fmtCountdown(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return '—'
  const ms = new Date(iso).getTime() - now
  if (Number.isNaN(ms)) return '—'
  if (ms <= 30_000) return 'now'
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 60) return `in ${totalMin}m`
  const h = Math.floor(totalMin / 60)
  if (h < 24) return `in ${h}h ${totalMin % 60}m`
  return `in ${Math.floor(h / 24)}d ${h % 24}h`
}

/** "3d 4h" / "4h 12m" / "12m" — header uptime strip. */
export function fmtUptime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// LR4 status codes seen in events (data.from/to) — the live card uses the
// backend's status_text instead. Unknown codes render as the raw code.
export const LR_STATUS: Record<string, string> = {
  RDY: 'Ready',
  CCP: 'Clean cycle in progress',
  CCC: 'Clean cycle complete',
  CST: 'Cat sensor timing',
  CSI: 'Cat sensor interrupted',
  CSF: 'Cat sensor fault',
  DF1: 'Drawer almost full',
  DF2: 'Drawer almost full',
  DFS: 'Drawer full',
  BR: 'Bonnet removed',
  P: 'Paused',
  PD: 'Pinch detected',
  OTF: 'Over-torque fault',
  EC: 'Empty cycle',
  OFF: 'Off',
  OFFLINE: 'Offline',
}

export function lrStatus(code: unknown): string {
  const key = String(code ?? '')
  return LR_STATUS[key] ?? key
}

// Real mechanical/user-intervention faults — the cloud clean command can't
// fix these; a mains power-cycle is the standard remote remedy (docs/05).
export const LR_FAULT_CODES = new Set(['CSF', 'PD', 'OTF', 'BR'])

export function isLrFault(code: unknown): boolean {
  return LR_FAULT_CODES.has(String(code ?? ''))
}

// The LR4 is cycling/settling — the status ring shows the amber sweep.
export const LR_BUSY_CODES = new Set(['CCP', 'CST', 'CSI', 'EC', 'P'])

/**
 * Scale-noise filter for the weight sparkline (docs/05 Part B item 2):
 * a sample more than `tolerance` (20%) off the trailing median of the last
 * `window` accepted samples is ignored (half-entries, litter clumps, the
 * scale firing while empty reads ~0 and is dropped by the v<=0 guard).
 */
export function filterWeights(
  values: number[],
  window = 5,
  tolerance = 0.2,
): number[] {
  const out: number[] = []
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) continue
    const recent = out.slice(-window)
    if (recent.length >= 2) {
      const sorted = [...recent].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      if (Math.abs(v - median) > tolerance * median) continue
    }
    out.push(v)
  }
  return out
}

/** Animations off for users who asked the OS for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia !== 'undefined' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
