# TermPocket feature map

What the app has, how a user reaches it, which elements are stable to drive, and which `ctl drive`
flow proves it. Routes are headings of the form `` ### `/path` `` (several per heading allowed; a
heading with `→` lists redirects) so `npm run ctl -- map check` can diff this file against
`frontend/pages/`. Keep it current when a page, a label or an aria-label changes.

Conventions that hold everywhere:
- **Auth** is `localStorage` `token` (JWT) + `user` (JSON with `id`, `email`, names). No server session. A 401 anywhere logs the user out.
- **Locales**: English at `/x`, Chinese at `/zh/x` (`next-i18next`). Labels below are the English strings; selectors by role/label are the stable ones, class names are not.
- **Demo account**: `john.doe@example.com` / `password123`, seeded by `db:seed` with five terms of data anchored to today. It cannot clear its data, create access tokens, turn on automatic deletion, or delete the account (403s). Every `ctl up` reseeds it.
- **Dialogs**: Radix dialogs (`role=dialog`) for forms; SweetAlert2 (`.swal2-confirm`, `.swal2-cancel`) for confirmations and error alerts.
- **Selects** are Radix: click the `role=combobox` trigger, then `role=option` by name.
- **Money** renders as `$1,234.56`; negative net as `-$12.00` in red.
- **First-run tour** opens only for new accounts (never the demo); Settings → "Show tour again" sends `/?tour=1`.
- **Terms gate**: signed-in pages show an undismissable accept card when `GET /auth/terms` says required; never for the demo account.

## Public pages

### `/login`
- Form: `placeholder "Enter your email"`, `placeholder "Enter your password"` (show/hide button beside it), `form button[type=submit]` (disabled until hydrated). Errors from `/auth/*` render inline (the global interceptor skips them).
- Links: "Get Started Free" → `/register`; an intro dialog (features list) opens from the landing panel and closes with "Continue to Login".
- Success: `POST /auth/login` → `{ token, user }` stored, `router.push('/')`.
- Flows: `login`, `pages`.

### `/register`
- Fields: `#first_name`, `#last_name`, `#email`, `#password` ("Create a password"), `#confirmPassword`, a required unticked terms checkbox (`accept_terms`), submit. Registration sends a verification email; without `EMAIL_*` on the backend nobody can finish signup locally, so flows only render this page.
- Flows: `pages`.

### `/verify-email`
- Reads `?token=`; shows "Verifying…", then "Email Verified Successfully!" or "Verification Failed" with "Continue to Login". Without a token it shows the failure state.
- Flows: `pages`.

### `/privacy`, `/terms`
- `components/LegalPage.tsx`; text from the `legal` namespace. `/privacy#ai-providers` names the AI provider. Untranslated keys here look like `legal.x.y`.
- Flows: `pages`.

### `/investments` → `/`, `/ai-planning` → `/agent`
- Redirects in `next.config.js` for old bookmarks (removed features). Signed out they end on `/login`.
- Flows: `pages`.

## Signed-in pages

### `/`
- Dashboard. Header buttons (icon-only on small screens): `aria-label "Add Transaction"` → `/transactions/new`, `"Import from screenshot"` → `/import`, `"Settings"` → `/settings`.
- Period selector: a tab list (`role=tab`) "This term", "Last term", "This year", "Last year" (`GET /summary/rolling?term=current|previous` / `?year=current|previous`). A year is three Waterloo terms.
- Tiles: cards titled "Total Income", "Total Expenses", "Net Income", and the savings tile ("Savings goals"). Chart "Income vs Expenses · <period>", category chart with `role=tab` "Spending" / "Income". "Savings Goals" card → `/goals`. "Recent Transactions" card with per-row `aria-label "Edit Transaction"` buttons.
- New accounts also get a "Getting started" card (`onboarding.card.*`) and the tour.
- API: `/summary/rolling`, `/transactions?limit=…`, `/goals`.
- Flows: `login`, `dashboard`.

### `/transactions`
- Heading "Transactions". Buttons "Import from screenshot", "Add Transaction" (icon variants have the same aria-labels). Filters card: `placeholder "Search transactions..."`, type select ("All Types" / "Income" / "Expense"), category select ("All Categories" + each category).
- Rows: description, category badge, amount; `aria-label "Edit Transaction"` → `/transactions/edit/<id>`, `aria-label "Delete Transaction"` → SweetAlert2 "Are you sure?" with "Yes, delete it!" then a success alert.
- Paging: keyset `before=<cursor>` from `GET /transactions` (`nextCursor`), "Load more" when there is a cursor.
- Flows: `transactions`, `transaction-crud`, `import`.

