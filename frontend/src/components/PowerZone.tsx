import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DeviceEntry, PlugAttrs } from '../types'
import HoldButton from './HoldButton'

/**
 * The RED ZONE (docs/05 safety rule 4): mains power controls for a bound
 * Govee plug. Lives at the very bottom of a device card, visually separated
 * and never adjacent to Clean/Feed. Collapsed by default; auto-expands when
 * the card shows a fault (that's when a power-cycle is the remedy).
 * Renders nothing when no plug is bound — power UI must not exist for
 * unbound sockets.
 */
export default function PowerZone({
  plugId,
  plug,
  autoExpand = false,
  hint,
}: {
  plugId: string
  plug?: DeviceEntry
  autoExpand?: boolean
  hint?: string
}) {
  const [open, setOpen] = useState(autoExpand)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)
  useEffect(() => {
    if (autoExpand) setOpen(true)
  }, [autoExpand])

  if (!plug) return null

  const attrs = plug.state?.attributes as PlugAttrs | undefined
  const reachable = attrs != null
  const powerOn = attrs?.power_on
  const stateLabel = !reachable
    ? 'unreachable'
    : `${powerOn ? 'on' : 'OFF'}${attrs.online === false ? ' · offline' : ''}`

  const run = (fn: () => Promise<unknown>, okText: string) => async () => {
    setNotice(null)
    try {
      await fn()
      setNotice({ text: okText, ok: true })
    } catch (err) {
      setNotice({ text: `Failed: ${(err as Error).message}`, ok: false })
    }
  }

  // ONE context-aware action, not two: when the plug is ON, the useful thing
  // is a RESTART (off → wait → on — the recovery remedy, ends ON; "restart"
  // is the plain-English name for a power-cycle). When it's OFF, the useful
  // thing is to switch it back ON. A standalone "switch OFF" is deliberately
  // omitted (you rarely want to kill the appliance's mains and leave it dead;
  // restart covers the reset). Still available via the API (plugOff).
  const action =
    powerOn === false ? (
      <HoldButton
        label="Hold to switch plug ON"
        onConfirm={run(() => api.plugOn(plugId), 'Plug switched on ✓')}
        disabled={!reachable}
      />
    ) : (
      <HoldButton
        label="Hold to restart"
        onConfirm={run(() => api.plugCycle(plugId), 'Restart complete ✓')}
        disabled={!reachable}
      />
    )

  return (
    <div className={open ? 'power-zone open' : 'power-zone'}>
      <button
        type="button"
        className="power-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="power-title">⚡ Power</span>
        <span className={powerOn === false ? 'power-state off' : 'power-state'}>
          plug {stateLabel}
        </span>
        <span className="power-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {hint && <p className="power-hint">{hint}</p>}
      {open && (
        <div className="power-actions">
          <p className="power-warning">
            {powerOn === false
              ? 'Restores mains power to the appliance'
              : 'Restarts the appliance (off, wait, back on)'}
            {!reachable ? ' — plug adapter not connected' : ''}.
          </p>
          {action}
          {notice && (
            <p className={notice.ok ? 'notice ok' : 'notice error'}>{notice.text}</p>
          )}
        </div>
      )}
    </div>
  )
}
