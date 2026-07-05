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
