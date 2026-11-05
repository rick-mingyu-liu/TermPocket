#!/usr/bin/env node
// control-termpocket: run the real app, drive it, collect proof.
//
//   npm run ctl -- up [--fresh] [--build] [--dev] [--no-db]
//   npm run ctl -- down | status [--json] | logs [backend|frontend|postgres] [-n 80]
//   npm run ctl -- flows
//   npm run ctl -- drive <flow>... | all   [--headed] [--video] [--audio say|<file.wav>] [--expect <regex>]
//   npm run ctl -- shot <route> [--anon] [--zh] [--out <file.png>]
//   npm run ctl -- perf <route> [--runs 3]
//   npm run ctl -- api <METHOD> <path> [<json body>]
//   npm run ctl -- map check
//
// Everything it writes goes under <repo>/.control/ (git-ignored). It never
// reads the repo's .env files and never touches a production database.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { Proof, Session, StepFailed, api, apiLogin, launch, proofDirFor } from './lib/browser.mjs'
import { BACKEND_URL, CONTROL, FRONTEND_URL, REPO, SKILL_DIR, down, log, readState, status, tailLog, up } from './lib/stack.mjs'

const argv = process.argv.slice(2)
const cmd = argv.shift()
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--') && ['audio', 'expect', 'out', 'runs', 'n', 'locale'].includes(key)) { flags[key] = next; i++ } else flags[key] = true
  } else if (a.startsWith('-n')) { flags.n = argv[++i] } else positional.push(a)
}

function fail(msg, code = 1) { process.stderr.write(`${msg}\n`); process.exit(code) }

async function requireUp() {
  const s = await status()
  if (!s.frontend) fail(`the stack is not up (frontend not answering on ${FRONTEND_URL}); run: npm run ctl -- up`)
  return s
}

async function ensurePlaywright() {
  try { await import('playwright') } catch {
    fail(`playwright is not installed in ${SKILL_DIR}; run: npm install --prefix ${SKILL_DIR} && npx --prefix ${SKILL_DIR} playwright install chromium`)
  }
}

// --------------------------------------------------------------- audio

function spokenAudio(spec) {
  if (!spec) return null
  if (spec !== 'say') { const p = resolve(spec); if (!existsSync(p)) fail(`audio file not found: ${p}`); return p }
  const dir = join(CONTROL, 'audio'); mkdirSync(dir, { recursive: true })
  const phrase = process.env.CONTROL_AUDIO_PHRASE || 'Coffee four dollars fifty at Tim Hortons'
  const wav = join(dir, 'phrase.wav')
  // macOS `say` writes a WAVE file when asked for LEI16; Chrome's fake capture wants 16-bit PCM.
  const r = spawnSync('say', ['-o', wav, '--data-format=LEI16@48000', '--', phrase], { encoding: 'utf8' })
  if (r.status !== 0 || !existsSync(wav)) fail(`could not synthesise speech with \`say\`: ${(r.stderr || '').trim()}`)
  // Chrome loops the file; ~1 s of silence first keeps the first word off the recording start.
  return wav
}

// --------------------------------------------------------------- drive

async function drive() {
  await requireUp()
  await ensurePlaywright()
  const { findFlows } = await import('./flows/index.mjs')
  const selected = findFlows(positional)
  const state = readState()
  const hasDb = !!state?.backend
  const audioFile = spokenAudio(flags.audio)
  const env = { ...process.env }
  if (audioFile) { env.CONTROL_AUDIO_FILE = audioFile; env.CONTROL_AUDIO_EXPECT = flags.expect || (flags.audio === 'say' ? 'coffee|four|4|fifty|50' : '') }
  const browser = await launch({ headed: !!flags.headed, audioFile })
  const results = []
  try {
    for (const flow of selected) {
      if (flow.needs.includes('db') && !hasDb) {
        log(`\n▶ ${flow.name}: skipped (no database/backend in this stack)`)
        results.push({ flow: flow.name, ok: null, skipped: 'no database' })
        continue
      }
      const proofDir = proofDirFor(flow.name)
      log(`\n▶ ${flow.name} — ${flow.description}`)
      const session = new Session(browser, { name: flow.name, proofDir, video: !!flags.video, locale: flags.locale === 'zh' ? 'zh-CN' : 'en-CA' })
      const page = await session.open()
      const proof = new Proof(session)
      const ctx = { page, session, repo: REPO, env, step: (name, fn) => proof.step(name, fn) }
      try { await flow.run(ctx) } catch (e) { if (!(e instanceof StepFailed)) await proof.step('unexpected error', async () => { throw e }).catch(() => {}) }
      await session.close()
      const report = proof.report(flow)
      results.push({ flow: flow.name, ok: report.ok, steps: report.steps.length, failed: report.steps.filter(s => !s.ok).length, consoleErrors: report.consoleErrors.length, proof: proofDir, ms: report.durationMs })
      log(`  ${report.ok ? 'PASSED' : 'FAILED'} in ${report.durationMs} ms · proof: ${proofDir}`)
      if (report.consoleErrors.length) log(`  console errors (${report.consoleErrors.length}): ${report.consoleErrors[0].slice(0, 160)}`)
    }
  } finally { await browser.close() }
  const summary = { at: new Date().toISOString(), results }
  mkdirSync(join(CONTROL, 'proof'), { recursive: true })
  writeFileSync(join(CONTROL, 'proof', 'latest.json'), JSON.stringify(summary, null, 2))
  log('\nflow               result   steps  failed  console  ms')
  for (const r of results) log(`${r.flow.padEnd(18)} ${(r.ok === null ? 'skipped' : r.ok ? 'passed' : 'FAILED').padEnd(8)} ${String(r.steps ?? '').padStart(5)}  ${String(r.failed ?? '').padStart(6)}  ${String(r.consoleErrors ?? '').padStart(7)}  ${r.ms ?? ''}`)
  const bad = results.filter(r => r.ok === false)
  log(`\n${results.length - bad.length - results.filter(r => r.ok === null).length} passed, ${bad.length} failed, ${results.filter(r => r.ok === null).length} skipped · ${join(CONTROL, 'proof', 'latest.json')}`)
  process.exit(bad.length ? 1 : 0)
}

