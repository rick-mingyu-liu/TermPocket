<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/brand/termpocket-icon-dark.svg">
    <img src="frontend/public/brand/termpocket-icon.svg" alt="TermPocket" width="96">
  </picture>
</p>
<h1 align="center">TermPocket</h1>
<p align="center">Your money, term by term.</p>
<p align="center">
  <a href="https://www.termpocket.com">Live app</a> ·
  <a href="https://www.termpocket.com/privacy">Privacy</a> ·
  <a href="https://www.termpocket.com/terms">Terms</a>
</p>

[![Node.js](https://img.shields.io/badge/Node.js-22-green.svg)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-blue.svg)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-blue.svg)](https://www.postgresql.org/)
[![OCR](https://img.shields.io/badge/OCR-PaddleOCR%20PP--OCRv6%2C%20on--device-orange.svg)](eval/)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-lightgrey.svg)](LICENSE.md)

Personal finance for students, organised by school term. Record spending by chatting with Pocky (English or 中文), import bank, Uber and WeChat Pay screenshots read entirely on-device, and track savings goals.

TermPocket is built around the **Waterloo term** (Winter Jan–Apr, Spring May–Aug, Fall Sep–Dec), not the calendar month. A study term and a co-op term are both four months, and that is the unit students actually budget in: a co-op term earns, a study term spends down.

**Try it:** **[www.termpocket.com](https://www.termpocket.com)** — sign in as `john.doe@example.com` / `password123`. Where your data goes: see the [Privacy Policy](https://www.termpocket.com/privacy).

---

## Contents

- [Why terms](#why-terms)
- [Features](#features)
- [Screenshot import](#screenshot-import)
- [Conversation recording](#conversation-recording)
- [Quick start](#quick-start)
- [The demo account](#the-demo-account)
- [Architecture](#architecture)
- [Development](#development)
- [API](#api)
- [Deployment](#deployment)
- [Stack](#stack) · [Database](#database) · [Known gaps](#known-gaps)
- [License](#license) · [Contributing](#contributing)

---

## Why terms

Most finance apps offer a rolling window: *the last 4 months*, counting back from today. For a term-based life that is subtly wrong. A rolling four months coincides with a term only in **April, August and December** — the last month of each, when the term is already over. In the *first* month of a co-op term, which is exactly when someone sets a budget, three quarters of a rolling window is the previous term's money.

So the dashboard's windows are term-aligned:

| Window | Query |
|---|---|
| This term | `?term=current` |
| Last term | `?term=previous` |
| This year | `?year=current` |
| Last year | `?year=previous` |
| A named term | `?term=2026-spring` |
| Rolling months | `?months=4` |

The term calendar is **Winter** Jan–Apr, **Spring** May–Aug, **Fall** Sep–Dec, defined once in [`backend/utils/terms.ts`](backend/utils/terms.ts). Those three tile Jan–Dec exactly, so a calendar year *is* three terms and a yearly total can never disagree with the terms inside it. Bounds are half-open `[start, end)`.

---

## Features

- **Term-based dashboard**: This term / Last term / This year / Last year, category breakdown and a month-by-month income-vs-expenses chart. See [Why terms](#why-terms).
- **On-device screenshot import**: bank lists, receipts, Uber trips, Uber Eats orders and WeChat Pay. The image never leaves your browser and nothing is saved until you confirm. [Details](#screenshot-import).
- **Pocky, the conversation assistant**: record income and spending by chatting in English, Chinese or both, with button-only confirmation and ten-minute undo; ask questions about your own recorded spending; plan with deterministic projections and goal proposals you confirm with a button; dictate in English with the mic button, transcribed on your device. Messages go to an AI provider ([Privacy Policy](https://www.termpocket.com/privacy)). Off unless the deployment enables it. [Details](#conversation-recording).
- **Savings goals**: targets with progress bars and days remaining, plus a monthly suggestion when last month left money over.
- **Transactions**: income and expenses across 18 categories in CAD, USD, EUR, GBP, AUD and CNY. Conversion happens at read time, so a row keeps the currency it was entered in.
- **English and 中文**: every user-facing string, in both languages.
- **Weekly email report**: the past seven days and the current term so far in CAD, spending by category, goal progress, and in the first report of each month last month's leftover. Every Sunday at 7 p.m. Toronto time; turn it off in Settings.
- **Read-only MCP access**: connect your own AI client with a personal access token (Settings → AI connections). [Details](#mcp--read-only-for-a-personal-agent).
- **Automatic deletion of old terms**: opt-in, off by default; Settings shows how many transactions would go and asks first.
- **Delete account**: Settings → Danger zone removes the account and everything belonging to it.
- **Settings**: theme, display currency, language and the weekly report switch. Every control saves the moment it changes.

---

## Screenshot import

Open **Import from screenshot** on the dashboard or the transactions page, then drop, pick or paste up to five images at a time.

```
Your browser                                        TermPocket API
  screenshot ──▶ Web Worker: PaddleOCR PP-OCRv6 small
                 (ONNX Runtime Web, WASM)
                 text lines + boxes ──── POST /import/parse ──▶ rows → layout → parser → checks
  review table ◀─────────────────── draft rows + flags ◀──┘   (nothing is stored)
  edit, untick, view source
  confirm ─────────────────────── POST /transactions/import ─▶ re-validate → one INSERT
```

**Private by design.** The image never leaves your device; only the recognised text is sent, it is never logged, and nothing is saved until you confirm. The first import downloads the reading model once (about 45 MB, cached by the browser after that).

### What it reads

| Screenshot | Recognised as | What you get |
|---|---|---|
| A bank app's transaction list — date headers, signed or unsigned amounts, pending rows, a running balance beside or **under** each amount | Bank list | One row per transaction; running balances verify the amounts |
| A photo of a paper receipt | Receipt | One expense: the total, the merchant, the date; items + tax + tip must add up |
| Uber → Activity | Uber trips | Each trip as a Transportation expense, `Uber: <destination>` |
| Uber Eats → Orders → **Past orders** | Uber Eats orders | Each order's total (fees and tip included) as an expense, `Uber Eats: <store>`, categorised by store |
| WeChat Pay → Transactions | WeChat Pay | Every transaction **in CNY**, dated from its own line and the month header |

Uber Eats' *Past items* tab is deliberately not imported: it shows today's menu prices, not what you paid.

### Checked, not trusted

Every row carries flags; the review screen shows the most serious as a **Check: …** badge, with the rest in its tooltip. Possible duplicates and incomplete rows start unticked.

- **Amount checked** — running balances or a receipt's arithmetic confirm the amount.
- **Income or expense was guessed** — the screen showed no sign. OCR drops minus signs with high confidence, so an unsigned bank amount is never treated as a confirmed expense.
- **Hard to read** — low OCR confidence on some field.
- **Some characters were guessed** — the parser repaired the text (`+4.801` → `4.80`, `O` → `0`).
- **Does not match the running balance** / **Receipt totals do not add up** — the arithmetic check failed.
- **Possible duplicate** — you already have a transaction with the same day, amount and currency.
- **No date found** — no date could be trusted; the row cannot be ticked until you add one.

The parser also copes with what real screenshots do to OCR: dates with the spaces squeezed out (`SEP15,2026`), app icons read as Chinese characters, arrows that span two lines, merchant names that wrap, and store logos read as text.

### Measured, not claimed

The [`eval/`](eval/) benchmark runs the same model the browser runs and scores every field, headlined by the **silent-error rate** — rows whose amount is wrong *and* carry no warning:

| Set | Rows found | Silent amount errors |
|---|---|---|
| Synthetic (48 images: bank lists and receipts) | 188 / 188 | 0 |
| Real screenshots (7, kept private and never committed) | 27 / 27 | 0 |

The recorded OCR output is replayed through the parser in CI, so a parser change that would introduce a silent error fails the build.

---

## Conversation recording

Open the dashboard's **Record with Pocky** panel or `/agent`. Pocky is TermPocket’s frog assistant. Conversations stay ordered by creation time, newest first, regardless of visits or later messages. Type transactions, including several in one message, and correct the pending batch through chat or its editable rows. The screen shows the default currency, timezone and reply language. Missing currency uses that displayed default; ambiguous amounts need clarification. Review every amount, date, currency and category before confirming selected rows or the whole batch. Typing “yes” in chat does not save anything.

Only the confirmation endpoint creates financial records. Confirmation binds the reviewed draft version and selected row IDs to a retry key; retrying the same confirmation cannot insert the batch twice. Pending drafts last 24 hours from the model proposal; manual edits and partial confirmation keep that deadline. Each saved batch offers ten-minute undo, which refuses if any of its transactions was edited or deleted afterward. Conversation deletion clears its messages and drafts while keeping saved transactions; Settings' broader clear-all action separately deletes financial records too.

Messages persist in TermPocket's database until their conversation is deleted. Each model request receives bounded recent history and the current pending draft. Pocky can also help plan: it averages your past months, lists your savings goals, runs deterministic cash projections from the numbers you give it (it asks for cash on hand rather than guessing, and will not call something affordable without it), and proposes one goal creation or change at a time, which only the goal card's Confirm button applies. Projections are estimates from stated inputs, not advice, and nothing is stored except the pending goal proposal. **Voice dictation:** the composer's mic button records up to 15 seconds of English speech and transcribes it in the browser with Whisper `base.en` (8-bit, about 77 MB plus a 14–27 MB runtime file, downloaded on the first tap and then cached; tap again once it is ready to record). The audio never leaves the device; the transcript goes into the message box for you to check and edit, and nothing is sent until you press Send. Dictated messages are flagged so Pocky asks about amounts speech-to-text may have run together (`2340`: 23.40 or 2340.00?). The microphone is hidden outside secure contexts. Deploy the backend before the frontend, or dictated sends get a 400. Details: [`docs/VOICE.md`](docs/VOICE.md). **Memory:** Pocky can offer to remember a stable fact you state (rent, pay, a cash reserve, a preference); only the card's Remember button saves it, at most 30, and Settings → Pocky memory lists them for deletion. Every remembered fact goes to the AI provider with each message. Design: [`docs/MEMORY.md`](docs/MEMORY.md). There are no conversation summaries in this release. Manual recording, screenshot import, savings goals and external read-only MCP remain available.

**Data handling:** Pocky uses third-party AI/LLM API providers. Messages, relevant history, pending rows, date/currency/timezone context and any transaction or goal records Pocky looks up are sent to the provider to generate responses. Inputs are not automatically anonymized, and processing takes place outside Canada; see [Current AI providers](https://www.termpocket.com/privacy#ai-providers) for the provider, location and API terms. We do not promise a fixed provider retention period or exclusion from model training. TermPocket stores conversations, and authorized administrators may access them; storage is not end-to-end encrypted. Deleting a conversation does not necessarily delete data retained by the provider. Do not include passwords or credentials. Operational agent logs contain metadata and safe error codes, not conversation contents or raw provider errors. The in-app notice links the draft [Privacy Policy](https://www.termpocket.com/privacy) and [Terms of Service](https://www.termpocket.com/terms). Pocky is optional.

The feature is off by default. `AGENT_ENABLED=true` enables migrated agent storage; a configured `CLAUDE_API_KEY` additionally enables new model turns. If the key is removed while storage remains enabled, history, draft editing/confirmation, undo and deletion remain available. With `AGENT_ENABLED=false`, agent routes and agent maintenance make no agent database queries; existing stored history remains until storage is enabled and deleted or cleaned up under the rules below.

Limits: one active turn per user, `AGENT_MAX_CONCURRENT_RUNS` active model requests per backend process (default 4), 20 new turns per user per rolling hour, 60 per user per rolling 24 hours (`AGENT_MAX_TURNS_PER_DAY`) and 600 across all users per rolling 24 hours (`AGENT_MAX_TURNS_PER_DAY_ALL_USERS`), which bounds the provider bill in turns (set a spending limit with the provider too), 100 conversations per user and 200 messages per conversation. A request accepts 4,000 characters, uses at most 30 recent messages / 24,000 history characters, proposes at most 12 rows, and has a 90-second deadline with at most eight tool attempts. Cancellation stops the local request promptly; PostgreSQL checks prevent a late response from restoring a cancelled or deleted conversation. Use Refresh or the same request's recovery action after an uncertain response; the UI does not poll.

---

## Quick start

**Prerequisites:** Node.js 22 (what CI runs), PostgreSQL 15+. The agent schema uses column-specific `ON DELETE SET NULL`, introduced in PostgreSQL 15.

```bash
git clone <repository-url>
cd <repository-folder>
(cd backend && npm install)   # also builds: `prepare` runs tsc into dist/
(cd frontend && npm install)
```

### Configure

`backend/.env` — see [`backend/.env.example`](backend/.env.example) for the annotated full list.

```env
DATABASE_URL=postgresql://user:password@localhost:5432/termpocket
JWT_SECRET=<at least 32 characters>
CORS_ORIGIN=http://localhost:3000   # one origin, or several separated by commas

# Optional. Each one degrades gracefully when absent.
MAILBOXLAYER_API_KEY=    # email address validation (falls back to a local domain list)
EMAIL_USER=              # weekly reports (SMTP login)
EMAIL_PASS=              # SMTP password or API key
EMAIL_HOST=              # optional SMTP server; unset = Gmail
EMAIL_PORT=              # optional, default 465
EMAIL_FROM=              # optional From header, e.g. TermPocket <noreply@example.com>
WEEKLY_REPORT_ENABLED=   # unset: weekly reports only under NODE_ENV=production

# Optional conversation recording: enable only after migration 013.
AGENT_ENABLED=false
CLAUDE_API_KEY=          # Claude API key (console.anthropic.com); without it, new model turns are unavailable
CLAUDE_MODEL=            # optional; default claude-sonnet-5-5 (claude-haiku-5-5 also works; Opus 5.5 cannot turn thinking off)
AGENT_MAX_CONCURRENT_RUNS=4   # model turns at once on this process
```

The app **refuses to boot** without database configuration and `JWT_SECRET`, and warns about missing email and address-validation credentials. Conversation recording reports its availability through `/agent/status`; a missing AI provider key does not stop the rest of the application.

`frontend/.env` — see [`frontend/.env.example`](frontend/.env.example):

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### Database

```bash
cd backend
npm run db:setup    # applies db/schema.sql — idempotent, safe to re-run
npm run db:seed     # (re)builds the demo account
```

A fresh database needs nothing else: `db:setup` also records every migration as applied in `schema_migrations`, because `schema.sql` already contains them. An **existing** database gets the migrations in [`backend/db/migrations/`](backend/db/migrations/) it has not had yet from the runner, which records each one:

```bash
export DATABASE_URL="<direct connection string>"   # not the -pooler one; the runner refuses it
npm run db:migrate -- --status   # applied / pending, changes nothing
npm run db:migrate               # apply every pending migration, in order
```

For production, the direct string is `neonctl connection-string production --project-id <id>`. A database that predates `schema_migrations` is **untracked**, and the runner refuses to touch it, because the early migrations include one-off data rewrites that must not run twice. Record what it already has first: `npm run db:migrate -- --baseline 015` marks 001–015 as applied without running them. The runner also refuses an empty database (that is `db:setup`'s job). Production is tracked (baselined at 015 on 2026-10-20) and at 023 since 2026-10-27; `npm run agent:preflight` reports any pending, changed or unrecorded migration as `db.migrations`. For a database that predates tracking, baseline it at 015 (`--baseline` records what you vouch for; it does not inspect the database), then `db:migrate` applies 016 onwards. 016 and 017 are idempotent, so it is safe whether or not they were already applied by hand. 018 and 021 refuse legacy rows that break their rules (a NULL owner, a currency outside the six, a non-positive amount, two addresses differing only in case) with counts and change nothing; the run stops there, and the next `db:migrate` continues once the rows are fixed. Older per-migration notes below that show `psql -f` still describe what each migration does; apply them through `db:migrate`.

`schema.sql` is the desired end state; a migration without a matching `schema.sql` edit means fresh setups and existing databases diverge.

Conversation recording needs [`013_conversational_transactions.sql`](backend/db/migrations/013_conversational_transactions.sql) on an existing database, after earlier migrations. Apply and verify it manually on a disposable local database or staging first; this implementation does not migrate production. It audits existing transaction sources and aborts on incompatible values without rewriting financial rows. Fresh setups include the same tables in `schema.sql`. Leave `AGENT_ENABLED=false` until the migration is installed; production migration and enablement are separate operator actions. Planning adds [`015_agent_goal_proposals.sql`](backend/db/migrations/015_agent_goal_proposals.sql) (additive, idempotent, requires 013): applying it before deploying the planning backend is recommended. Without it, goal proposals are simply unavailable (Pocky says so and the goal buttons answer `agent_unavailable`) while everything else works, and the backend notices the table once it is applied, without a restart.

### Run

```bash
cd backend && npm run dev      # http://localhost:3001
cd frontend && npm run dev     # http://localhost:3000 — downloads the OCR model on first run
```

If the backend reports `EADDRINUSE :3001`, another backend is still running — find it with `lsof -iTCP:3001 -sTCP:LISTEN` and stop it.

---

## The demo account

Generated relative to **today**, not hardcoded — five terms of a co-op student alternating study and work terms, with the current term truncated at today so it reads as live.

The alternation is the point: a study term is tuition and rent against part-time income and runs at a loss, a co-op term earns and saves. That contrast is what makes *This term / Last term* worth clicking.

`npm run db:seed` is **re-runnable** and is how the demo stays current — it replaces the demo user's rows rather than adding to them. Amounts vary month to month but come from a generator seeded on the term and category, so re-seeding on the same day is byte-identical.

To keep it current without intervention, set `DEMO_REFRESH_ENABLED=true`. The hourly maintenance run then checks when the account was last refreshed (the earliest creation time among its transactions) and rewrites it when that is more than 14 days ago (`DEMO_REFRESH_STALE_DAYS`, minimum 7) or it has no transactions. A redeploy delays a due refresh by at most an hour, and rows a visitor adds or edits do not delay it at all. It is **off by default** because it deletes every row belonging to the demo account before rewriting them. It identifies that account by the `is_demo` column rather than by an email address anyone could register, never creates the account, and scopes every delete to the resolved user id. See [`backend/services/demoAccountService.ts`](backend/services/demoAccountService.ts). The refresh discards anything a visitor adds while trying the demo.

---

## Architecture

[![TermPocket architecture: the browser (Next.js, on-device OCR and dictation), the Express API with Pocky and the scheduler, Neon PostgreSQL, external services, and delivery](docs/architecture.png)](docs/architecture.png)

The source is [`docs/architecture.drawio`](docs/architecture.drawio); open it in draw.io or at app.diagrams.net to edit it, then export it over `docs/architecture.png`.

```
backend/                        Express + PostgreSQL API (TypeScript)
├── app.ts                      helmet, morgan, cors, routers, error handlers
├── config/index.ts             ALL configuration — read env vars here, not process.env
├── config/validate.ts          startup check; exits on a missing secret
├── controllers/                request handling and orchestration
├── db/
│   ├── connection.ts           lazy pool, auto-closes after 5 min idle
│   ├── schema.sql              desired end state
│   ├── migrations/             numbered; applied and recorded by `npm run db:migrate`
│   └── demoData.ts             the demo account, generated from today
├── middleware/                 auth.ts (JWT), rateLimiter.ts
├── routes/                     express-validator chains + mounting
├── services/
│   ├── import/                 screenshot parser — pure functions, no I/O
│   │   ├── rows.ts             OCR boxes → visual rows (drops icons)
│   │   ├── tokens.ts           amounts and days out of text
│   │   ├── classify.ts         which layout a screenshot is
│   │   ├── bankList.ts         receipt.ts  uberActivity.ts  uberEats.ts  wechat.ts
│   │   ├── categorize.ts       first-guess category from the merchant
│   │   ├── duplicates.ts       possible_duplicate lookup
│   │   └── parse.ts            confidence, flags, output
│   ├── agent/                  isolated model runtime, validated drafts, owned storage
│   ├── schedulerService.ts     weekly email (cron, Toronto time) + hourly maintenance
│   └── …                       email, exchange rates, financial facts
├── types/
│   ├── db.ts                   one interface per table — edit with schema.sql
│   ├── express.d.ts            req.user, merged into Express’s own Request
│   └── import.ts               the screenshot parser’s vocabulary
├── utils/
│   ├── terms.ts                the term calendar — one definition
│   ├── dates.ts                calendar-day helpers
│   ├── logger.ts               info/warn/debug are dev-only; error/audit always print
│   └── privacy.ts              maskEmail()
├── test/                       unit + opt-in database tests, node --test
└── dist/                       tsc output (CommonJS) — gitignored; what production runs

frontend/                       Next.js 15, Pages Router, TypeScript
├── pages/                      one file per screen (import.tsx, settings.tsx, …)
├── components/ui/              Radix primitives, shadcn-style
├── lib/
│   ├── ocr/                    Web Worker, useOcr hook, pinned model profile
│   ├── import/review.ts        review-table state and validation
│   ├── preferences.ts          currency and language preferences
│   └── date.ts                 calendar-day helpers (never new Date(day))
├── scripts/                    ocr-assets.js (model download + checksums), check-locales.js
├── utils/api.ts                shared axios instance with auth + error interceptors
├── contexts/ThemeContext.tsx   light/dark/system
└── public/locales/{en,zh}/     every user-facing string

eval/                           screenshot-import benchmark (separate npm project)
├── generate.mjs                the synthetic screenshot set
├── run.mjs                     OCR (cached) → parser → per-layout scores
├── exportFixtures.mjs          records OCR output for the backend tests
└── private/                    real screenshots — gitignored, never committed

```

**Request flow:** route → auth middleware → validation → controller → service/db.
[`backend/ARCHITECTURE.md`](backend/ARCHITECTURE.md) has the diagram and where the layering still leaks.

### Conventions worth knowing

- **All config is centralized** in `config/index.ts`. Read env vars from there.
- **Controllers read the user id as `req.user.userId`.** Protected routers apply `router.use(auth)` at the top.
- **Validation** is `express-validator` arrays in the route file, checked with `validationResult(req)` at the top of the controller.
- **Always use parameterized queries.** Every query naming a user-owned table is scoped by `user_id`.
- **Amounts are two-decimal strings** in the import path, from OCR to INSERT — never floats.
- **Dates are calendar days, not instants.** A `pg` type parser hands `DATE` columns back as `'YYYY-MM-DD'`. Never `new Date(day).getMonth()` — a plain `'2026-08-01'` parses as UTC midnight and answers July west of UTC. Use `utils/dates.ts` and `lib/date.ts`.
- **Never log a credential** — no tokens, JWTs or password hashes — and **never log screenshot text, row values or request bodies**. Log a user id where one exists, a masked address only where one does not.
- **`logger.audit` is for destroying user data.** `info`/`warn`/`debug` print nothing in production.
- **Test fixtures from real screenshots** keep the OCR boxes and replace every name, place and reference number.
- **Adding a transaction category means four edits** — the list in `pages/transactions/new.tsx`, `CATEGORY_COLORS` in `pages/index.tsx`, and both `common.json` files.

---

## Development

```bash
# backend
npm run dev              # tsx watch app.ts
npm start                # production
npm run build            # tsc → dist/
npm test                 # builds, then node --test
npm run lint             # eslint 9, flat config, typescript-eslint
npm run db:setup         # apply schema (idempotent)
npm run db:seed          # rebuild the demo account

# frontend
npm run dev              # runs ocr-assets first
npm run build            # runs ocr-assets first
npm start
npm run lint
npm run check:locales    # every locale namespace: fails on duplicate keys or keys missing from one locale; warns on unresolved keys
npm run ocr-assets       # fetch + checksum the OCR model, copy ONNX Runtime

# eval
npm run generate         # regenerate the synthetic screenshot set
npm run benchmark        # score the shipped model on the synthetic set
npm run benchmark -- --set private   # score your own screenshots in eval/private/
npm run fixtures         # re-record backend/test/fixtures/ocr/ after a model change
npm test                 # scorer unit tests
```

To add a real screenshot to the private benchmark, put `name.png` and a hand-written `name.truth.json` (layout, `today`, and the expected rows) in `eval/private/`.

### Tests

[`backend/test/`](backend/test/) holds the application's tests, run by `node --test`. No test framework is installed and none is needed.

**Unit tests always run**, with no database and no network. They cover the things that fail silently:

- currency conversion and its caching; the term calendar and date helpers, swept across timezones
- the demo generator's evergreen properties at nine different "todays"
- the startup config check, retention predicates, logger levels in production
- the scheduler's timer plumbing, and the weekly report's next run **on a UTC clock**
- the removed stock and AI-plan endpoints fall through to the ordinary 404, signed in or not, without touching the database
- that registration and the import routes never write a token, an address, screenshot text or a row value to the log
- the screenshot parser piece by piece and end to end, including layouts copied from real screenshots
- planning projections in integer cents (weekly, two-weekly and monthly repeats, month-end clamping, leap years, window edges, conversion, reserve breaches, goal math) and goal-proposal validation
- agent row validation, authenticated routes, unavailable-mode behavior, cancellation, runtime tool restrictions, token limits, safe failures and temporary-directory cleanup

**Drift guards** (`sharedContracts.test.ts`, `demoData.test.ts`) pin what the backend and frontend both define: the seed's category list must match the picker's, and every category the picker offers must have a colour. The two projects are deliberately not npm workspaces, since workspaces move every lockfile to the repo root and break `npm ci` for both deploys (each is built from its own directory).

**Recorded OCR fixtures** (`importFixtures.test.ts`) replay real OCR output — captured by the [`eval/`](eval/) benchmark and checked into `backend/test/fixtures/ocr/` — through the live parser on every run, so a parser change is caught without re-running OCR in CI.

**`api.test.ts`, `agentStore.test.ts`, `agentGoalProposals.test.ts`, `agentMigration.test.ts`, `goalProposalMigration.test.ts` and `dropWatchlistMigration.test.ts` need a disposable database and skip without one.** They use an explicit `TEST_DATABASE_URL`, never the production URL from `.env`.

The quickest disposable database is the PostgreSQL 17 in [`docker-compose.test.yml`](docker-compose.test.yml), the same major version CI uses. It listens on this machine only, needs no password and keeps its data in memory, so each `up` starts empty:

```bash
docker compose -f docker-compose.test.yml up -d --wait
cd backend
export TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/termpocket_test
npm run build && DATABASE_URL=$TEST_DATABASE_URL npm run db:setup
npm test
docker compose -f docker-compose.test.yml down
```

Any other PostgreSQL 15+ works too (013 needs 15):

```bash
TEST_DATABASE_URL=postgresql://user@localhost:5432/termpocket_test npm test
```

It creates and deletes users, which is why opting in is deliberate. **Never point it at production.**

The frontend has no test runner. Verify UI changes by running the app.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs backend lint and tests against a Postgres service container, plus `check:locales`, lint and `build` for the frontend (which downloads and checksums the OCR model). It uses `npm ci`, so a `package.json` that disagrees with its lockfile fails the build.

### Dependency updates

[Dependabot](.github/dependabot.yml) checks the backend, frontend, OCR evaluation project and GitHub Actions every Monday at 9 a.m. Toronto time. Minor and patch version updates are grouped separately for each project; major version updates get individual PRs. Routine open PRs are capped at three per npm project and two for Actions. Security-update groups are separate and do not wait for the weekly schedule; their repository-level alerts and security-update settings are managed in GitHub.

Updates require manual review and passing CI; no auto-merge workflow is configured. For OCR dependency updates, also run the `eval/` tests and benchmark before merging: the existing application CI does not run that project's test command or OCR benchmark. Dependabot cannot fix a vulnerability without a suitable upstream release. The remaining frontend build-tool advisories and the tested PostCSS override are documented in [`frontend/DEPENDENCIES.md`](frontend/DEPENDENCIES.md).

---

## API

All routes except registration, login and email verification require `Authorization: Bearer <token>`.

### `/auth`
| | |
|---|---|
| `POST /register` | create an account; `accept_terms: true` (the sign-up tick box) stores the current terms version |
| `POST /login` | returns a JWT |
| `GET /verify-email/:token` | confirm an address |
| `POST /resend-verification` | reissue the mail |
| `GET, PUT /profile` | read and update the profile; `GET` includes the notification flags |
| `PUT /notifications` | `weekly_reports_enabled`, `email_notifications_enabled` — the scheduled email needs both |
| `POST /test-email` | send the weekly report now |
| `GET /terms` | `{currentVersion, acceptedVersion, required}`; `required` (the accept card) when the accepted version is not the current one — never for the demo account or before migration 017 |
| `POST /terms` | `{version}` — accept the current terms; `409` `terms_version_mismatch` for any other version |
| `DELETE /account` | `{ password }` — delete the account and everything belonging to it; `403` `account_password_incorrect` or `account_demo` deletes nothing |

Rate limited to 5 requests per 15 minutes per IP across `/register`, `/login`, `/resend-verification` and `/test-email` **combined**. `DELETE /account` has its own budget instead, 5 attempts per 15 minutes per user (`RATE_LIMIT_ACCOUNT_DELETE_MAX`).

### `/transactions`
| | |
|---|---|
| `GET /` | list, with filters and pagination |
| `POST /` | create |
| `PUT /:id`, `DELETE /:id` | update, delete |
| `GET /categories` | categories in use |
| `DELETE /clear-all` | delete every transaction |
| `GET /retention-settings` | automatic deletion: `{available, demo, retentionTerms, choices, window}`; `retentionTerms` is `null` (off, the default) or 3, 6, 9 or 12 terms kept, the current term included; `window` gives the first kept term and the cutoff day |
| `PUT /retention-settings` | `{retentionTerms: 3\|6\|9\|12\|null}`; stores it and answers as GET. 503 `retention_unavailable` before migration 016, 403 `retention_demo` for turning it on on the demo account |
| `GET /retention-preview?terms=N` | deletes nothing: `{terms, keepFromTerm, cutoff, count}` — how many of your transactions keeping N terms would delete now |
| `POST /import` | write confirmed screenshot-import rows (1–100, all or nothing) plus one `import_batches` record |

### `/import`
| | |
|---|---|
| `POST /parse` | OCR lines in; `layout` (`bank-list`, `receipt`, `uber-activity`, `uber-eats-orders`, `wechat-pay` or `unknown`), draft rows and flags out; nothing stored; 30 per 15 min per user |

### `/summary`
| | |
|---|---|
| `GET /monthly` | a single month |
| `GET /rolling` | a term, a year, or a rolling month count |
| `GET /trends` | spending by category over time |

`GET /rolling` takes **exactly one** of `?term=`, `?year=` or `?months=` — more than one is a 400. It echoes `term`, `year`, `periodLabel`, `startDate` and `endDate`, so a client never computes a date or a name.

### `/goals`
| | |
|---|---|
| `GET /`, `POST /` | list, create |
| `PUT /:id`, `DELETE /:id` | update, delete |
| `PUT /:id/progress` | update progress |
| `GET /stats` | aggregates |
| `DELETE /clear-all` | delete every goal |

### Removed stock and one-shot planning features

The stock watchlist and the old one-shot AI Planning feature are gone, code and storage both. Nothing is mounted under `/investments` or `/ai` any more, and `POST /goals/from-ai-plan` no longer exists, so those paths get the ordinary `404`. Migration [`014_drop_watchlist_ai_plans.sql`](backend/db/migrations/014_drop_watchlist_ai_plans.sql) drops the `watchlist` and `ai_plans` tables. Old frontend bookmarks still redirect: `/investments` to the dashboard and `/ai-planning` to `/agent`, the optional conversation-recording flow (which is not one-shot planning).

### `/agent` — conversation recording

All endpoints require the login JWT and return `Cache-Control: no-store`. Errors use stable application codes; provider types never enter the HTTP contract.

| Endpoint | Purpose |
|---|---|
| `GET /status` | `{available}` for new model turns; no database query |
| `GET, POST /conversations` | List or create owned conversations |
| `GET, DELETE /conversations/:id` | Read or delete owned history and pending drafts |
| `DELETE /conversations` | Clear owned history and drafts; saved transactions survive |
| `POST /conversations/:id/messages` | Run a turn with a UUID request ID and explicit currency/timezone/language |
| `POST /conversations/:id/runs/:runId/cancel` | Cancel an owned run |
| `PATCH, DELETE /conversations/:id/draft` | Save edits or discard a specific draft version |
| `POST /conversations/:id/confirm` | Confirm a version and selected row IDs with a UUID request ID |
| `POST /receipts/:id/undo` | Undo an unchanged saved batch within ten minutes |
| `POST /conversations/:id/goal-proposal/confirm` | Apply the latest pending goal proposal: `{proposalId, requestId}` (UUIDs); an update applies only if the goal is unchanged since it was proposed (`agent_goal_conflict` otherwise); a new goal whose target date has passed answers `agent_goal_invalid` |
| `DELETE /conversations/:id/goal-proposal` | Cancel the pending goal proposal: `{proposalId}` |

Conversation state includes `goalProposal`: the conversation's most recent proposal, `{id, action: 'create'|'update', goal_id, before, after, status: 'pending'|'confirmed'|'cancelled'|'expired'|'conflict', expires_at, result_goal_id}`, where `before`/`after` are `{name, target_amount, current_amount, currency, target_date, description}` with two-decimal amount strings and `YYYY-MM-DD` dates. Proposals expire after 24 hours. New goals need a target date, as in the goal form. Without migration `015`, both goal-proposal endpoints answer 503 `agent_unavailable`.

When `AGENT_ENABLED=false`, only status is available. When it is true but the provider key is missing, only new model turns are unavailable. Request IDs bind their original payload; reuse with a different payload conflicts. Amounts are two-place decimal strings, and dates are calendar days.

### `/mcp` — read-only, for a personal agent

TermPocket as an [MCP](https://modelcontextprotocol.io) server, so an AI client can read your numbers. `POST /mcp` speaks JSON-RPC 2.0 over Streamable HTTP and takes a **personal access token**, never the login JWT.

#### What a connected client can read

| Tool | Answers |
|---|---|
| `money_term_summary` | a term's income, spending, net, savings rate and top spending categories. For the current term it adds `pace`, which compares spending so far with what last term had actually spent over the same number of days. `pace` excludes future-dated rows and returns both half-open date windows, clamps the comparison to all of last term if that term was shorter, and includes a `note` when last term spent nothing (then `ratio` is `null`) or the comparison was clamped, and a `caveat` that a study term and a co-op term are different kinds of term. |
| `money_baseline` | average monthly income, spending and saving over the last 12 whole months that have data |
| `money_goals` | each savings goal's **name**, target, amount saved, target date, status, and what it needs per month |

Every tool is a `SELECT` of totals. No transaction, description or merchant leaves, and nothing can be added, changed or deleted through a token.

The figures are what you recorded in TermPocket, not verified bank balances. Term summaries and monthly baselines are in **CAD**, with other currencies converted at **current** exchange rates. Savings goals retain each goal's own `currency`; their amounts are not converted. The AI service you connect receives these numbers and handles them under its own terms. Nothing is anonymised or end-to-end encrypted.

#### Create and revoke a token

In the web app, **Settings → AI connections**:

- Name the connection, enter your TermPocket password, and press **Create token**. The password is checked again on the server (a wrong one is `403 access_token_password_incorrect`), so a stolen login session alone cannot mint a token. The demo account cannot create tokens.
- The token (`mgo_…`) is shown **once**. Copy it into your client straight away; only its SHA-256 hash is stored.
- A token **expires 90 days** after it is created; from then on its requests get `401`. Settings shows each token's expiry date and marks an expired one; create a new token and give it to the app. (Tokens that existed when expiry was introduced were given 90 days from that day.)
- **Revoke** takes effect at once: the next request from that client gets `401`.
- At most 5 tokens per account can be active at a time. Revoked and expired tokens do not count.
- Five wrong passwords within 15 minutes pause token creation for that account (`429 access_token_password_rate_limited`), the same budget as deleting the account.
- Creating and revoking a token each write an audit line with the user id and token id only.

The CLI still works, and enforces the same limit through the same transaction. It is an operator tool, run with the database's credentials, so it does not ask for the account's password; its tokens expire after 90 days too:

```bash
cd backend
npm run access-token -- create you@example.com "Claude Code"
npm run access-token -- list you@example.com
npm run access-token -- revoke you@example.com <id>
```

#### Connect Claude Code (verified)

Verified on 2026-10-14 with **Claude Code 2.1.300**:

- the endpoint was a local backend on a test database with fictional data
- discovery found all three tools
- all three tool calls worked, and the client interpreted the results
- after revoking the token, the client reported `✘ Failed to connect` with a `401`

```bash
claude mcp add --transport http termpocket https://<your-api-host>/mcp \
  --header "Authorization: Bearer <token>"
claude mcp get termpocket        # ✔ Connected
```

The `/mcp` endpoint is the backend's URL plus `/mcp`. Settings shows the right one for the deployment you're signed in to.

[Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp) describes local scope (the default), which stores the configuration in your own `~/.claude.json`, and environment-variable expansion in HTTP headers. Never put a real token in a committed `.mcp.json`. If you share one, reference an environment variable instead:

```json
{ "mcpServers": { "termpocket": { "type": "http", "url": "https://<your-api-host>/mcp",
  "headers": { "Authorization": "Bearer ${TERMPOCKET_TOKEN}" } } } }
```

**Protocol, as observed:**
1. Claude Code first sends a `server/discover` probe under revision 2026-07-28. TermPocket answers `-32601`, and the client falls back.
2. It then asks for `2025-11-25` in `initialize`. TermPocket offers only `2025-06-18`, and the client accepts it.
3. A `GET /mcp` for a server stream gets `405`, which the spec allows.

TermPocket implements one protocol version and refuses JSON-RPC batches.

#### Connect Codex

Open **Settings → AI connections → Setup guide → Codex** for a command with your endpoint filled in. Codex uses the same three read-only tools above.

Set `TERMPOCKET_TOKEN` to your token, without `Bearer`. In Bash/Zsh, run the first line, paste the token into the hidden input and press Enter, then run the second:

```bash
read -r -s TERMPOCKET_TOKEN
export TERMPOCKET_TOKEN
```

Add TermPocket and start Codex from that terminal:

```bash
codex mcp add termpocket --url "https://<your-api-host>/mcp" --bearer-token-env-var TERMPOCKET_TOKEN
codex
```

Or add this to `~/.codex/config.toml` instead of running `mcp add`:

```toml
[mcp_servers.termpocket]
url = "https://<your-api-host>/mcp"
bearer_token_env_var = "TERMPOCKET_TOKEN"
```

Keep tokens out of shared files. App/IDE users must make `TERMPOCKET_TOKEN` available to the application's process, then restart it.

In Codex CLI, use `/mcp` to check the connection, then ask about your term spending. `codex mcp get termpocket` checks configuration only. No OAuth login needed. [Codex documentation](https://developers.openai.com/codex/mcp/).

Verified locally on 2026-10-18 with **Codex CLI 0.162.1**: authenticated discovery of all three tools and rejection of an invalid token against the real router with stubbed data. All 16 MCP tests passed. No paid model turn or hosted-deployment check was performed.

#### Other clients (not verified)

- **claude.ai custom connectors**: [Anthropic documents a Request headers setting](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) for fixed credentials, including bearer tokens, and requires an endpoint reachable from its cloud infrastructure. Use `Authorization: Bearer <token>` with the public HTTPS `/mcp` URL. This combination has not been tested with TermPocket.
- **Clients that require OAuth** cannot connect. TermPocket has no authorization server, and adding one is a separate project.

#### Troubleshooting

- **`401 A TermPocket access token is required.`**:
  - the token is wrong, revoked, expired (90 days after creation), or from another deployment's database;
  - the header lacks `Bearer `; or
  - you used the login JWT, which `/mcp` refuses on purpose.

  Create a new token in Settings.
- **Claude Code shows `✘ Failed to connect` with no OAuth prompt.** This is expected when the header is set: Claude Code doesn't fall back to OAuth. Fix the token, then run `claude mcp get termpocket`.
- **The first request is slow.** On a host that sleeps, the first request waits for the server to wake.
- **Codex reports `TERMPOCKET_TOKEN` is missing.** Set it in the environment that launches Codex, then restart the client. `bearer_token_env_var` is a variable name, not a place to paste the token. A valid configuration alone does not establish an authenticated connection.
- **`429` from Settings.** Creating and revoking tokens shares a per-user budget of 20 requests per 15 minutes (`RATE_LIMIT_ACCESS_TOKEN_MAX`).

---

## Deployment

Current production setup: [STATUS.md](STATUS.md). To self-host you need a Node 22 host for the backend, a Next.js host for the frontend, and PostgreSQL 15+.

The frontend is built with `next build`, which first downloads the OCR model from a pinned commit and verifies its checksums; set `NEXT_PUBLIC_API_URL` to the backend's public URL. [`frontend/vercel.json`](frontend/vercel.json) deploys only `main` automatically (no preview deployment per branch or pull request; run `vercel` in `frontend/` for one by hand), and makes the hosted build skip when nothing under `frontend/` changed (`git diff --quiet HEAD^ HEAD -- .`, run from the project's root directory, `frontend`); to change anything the frontend build reads from outside `frontend/`, widen the command first.

The backend is built with `tsc` during the host's build (`npm ci --include=dev`, which runs the `prepare` script), and `npm start` runs `node dist/app.js`. Set `DATABASE_URL`, `JWT_SECRET` and `CORS_ORIGIN` (see [Configure](#configure)). In production, database connections use SSL (`ssl: { rejectUnauthorized: false }`). Every query names tables unqualified, so `db/connection.ts` issues `SET search_path` on each new connection. Use a direct (non-pooled) connection for `pg_dump`/restore and migrations.

**Migration 014 (drop `watchlist` and `ai_plans`):** deploy the frontend first (the previous build's Settings clear-all calls `DELETE /investments/watchlist/clear-all`, which now 404s), then the backend, then apply `014_drop_watchlist_ai_plans.sql`. The previous backend release queries `ai_plans` in its hourly maintenance job and its `/ai/plans` routes, and would error against a database without it. The migration is idempotent and prints only row counts.

**Migration and enablement:** verify migration `013` on PostgreSQL 15+ locally or in staging before applying it to production. `AGENT_ENABLED=false` permits the application to run without the new tables being queried by agent routes or maintenance. Enable it only after migration verification, and configure `CLAUDE_API_KEY` (the AI provider key) for new model turns.

**Agent runtime:** a model turn runs in the backend's own process with the plain `@anthropic-ai/sdk` HTTP client (pinned `0.135.0`, its OpenTelemetry tracing and trace headers off): no child process, no temporary directory. One implementation holds every guard: the deadline, cancellation, `assertActive` before each tool, the eight-attempt and eight-execution budgets, the tool-output, token and character limits, and the error codes. The request carries no date other than the envelope's `context`. Until 2026-10-22 the default was the Claude Agent SDK, which spawned its Claude Code binary for every turn: 212–217 MB of resident memory for that child alone during one live preflight turn (about 335 MB for the whole process tree, against about 105 MB for the in-process runtime; macOS arm64, sampled every 0.2 s), and its CLI added the host's date to the model's context. Production ran in-process from 2026-10-15, and the SDK was removed a week later (#102). `AGENT_RUNTIME` is no longer read; the startup check warns if it is still set.

**Agent hosting requirements:** outbound HTTPS to the AI provider, and HTTP requests allowed to run beyond the 90-second model deadline so terminal state and cleanup can finish; a short-lived edge handler is insufficient. Provider throttling still needs validation under real load. `AGENT_MAX_CONCURRENT_RUNS` (default 4) is a per-process limit, not a fleet-wide cap; a turn refused because every slot is taken answers `agent_server_busy`, or `agent_busy` when one of those turns is the same user's. Set the email credentials separately when enabling reports.

**Scheduled jobs** run in the backend process: weekly report emails via `node-cron` at 7 p.m. `America/Toronto`, scheduled only under `NODE_ENV=production` unless `WEEKLY_REPORT_ENABLED=true` (so a local backend never mails the users of the database it points at; `false` turns it off in production too), plus one hourly maintenance job that deletes stale unverified accounts, deletes old transactions for users who turned on automatic deletion, and, when agent storage is enabled, expires agent drafts and goal proposals and removes stale run/receipt/admission metadata. Nothing mounts them over HTTP. **`node-cron` must stay at 4.6 or later**: 4.2 computed the next Sunday as 2034 and never sent the email.

### Evaluating Pocky with fictional conversations

From `backend/`, build once with `npm run build`, then opt in to paid model turns:

```bash
AGENT_ENABLED=true npm run agent:eval
AGENT_ENABLED=true npm run agent:eval -- --case en-record-single,zh-record-single-no-currency --repeat 3
AGENT_ENABLED=true npm run agent:eval -- --json --min-pass 0.9
```

`CLAUDE_API_KEY` (the AI provider key) is read through the usual backend configuration (`.env` or environment). Run it with `AGENT_ENABLED=true npm run agent:eval`. Enabling the flag for this command only does not enable the deployed app. No database or migrations are needed. The runner replaces database queries and exchange rates with [`backend/eval/agent-fixture.json`](backend/eval/agent-fixture.json), blocks pool access, and rejects SQL it does not recognize. It executes the real runtime, tool validation, investigation and planning code. Its only external service is the AI provider; it never confirms a transaction or goal, writes financial data, or reads your accounts.

The 82 cases in [`backend/eval/agent-cases.json`](backend/eval/agent-cases.json) cover English, Chinese and mixed-language recording, dictated-style English (spelled-out amounts, filler words, no punctuation, mid-sentence corrections, cut-off recordings, real Whisper transcripts, and the `input: "voice"` flag the mic button sends), the reply language under the automatic setting, corrections, missing information, chat confirmation boundaries, record totals and comparisons, spending habits over a whole year or term, conversion, hostile record descriptions, plain-text replies, cash-flow scenarios (including expenses taken from recorded averages rather than invented, and payday counts quoted from the tool), goal proposals and out-of-scope investment questions. The conversation date is fixed at October 14, 2026, independent of the machine clock. All content is fictional; keep new cases and fixtures fictional too.

Each run reports successful/failed assertions, tool names, token usage and elapsed time. Failed reply assertions include a bounded excerpt; the key and raw provider errors are never printed. `--json` returns one report (use `npm run --silent agent:eval -- --json` to omit npm's banner). Exit status is 0 when every run passes, 1 for evaluation failures, and 2 for invalid arguments, fixture/case files or missing configuration. `--min-pass` deliberately relaxes the aggregate threshold; it does not hide individual failures. `--repeat` accepts 1–20; repeated `--case` flags and comma-separated IDs select cases.

Assertions require included record tools to succeed, forbid excluded handler calls, check tool arguments as the handler received them (`tools.anyOf`: at least one successful call matches, e.g. `spending_baseline` with `months` at least 12; `tools.everyCall`: every call to a tool must match, e.g. a `calculate_scenario` `start` that is absent or not before today), check draft counts/IDs/fields and goal proposals, and inspect reply text. Numbers ignore thousands separators and trailing decimal zeros; numeric expectations must match the sign as well. Regex assertions use multiline, case-insensitive matching. Tool names cover calls that reached application handlers (transaction proposals are inferred from the resulting draft), not schema-rejected attempts. The runtime's total call count supplies the maximum-call assertion. Usage is reported for completed turns only; failed turns may still incur provider charges.

The [October 15 acceptance record](backend/eval/reports/2026-10-15.md) includes captured fictional results, review findings and an offline replay command.

This is an opt-in behavioral evaluation, not a CI model-quality guarantee: replies are nondeterministic and text assertions cannot prove every sentence correct. Review failures against their prompt, fixture and expectation before changing either the agent or a case. The offline `agentEval.test.ts` suite runs under `npm test`, exercising the scorer, CLI exit codes and redaction, fixture isolation, and the real tools' fixture totals, pagination and goal versions without provider or database access.

### Deploying Pocky to production

`npm run agent:preflight` ([`backend/scripts/agentPreflight.ts`](backend/scripts/agentPreflight.ts)) checks a host and its database before and after each step below. It prints one `PASS|FAIL|WARN|SKIP` line per check and exits non-zero only on a FAIL. It prints booleans, counts and versions only: never a key, a connection string, a hostname or a row. Every database statement is a catalog read or a count inside a rolled-back `READ ONLY` transaction with a 5-second `statement_timeout`. A missing 013 is a FAIL only once `AGENT_ENABLED=true`, and host or network problems are FAILs only once both the flag and the key are set. Before that they are WARNs.

The order constraints: **frontend, then backend, then 014** (the previous frontend calls the removed watchlist endpoint, and the previous backend queries `ai_plans`). **013 before `AGENT_ENABLED=true`.** 015 is optional but recommended before enabling: without it goal proposals answer `agent_unavailable`.

0. **Rehearse locally (optional, recommended).** With Docker running: `docker compose -f docker-compose.test.yml up -d --wait`, then `backend/scripts/rehearse-linux.sh --live`. In a fresh `node:<.node-version>` container it runs `npm ci --include=dev`, loads the schema into the compose database (with SSL, as under `NODE_ENV=production`) and runs the preflight, including one fictional live turn. The source is streamed in without any `.env` file, and only `CLAUDE_API_KEY` is read from `backend/.env`, withheld from `npm ci`. It runs this machine's architecture; check an x64 host with step 3's preflight there.
1. **Check the host.** Confirm that the request timeout is longer than the 90-second model deadline and that the host can reach the provider over HTTPS.
2. **Deploy the frontend, then the backend,** with `AGENT_ENABLED` unset or `false`. The backend build (`npm ci --include=dev`) should use the Node version in `backend/.node-version`.
3. **Preflight before migrating.** On the host:

   ```bash
   cd backend && npm run agent:preflight
   ```

   Expect `WARN` for `migration.013`, `migration.014` (with the two tables' row counts) and `migration.015`, and `PASS` for `db.server_version` (PostgreSQL 15+), `db.transaction_sources` (0 incompatible values), `host.direct_client` and `network.anthropic`. Fix any FAIL before going on. A non-zero `db.transaction_sources` means 013 will abort; review those rows and do not rewrite them blindly.
4. **Apply the migrations** from your own machine, through a direct (non-pooled) database connection. 013 and 015 need PostgreSQL 15 or later, and each migration is idempotent:

   ```bash
   cd backend
   read -rs 'DIRECT_URL?Database URL: ' && export DIRECT_URL   # zsh; in bash: read -rsp 'Database URL: ' DIRECT_URL
   # Typed at a hidden prompt, so the connection string never reaches shell history.
   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f db/migrations/013_conversational_transactions.sql
   # Before dropping anything, look at what 014 will drop (counts only):
   psql "$DIRECT_URL" -c "SELECT (SELECT count(*) FROM watchlist) AS watchlist_rows, (SELECT count(*) FROM ai_plans) AS ai_plans_rows;"
   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f db/migrations/014_drop_watchlist_ai_plans.sql
   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f db/migrations/015_agent_goal_proposals.sql
   unset DIRECT_URL
   ```

   013 prints its source audit and aborts without changing anything if a row is incompatible. 014 prints only row counts. Run the preflight again: `migration.013`, `.014` and `.015` should now PASS.
5. **Enable.** Set `AGENT_ENABLED=true` and `CLAUDE_API_KEY` in the backend's environment, then redeploy.
6. **Live preflight.** On the host:

   ```bash
   cd backend && npm run agent:preflight -- --live
   ```

   This runs one fictional turn ("I spent 12.50 CAD on lunch today") through the real runtime against in-memory fake records. It touches no database. It reports the tool-call count, token counts and latency, or a stable `agent_*` error code, and never the prompt or the reply. Expect `PASS  live.turn  1 tool call(s), 1 row(s) proposed, …`.
7. **Smoke-test in the app** with fictional input only. Open `/agent`, send "I spent 12.50 CAD on lunch today", check the drafted row, and confirm it. Check that the transaction appears with the right day and currency. Undo it within ten minutes and check that it is gone. Then delete the conversation.
8. **Rollback.** Setting `AGENT_ENABLED=false` and redeploying turns off the agent routes and agent maintenance before any agent query. Leave the migrations in place and do not drop the agent tables: stored history and saved transactions stay intact for when the feature is turned back on. To stop model calls but keep history, edits, confirmation, undo and deletion working, remove `CLAUDE_API_KEY` instead and leave `AGENT_ENABLED=true`. `/agent/status` then reports that new turns are unavailable.

---

## Stack

**Backend** — TypeScript, Express 4, PostgreSQL via `pg`, JWT auth with `bcryptjs`, `express-validator`, `helmet`, `express-rate-limit`, `morgan`, `node-cron`, `nodemailer`.

**Frontend** — Next.js 15 (Pages Router), React 18, TypeScript, Tailwind CSS, Radix UI, Recharts, React Hook Form, `next-i18next`, SweetAlert2, react-hot-toast, Lucide icons.

**On-device OCR** — [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv6 small through [`ppu-paddle-ocr`](https://www.npmjs.com/package/ppu-paddle-ocr) and ONNX Runtime Web (single-threaded WASM, in a Web Worker); the benchmark uses `onnxruntime-node` and `@napi-rs/canvas`.

**On-device dictation** — Whisper `base.en` ([`onnx-community/whisper-base.en`](https://huggingface.co/onnx-community/whisper-base.en), 8-bit) through [Transformers.js](https://github.com/huggingface/transformers.js) `4.3.1` and its own ONNX Runtime Web `1.31.0-dev` build, in a module Web Worker, all self-hosted by `frontend/scripts/voice-assets.js`.

**Conversation runtime** — the [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) `0.135.0` (MIT), Zod `4.6.7`, against an Anthropic-compatible AI provider endpoint.

**External services** — an exchange-rate service for currency conversion, an address-validation service (optional), a configurable SMTP server for mail, and an AI provider for optional conversation recording. See the [Privacy Policy](https://www.termpocket.com/privacy) for where your data goes.

## Database

The original tables are `users`, `transactions`, `savings_goals`, `import_batches` and `access_tokens`. Migration `013` adds `agent_conversations`, `agent_messages`, `agent_runs`, `agent_drafts`, `agent_receipts` and `agent_admissions`. Compound foreign keys enforce owner and conversation associations. Saved transactions have no deletion dependency on conversations. Migration `014` drops the retired `watchlist` and `ai_plans` tables. Migration `015` adds `agent_goal_proposals` (goal changes awaiting the Confirm button); until it is applied, goal proposals are unavailable and nothing else is affected. Migration `016` adds `users.transaction_retention_terms` (automatic deletion; NULL, off, for everyone); until it is applied, Settings shows the option as unavailable and nothing is deleted. Migration `017` adds `users.terms_version` and `users.terms_accepted_at` (which terms each user accepted, and when; NULL for existing users, who are asked once after signing in); until it is applied, nobody is asked and nothing is stored. Migrations `018`–`021` tighten the original tables: owners required and the API's value rules enforced by CHECKs (018), an index matching the transaction list's `date DESC, id DESC` order (019), TIMESTAMPTZ timestamps (020, every instant kept), and one account per address whatever its case (021). The code works before and after them; deploy it first.

**Automatic deletion.** Off for every account unless its owner turns it on in Settings. A user keeps the last 3, 6, 9 or 12 terms (the current one included); the hourly maintenance run deletes that user's transactions dated before the first kept term's start, with the boundary from `utils/terms.ts`, so it removes whole terms and agrees with the dashboard's term view. Only transactions are deleted — goals, Pocky conversations, import records and tokens are not. At most 5,000 rows go per run across all users; the rest go on later runs. Each run audits one line per user with the user id and count only. The demo account is excluded: it cannot turn it on, and the sweep skips it. See [`backend/services/retentionService.ts`](backend/services/retentionService.ts).

**Account deletion.** Settings → Danger zone → Delete account asks for the password again, then `DELETE /auth/account` deletes, in one transaction, the user's rows in every per-user table (Pocky goal proposals, messages, drafts, receipts, runs, admission records and conversations, access tokens, import counts, savings goals, transactions), then the user row with its preferences and retention setting. Every one of those tables also cascades from `users`; the explicit deletes make the result independent of the deployed foreign-key actions and give the audit line its counts (user id and counts only). Admission records go too: they outlive *conversation* deletion so clearing history cannot reset the turn budget, but a deleted account has no budget left to use, and re-registering means a new user id and a verified address. The demo account refuses (`403 account_demo`). A Pocky turn running for that user in this process is aborted. See [`backend/services/accountService.ts`](backend/services/accountService.ts).

**Migration 016 (automatic deletion):** deploy the backend first (it tolerates the column's absence and notices it without a restart), then the frontend, then apply `016_transaction_retention.sql` with `psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f db/migrations/016_transaction_retention.sql` against a direct (non-pooled) database connection. It is additive and idempotent, and leaves every user off.

**Migration 017 (terms acceptance):** the same order: deploy the backend, then the frontend, then apply `017_terms_acceptance.sql` the same way. It is additive and idempotent. After it, every existing account sees the accept card once on its next visit; new sign-ups that ticked the box do not. To ask everyone again after changing the legal text, change `config.legal.termsVersion`.

`updated_at` is maintained by triggers. Monetary rows carry a `currency` column. `transactions.source` accepts `manual`, `ocr`, `ocr_llm` and `agent`; only confirmation writes `agent` rows. `import_batches` records counts for confirmed screenshot imports.

Agent messages and conversations have no automatic age-based deletion. Drafts expire 24 hours after the model proposal; manual edits and partial confirmation retain that deadline. Expiry is checked when read or confirmed. Terminal run metadata and admission records are removed after 30 days. Confirmation receipts retain request hashes, transaction IDs and exact transaction versions, without descriptions or amounts: they expire from storage after 30 days, or after the undo deadline once their conversation is deleted. The enabled hourly sweep performs physical cleanup; expiry remains enforced between sweeps. Deleting history also removes its runs, but retained admission records prevent deletion from resetting the hourly turn budget. Remembered facts (`agent_memories`) are kept until the user deletes them or the account. Memory offers expire after 24 hours, keep no copy of the fact once cancelled, expired, replaced or refused, and are deleted 30 days after they are decided; forgetting a fact redacts every offer that named it.

## Known gaps

The improvement backlog is retired; the reasoning for anything already fixed lives in the comment next to the code, and the rest is in git history.

- **Phone OCR speed is unmeasured.** Import takes about 1–2 s per image on a laptop; a phone browser may be several times slower. `POST /import/parse` takes OCR lines rather than an image, so a future native client could feed it Apple Vision or ML Kit output instead of the 45 MB WASM model — but the parser's layout thresholds were tuned against one specific engine, so `eval/` needs re-running before that output can be trusted.
- **Uber and Uber Eats imports can double-count** a card charge already imported from a bank screenshot. Duplicates are flagged only when the day, amount and currency all match.
- **Each new app layout needs its own parser rules.** Every layout added so far needed at least one measured spacing rule; an unsupported app shows the recognised text for manual entry.
- **The LLM fallback for screenshot import was not built.** The seven real screenshots tried so far were all read by the rule-based parser once their layouts were added; unsure rows report `ai_fallback_unavailable`.
- **`/summary/rolling` returns every transaction twice** and aggregates in Node — one user's year is a ~154 kB response. This is the gate on an *All time* view.
- **No frontend test runner**, so `lib/date.ts` and `lib/preferences.ts` are unguarded.
- **Locale files are unguarded** against category drift; the backend and frontend category lists are pinned to each other, the translations are not.
- **`LOG_LEVEL` is close to inert** — it gates `debug()` and nothing else.

## License

TermPocket is **source-available** under the [Functional Source License, Version 1.1, MIT Future License](LICENSE.md) (FSL-1.1-MIT).

- **You may** read, run, modify and self-host it for your own use, for non-commercial education or research, or to build something that is not a competing product.
- **You may not** offer it, or a modified version, as a commercial product or service that competes with TermPocket.
- **Each version becomes MIT** on the second anniversary of its release, with no restrictions.

The hosted app at [www.termpocket.com](https://www.termpocket.com) is free to use.

The license covers every version that includes `LICENSE.md`, starting October 2026. Earlier commits were published without a license; ask the maintainer if you need to use one of them.

The TermPocket name and Pocky are not licensed for use as your own product's name or branding.

## Contributing

Issues and pull requests are welcome. By submitting a contribution, you agree that it is licensed under the same terms as the project and that the maintainer may relicense it, including under a commercial license, as part of TermPocket.

For larger changes, open an issue first so we can agree on the approach.
