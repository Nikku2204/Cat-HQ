/* M5 smoke test — READ-ONLY (never presses Feed/Clean: those move hardware).
 * Verifies: login rejects a bad token, accepts the real one, dashboard
 * renders live cards over the WebSocket, history tab loads events.
 * The token is read from .env and never printed.
 *
 * Needs playwright OUTSIDE frontend/ (keep it out of frontend/package.json —
 * its postinstall would bloat the Docker build): from any temp dir,
 *   npm init -y && npm i playwright && npx playwright install chromium
 * then: node /Users/kolt/Downloads/cat-hq/scripts/smoke.cjs
 * Screenshots go to $SHOT_DIR (default: os tmpdir). */
const { chromium } = require('playwright')
const fs = require('fs')
const os = require('os')

const BASE = 'http://localhost:8000'
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
  await page.screenshot({ path: `${SHOT_DIR}/m5-login.png` })

  // wrong token → inline error, stays on login
  await page.fill('input', 'definitely-wrong-token')
  await page.click('button[type=submit]')
  await page.waitForSelector('.error', { timeout: 5000 })
  check(
    (await page.locator('.error').textContent())?.includes('rejected') ?? false,
    'bad token is rejected with a message',
  )

  // real token → dashboard
  await page.fill('input', token)
  await page.click('button[type=submit]')
  await page.waitForSelector('.topbar', { timeout: 10000 })
  check(true, 'login succeeds with the real token')

  // WS goes live and cards carry real state
  await page.waitForSelector('.conn-live', { timeout: 10000 })
  check(true, 'websocket connected (conn pill = live)')
  const cards = page.locator('.card')
  check((await cards.count()) === 2, 'two device cards render')
  const litterStatus = await page.locator('.status-big').first().textContent()
  check(!!litterStatus && litterStatus !== '—', `litter status shows ("${litterStatus}")`)
  const feederVisible = await page
    .locator('.card', { hasText: 'Feeder' })
    .locator('.meta')
    .isVisible()
  check(feederVisible, 'feeder card shows live metadata')
  const badges = await page.locator('.badge').allTextContents()
  check(badges.length === 2, `health badges present (${badges.join(', ')})`)
  await page.screenshot({ path: `${SHOT_DIR}/m5-dashboard.png` })

  // history tab
  await page.click('.tab >> text=History')
  await page.waitForSelector('.event-row', { timeout: 10000 })
  const rows = await page.locator('.event-row').count()
  check(rows > 0, `history shows events (${rows} rows)`)
  await page.screenshot({ path: `${SHOT_DIR}/m5-history.png` })

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
