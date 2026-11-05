// The local stack: a throwaway PostgreSQL, the backend on 3001 and the frontend
// on 3000, started as detached processes so `ctl up` can return and `ctl down`
// can stop exactly what it started. State lives in <repo>/.control/.
//
// Nothing here reads the repo's .env files: the backend gets an explicit
// environment with a random JWT secret, local URLs and generous rate limits.
// Production credentials never belong in this file or in .control/.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const SKILL_DIR = resolve(new URL('..', import.meta.url).pathname)
export const REPO = resolve(SKILL_DIR, '..', '..', '..')
export const CONTROL = join(REPO, '.control')
export const LOGS = join(CONTROL, 'logs')
export const STATE_FILE = join(CONTROL, 'state.json')

export const DB_PORT = Number(process.env.CONTROL_DB_PORT || 55432)
export const BACKEND_PORT = Number(process.env.CONTROL_BACKEND_PORT || 3001)
export const FRONTEND_PORT = Number(process.env.CONTROL_FRONTEND_PORT || 3000)
export const DB_URL = process.env.CONTROL_DATABASE_URL || `postgresql://postgres@127.0.0.1:${DB_PORT}/termpocket_test`
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`
export const DEMO = { email: 'john.doe@example.com', password: 'password123' }

const PG_BIN_CANDIDATES = ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/opt/postgresql@15/bin', '/usr/local/opt/postgresql@17/bin']

export function log(msg) { process.stdout.write(`${msg}\n`) }

export function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}
export function writeState(state) {
  mkdirSync(CONTROL, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: opts.quiet ? 'pipe' : ['ignore', 'pipe', 'pipe'], ...opts })
  if (r.error) throw r.error
  return r
}

function sh(cmd, args, opts = {}) {
  const r = run(cmd, args, opts)
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-12).join('\n')
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})\n${tail}`)
  }
  return r.stdout
}

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function killGroup(pid) {
  if (!alive(pid)) return
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  const until = Date.now() + 8000
  while (alive(pid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  if (alive(pid)) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
}

export async function waitFor(url, { timeoutMs = 90000, label = url, okStatuses = [200] } = {}) {
  const until = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { redirect: 'manual' })
      if (okStatuses.includes(r.status)) return true
      last = `HTTP ${r.status}`
    } catch (e) { last = e.cause?.code || e.message }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`${label} did not answer within ${timeoutMs / 1000}s (last: ${last})`)
}

/**
 * True when node_modules disagrees with package-lock.json for any direct
 * dependency (a clone that last built another branch, a bumped lockfile).
 */
function depsStale(dir) {
  if (!existsSync(join(dir, 'node_modules'))) return true
  let lock
  try { lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) } catch { return false }
  const root = lock.packages?.[''] || {}
  const names = Object.keys({ ...(root.dependencies || {}), ...(root.devDependencies || {}) })
  for (const name of names) {
    const want = lock.packages?.[`node_modules/${name}`]?.version
    let have = null
    try { have = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version } catch { /* missing */ }
    if (want && have !== want) return true
  }
  return false
}

function detach(name, cmd, args, { cwd, env }) {
  mkdirSync(LOGS, { recursive: true })
  const out = openSync(join(LOGS, `${name}.log`), 'a')
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', out, out] })
  child.unref()
  return child.pid
}

// ---------------------------------------------------------------- database

function dockerUp() {
  const probe = run('docker', ['info'], { quiet: true })
  return probe.status === 0
}

function pgBin() {
  for (const dir of PG_BIN_CANDIDATES) if (existsSync(join(dir, 'pg_ctl'))) return dir
  const which = run('which', ['pg_ctl'], { quiet: true })
  if (which.status === 0) return resolve(which.stdout.trim(), '..')
  return null
}

const PGDATA = join(CONTROL, 'pg')

function localPgRunning(bin) {
  if (!existsSync(join(PGDATA, 'PG_VERSION'))) return false
  return run(join(bin, 'pg_ctl'), ['-D', PGDATA, 'status'], { quiet: true }).status === 0
}

