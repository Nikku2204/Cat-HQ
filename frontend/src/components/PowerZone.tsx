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

  const cycle = (
    <HoldButton
      key="cycle"
      label="Hold to power-cycle"
      onConfirm={run(() => api.plugCycle(plugId), 'Power cycle complete ✓')}
      disabled={!reachable}
    />
  )
  const toggle = (
    <HoldButton
      key="toggle"
      className="btn hold secondary"
      label={powerOn === false ? 'Hold to switch plug ON' : 'Hold to switch plug OFF'}
      onConfirm={
        powerOn === false
          ? run(() => api.plugOn(plugId), 'Plug switched on ✓')
          : run(() => api.plugOff(plugId), 'Plug switched off ✓')
      }
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
            Switches mains power{!reachable ? ' — plug adapter not connected' : ''}.
          </p>
          {/* when the plug is off, switching it back ON is the likely intent */}
          {powerOn === false ? [toggle, cycle] : [cycle, toggle]}
          {notice && (
            <p className={notice.ok ? 'notice ok' : 'notice error'}>{notice.text}</p>
          )}
        </div>
      )}
    </div>
  )
}
