# Cat HQ — Testing Spec

Written 2026-07-05 (end of M5). This is the executable plan for a dedicated
test-writing session. Read `docs/00`–`03` first as usual; this file defines
WHAT to test, the tooling, and the hard rules. Work through the phases in
order — each phase leaves the repo green.

## Hard rules (non-negotiable)

1. **Tests never touch vendor clouds.** Mock at the client boundary:
   `PetlibroClient` methods and pylitterbot `Account`/`Robot` objects. If a
   test needs the network, it's wrong. (Vendor politeness rules in
   `CLAUDE.md` apply to test runs too — a test loop hammering Whisker would
   be a disaster.)
2. **Tests never move hardware.** No test may call the real
   `POST /devices/litterrobot/clean` or `/devices/feeder/feed` against the
   running container. We learned this the hard way (see memory
   `no-side-effect-probes`, 2026-07-05): even an "expect 401" probe fired a
   real clean cycle when the wrong image was live. The existing E2E scripts
   (`scripts/verify_m5.sh`, `scripts/smoke.cjs`) stay read-only; unit tests
   exercise command paths only against in-process apps with mocked adapters.
3. **Test deps stay out of the runtime image.** Backend: `[project.optional-
   dependencies] test` extra in `pyproject.toml` — the Dockerfile's explicit
   pip list is untouched. Frontend: vitest & friends are devDependencies
   (npm ci in the image already installs devDeps for the vite build; accept
   the modest build-time cost, or split a `--omit=dev` stage later if it
   annoys).
4. **A milestone's tests are part of the milestone.** From M6 on, new code
   lands with its tests; this spec back-fills M0–M5.

## Tooling decisions (settled — don't re-litigate)

| Layer | Framework | Why |
|---|---|---|
| Backend | pytest + pytest-asyncio + httpx (ASGITransport) + aiosqlite :memory: | FastAPI-native, no server process needed |
| Frontend units | vitest + @testing-library/react + jsdom | Vite-native, same transform pipeline |
| E2E | existing `scripts/verify_m5.sh` + `scripts/smoke.cjs` (Playwright) | already written; run manually against the container |

Layout:

```
backend/tests/conftest.py        # app factory w/ FakeAdapter(s), in-mem DB
backend/tests/test_auth.py
backend/tests/test_api_devices.py
backend/tests/test_api_events.py
backend/tests/test_ws.py
backend/tests/test_static_spa.py
backend/tests/test_recorder.py
backend/tests/test_litterrobot_adapter.py
backend/tests/test_petlibro_adapter.py
frontend/src/**/*.test.ts(x)     # colocated next to the module under test
```

Commands (add to README once green):
- backend: `cd backend && pip install -e '.[test]' && pytest`
- frontend: `cd frontend && npm test` (script: `vitest run`)

## Phase 1 — backend API surface (highest value first)

**conftest**: build the FastAPI app with `app.state.adapters` injected as
fakes (bypass lifespan, or run lifespan with no creds so no adapter starts
and inject fakes after). `FakeAdapter` implements `get_state/execute/health/
connected` with scriptable returns/raises. Settings override:
`CATHQ_AUTH_TOKEN=test-token`, `DATABASE_PATH=:memory:`-backed engine.

- **test_auth.py**
  - /devices, /events: 401 with no header, wrong scheme ("Basic x"), wrong
    token, empty Bearer; 200 with the right token; WWW-Authenticate header
    present on 401.
  - /health and / : 200 with NO token (healthcheck + PWA shell contract).
  - `ws_authenticated()` unit tests with fabricated headers: valid token in
    subprotocol list (any position, with/without spaces), Authorization
    header path (case-insensitive scheme), token == "cathq" is NOT accepted,
    empty header, multiple bogus offers.
- **test_api_devices.py**
  - GET /devices: shape {devices:{id:{health,state}}}; state null when
    adapter disconnected (fail-loud contract).
  - GET /devices/litterrobot: 404 when adapter absent; 200 with state:null +
    full health payload when present but disconnected (fail-loud: the UI
    renders the badge from it — the 503-with-health-detail contract lives on
    the command/history paths); 200 with state when connected.
  - POST /devices/litterrobot/clean: 502 when adapter raises each member of
    CLOUD_ERRORS (parametrize — incl. KeyError, BotoCoreError); 502 when
    accepted=False; 200 pass-through of result. Same matrix for feeder feed
    incl. PetlibroSessionError → 503 and portions bounds (0, 49 → 422 via
    pydantic; 1 and 48 OK).
- **test_api_events.py** (real in-memory DB, seeded rows)
  - device/type/since/until/limit filters; unknown device → 422; ordering
    newest-first; `until` inclusivity documented by a test (the frontend
    pagination relies on it).