function startLocalPg(bin) {
  if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
    log(`  initdb → ${PGDATA}`)
    sh(join(bin, 'initdb'), ['-D', PGDATA, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale'], { quiet: true })
  }
  if (!localPgRunning(bin)) {
    mkdirSync(LOGS, { recursive: true })
    sh(join(bin, 'pg_ctl'), ['-D', PGDATA, '-l', join(LOGS, 'postgres.log'), '-w', '-t', '60', '-o',
      `-p ${DB_PORT} -c listen_addresses=127.0.0.1 -k ${CONTROL} -c fsync=off -c synchronous_commit=off`, 'start'], { quiet: true })
  }
  const psql = (sql, db = 'postgres') => sh(join(bin, 'psql'), ['-h', '127.0.0.1', '-p', String(DB_PORT), '-U', 'postgres', '-d', db, '-tAc', sql], { quiet: true }).trim()
  if (psql(`SELECT 1 FROM pg_database WHERE datname = 'termpocket_test'`) !== '1') psql(`CREATE DATABASE termpocket_test`)
  return psql
}

export function dbUp({ fresh = false } = {}) {
  if (process.env.CONTROL_DATABASE_URL) {
    log(`db: external ${redact(process.env.CONTROL_DATABASE_URL)}`)
    return { mode: 'external', url: DB_URL }
  }
  if (dockerUp()) {
    log('db: docker compose (postgres:17, in memory)')
    sh('docker', ['compose', '-f', join(REPO, 'docker-compose.test.yml'), 'up', '-d', '--wait'], { cwd: REPO, quiet: true })
    return { mode: 'docker', url: DB_URL }
  }
  const bin = pgBin()
  if (bin) {
    log(`db: local PostgreSQL from ${bin} on ${DB_PORT}`)
    const psql = startLocalPg(bin)
    if (fresh) {
      psql(`DROP DATABASE IF EXISTS termpocket_test`)
      psql(`CREATE DATABASE termpocket_test`)
    }
    return { mode: 'local', url: DB_URL, bin }
  }
  log('db: none (Docker is down and no pg_ctl found) — login flows will be skipped')
  return { mode: 'none', url: null }
}

export function dbDown(db) {
  if (!db) return
  if (db.mode === 'docker') run('docker', ['compose', '-f', join(REPO, 'docker-compose.test.yml'), 'down'], { cwd: REPO, quiet: true })
  if (db.mode === 'local' && db.bin && localPgRunning(db.bin)) run(join(db.bin, 'pg_ctl'), ['-D', PGDATA, '-m', 'fast', 'stop'], { quiet: true })
}

export function dbReady(db) {
  if (!db || db.mode === 'none') return false
  if (db.mode === 'docker') return run('docker', ['compose', '-f', join(REPO, 'docker-compose.test.yml'), 'ps', '--status', 'running', '-q'], { cwd: REPO, quiet: true }).stdout.trim() !== ''
  if (db.mode === 'local') return !!db.bin && localPgRunning(db.bin)
  return true
}

function redact(url) { return url.replace(/\/\/([^:@/]+)(:[^@/]*)?@/, '//$1:***@') }

// ----------------------------------------------------------------- backend

const BACKEND = join(REPO, 'backend')

// Files the build itself rewrites; counting them would make every build look stale.
const BUILD_OUTPUTS = ['next-env.d.ts', 'tsconfig.tsbuildinfo']

function newestMtime(dir, { skip = ['node_modules', 'dist', 'test', 'eval'] } = {}) {
  let newest = 0
  const walk = d => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (skip.includes(entry.name) || BUILD_OUTPUTS.includes(entry.name) || entry.name.startsWith('.')) continue
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(ts|json|sql)$/.test(entry.name)) newest = Math.max(newest, statSync(p).mtimeMs)
    }
  }
  walk(dir)
  return newest
}