// ---------------------------------------------------------------- shot

async function shot() {
  await requireUp(); await ensurePlaywright()
  const route = positional[0] || '/'
  const browser = await launch()
  const dir = proofDirFor('shot')
  const session = new Session(browser, { name: 'shot', proofDir: dir, trace: false, locale: flags.zh ? 'zh-CN' : 'en-CA' })
  const page = await session.open()
  try {
    if (!flags.anon && readState()?.backend) await session.signIn()
    const target = flags.zh && !route.startsWith('/zh') ? `/zh${route}` : route
    const res = await page.goto(target, { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    const out = flags.out ? resolve(flags.out) : join(dir, 'shot.png')
    await page.screenshot({ path: out, fullPage: true })
    log(`${res?.status()} ${target} → ${out}`)
    if (session.errors.length) log(`console errors: ${session.errors.join(' | ').slice(0, 400)}`)
  } finally { await session.close(); await browser.close() }
}

// ---------------------------------------------------------------- perf

async function perf() {
  await requireUp(); await ensurePlaywright()
  const route = positional[0] || '/'
  const runs = Number(flags.runs || 3)
  const browser = await launch()
  const dir = proofDirFor('perf')
  const session = new Session(browser, { name: 'perf', proofDir: dir, trace: false })
  const page = await session.open()
  const samples = []
  try {
    if (readState()?.backend) await session.signIn()
    await page.addInitScript(() => {
      window.__longTasks = []
      try { new PerformanceObserver(list => { for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration)) }).observe({ type: 'longtask', buffered: true }) } catch { /* unsupported */ }
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    for (let i = 0; i < runs; i++) {
      await page.goto(route, { waitUntil: 'networkidle' })
      await page.waitForTimeout(500)
      const nav = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0]
        const lcp = performance.getEntriesByType('largest-contentful-paint').pop()
        return { ttfb: Math.round(n.responseStart), domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), lcp: lcp ? Math.round(lcp.startTime) : null, longTasks: window.__longTasks.slice(), transfer: n.transferSize }
      })
      const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
      samples.push({ ...nav, jsHeapMB: +(metrics.JSHeapUsedSize / 1048576).toFixed(1), taskDurationMs: Math.round(metrics.TaskDuration * 1000), layoutCount: metrics.LayoutCount, nodes: metrics.Nodes })
    }
  } finally { await session.close(); await browser.close() }
  const med = key => { const v = samples.map(s => s[key]).filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
  const out = { route, runs, at: new Date().toISOString(), median: { ttfb: med('ttfb'), domContentLoaded: med('domContentLoaded'), load: med('load'), lcp: med('lcp'), jsHeapMB: med('jsHeapMB'), taskDurationMs: med('taskDurationMs'), layoutCount: med('layoutCount'), nodes: med('nodes'), longTasks: samples.at(-1)?.longTasks ?? [] }, samples, consoleErrors: session.errors }
  writeFileSync(join(dir, 'perf.json'), JSON.stringify(out, null, 2))
  log(`perf ${route} (median of ${runs}): ttfb ${out.median.ttfb} ms · DCL ${out.median.domContentLoaded} ms · load ${out.median.load} ms · LCP ${out.median.lcp ?? '?'} ms · JS heap ${out.median.jsHeapMB} MB · main-thread ${out.median.taskDurationMs} ms · long tasks ${out.median.longTasks.length} (${out.median.longTasks.join(',') || 'none'}) · DOM nodes ${out.median.nodes}`)
  log(`→ ${join(dir, 'perf.json')}`)
}

