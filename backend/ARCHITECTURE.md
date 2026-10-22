# TermPocket Backend — Architecture & Design Patterns

The backend is a **layered MVC-style Express REST API**. It follows a
`route → middleware → controller → service → database` layering. The agent router performs its own orchestration over separate storage and runtime services, without a controller shim. There is **no
traditional Observer pattern** — the closest thing is a time-driven scheduler.

## Request flow

```
Client (frontend / axios)
        │  HTTP  (Authorization: Bearer <JWT>)
        ▼
┌─────────────────────────────────────────────────────────────┐
│  app.ts — global middleware chain                            │
│  helmet → morgan → cors → express.json()                     │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  routes/*.ts   (URL → handler mapping)                       │
│    router.use(auth)              ← auth middleware           │
│    body([...]) validators        ← express-validator        │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  middleware/                                                 │
│    auth.ts       verifies JWT, sets req.user.userId          │
│    rateLimiter.ts  authLimiter, per-route on 4 /auth routes  │
│                    apiLimiter, general API budget           │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  controllers/*.ts   (the "C")                                │
│    - checks validationResult(req)                            │
│    - reads req.user.userId                                   │
│    - orchestrates services + DB                              │
└─────────────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
┌───────────────────────┐   ┌─────────────────────────────────┐
│ services/*.ts         │   │ db/connection.ts                │
│  email, exchangeRate, │   │  query(text, params)            │
│  moneyFacts, tokens, │   │  lazy pool, auto-close after    │
│  cleanup, import     │   │  5 min idle                     │
└───────────────────────┘   └─────────────────────────────────┘
        │                              │
        ▼                              ▼
   External APIs                   PostgreSQL
   (exchange rates,               (users, transactions,
    address validation,            savings_goals, access_tokens,
    SMTP, DeepSeek)                import_batches, agent_*, legacy tables)
        ▲
        │  cron / hourly timer (out-of-band, not request-driven)
┌─────────────────────────────────────────────────────────────┐
│  services/schedulerService.ts  (Singleton)                   │
│    weekly report emails + hourly maintenance                 │
└─────────────────────────────────────────────────────────────┘
        │  calls down into  →  services/cleanupService.ts
        │                     services/agent/store.ts (when enabled)
```

Two of those arrows carry types. `auth.ts` sets `req.user`, and
[types/express.d.ts](types/express.d.ts) merges `AuthUser` into Express's own
`Request`, so every controller reads `req.user.userId` as a `number` without a
cast or a guard. Controllers name the row shape where they query —
`query<TransactionRow>(sql, params)` — because `query()` is generic but cannot
infer a shape from a SQL string; the interfaces are one per table in
[types/db.ts](types/db.ts). `types/` holds those two and
[types/import.ts](types/import.ts), the screenshot parser's vocabulary.

The global middleware runs in the order drawn, but two things sit outside it:
`app.set('trust proxy', 1)` comes first — the rate limiters read
`X-Forwarded-For`, and Render terminates TLS in front of the app — and
`apiLimiter` is mounted globally *before* the routers, not after them.

## Response / error flow

- Controllers return JSON directly.
- A **global error handler** and **404 handler** are mounted last in `app.ts`.
- On the frontend, `utils/api.ts` interceptors handle `401` (logout) and
  `403/404/500` (SweetAlert dialog) globally. `/agent` errors are handled by its
  caller through application-owned codes; authentication failures still log out.

## Patterns in use

| Pattern | Where | Notes |
|---|---|---|
| **Layered MVC** | `routes/` → `controllers/` → `services/` → `db/` | Primary organizing pattern. No `View` (JSON API); the frontend is the view. |
| **Chain of Responsibility** | Express middleware pipeline | `helmet → cors → json → auth → validation → controller → error handler`. |
| **Strategy + fallback** | Address validation | MailboxLayer → local domain list; provider failure never blocks registration. |
| **Singleton** | `schedulerService` (single class instance holding a `jobs` Map of `{ job, kind }`); lazy DB pool | One shared instance each. `kind` is `'cron'` or `'interval'` — it is what tells `stop()` which API it is holding, since the two job types share no methods. |
| **Scheduler / publish-on-timer** | `schedulerService` (`node-cron` + self-rearming timers) | Time-driven, **not** Observer. |

## Is there an Observer pattern?

**No.** A true Observer has objects *subscribing* to a subject and being
*notified on its state changes*. This codebase has nothing like that. The
scheduler reacts to **time events**, not to state changes in another object —
that's the Scheduler pattern. (Node's underlying `EventEmitter` is
observer-based, but no custom emitters/listeners are defined here.)

## Where the layering leaks

These are minor and common in Express apps, but worth noting:

