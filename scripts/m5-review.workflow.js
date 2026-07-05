export const meta = {
  name: 'm5-adversarial-review',
  description: 'Review the M5 dashboard diff across 5 lenses, adversarially verify each finding',
  phases: [
    { title: 'Review', detail: 'five parallel lenses over the M5 diff' },
    { title: 'Verify', detail: 'one skeptic per finding, prompted to refute' },
  ],
}

const REPO = '/Users/kolt/Downloads/cat-hq'
const CONTEXT = `
Repo: ${REPO} (Cat HQ — home cat-device dashboard; FastAPI backend + new React PWA).
The M5 change is UNCOMMITTED work on top of HEAD: run \`git -C ${REPO} status --short\`
and \`git -C ${REPO} diff\` to see it; new untracked files live under frontend/ and
backend/app/auth.py. Read any file you need in full.
Key facts: single-user home app behind Tailscale later (M7); auth = one bearer token
(CATHQ_AUTH_TOKEN) enforced at router level, WS auth via Sec-WebSocket-Protocol
["cathq", token]; backend serves frontend/dist via a catch-all SPA route; the PWA is
built by stage 1 of backend/Dockerfile (context = repo root). Vendor-cloud politeness
matters: the UI must never add per-render vendor-cloud calls. Devices are REAL —
findings about accidental hardware actuation are top severity.
DO NOT run docker, npm, curl, or any state-changing command — static code review only.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'title', 'detail', 'severity'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          title: { type: 'string' },
          detail: { type: 'string', description: 'concrete failure scenario: inputs/state → wrong behavior' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'reason'],
  properties: {
    isReal: { type: 'boolean' },
    reason: { type: 'string' },
    fixHint: { type: 'string' },
  },
}

const LENSES = [
  {
    key: 'auth-security',
    prompt: `Review ONLY backend/app/auth.py, backend/app/api/ws.py, and the M5 changes in backend/app/main.py for auth/security defects: token-compare pitfalls, WS subprotocol auth bypasses (header casing, multiple headers, empty token, token equal to "cathq"), static-file path traversal in _static_response (URL-encoding, symlinks, ".." handling by Starlette before the route sees the path), routes accidentally left unauthenticated, and whether the docker-compose healthcheck (GET /health from inside the container) still works. Single-user home app: do NOT report rate-limiting, CSRF-on-JSON-API, token rotation, or HTTPS-missing (HTTPS arrives at M7 by design).`,
  },
  {
    key: 'ws-lifecycle',
    prompt: `Review ONLY frontend/src/useLive.ts and frontend/src/App.tsx for WebSocket lifecycle bugs: reconnect storms, leaked sockets/timers (incl. React 19 StrictMode double-effect), stale closures over token/state, double connections after visibilitychange, missed 'hello' vs REST snapshot races (which wins, can stale REST overwrite fresher WS data?), behavior when the token is cleared mid-session, and ping timer leaks across reconnects.`,
  },
  {
    key: 'react-correctness',
    prompt: `Review ONLY frontend/src/components/*.tsx and frontend/src/api.ts for React/TS correctness bugs: wrong/missing useEffect deps (LitterCard and FeederCard use expressions like [entry != null, statusCode]), setState after unmount, ConfirmButton timer/armed-state bugs (double-tap races, unmount during busy), HistoryView pagination (inclusive 'until' boundary, dedupe, 'exhausted' logic when many events share one timestamp, filter switch races), and api.ts error handling (401 handler reentrancy, JSON parse of empty bodies).`,
  },
  {
    key: 'pwa-platform',
    prompt: `Review ONLY frontend/vite.config.ts, frontend/index.html, frontend/src/main.tsx, and the static-serving code in backend/app/main.py for PWA/platform pitfalls: navigateFallback + denylist correctness (would /docs or /events navigation break? would a deep link precache-miss?), autoUpdate + no-cache sw.js interplay, manifest icon paths/purposes, iOS add-to-home-screen over plain HTTP (what degrades, is anything actively broken?), viewport/safe-area issues, and whether serving sw.js with Cache-Control: no-cache while /assets are immutable can strand clients on an old bundle.`,
  },
  {
    key: 'build-packaging',
    prompt: `Review ONLY backend/Dockerfile, docker-compose.yml, .dockerignore, frontend/package.json, and frontend/tsconfig.json for build/packaging defects: multi-stage copy paths, npm ci determinism, files missing from or wrongly excluded by .dockerignore (does excluding frontend/dist matter? does the build context bloat?), whether local frontend/dist or node_modules can leak into the image, tsc --noEmit not covering vite.config.ts, and anything that breaks \`docker compose up -d --build\` on a fresh ARM home box (the eventual N100/Pi target — check base-image arch support).`,
  },
]

phase('Review')
const results = await pipeline(
  LENSES,
  (l) =>
    agent(`${CONTEXT}\nYou are a meticulous ${l.key} reviewer. ${l.prompt}\nReport at most 6 findings — only defects you can state a concrete failure scenario for, not style. Return line numbers from the actual files.`, {
      label: `review:${l.key}`,
      phase: 'Review',
      schema: FINDINGS_SCHEMA,
    }),
  (review, l) =>
    review
      ? parallel(
          review.findings.map((f) => () =>
            agent(
              `${CONTEXT}\nA reviewer claims this defect in the M5 change:\n` +
                `file: ${f.file}:${f.line}\ntitle: ${f.title}\ndetail: ${f.detail}\n` +
                `Adversarially VERIFY by reading the actual code (and any code it interacts with). ` +
                `Try hard to REFUTE it: is the scenario actually reachable? Does other code already guard it? ` +
                `isReal=true ONLY if the failure scenario is concrete and reachable. If real, give a minimal fixHint.`,
              { label: `verify:${l.key}`, phase: 'Verify', schema: VERDICT_SCHEMA },
            ).then((v) => ({ ...f, lens: l.key, verdict: v })),
          ),
        )
      : [],
)

const all = results.filter(Boolean).flat().filter(Boolean)
const confirmed = all.filter((f) => f.verdict?.isReal)
const rejected = all.length - confirmed.length
log(`${all.length} raw findings, ${confirmed.length} confirmed, ${rejected} refuted`)
return {
  confirmed: confirmed.map((f) => ({
    lens: f.lens,
    severity: f.severity,
    file: f.file,
    line: f.line,
    title: f.title,
    detail: f.detail,
    reason: f.verdict.reason,
    fixHint: f.verdict.fixHint ?? null,
  })),
}
