import { useEffect, useRef, useState } from 'react'
import { api, getToken } from './api'
import type { Devices, WsMessage } from './types'

export type ConnStatus = 'connecting' | 'live' | 'offline'

const PING_INTERVAL_MS = 25_000 // server ignores content; keeps NATs/iOS awake
const MAX_BACKOFF_MS = 30_000

/**
 * Live device store: one REST snapshot for a fast first paint, then the
 * /ws feed (hello snapshot + per-refresh broadcasts) keeps it fresh.
 * Reconnects with expo backoff + jitter; reconnects/refetches immediately
 * when the tab becomes visible again (iOS suspends sockets in background).
 *
 * Auth: the browser WebSocket API cannot set headers, so the token rides in
 * the subprotocol list ["cathq", token] — see backend/app/auth.py.
 */
export function useLive(): { devices: Devices; conn: ConnStatus } {
  const [devices, setDevices] = useState<Devices>({})
  const [conn, setConn] = useState<ConnStatus>('connecting')
  const attempts = useRef(0)

  useEffect(() => {
    let disposed = false
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let pingTimer: ReturnType<typeof setInterval> | undefined

    const fetchSnapshot = () => {
      // 401 → api.ts fires the global unauthorized handler → login screen
      api
        .devices()
        .then((d) => !disposed && setDevices(d.devices))
        .catch(() => {})
    }

    const connect = () => {
      if (disposed) return
      const token = getToken()
      if (!token) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      try {
        ws = new WebSocket(`${proto}://${location.host}/ws`, ['cathq', token])
      } catch {
        // token contains chars illegal in a subprotocol → constructor throws
        setConn('offline')
        return
      }
      setConn((prev) => (prev === 'live' ? prev : 'connecting'))

      ws.onopen = () => {
        attempts.current = 0
        setConn('live')
        pingTimer = setInterval(() => ws?.send('ping'), PING_INTERVAL_MS)
      }
      ws.onmessage = (ev: MessageEvent<string>) => {
        let msg: WsMessage
        try {
          msg = JSON.parse(ev.data) as WsMessage
        } catch {
          return
        }
        if (msg.kind === 'hello') {
          setDevices(msg.devices)
        } else if (msg.kind === 'state') {
          setDevices((prev) => ({
            ...prev,
            [msg.device_id]: { health: msg.health, state: msg.state },
          }))
        }
      }
      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = undefined
        if (disposed) return
        setConn('offline')
        const backoff =
          Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts.current) *
          (0.8 + Math.random() * 0.4)
        attempts.current += 1
        reconnectTimer = setTimeout(connect, backoff)
      }
      // onerror always precedes onclose; onclose owns the retry
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible' || disposed) return
      fetchSnapshot() // bridge whatever was missed while backgrounded
      if (ws && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        clearTimeout(reconnectTimer)
        attempts.current = 0
        connect()
      }
    }

    fetchSnapshot()
    connect()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisible)
      clearTimeout(reconnectTimer)
      if (pingTimer) clearInterval(pingTimer)
      ws?.close()
    }
  }, [])

  return { devices, conn }
}
