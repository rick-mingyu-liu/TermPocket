---
name: control-termpocket
description: Run the real TermPocket app locally (throwaway Postgres, backend on 3001, frontend on 3000), drive it through named flows in headless Chromium, and collect proof (screenshots, console log, trace, metrics). Use it to verify UI changes, reproduce bug reports, and attach evidence to PRs and triage notes.
---

# control-termpocket

A verification skill in two parts: a **CLI** (`ctl.mjs`) that reproducibly runs the app and collects
evidence, and a **feature map** (`FEATURE-MAP.md`) that says what the app has, how a user reaches it
and which stable selectors to drive. Read the map before driving anything; keep it current when you
change a page.

Everything it writes lives under `<repo>/.control/` (git-ignored): the Postgres cluster, logs,
`state.json`, and `proof/<timestamp>-<flow>/` with `report.md`, `report.json`, one screenshot per
step, `console.log` and `trace.zip` (open with `npx playwright show-trace`).

## Commands

Run from anywhere with `npm run ctl --prefix <repo>/.claude/skills/control-termpocket -- <command>`
(or `npm run ctl -- <command>` inside this folder). First time: `npm install` here, then
`npx playwright install chromium`.

| command | what it does |
|---|---|
| `up [--fresh] [--build] [--dev] [--no-db]` | Start the stack. Postgres: Docker compose if the daemon is up, else a local `pg_ctl` cluster in `.control/pg`, else none (`--no-db`: frontend only, login flows skip). Backend: `npm ci` when node_modules disagree with the lockfile, build when stale, `db:setup` + `db:seed`, then `node dist/app.js` with an explicit environment (random `JWT_SECRET`, rate limits raised, email and demo-refresh off, agent storage on with a placeholder provider key so the composer and dictation can be driven without spending anything). Frontend: production build cached by HEAD + dirty state, `next start`; `--dev` uses `next dev`. Idempotent: says "already up" if it is. |
| `down` | Stop exactly what `up` started (process groups, Postgres). |
| `status [--json]` | Which pieces answer. Exit 1 when the frontend is down. |
| `logs [backend\|frontend\|postgres] [-n 80]` | Tail a log. |
| `flows` | List the named flows and the routes each covers. |
| `drive <flow>… \| all [--headed] [--video] [--audio say\|file.wav] [--expect regex] [--locale zh]` | Run flows. Each gets a fresh browser context; every step takes a screenshot; exit 1 if any flow fails. `--audio say` synthesises a spoken phrase with macOS `say` and feeds it to Chrome's fake microphone (for `dictate`). |
| `shot <route> [--anon] [--zh] [--out file.png]` | One signed-in full-page screenshot of a route (signed out with `--anon`). |
| `perf <route> [--runs 3]` | Median TTFB, DOMContentLoaded, load, LCP, JS heap, main-thread task time, long tasks and DOM nodes over N signed-in loads, from Navigation Timing and the CDP `Performance` domain. Writes `perf.json`. |
| `api <METHOD> <path> [json]` | A signed-in request as the demo account, e.g. `api GET /summary/rolling?term=current`. |
| `map check` | Diff the routes in `FEATURE-MAP.md` against `frontend/pages/` and list routes no flow covers. Exit 1 on drift. |

## Flows

`login`, `dashboard`, `transactions`, `transaction-crud`, `goals`, `import` (on-device OCR on a
synthetic bank screenshot from `eval/synthetic/`), `agent` (page renders with the composer enabled and
nothing is sent; a real model turn only with `CONTROL_AGENT=1 CLAUDE_API_KEY=…`, which costs money), `dictate` (Whisper loads from `/voice`,
records from the fake microphone, transcript or no-speech), `settings` (theme and language round
trips; never the danger zone), `pages` (every public page in `en` and `zh`: 200, no console errors,
no untranslated keys, the two legacy redirects). A step may pass with a warning (`~`) when the
observation is informative but not a failure.

## How to use it in a task

1. `up`, then `drive all` (or the flows whose `covers` include the routes you touched) **before** you
   change anything, so you know what already fails on `main`.
2. Make the change. `drive` the same flows again; use `shot` for a before/after picture and `perf`
   when the change could affect load time or the renderer.
3. Reproducing a bug report: find the route in the feature map, write the steps as a one-off flow
   (copy a file in `flows/`, register it in `flows/index.mjs`) or drive it by hand with `shot`/`api`;
   keep the proof folder path and quote `report.md` in the PR or the card.
4. Quote evidence, not impressions: step names and timings from `report.md`, the console error line,
   the screenshot file name, the `perf.json` numbers.
5. `down` when you are done. Never leave the stack running at the end of an unattended run.

## Rules

- Never point it at production: no `DATABASE_URL` from `.env`, no deployed URLs, no real credentials.
  `CONTROL_DATABASE_URL` is for another throwaway database only.
- The demo account is the only account the flows use. Registration needs email and is not driven.
- Flows never click "Clear All Data", "Delete account", or anything that sends mail.
- A flow that writes (transaction, goal, import) also cleans up, and every `up` reseeds the demo
  account anyway.
- When a selector in a flow breaks because the UI changed on purpose, fix the flow **and** the feature
  map in the same PR.

## Environment knobs

`CONTROL_DB_PORT` (55432), `CONTROL_BACKEND_PORT` (3001), `CONTROL_FRONTEND_PORT` (3000),
`CONTROL_DATABASE_URL` (skip starting Postgres), `CONTROL_AGENT=1` + `CLAUDE_API_KEY` (+ `CLAUDE_MODEL`)
to enable Pocky, `CONTROL_AUDIO_PHRASE` for `--audio say`.