// ----------------------------------------------------------------- api

async function apiCmd() {
  const s = await requireUp()
  if (!s.backend) fail('backend is not up')
  const [method, path, body] = positional
  if (!method || !path) fail('usage: api <METHOD> <path> [json]')
  const { token } = await apiLogin()
  const r = await api(method.toUpperCase(), path, body ? JSON.parse(body) : undefined, token)
  log(`HTTP ${r.status}`)
  log(r.json ? JSON.stringify(r.json, null, 2) : r.text)
  if (!r.ok) process.exit(1)
}

// ----------------------------------------------------------------- map

function routesFromPages() {
  const pagesDir = join(REPO, 'frontend', 'pages')
  const routes = []
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('_') || e.name === 'api') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p, `${prefix}/${e.name}`); continue }
      if (!/\.tsx$/.test(e.name)) continue
      const base = e.name.replace(/\.tsx$/, '')
      routes.push(base === 'index' ? (prefix || '/') : `${prefix}/${base}`)
    }
  }
  walk(pagesDir, '')
  return routes.sort()
}

function routesFromMap() {
  const text = readFileSync(join(SKILL_DIR, 'FEATURE-MAP.md'), 'utf8')
  // Every backticked route in a `### ` heading counts; a heading with `→` describes redirects, not pages.
  const routes = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('### ') || line.includes('→')) continue
    for (const m of line.matchAll(/`(\/[^`]*)`/g)) routes.push(m[1])
  }
  return routes.sort()
}

async function mapCheck() {
  const code = routesFromPages()
  const map = routesFromMap()
  const missing = code.filter(r => !map.includes(r))
  const stale = map.filter(r => !code.includes(r))
  const { flows } = await import('./flows/index.mjs')
  const covered = new Set(flows.flatMap(f => f.covers))
  const uncovered = code.filter(r => !covered.has(r))
  log(`routes in frontend/pages: ${code.length} · in FEATURE-MAP.md: ${map.length}`)
  if (missing.length) log(`MISSING from the map: ${missing.join(', ')}`)
  if (stale.length) log(`STALE in the map (no page): ${stale.join(', ')}`)
  if (uncovered.length) log(`not covered by any flow: ${uncovered.join(', ')}`)
  const mapMtime = statSync(join(SKILL_DIR, 'FEATURE-MAP.md')).mtimeMs
  let newer = []
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx$/.test(e.name) && statSync(p).mtimeMs > mapMtime) newer.push(p.replace(REPO + '/', '')) } }
  walk(join(REPO, 'frontend', 'pages'))
  if (newer.length) log(`pages edited after the map was last written (${newer.length}): ${newer.slice(0, 8).join(', ')}${newer.length > 8 ? ', …' : ''}`)
  if (!missing.length && !stale.length) log('map and pages agree')
  process.exit(missing.length || stale.length ? 1 : 0)
}

// ---------------------------------------------------------------- main

const commands = {
  async up() {
    const s = await up({ fresh: !!flags.fresh, build: !!flags.build, dev: !!flags.dev, noDb: !!flags['no-db'] })
    log(`\nfrontend ${FRONTEND_URL} · backend ${s.backend ? BACKEND_URL : 'off'} · db ${s.db.mode} · demo ${s.backend ? 'john.doe@example.com / password123' : 'n/a'}`)
  },
  async down() { down() },
  async status() {
    const s = await status()
    if (flags.json) { log(JSON.stringify(s)); return }
    log(`db ${s.db ? 'up' : 'down'} · backend ${s.backend ? `up ${BACKEND_URL}` : 'down'} · frontend ${s.frontend ? `up ${FRONTEND_URL} (${s.mode})` : 'down'}${s.since ? ` · since ${s.since}` : ''}`)
    process.exit(s.frontend ? 0 : 1)
  },
  async logs() { log(tailLog(positional[0] || 'backend', Number(flags.n || 80))) },
  async flows() {
    const { flows } = await import('./flows/index.mjs')
    for (const f of flows) log(`${f.name.padEnd(18)} ${f.description}\n${''.padEnd(18)} covers ${f.covers.join(', ')}${f.needs.length ? ` · needs ${f.needs.join(', ')}` : ''}`)
  },
  drive, shot, perf, api: apiCmd,
  async map() { if (positional[0] !== 'check') fail('usage: map check'); await mapCheck() },
  async help() { log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n')) },
}

if (!cmd || !commands[cmd]) { await commands.help(); process.exit(cmd ? 1 : 0) }
try { await commands[cmd]() } catch (e) { fail(`${cmd}: ${e.message}`) }