export function backendEnv(db, secret) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    NODE_ENV: 'development',
    PORT: String(BACKEND_PORT),
    DATABASE_URL: db.url,
    JWT_SECRET: secret,
    CORS_ORIGIN: FRONTEND_URL,
    FRONTEND_URL,
    LOG_LEVEL: 'info',
    RATE_LIMIT_AUTH_MAX: '100000',
    RATE_LIMIT_API_MAX: '100000',
    RATE_LIMIT_IMPORT_MAX: '100000',
    WEEKLY_REPORT_ENABLED: 'false',
    DEMO_REFRESH_ENABLED: 'false',
    // Storage on with a placeholder key: /agent reports `available`, so the composer and the
    // on-device dictation UI are enabled and can be driven. A model turn against this key fails
    // at the provider with `agent_provider_error`; nothing is spent. Without any key the page
    // disables the composer and the microphone; with storage off it shows only a notice.
    AGENT_ENABLED: 'true',
    CLAUDE_API_KEY: 'sk-control-placeholder-no-real-turns',
  }
  if (process.env.CONTROL_AGENT === '1') {
    // Opt-in only: a real model turn costs money and sends text to the provider.
    if (process.env.CLAUDE_API_KEY) env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY
    if (process.env.CLAUDE_MODEL) env.CLAUDE_MODEL = process.env.CLAUDE_MODEL
  }
  return env
}

export async function backendUp(db, { secret }) {
  const dist = join(BACKEND, 'dist', 'app.js')
  if (depsStale(BACKEND)) { log('backend: npm ci (node_modules disagree with the lockfile; this also builds)'); sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: BACKEND, quiet: true }) }
  else if (!existsSync(dist) || statSync(dist).mtimeMs < newestMtime(BACKEND)) { log('backend: npm run build'); sh('npm', ['run', 'build'], { cwd: BACKEND, quiet: true }) }
  const env = backendEnv(db, secret)
  log('backend: db:setup + db:seed (demo account replaced)')
  sh('npm', ['run', 'db:setup'], { cwd: BACKEND, env, quiet: true })
  sh('npm', ['run', 'db:seed'], { cwd: BACKEND, env, quiet: true })
  const pid = detach('backend', 'node', ['dist/app.js'], { cwd: BACKEND, env })
  await waitFor(`${BACKEND_URL}/health`, { label: 'backend /health' })
  log(`backend: up on ${BACKEND_URL} (pid ${pid})`)
  return { pid, port: BACKEND_PORT }
}

// ---------------------------------------------------------------- frontend

const FRONTEND = join(REPO, 'frontend')

function buildKey() {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: REPO, quiet: true }).stdout.trim()
  const dirty = run('git', ['status', '--porcelain', '--', 'frontend'], { cwd: REPO, quiet: true }).stdout
  const h = createHash('sha1').update(head).update(dirty).update(String(newestMtime(FRONTEND, { skip: ['node_modules', '.next', 'public'] }))).update(BACKEND_URL)
  return h.digest('hex').slice(0, 12)
}