1. **No `models/` layer.** SQL lives directly in controllers — e.g.
   `transactionController.ts` calls `db.query(...)` 10 times. The "Model" is
   thin/absent, so it's really **Route–Controller–Repository**, not full MVC
   with an ORM. Business + data-access concerns are mixed in the controller.

2. **Every controller imports services** (all 6 do), which is fine — but
   combined with (1), the controller ends up doing both orchestration *and*
   raw persistence.

### Resolved

- **Service imported controllers (inverted dependency).** `schedulerService.ts`
  used to `require` `authController` and `aiController` in order to call
  `autoDeleteOldAIPlans` and `deleteUnverifiedAccounts`. Both moved to
  [services/cleanupService.ts](services/cleanupService.ts), and the scheduler
  depends downward. (The AI-plan half has since been removed with the
  feature; see below.)

  An earlier draft of this document said that cleanup logic was *"reused by
  both HTTP routes and the scheduler"*. That was wrong — no route ever mounted
  either function; they took no `(req, res)` and never sent a response. The fix
  was a move, not a split; three timer bugs were found alongside it.

- **Address validation lived in the controller.** `authController` held a
  30-domain disposable list, an apilayer client and the verdict logic, ~60
  lines above the controller object. All of it is
  [services/emailValidationService.ts](services/emailValidationService.ts) now;
  the controller makes one call, `validateEmail(email)`.

  This is a **strategy/fallback** instance: MailboxLayer is the primary, the domain list is the fallback,
  and the caller sees one function and one result shape (`{ valid, reason?,
  source }`). The rule it encodes — **a validator that cannot reach its service
  must not become a gate** — matters because the previous version turned a
  missing key, an outage, an expired key and an exhausted quota all into a
  blocked registration, three of them silently.

## Bottom line

- **Yes to MVC** — clean, idiomatic Express layering.
- **No traditional Observer** — the scheduler is time-driven.
- Supporting patterns: **middleware chain**, **strategy/fallback**, **singleton**.
- Main structural smell remaining: the absent model layer. The scheduler's
  upward dependency on controllers is fixed.

## Removed features

The stock watchlist and one-shot AI planning are removed entirely. Their routers (`/investments`, `/ai`), controllers, the `/goals/from-ai-plan` route, the AI-plan expiry filter and its hourly cleanup are gone, so those paths fall through to the global 404. Migration `014_drop_watchlist_ai_plans.sql` drops the `watchlist` and `ai_plans` tables; deploy the code before applying it. The optional `/agent` recording flow separately calls DeepSeek. MCP financial facts, imports, manual transactions and savings goals remain active.


## Conversation recording

The first implemented slice proposes income/spending entries and corrects a pending batch in English, Chinese or mixed text. The frontend `/agent` page provides persistent conversations, visible currency/timezone/language, editable/selectable drafts, explicit confirmation, cancellation, recovery and batch undo. It contains no voice input, durable facts, conversation summaries, financial planning or spending-query tools. `/ai-planning` redirects to this page; one-shot generation is removed, not restored.

```text
JWT-authenticated POST /agent/conversations/:id/messages
  → strict application input validation + process slot
  → store.beginTurn: owner lock, request identity, admission, user message
  → release database transaction
  → runtime.runAgent: in-process tool loop over HTTP → DeepSeek
      ↔ one in-process MCP tool: propose_transactions
         validate whole pending batch; return pending_review only
  → store.finishTurn: recheck owner/run/lease, persist reply and draft revision
  → application-owned ConversationState JSON

User reviews version + selected row IDs and presses Confirm
  → store.confirmDraft: one transaction, request-key replay check
      → INSERT transactions(source='agent')
      → minimal receipt + new draft revision for remaining rows
```

### Boundaries and write safety

[routes/agent.ts](routes/agent.ts) derives identity exclusively from the verified JWT. [services/agent/types.ts](services/agent/types.ts) defines HTTP/service shapes independently of the provider client. [validation.ts](services/agent/validation.ts) validates decimal-string money, real calendar days, categories and currencies. PostgreSQL compound foreign keys enforce owner and conversation associations in addition to service checks.

[store.ts](services/agent/store.ts) uses dedicated clients and short transactions, locking the owning user before conversations/receipts. A provider request never holds a database transaction open. Immutable draft revisions make confirmation version-bound. Confirmation hashes the conversation, version and sorted selection under a per-user request UUID; matching retries return existing state, while a changed request conflicts. Partial confirmation atomically writes selected rows and preserves remaining rows in a new revision.

The model only proposes rows. Chat messages such as “yes” cannot authorize financial writes. Ten-minute undo checks all transaction IDs and their exact PostgreSQL timestamp text plus tuple versions before deleting anything; an edit or deletion causes the whole undo to fail. Conversation deletion cascades history, runs and drafts, but has no cascading relationship to saved financial transactions. A minimal detached receipt can still support undo until its deadline.