- **test_ws.py** (httpx doesn't do WS; use starlette TestClient)
  - handshake rejected without token (connect raises / HTTP 403).
  - hello message first, correct snapshot shape, subprotocol "cathq" echoed.
  - hub broadcast: publish via `app.state.hub` → both of two connected
    clients receive it (this is the automated stand-in for the M4 two-client
    acceptance).
- **test_static_spa.py** (point STATIC_DIR at a tmp_path fixture tree)
  - / serves index.html when present, JSON hint when absent; /assets/x.js
    immutable cache header; index/sw.js no-cache; deep SPA route falls back
    to index.html; API routes still win over the catch-all; path traversal
    attempts (%2e%2e, ../, absolute) never serve anything outside STATIC_DIR
    and never 500 — 404 guaranteed for file-looking paths; extensionless
    traversals are contained and fall through to the SPA shell by design.

## Phase 2 — pure logic units (fast, no I/O)

- **test_petlibro_adapter.py**
  - `_compute_next_feed`: plan later today; plan tomorrow (weekday roll);
    repeatDay as stringified list "[1,3,5]"; empty "[]" → all days; disabled
    plan skipped; unparseable executionTime skipped (colon-less values fail
    the pre-check silently, colon-containing garbage logs a warning; returns
    None, never raises); plan timezone ≠ owner tz; DST boundary date.
  - `get_feed_log` flattening: day-buckets → flat list, non-GRAIN_OUTPUT_
    SUCCESS filtered, missing recordTime → emitted with timestamp_utc None
    (the adapter stays a dumb flattener; the RECORDER is what drops
    timestamp-less rows), `limit` enforced on the flattened list (vendor
    `size` is per-bucket — regression-protect that comment).
  - health state machine: OK → DEGRADED after 1 failure → ERROR after 5;
    device offline while cloud OK → DEGRADED with the specific detail;
    `_note_cloud_success` does NOT reset failure counters (feed during a
    poll outage must not fake freshness).
- **test_litterrobot_adapter.py**
  - `_is_credential_failure`: NotAuthorizedException ClientError → True;
    TooManyRequestsException → False; LitterRobotLoginException chaining a
    throttle ClientError → False; chaining NotAuthorized → True; bare
    LoginException → True; KeyError with/without Cognito context.
  - `_handle_poll_error` backoff arithmetic: transient doubling capped at
    600s; login failures escalate 600s→30min cap (base = the 5-min M4
    reconcile interval, POLL_INTERVAL_S); ERROR badge only at ≥2 login
    strikes; unexpected error → teardown + 600s.
  - get_state attribute mapping from a stub Robot (enums → .value, None
    litter_level_state, last_seen None).
- **test_recorder.py** (in-memory DB + FakeAdapter)
  - state diff → one event per TRACKED_FIELD change, correct from/to;
    no events on identical sample; snapshot upsert (1 row per device).
  - baseline seeding: restart with existing DeviceStateRow → change across
    downtime produces an event, unchanged does not.
  - history ingest idempotency: same rows twice → no duplicates (dedupe_key
    UNIQUE + do_nothing); feeder rows with falsy timestamps skipped row-by-
    row; a MALFORMED timestamp aborts only that adapter's batch for the
    cycle (known gap: while the bad row sits in the fetch window it shadows
    newer rows — per-row try/except fix queued for a feature session); one
    adapter failing doesn't block the other.
  - health_change events on status transitions.

## Phase 3 — frontend units

- **format.test.ts**: fmtDay Today/Yesterday/older; relTime boundaries
  (59s/60s/1h/1d); lrStatus known + unknown code passthrough.
- **api.test.ts** (mock global fetch): Authorization header attached; 401 →
  unauthorized handler fired exactly once and ApiError thrown; non-JSON
  error body → statusText; detail extraction from {detail}; events() query
  string building (until/type/device/limit).
- **useLive.test.tsx** (mock WebSocket class): hello replaces store; state
  merges per device; reconnect scheduled with growing backoff on close;
  ping interval started on open and cleared on close; StrictMode double-
  mount leaves exactly one live socket; visibilitychange → immediate
  reconnect + REST refetch; cleanup closes socket and timers.
- **ConfirmButton.test.tsx**: idle→armed→busy→idle; armed auto-resets after
  5s; unmount while armed doesn't leak the timer (fake timers); onConfirm
  rejection still returns to idle.
- **HistoryView.test.tsx** (mock api.events): renders rows; filter switch
  refetches and resets list; load-older passes until=oldest and dedupes the
  inclusive boundary row; exhausted hides the button; day headers grouped
  once per day.
- **LitterCard / FeederCard.test.tsx**: not-configured placeholder (no
  entry); "No data — <detail>" when state null; warning banners (food_low,
  dispenser_blocked, offline) each render from attrs; clean/feed happy path
  calls api and shows the ✓ notice; failure shows the error notice; buttons
  disabled when offline/blocked/CCP.

## Phase 4 — wiring & docs

- `pyproject.toml`: `[project.optional-dependencies] test = ["pytest", "pytest-asyncio", "httpx"]`
  plus `[tool.pytest.ini_options] asyncio_mode = "auto"`.
- `frontend/package.json`: `"test": "vitest run"`, devDeps vitest,
  @testing-library/react, @testing-library/user-event, jsdom.
- README: a Testing section with both commands + the two E2E scripts.
- docs/03: add a line to M9's checklist: "backend+frontend test suites green
  in one command each" (testing debt formally parks under Hardening).

## Explicitly out of scope

- No live-cloud integration tests, no contract tests against Whisker/
  Petlibro (unofficial APIs — the health badges + M9 soak are the contract).
- No visual-regression suite; `scripts/smoke.cjs` screenshots are enough.
- No CI pipeline yet — decide at M9 when the home box exists (a GH Action
  can run both unit suites; E2E stays manual on the LAN).
