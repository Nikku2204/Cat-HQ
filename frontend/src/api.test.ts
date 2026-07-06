// Unit tests for the fetch wrapper (docs/04-TESTING.md Phase 3, api.test.ts).
// No network: global fetch is stubbed per test.
//
// localStorage note: under vitest 4 + Node 26, `window === globalThis` and
// Node's EXPERIMENTAL `localStorage` global (undefined unless the process
// runs with --localstorage-file) shadows jsdom's implementation — bare
// `localStorage` is undefined at test time even in the jsdom environment.
// api.ts would crash on it, so each test stubs a minimal in-memory Storage.
import type { Mock } from 'vitest'
import {
  api,
  ApiError,
  checkToken,
  clearToken,
  fireUnauthorized,
  getToken,
  saveToken,
  setUnauthorizedHandler,
} from './api'

const jsonRes = (body: unknown, status = 200, statusText = ''): Response =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  })

function makeStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  }
}

let fetchMock: Mock<typeof fetch>

/** Path + init of the nth fetch call, headers as the plain record request() builds. */
function fetchCall(n = 0) {
  const call = fetchMock.mock.calls[n] as [string, RequestInit | undefined]
  return {
    path: call[0],
    init: call[1],
    headers: (call[1]?.headers ?? {}) as Record<string, string>,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorageStub()) // fresh + empty per test
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  // The unauthorized handler is module-level state that persists between
  // tests — neutralize it here so a mock registered by one test can never
  // fire in another. Tests that assert on it re-register their own.
  setUnauthorizedHandler(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('token storage', () => {
  it('saveToken / getToken / clearToken round-trip through localStorage', () => {
    expect(getToken()).toBeNull()
    saveToken('sekrit')
    expect(getToken()).toBe('sekrit')
    expect(localStorage.getItem('cathq_token')).toBe('sekrit')
    clearToken()
    expect(getToken()).toBeNull()
  })
})

describe('Authorization header', () => {
  it('attaches Bearer header when a token is stored and returns parsed JSON', async () => {
    saveToken('sekrit')
    fetchMock.mockResolvedValue(jsonRes({ devices: {} }))

    const result = await api.devices()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { path, headers } = fetchCall()
    expect(path).toBe('/devices')
    expect(headers.Authorization).toBe('Bearer sekrit')
    expect(result).toEqual({ devices: {} })
  })

  it('omits the Authorization header when no token is stored', async () => {
    fetchMock.mockResolvedValue(jsonRes({ devices: {} }))

    await api.devices()

    expect(fetchCall().headers).not.toHaveProperty('Authorization')
  })
})

describe('401 handling', () => {
  it('fires the unauthorized handler exactly once and throws ApiError(401)', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))

    const err = await api.devices().catch((e: unknown) => e)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
    expect((err as ApiError).message).toBe('token rejected')
  })
})

describe('error detail extraction', () => {
  it('uses {detail} from a JSON error body as the message', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({ detail: 'litterrobot adapter is not connected' }, 503, 'Service Unavailable'),
    )

    const err = await api.devices().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(503)
    expect((err as ApiError).message).toBe('litterrobot adapter is not connected')
  })

  it('falls back to statusText when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>nope</html>', { status: 500, statusText: 'Internal Server Error' }),
    )

    const err = await api.devices().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    expect((err as ApiError).message).toBe('Internal Server Error')
  })
})

describe('events() query building', () => {
  beforeEach(() => {
    // Fresh Response per call — a Response body is single-use.
    fetchMock.mockImplementation(() => Promise.resolve(jsonRes({ count: 0, events: [] })))
  })

  it('includes device, type, until and limit when all are set, with until URL-encoded', async () => {
    await api.events({
      device: 'litterrobot',
      type: 'clean_cycle',
      until: '2026-07-05T10:00:00+00:00',
      limit: 50,
    })

    expect(fetchCall().path).toBe(
      '/events?device=litterrobot&type=clean_cycle&until=2026-07-05T10%3A00%3A00%2B00%3A00&limit=50',
    )
  })

  it('omits every param when the object is empty', async () => {
    await api.events({})
    expect(fetchCall().path).toBe('/events?')
  })

  it('includes only the params that are set', async () => {
    await api.events({ device: 'feeder' })
    expect(fetchCall(0).path).toBe('/events?device=feeder')

    await api.events({ type: 'feed', limit: 10 })
    expect(fetchCall(1).path).toBe('/events?type=feed&limit=10')
  })

  it('treats limit: 0 as unset (falsy guard — documented actual behavior)', async () => {
    // The app never asks for limit 0; the truthiness guard dropping it is
    // defensible, so we pin the actual behavior rather than call it a bug.
    await api.events({ limit: 0 })
    expect(fetchCall().path).toBe('/events?')
  })
})

describe('checkToken', () => {
  it('returns true on 200 and probes with the token argument, not the stored token', async () => {
    saveToken('stored-token')
    fetchMock.mockResolvedValue(jsonRes({ devices: {} }))

    await expect(checkToken('probe-token')).resolves.toBe(true)
    expect(fetchCall().path).toBe('/devices')
    expect(fetchCall().headers.Authorization).toBe('Bearer probe-token')
  })

  it('returns false on 401 without firing the unauthorized handler', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))

    await expect(checkToken('bad-token')).resolves.toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('throws ApiError with status and statusText on 500', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    )

    const err = await checkToken('any').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    expect((err as ApiError).message).toBe('Internal Server Error')
  })
})

describe('fireUnauthorized', () => {
  it('invokes the registered handler (WS no-token path)', () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    fireUnauthorized()

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('Content-Type header', () => {
  it('sets application/json on api.feed (POST with body)', async () => {
    fetchMock.mockResolvedValue(jsonRes({ command: 'feed', portions: 2 }))

    await api.feed(2)

    const { path, init, headers } = fetchCall()
    expect(path).toBe('/devices/feeder/feed')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ portions: 2 }))
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('does not set Content-Type on GETs', async () => {
    fetchMock.mockResolvedValue(jsonRes({ devices: {} }))

    await api.devices()

    expect(fetchCall().headers).not.toHaveProperty('Content-Type')
  })

  it('does not set Content-Type on api.clean (POST without body)', async () => {
    fetchMock.mockResolvedValue(jsonRes({ command: 'clean', accepted: true }))

    await api.clean()

    const { path, init, headers } = fetchCall()
    expect(path).toBe('/devices/litterrobot/clean')
    expect(init?.method).toBe('POST')
    expect(headers).not.toHaveProperty('Content-Type')
  })
})
