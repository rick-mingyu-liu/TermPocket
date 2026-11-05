// Browser side: one Chromium, one context per flow, a Proof recorder that
// writes a screenshot after every step, the console/network log, a Playwright
// trace and a report.json + report.md into <repo>/.control/proof/<stamp>-<flow>/.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKEND_URL, CONTROL, DEMO, FRONTEND_URL } from './stack.mjs'

export const PROOF_ROOT = join(CONTROL, 'proof')

const CONSOLE_NOISE = [
  /Download the React DevTools/,
  /favicon\.ico/,
  /net::ERR_ABORTED/,
  /\[Fast Refresh\]/,
  /was preloaded using link preload but not used/,
  /_vercel\/insights/, // Vercel Analytics script: only exists on Vercel, 404s locally by design
]

export function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) }

export async function launch({ headed = false, audioFile = null } = {}) {
  const { chromium } = await import('playwright')
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  if (audioFile) args.push(`--use-file-for-fake-audio-capture=${audioFile}`)
  return chromium.launch({ headless: !headed, args })
}

/** POST /auth/login as the demo account; returns { token, user }. */
export async function apiLogin(creds = DEMO) {
  const r = await fetch(`${BACKEND_URL}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) })
  if (!r.ok) throw new Error(`login failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  if (!data.token || !data.user) throw new Error(`login answered without token/user: ${JSON.stringify(Object.keys(data))}`)
  return data
}

/** Signed-in fetch against the backend. */
export async function api(method, path, body, token) {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, ok: r.ok, json, text }
}

export class Session {
  constructor(browser, { name, locale = 'en-CA', proofDir, video = false, trace = true }) {
    this.browser = browser; this.name = name; this.locale = locale
    this.proofDir = proofDir; this.video = video; this.trace = trace
    this.messages = []; this.errors = []; this.requests = []
  }

  async open() {
    mkdirSync(this.proofDir, { recursive: true })
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 }, locale: this.locale, timezoneId: 'America/Toronto',
      permissions: ['microphone'], baseURL: FRONTEND_URL,
      recordVideo: this.video ? { dir: this.proofDir, size: { width: 1280, height: 800 } } : undefined,
    })
    if (this.trace) await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(20000)
    this.page.on('console', m => {
      const url = m.location()?.url || ''
      const line = `[${m.type()}] ${m.text()}${url ? ` (${url})` : ''}`
      this.messages.push(line)
      if (m.type() === 'error' && !CONSOLE_NOISE.some(re => re.test(m.text()) || re.test(url))) this.errors.push(line)
    })
    this.page.on('pageerror', e => { const line = `[pageerror] ${e.message}`; this.messages.push(line); this.errors.push(line) })
    this.page.on('response', r => {
      const s = r.status()
      if (s >= 400) {
        const line = `[http ${s}] ${r.request().method()} ${r.url()}`
        this.requests.push(line)
        if (s >= 500) this.errors.push(line)
      }
    })
    this.page.on('requestfailed', r => {
      const f = r.failure()?.errorText || ''
      if (!/ERR_ABORTED/.test(f)) this.requests.push(`[failed] ${r.method()} ${r.url()} ${f}`)
    })
    return this.page
  }

  /** Puts the demo JWT into localStorage so the next navigation is signed in. */
  async signIn(creds = DEMO) {
    const { token, user } = await apiLogin(creds)
    this.token = token
    await this.page.goto('/login', { waitUntil: 'domcontentloaded' })
    await this.page.evaluate(({ token, user }) => {
      localStorage.setItem('token', token)
      localStorage.setItem('user', JSON.stringify(user))
      // The first-run tour is for new accounts; keep it out of proof runs.
      localStorage.setItem(`onboardingTour:${user.id}`, '1')
    }, { token, user })
    return { token, user }
  }

  async close() {
    try { if (this.trace && this.context) await this.context.tracing.stop({ path: join(this.proofDir, 'trace.zip') }) } catch { /* ignore */ }
    try { await this.context?.close() } catch { /* ignore */ }
    writeFileSync(join(this.proofDir, 'console.log'), [...this.messages, '', '--- http ---', ...this.requests].join('\n'))
  }
}

export class Proof {
  constructor(session) { this.session = session; this.steps = []; this.n = 0; this.startedAt = Date.now() }

  async step(name, fn) {
    const page = this.session.page
    const t0 = Date.now()
    this.n += 1
    const file = `${String(this.n).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
    const entry = { name, ok: true, ms: 0, shot: `${file}.png` }
    try {
      const result = await fn(page)
      if (result && typeof result === 'object' && 'note' in result) entry.note = result.note
      if (result && typeof result === 'object' && result.warn) { entry.warn = result.warn }
    } catch (e) {
      entry.ok = false
      entry.error = (e && e.message) ? e.message.split('\n')[0].slice(0, 300) : String(e)
      entry.shot = `${file}-FAILED.png`
    }
    entry.ms = Date.now() - t0
    try { await page.screenshot({ path: join(this.session.proofDir, entry.shot), fullPage: true }) } catch { entry.shot = null }
    this.steps.push(entry)
    const mark = entry.ok ? (entry.warn ? '~' : '✓') : '✗'
    process.stdout.write(`    ${mark} ${name} (${entry.ms} ms)${entry.error ? ` — ${entry.error}` : ''}${entry.warn ? ` — ${entry.warn}` : ''}\n`)
    if (!entry.ok) throw new StepFailed(entry)
    return entry
  }

  report(flow, extra = {}) {
    const ok = this.steps.every(s => s.ok) && this.session.errors.length === 0
    const report = {
      flow: flow.name, description: flow.description, ok, startedAt: new Date(this.startedAt).toISOString(),
      durationMs: Date.now() - this.startedAt, frontend: FRONTEND_URL, backend: BACKEND_URL,
      steps: this.steps, consoleErrors: this.session.errors, httpProblems: this.session.requests, ...extra,
    }
    writeFileSync(join(this.session.proofDir, 'report.json'), JSON.stringify(report, null, 2))
    const md = [`# ${flow.name} — ${ok ? 'PASSED' : 'FAILED'}`, '', flow.description, '',
      `Started ${report.startedAt}, ${report.durationMs} ms. Proof: \`${this.session.proofDir}\``, '',
      '| # | step | result | ms | screenshot |', '|---|---|---|---|---|',
      ...this.steps.map((s, i) => `| ${i + 1} | ${s.name} | ${s.ok ? (s.warn ? `warn: ${s.warn}` : 'ok') : `FAILED: ${s.error}`} | ${s.ms} | ${s.shot || ''} |`),
      '', `Console errors: ${this.session.errors.length}`, ...this.session.errors.map(e => `- ${e}`),
      '', `HTTP problems: ${this.session.requests.length}`, ...this.session.requests.slice(0, 30).map(e => `- ${e}`)]
    writeFileSync(join(this.session.proofDir, 'report.md'), md.join('\n'))
    return report
  }
}

export class StepFailed extends Error { constructor(entry) { super(entry.error); this.entry = entry } }

/** Text that looks like an untranslated i18n key (`agent.send`, `legal.x.y`). */
export function rawKeys(text) {
  const found = new Set()
  for (const m of text.matchAll(/\b(?:agent|legal|onboarding|settings|import|voice)\.[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*\b/g)) found.add(m[0])
  return [...found]
}

export function assert(cond, msg) { if (!cond) throw new Error(msg) }

export function proofDirFor(flowName) {
  const dir = join(PROOF_ROOT, `${stamp()}-${flowName}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function fixture(repo, rel) {
  const p = join(repo, rel)
  return existsSync(p) ? p : null
}