### `/transactions/new`
- Type buttons "Expense" / "Income" (hidden `type` field), `#description`, `#amount`, currency select (default CAD; "CAD ($)", "USD ($)", "CNY (¥)", "EUR (€)", "GBP (£)", "AUD (A$)"), category select (`placeholder "Select a category"`, the canonical list from this file's exported `categories`), `#date` (`type=date`), `#notes`, "Cancel", submit. Success → `POST /transactions` then `/`.
- Flows: `transaction-crud`.

### `/transactions/edit/[id]`
- Same fields as new (`#description`, `#amount`, currency, `type`, category, `#date`), submit saves with `PUT /transactions/:id` and returns to `/transactions`. Reads its id client-side from `router.query`.
- Flows: `transaction-crud`.

### `/goals`
- "Add Goal" opens a dialog: `#name`, `#target_amount`, `#current_amount`, `#target_date` (required, not in the past), currency select, `#description`, "Create Goal" / "Update Goal". Cards show progress; per-card `aria-label "View Goal"` (detail dialog), an edit pencil, and a delete that confirms in a dialog then a SweetAlert2 "Goal deleted successfully!".
- API: `GET/POST/PUT/DELETE /goals`.
- Flows: `goals`.

### `/import`
- Heading "Import transactions". `EngineBanner`: "Downloading the reading model (N%)" → "Reading model ready" (OCR runs on-device from `/models` + `/ort`; nothing is fetched from a CDN). Drop zone with a hidden `input[type=file]` (PNG/JPEG/WebP, up to 5) and a "Choose files" button; per-image status "Read in N s", "Try again", `aria-label "Remove"`.
- Results: "Review" card with an editable table (`table tbody tr` per row), "Total selected", button "Import N transactions" → `POST /transactions/import` → toast "Imported N transactions" → `/transactions`. No rows: "No transactions found. The text we read is below…" with "Add manually".
- Fixtures: `eval/synthetic/*.png` with `*.truth.json` (bank lists; `bank-balance-01` has 10 rows).
- Flows: `import`.

### `/agent`
- Pocky. `aria-label "Back to dashboard"`, "New conversation", a `role=log` named "Conversation messages", composer label "Your message" with `placeholder "Tell me what you spent or earned, ask about your records, or correct a pending entry…"` (disabled unless `GET /agent/status` answers `available: true`), mic button `aria-label "Dictate a message (English only)"` → "Stop recording" while recording (hidden without `getUserMedia`/`MediaRecorder`), "Send".
- Drafts: editable pending rows with "Save selected (N)" / "Save all to transactions" / "Discard draft"; receipts with "Undo saved entries"; "Delete conversation" dialog; memory cards with Remember.
- Dictation states (text under the composer): "Speech model ready. Tap the microphone and speak in English.", recording timer, transcribing spinner, `role=alert` errors ("No speech was heard…", "Microphone access is blocked…"). The transcript lands in the textarea; it is never auto-sent.
- Backend flags: `AGENT_ENABLED` (storage) and `CLAUDE_API_KEY` (model turns). `ctl up` runs with storage on and a placeholder key, so `/agent/status` says available and the composer, Send and microphone are enabled; a turn sent that way fails at the provider (`agent_provider_error`) and costs nothing. Without a key the composer and microphone are disabled with "New messages are temporarily unavailable…"; with storage off the page shows only "Recording with Pocky is not enabled on this deployment". `CONTROL_AGENT=1 CLAUDE_API_KEY=… ctl up` enables real turns (paid).
- Flows: `agent`, `dictate`.

### `/settings`
- Heading "Settings". Cards: **Appearance** (theme `role=radiogroup` "Theme": Light / Dark / System; dark adds `html.dark`), **Preferences** (`#language` English / 中文 → switches the URL locale; default currency), **Notifications** ("Weekly Reports" switch `#weekly-reports`), **Automatic deletion** (`retention.*`: keep the last 3/6/9/12 terms; preview count in the confirm dialog; refused for the demo account), **AI connections** (personal access tokens for MCP: list, create with password, revoke; refused for the demo account), **Account Management** ("Show tour again" → `/?tour=1`, log out), **Danger zone** (a collapsed `<details>`; open its summary to reveal "Clear All Data" → dialog "Yes, Delete Everything", and "Delete account" with password). Flows open the summary and click nothing inside.
- Flows: `settings`.

## Backend surface the flows touch

- `GET /health` → `{ status: 'OK' }` (no database query).
- `POST /auth/login` `{ email, password }` → `{ token, user }`; `GET /auth/terms`.
- `GET /summary/rolling`, `GET/POST/PUT/DELETE /transactions`, `POST /transactions/import`, `GET/POST/PUT/DELETE /goals`, `POST /import/parse`, `GET /agent/status`, `GET /agent/*`.
- Rate limits are raised to 100000 by `ctl up` (`RATE_LIMIT_AUTH_MAX` is 5 per 15 min in production: a flow that logs in repeatedly would trip it).

## Known gotchas for drivers

- `next build` runs `prebuild` (OCR and voice asset checksums, ~160 MB on disk, no download when present). First `ctl up` takes a few minutes; later ones reuse the build while `git status` of `frontend/` and HEAD are unchanged.
- OCR and Whisper are single-threaded WASM; headless Chromium reads a synthetic screenshot in 2–10 s and loads the speech model in 10–60 s from local files.
- Chrome's fake microphone (`--use-fake-device-for-media-stream`) produces a tone: Whisper answers "no speech". `ctl drive dictate --audio say` feeds a spoken WAV synthesised with macOS `say` instead.
- The transactions list de-duplicates on append; a search is client-side on the loaded page.
- Dates are days (`YYYY-MM-DD`), never instants; `#date` inputs take that string with `fill()`.
