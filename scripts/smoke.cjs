/* M5/M5.5 smoke test — READ-ONLY (never presses Feed/Clean/Power: those move
 * hardware or switch mains). Verifies: login rejects a bad token, accepts the
 * real one, dashboard v2 renders live cards over the WebSocket (status ring,
 * gauges, presence line, feed timeline), the header health strip opens, and
 * the history tab loads events. The token is read from .env, never printed.
 *
 * Needs playwright OUTSIDE frontend/ (keep it out of frontend/package.json —
 * its postinstall would bloat the Docker build): from any temp dir,
 *   npm init -y && npm i playwright && npx playwright install chromium
 * then: node /Users/kolt/Downloads/cat-hq/scripts/smoke.cjs
 * (or NODE_PATH=<that dir>/node_modules node scripts/smoke.cjs)
 * Screenshots go to $SHOT_DIR (default: os tmpdir).
 * $SMOKE_BASE overrides the target (default http://localhost:8000) — used
 * pre-deploy against the vite dev server on :5173. */
const { chromium } = require('playwright')
const fs = require('fs')
const os = require('os')

const BASE = process.env.SMOKE_BASE || 'http://localhost:8000'
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir()

const token = fs
  .readFileSync('/Users/kolt/Downloads/cat-hq/.env', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('CATHQ_AUTH_TOKEN='))
  ?.slice('CATHQ_AUTH_TOKEN='.length)
  .trim()

if (!token) {
  console.error('FAIL: CATHQ_AUTH_TOKEN not found in .env')
  process.exit(1)
}

let failures = 0
const check = (ok, name) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures++
}

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  check(await page.locator('.login-card').isVisible(), 'login screen renders')
  await page.screenshot({ path: `${SHOT_DIR}/m55-login.png` })

  // wrong token → inline error, stays on login
  await page.fill('input', 'definitely-wrong-token')
  await page.click('button[type=submit]')
  await page.waitForSelector('.error', { timeout: 5000 })
  check(
    (await page.locator('.error').textContent())?.includes('secret pass') ?? false,
    'bad token is rejected with a message',
  )

  // real token → dashboard
  await page.fill('input', token)
  await page.click('button[type=submit]')
  await page.waitForSelector('.topbar', { timeout: 10000 })
  check(true, 'login succeeds with the real token')

  // WS goes live — v2 folds the connection dot into the header avatar
  await page.waitForSelector('.avatar.conn-live', { timeout: 10000 })
  check(true, 'websocket connected (avatar ring = live)')
  const cards = page.locator('.card:not(.skeleton)')
  await page.waitForSelector('.ring', { timeout: 10000 })
  check((await cards.count()) === 3, 'mood + two device cards render')

  // Chutku's mood card (M5.7 follow-on) — read-only, top of Home
  const moodTitle = await page.locator('.mood-title').textContent()
  check(
    (moodTitle ?? '').includes('Chutku'),
    `mood card speaks ("${(moodTitle ?? '').slice(0, 60)}…")`,
  )

  // litter card v2: status ring + drawer gauge + litter tube + presence
  const ringMode = await page.locator('.ring').getAttribute('data-mode')
  check(!!ringMode && ringMode !== 'off', `status ring renders (mode=${ringMode})`)
  const statusBig = await page.locator('.status-big').first().textContent()
  check(!!statusBig && statusBig !== '—', `litter status shows ("${statusBig}")`)
  check(await page.locator('.gauge-dial').isVisible(), 'drawer radial gauge renders')
  check(await page.locator('.tube-body').isVisible(), 'litter fill tube renders')
  const presence = await page.locator('.presence-row').textContent()
  check(
    (presence ?? '').includes('Pinsu visited'),
    `presence line renders ("${(presence ?? '').trim()}")`,
  )

  // feeder card v2: 24h dot timeline + live metadata
  check(await page.locator('.timeline-track').isVisible(), 'feed timeline renders')
  const feederVisible = await page
    .locator('.card', { hasText: 'Food Bowl' })
    .locator('.meta')
    .isVisible()
  check(feederVisible, 'feeder card shows live metadata')
  const badges = await page.locator('.card .badge').allTextContents()
  check(badges.length === 2, `health badges present (${badges.join(', ')})`)
  await page.screenshot({ path: `${SHOT_DIR}/m55-dashboard.png` })

  // header health strip (tap the avatar; /health is read-only)
  await page.click('.brand')
  // wait for the fetch to land, not just the strip container
  await page.waitForFunction(
    () => document.querySelector('.health-strip')?.textContent?.includes('up '),
    { timeout: 5000 },
  )
  const strip = await page.locator('.health-strip').textContent()
  check((strip ?? '').includes('up '), `health strip shows uptime ("${(strip ?? '').slice(0, 60)}…")`)
  await page.screenshot({ path: `${SHOT_DIR}/m55-header-strip.png` })
  await page.click('.brand') // collapse again

  // history tab: rows + sticky day headers + the Power filter chip
  await page.click('.tab >> text=Diary')
  await page.waitForSelector('.event-row', { timeout: 10000 })
  const rows = await page.locator('.event-row').count()
  check(rows > 0, `history shows events (${rows} rows)`)
  check(await page.locator('.day-head').first().isVisible(), 'day headers render')
  check(
    await page.locator('.chip', { hasText: 'Power' }).isVisible(),
    'Power filter chip present',
  )
  await page.waitForTimeout(400) // let the pane-in fade settle before the shot
  await page.screenshot({ path: `${SHOT_DIR}/m55-history.png` })

  // ── The Den (M5.7) — READ-ONLY: the tab only reads /events, never a command
  await page.click('.tab >> text=Den')
  await page.waitForSelector('.den-hero', { timeout: 10000 })
  check(await page.locator('.den-hero').isVisible(), 'Den hero renders')
  const rings = await page.locator('.goalring-arc').count()
  check(rings >= 1, `hero goal ring(s) render (${rings} arc${rings === 1 ? '' : 's'})`)
  const heroName = await page.locator('.den-name').textContent()
  check(heroName === 'Pinsu', `hero names the cat ("${heroName}")`)
  check(await page.locator('.den-bento').isVisible(), 'vitals bento renders')
  const tiles = await page.locator('.den-tile').count()
  check(tiles === 4, `four vitals tiles render (${tiles})`)
  check(
    await page.locator('.den-seclabel', { hasText: 'Weight watch' }).isVisible(),
    'weight watch section renders',
  )
  // the page body must never scroll sideways (heatmap etc. scroll internally)
  const noHScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )
  check(noHScroll, 'page body does not scroll horizontally')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/m57-den.png`, fullPage: true })

  // reload with stored token skips login
  await page.reload({ waitUntil: 'networkidle' })
  check(
    await page.locator('.topbar').isVisible(),
    'token persists across reload (no re-login)',
  )

  check(pageErrors.length === 0, `no page errors (${pageErrors.join('; ') || 'clean'})`)

  await browser.close()
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('FAIL (exception):', e.message)
  process.exit(1)
})
