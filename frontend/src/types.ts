// Shapes mirror the backend exactly:
// - health/state envelope: backend/app/api/devices.py + ws.py
// - litter attributes:     backend/app/adapters/litterrobot.py get_state()
// - feeder attributes:     backend/app/adapters/petlibro/adapter.py _poll_once()
// - events:                backend/app/models.py EventOut

export type HealthStatus = 'ok' | 'degraded' | 'error' | 'unconfigured'

export interface AdapterHealth {
  status: HealthStatus
  detail: string
  last_success_utc: string | null
  consecutive_failures: number
}

export interface DeviceState {
  device_id: string
  device_type: string
  fetched_at_utc: string
  attributes: Record<string, unknown>
}

export interface DeviceEntry {
  health: AdapterHealth
  state: DeviceState | null // null while disconnected — never silently stale
}

export type Devices = Record<string, DeviceEntry>

export type WsMessage =
  | { kind: 'hello'; devices: Devices }
  | { kind: 'state'; device_id: string; health: AdapterHealth; state: DeviceState | null }

export interface EventOut {
  id: number
  device_id: string
  event_type: string
  ts_utc: string
  source: string
  data: Record<string, unknown>
}

export interface LitterAttrs {
  name?: string
  serial?: string
  model?: string
  is_online?: boolean
  is_on?: boolean
  power_type?: string
  status_code?: string | null
  status_text?: string | null
  is_sleeping?: boolean
  sleep_mode_enabled?: boolean
  waste_drawer_level_pct?: number
  is_waste_drawer_full?: boolean
  litter_level_pct?: number
  litter_level_state?: string | null
  cycle_count?: number
  cycle_capacity?: number
  scoops_saved_count?: number
  night_light_mode?: string | null
  panel_lock_enabled?: boolean
  pet_weight_lbs?: number
  last_seen_utc?: string | null
  firmware?: string
}

// plug attributes: backend/app/adapters/govee/adapter.py _poll_once()
export interface PlugAttrs {
  name?: string
  model?: string
  govee_device_id?: string
  bound_to?: string
  online?: boolean
  power_on?: boolean
}

// GET /health (unauthenticated) — header uptime/health strip
export interface HealthInfo {
  status: string
  app: string
  version: string
  build: string
  uptime_seconds: number
  server_time_utc: string
  timezone: string
  cats: string[]
  configured: Record<string, boolean>
  adapters: Record<string, AdapterHealth>
}

export interface FeederAttrs {
  name?: string
  serial?: string
  model?: string
  online?: boolean
  running_state?: string
  food_low?: boolean
  dispenser_blocked?: boolean
  battery_state?: string
  battery_pct?: number | null
  wifi_rssi?: number
  feeding_plan_enabled?: boolean
  today_portions?: number
  today_feed_count?: number
  today_portion_list?: number[]
  today_all_skipped?: boolean
  next_feed_time_utc?: string | null
  next_feed_portions?: number | null
  firmware?: string
}