### Runtime isolation and resource bounds

[runtime.ts](services/agent/runtime.ts) runs the tool loop in the backend process with the plain Anthropic client (`@anthropic-ai/sdk` `0.135.0`, loaded lazily on the first turn) against DeepSeek's Anthropic-compatible endpoint, `deepseek-flash` by default, and Zod `4.6.7` schemas. Every client option is explicit (key, no bearer token, logging off, OpenTelemetry spans and trace headers off), so nothing comes from the host's `ANTHROPIC_*` variables. The request carries only the system prompt, the JSON envelope, the eight tools' schemas and their results; there is no child process, temporary directory or session transcript. Tool handlers have no ledger-write or arbitrary shell/filesystem/SQL/network capability. Until 2026-10 the same loop ran through the Claude Agent SDK, which spawned a ~240 MB CLI process per turn and injected the host's date; it was removed after a week of production on the in-process loop.

Every `tool_use` block counts as an attempt before its name or arguments are checked, and the handler separately limits executions. The handler checks the server-owned run-revocation callback before running. Unknown tools and schema failures are answered with an error code and the turn goes on. `AbortController`, the request deadline and storage run/lease checks prevent late output from publishing after cancellation or deletion; each handler is raced against the turn, so a hung query cannot hold it past the deadline. Cross-process cancellation is enforced at tool invocation and final publication.

| Bound | Enforcement |
|---|---|
| One live run per user; 20 new turns per rolling hour | PostgreSQL owner lock, active-run index and admission records |
| Four active model requests per process | Router admission; not a fleet-wide semaphore |
| 100 conversations per user; 200 messages per conversation | Storage admission |
| 4,000 input characters; 30 history messages / 24,000 history characters | Validation and context construction |
| 12 pending rows | Tool schema, validation and database constraint |
| Eight tool attempts/executions; ten model turns | Runtime attempt gate, handler and loop |
| 4,000 generated tokens; 8,000 final reply characters; 32,000 cumulative tokens | Provider output option and runtime accounting |
| 16,000 cumulative tool-output characters | Runtime handler |
| 90-second execution / run lease | Router/runtime deadlines and storage checks |

Usage stores the provider's real token counts. Raw provider errors and conversation text do not enter operational logs. The runtime maps failures to stable `agent_*` codes; any stop other than `end_turn` without tool calls is `agent_provider_error`, and `max_tokens` is `agent_limit_exceeded`.

### Availability, privacy and retention

`AGENT_ENABLED=false` leaves `/agent/status` available but blocks all other agent routes before database access and omits agent cleanup from maintenance. It does not erase existing data. `AGENT_ENABLED=true` means migration `013` is installed and storage access is enabled. Without `DEEPSEEK_API_KEY`, only new model turns are unavailable: history, draft edits, confirmation, undo and deletion still work.

TermPocket stores messages until the user deletes the conversation. It sends the current message, bounded relevant history, pending draft and date/currency/timezone context to DeepSeek. Authorized administrators can access stored conversations. There is no end-to-end encryption guarantee and no promise that deleting local history erases provider-held data. The frontend discloses these boundaries; passwords and account credentials should not be submitted.

Drafts expire 24 hours after the model proposal, enforced during reads/writes. Manual edits and partial confirmation preserve the deadline. Existing hourly maintenance removes expired drafts, terminal runs and admission records older than 30 days, and receipts after 30 days or after undo expiry when their conversation has been deleted. Receipts contain request hashes, transaction IDs and exact versions, not transaction descriptions or amounts. Admission records survive history deletion, preventing a budget reset through chat deletion. Messages survive run-metadata cleanup through a column-specific nullable run foreign key. No periodic polling, extra frequent cleanup schedule or provider-side transcript store is introduced.

### Deployment and validation

Fresh `schema.sql` and migration [`013_conversational_transactions.sql`](db/migrations/013_conversational_transactions.sql) require PostgreSQL 15+ for column-specific `ON DELETE SET NULL`. The migration audits transaction-source compatibility and aborts rather than rewriting incompatible financial records. Apply and verify locally or in staging first; production migration/enablement is a separate operator action, not performed by this implementation. Leave the feature flag false until its tables exist.

The backend host must allow outbound HTTPS to `https://api.deepseek.com/anthropic` and allow HTTP requests longer than the 90-second deadline plus teardown. This is a Node-hosted backend feature. Local live-provider acceptance covers bilingual input, corrections, multiple tool roundtrips, hypotheticals, missing details, cancellation, deadlines and errors; target-host Linux compatibility, capacity and throttling still need verification.

Unit tests cover validation, HTTP isolation, runtime restrictions and maintenance without provider access. Storage and fresh/upgrade migration tests require explicit `TEST_DATABASE_URL` and isolated fictional data; they must never borrow a production database from `.env`.