export async function frontendUp({ dev = false, build = false } = {}) {
  if (depsStale(FRONTEND)) { log('frontend: npm ci (node_modules disagree with the lockfile)'); sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: FRONTEND, quiet: true }); rmSync(join(FRONTEND, '.next'), { recursive: true, force: true }) }
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_PUBLIC_API_URL: BACKEND_URL, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: dev ? 'development' : 'production' }
  const next = join(FRONTEND, 'node_modules', '.bin', 'next')
  let mode = 'dev'
  let key = null
  if (!dev) {
    mode = 'start'
    key = buildKey()
    const marker = join(CONTROL, 'frontend-build.json')
    const built = existsSync(join(FRONTEND, '.next', 'BUILD_ID')) && existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).key === key
    if (build || !built) {
      log('frontend: npm run build (production; prebuild verifies the OCR and voice assets)')
      // `next build` pretty-prints tsconfig.json; a clean file is put back so the clone stays
      // clean for the next `gh pr checkout` (a file the user had edited is left alone).
      const tsconfigClean = run('git', ['diff', '--quiet', '--', 'frontend/tsconfig.json'], { cwd: REPO, quiet: true }).status === 0
      sh('npm', ['run', 'build'], { cwd: FRONTEND, env: { ...env, NODE_ENV: undefined }, quiet: true })
      if (tsconfigClean) run('git', ['checkout', '--', 'frontend/tsconfig.json'], { cwd: REPO, quiet: true })
      key = buildKey() // recomputed after the build, so files the build touched do not force the next one
      writeFileSync(marker, JSON.stringify({ key, at: new Date().toISOString() }))
    } else log(`frontend: build ${key} is current`)
  }
  const args = mode === 'dev' ? ['dev', '-p', String(FRONTEND_PORT)] : ['start', '-p', String(FRONTEND_PORT)]
  const pid = detach('frontend', next, args, { cwd: FRONTEND, env })
  await waitFor(`${FRONTEND_URL}/login`, { label: 'frontend /login', timeoutMs: 120000 })
  log(`frontend: up on ${FRONTEND_URL} (${mode}, pid ${pid})`)
  return { pid, port: FRONTEND_PORT, mode, buildKey: key }
}

// --------------------------------------------------------------------- all

export async function up(opts = {}) {
  const state = readState()
  if (state && alive(state.backend?.pid) && alive(state.frontend?.pid) && !opts.fresh && !opts.build) {
    log(`already up: backend pid ${state.backend.pid}, frontend pid ${state.frontend.pid} (${state.frontend.mode}); use --fresh to restart`)
    return state
  }
  if (state) down(state)
  mkdirSync(LOGS, { recursive: true })
  const secret = randomBytes(32).toString('hex')
  // The state file is written after every stage, so a failure half-way still
  // leaves `ctl down` able to stop what did start.
  const next = { startedAt: new Date().toISOString(), db: null, backend: null, frontend: null, secret, urls: { backend: BACKEND_URL, frontend: FRONTEND_URL }, partial: true }
  try {
    next.db = opts.noDb ? { mode: 'none', url: null } : dbUp({ fresh: opts.fresh })
    writeState(next)
    if (next.db.mode !== 'none') next.backend = await backendUp(next.db, { secret })
    else log('backend: skipped (no database)')
    writeState(next)
    next.frontend = await frontendUp({ dev: opts.dev, build: opts.build })
    delete next.partial
    writeState(next)
    return next
  } catch (e) {
    log(`up failed at ${next.frontend ? 'the end' : next.backend ? 'the frontend' : next.db ? 'the backend' : 'the database'}; stopping what had started`)
    down(next)
    throw e
  }
}

export function down(state = readState()) {
  if (!state) { log('nothing to stop (no .control/state.json)'); return }
  if (state.frontend?.pid) { killGroup(state.frontend.pid); log(`frontend: stopped (pid ${state.frontend.pid})`) }
  if (state.backend?.pid) { killGroup(state.backend.pid); log(`backend: stopped (pid ${state.backend.pid})`) }
  dbDown(state.db)
  if (state.db?.mode && state.db.mode !== 'none') log(`db: stopped (${state.db.mode})`)
  rmSync(STATE_FILE, { force: true })
}

export async function status() {
  const state = readState()
  const out = { state: !!state, db: false, backend: false, frontend: false }
  if (state) {
    out.db = dbReady(state.db)
    out.backend = alive(state.backend?.pid) && await fetch(`${BACKEND_URL}/health`).then(r => r.ok).catch(() => false)
    out.frontend = alive(state.frontend?.pid) && await fetch(`${FRONTEND_URL}/login`).then(r => r.ok).catch(() => false)
    out.since = state.startedAt
    out.mode = state.frontend?.mode
  }
  return out
}

export function tailLog(name, n = 80) {
  const file = join(LOGS, `${name}.log`)
  if (!existsSync(file)) return `(no ${name} log yet)`
  return readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n')
}
