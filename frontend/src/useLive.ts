import { useEffect, useRef, useState } from 'react'
import { api, fireUnauthorized, getToken } from './api'
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
 *
 * Lifecycle rules (post-review hardening, 2026-07-05):
 * - Every handler guards `sock !== ws` so a superseded socket's late events
 *   can never touch live state, and connect() detaches+closes any previous
 *   socket — no parallel connections, no cross-socket ping clearing.
 * - REST snapshots merge per device and never overwrite fresher WS state
 *   (compare state.fetched_at_utc — a stale GET landing after a push must
 *   not revert the UI and invite a duplicate hardware command).
 * - A 403'd handshake is indistinguishable from an outage in the browser
 *   (opaque close 1006), so after repeated failures we probe REST: its 401
 *   fires the global unauthorized handler and bounces to Login.
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

    const detach = (sock: WebSocket) => {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null
    }

    const mergeSnapshot = (snap: Devices) => {
      setDevices((prev) => {
        const next: Devices = { ...prev }
        for (const [id, entry] of Object.entries(snap)) {
          const cur = prev[id]
          if (
            cur?.state &&
            entry.state &&
            cur.state.fetched_at_utc > entry.state.fetched_at_utc
          ) {
            continue // REST response is staler than what WS already delivered
          }
          next[id] = entry
        }
        return next
      })
    }

    const fetchSnapshot = () => {
      // 401 → api.ts fires the global unauthorized handler → login screen
      api
        .devices()
        .then((d) => !disposed && mergeSnapshot(d.devices))
        .catch(() => {})
    }

    const connect = () => {
      if (disposed) return
      const token = getToken()
      if (!token) {
        // logged out (possibly from another tab): bounce to Login instead
        // of leaving a dead "retrying…" banner that never retries
        setConn('offline')
        fireUnauthorized()
        return
      }
      if (ws) {
        detach(ws) // late events from the superseded socket are ignored
        try {
          ws.close()
        } catch {
          /* already closing */
        }
      }
      if (pingTimer) clearInterval(pingTimer)
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      let sock: WebSocket
      try {
        sock = new WebSocket(`${proto}://${location.host}/ws`, ['cathq', token])
      } catch {
        // token contains chars illegal in a subprotocol → constructor throws
        setConn('offline')
        return
      }
      ws = sock
      setConn((prev) => (prev === 'live' ? prev : 'connecting'))

      sock.onopen = () => {
        if (sock !== ws) return
        attempts.current = 0
        setConn('live')
        pingTimer = setInterval(() => sock.send('ping'), PING_INTERVAL_MS)
      }
      sock.onmessage = (ev: MessageEvent<string>) => {
        if (sock !== ws) return
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
      sock.onclose = () => {
        if (sock !== ws) return
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = undefined
        if (disposed) return
        setConn('offline')
        if (attempts.current >= 2) fetchSnapshot() // 401 probe — see header
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
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        clearTimeout(reconnectTimer)
        attempts.current = 0
        connect()
      } else if (ws.readyState === WebSocket.CLOSING) {
        // its onclose is imminent and owns the retry — just make it prompt
        attempts.current = 0
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
      if (ws) {
        detach(ws)
        ws.close()
      }
    }
  }, [])

  return { devices, conn }
}
