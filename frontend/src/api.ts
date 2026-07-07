import type { Devices, EventOut, HealthInfo } from './types'

const TOKEN_KEY = 'cathq_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

// App.tsx registers a handler that clears the token and returns to the
// login screen whenever any API call comes back 401.
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}
/** For non-fetch auth failures (e.g. WS connect with no stored token). */
export function fireUnauthorized(): void {
  onUnauthorized?.()
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (init?.body) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    onUnauthorized?.()
    throw new ApiError(401, 'token rejected')
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (body.detail) detail = String(body.detail)
    } catch {
      /* non-JSON error body — keep statusText */
    }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

export const api = {
  devices: () => request<{ devices: Devices }>('/devices'),

  clean: () =>
    request<{ command: string; accepted: boolean }>('/devices/litterrobot/clean', {
      method: 'POST',
    }),

  feed: (portions: number) =>
    request<{ command: string; portions: number }>('/devices/feeder/feed', {
      method: 'POST',
      body: JSON.stringify({ portions }),
    }),

  // Plug power (M5.5) — MAINS. Only ever called from hold-to-confirm
  // controls; nothing in the app automates these.
  plugOn: (plugId: string) =>
    request<{ command: string; accepted: boolean }>(`/devices/${plugId}/on`, {
      method: 'POST',
    }),
  plugOff: (plugId: string) =>
    request<{ command: string; accepted: boolean }>(`/devices/${plugId}/off`, {
      method: 'POST',
    }),
  plugCycle: (plugId: string) =>
    request<{ command: string; accepted: boolean; off_seconds: number }>(
      `/devices/${plugId}/cycle`,
      { method: 'POST' },
    ),

  // Owner care log (M5.7 follow-on): brushing, nail trims, playtime, pets.
  // Writes to the shared event log server-side (device 'care').
  careLog: (task: 'brush' | 'nails' | 'play' | 'pet' | 'water') =>
    request<EventOut>('/care', {
      method: 'POST',
      body: JSON.stringify({ task }),
    }),

  health: () => request<HealthInfo>('/health'),

  events: (params: {
    device?: string
    type?: string
    since?: string
    until?: string
    limit?: number
  }) => {
    const qs = new URLSearchParams()
    if (params.device) qs.set('device', params.device)
    if (params.type) qs.set('type', params.type)
    if (params.since) qs.set('since', params.since)
    if (params.until) qs.set('until', params.until)
    if (params.limit) qs.set('limit', String(params.limit))
    return request<{ count: number; events: EventOut[] }>(`/events?${qs}`)
  },
}

/** Login-screen probe: is this token accepted? Throws on network failure. */
export async function checkToken(token: string): Promise<boolean> {
  const res = await fetch('/devices', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) return false
  if (!res.ok) throw new ApiError(res.status, res.statusText)
  return true
}
