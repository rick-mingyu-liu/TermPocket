# TermPocket — status and plan

As of 2026-10-17. Update this file when a step below completes; git history keeps the earlier versions.

## Summary

Pocky, TermPocket's bilingual assistant, can now record, investigate and plan. It is live in production as of 2026-10-15: migrations 013 and 015 are applied, the agent is enabled, and the production preflight passes with a live model turn.

- **Built:** recording transactions by chat with button-only saving, read-only questions about your own spending, and planning (cash projections, savings-goal proposals). The stock watchlist and the old one-shot AI plans are removed.
- **Production:** the agent is enabled (`AGENT_ENABLED=true`) with its AI provider key; the production database has all three agent migrations: 013 (conversations), 014 (legacy `watchlist` and `ai_plans` dropped) and 015 (goal proposals). The runbook is the README section "Deploying Pocky to production", and `npm run agent:preflight` checks each step.
- **Since 2026-10-15:** TermPocket has its own domain (https://www.termpocket.com) and sends mail from it through Resend. Privacy policy and terms are drafted and linked, account deletion and a stored, enforced retention setting exist, and Pocky runs on the in-process runtime. See "Merged 2026-10-15 to 2026-10-17".
- **Next:** the remaining owner checks before a public post (see "Next"), a week of real use of Pocky, then Pocky memory, shaped by what real use shows.

## What is merged

The twelve original feature and deployment pull requests below landed between 2026-10-14 and 2026-10-15 (UTC). GitHub confirms that each passed the backend and frontend CI jobs before merge. PR [#65](https://github.com/rick-mingyu-liu/TermPocket/pull/65) also has a failed GitGuardian check: its finding points to the deliberately fictional `FAKE_PASSWORD` in [`agentPreflight.test.ts`](backend/test/agentPreflight.test.ts), used only with a stub database and an `.invalid` hostname. Code inspection identifies this as a test-fixture false positive; the historical check remains failed.

| PR | Merged | Change |
| --- | --- | --- |
| #65 | 2026-10-15 | Pocky deploy preflight (`npm run agent:preflight`), Docker test database and Linux rehearsal of the production host, Node pinned to 22, production runbook |
| #64 | 2026-10-15 | Zone-less timestamps read and written as UTC on any host (off UTC, an expired verification link was accepted for 4 more hours) |
| #63 | 2026-10-15 | Planning: spending baseline, cash projections, savings-goal proposals confirmed by button; migration 015 |
| #62 | 2026-10-15 | Stock watchlist and AI plans removed; migration 014 drops their tables |
| #61 | 2026-10-15 | Investigation: read-only spending summaries, comparisons and record listing |
| #60 | 2026-10-15 | Term label locale key renamed to its English text |
| #59 | 2026-10-15 | Recording: chat drafts, button-only confirm, undo, conversation history; migration 013 (built by Codex, then reviewed and fixed) |
| #58 | 2026-10-14 | Legacy one-shot planning and stock features retired |
| #56 | 2026-10-14 | AI provider switched to DeepSeek |
| #55 | 2026-10-14 | Self-service MCP connections and term-pace comparisons |
| #54 | 2026-10-14 | Hourly maintenance, so the database can scale to zero |
| #53 | 2026-10-14 | Rebrand from MindGo to TermPocket |

## Production

On 2026-10-15 the production host was found to be on a plan without shell access, so the owner upgraded it and enabled the agent. Migrations 013 and 015 were then applied to the production database through its direct endpoint (013's audit: 0 incompatible rows). The preflight on the host with `--live` passed: 17 PASS, 1 WARN (014), 0 FAIL. Migration 014 followed the same day, on the owner's decision that the stock watchlist and AI plans will never return: it dropped 23 `watchlist` rows and an empty `ai_plans` table. The production database was 8.7 MB afterwards.

| Item | State |
| --- | --- |
| Frontend and backend | Both auto-deploy from `main`. The production frontend build calls the production backend (checked in the served JavaScript, 2026-10-15) |
| Domain | termpocket.com (Namecheap). The site is https://www.termpocket.com; the apex redirects to www, and the old frontend URL redirects (307) to www, keeping the path and query. `CORS_ORIGIN` is a comma-separated list (#120) with www, the apex and the old frontend URL; `FRONTEND_URL` is the www address |
| Email | Sent through Resend SMTP (#122 made `EMAIL_HOST`, `EMAIL_PORT` and `EMAIL_FROM` configurable), from `TermPocket <noreply@termpocket.com>`. The domain is verified in Resend; the owner tested that mail delivers. Namecheap forwards `privacy@`, `support@` and `noreply@` to the owner's Gmail |
| Backend host | Starter instance (0.5 CPU, 512 MB), in a region next to the database since 2026-10-15; one instance, build `npm ci --include=dev`. The previous service in another region is suspended, kept for rollback. One SDK turn measured about 240 MB for its child process, so `AGENT_MAX_CONCURRENT_RUNS` defaults to 1 (#88); the direct runtime (#89, `AGENT_RUNTIME=direct`) measured about 105 MB for the whole process. Production has run `AGENT_RUNTIME=direct` since 2026-10-15 per the description of #102; the host preflight output has not been pasted into the repo (owner check) |
| Migration 016 (retention) | Merged in #103 and additive. This repo does not record that it was applied to the production database: owner check (until it is, Settings shows automatic deletion as unavailable and nothing is deleted) |
| Production PostgreSQL and source audit | PostgreSQL 17.11; 0 incompatible transaction source values; read-only preflight |
| Migration 013 (conversations) | Applied 2026-10-15: 6/6 agent tables, source check allows `agent` |
| Migration 014 (drop `watchlist`, `ai_plans`) | Applied 2026-10-15: 23 watchlist rows and 0 AI plans dropped, by the owner's decision |
| Migration 015 (goal proposals) | Applied 2026-10-15: `agent_goal_proposals` present |
| `AGENT_ENABLED` and the AI provider key | Set 2026-10-15. The `--live` preflight turn (1 tool call, 1 drafted row, 8,109 in / 201 out tokens, 3.8 s) confirms the key works |
| Host checks | `/tmp` writable, linux-x64 glibc, Node 22.23.3, SDK binary launches, DeepSeek reachable (preflight on the host) |

The owner's work machine's Zscaler proxy blocks termpocket.com as a "Newly Registered Domain". That is the proxy, not the site.

Turning Pocky on is the runbook in the README. In short: deploy, run the preflight on the host, apply 013, 014 and 015 through the database's direct endpoint, set the two variables, run the preflight with `--live`, then smoke-test in the app with fictional input.

## Merged 2026-10-15 to 2026-10-17

Pull requests merged after the table above, grouped by theme. Each passed CI before merge.

| Theme | PRs |
| --- | --- |
| Pocky runtime and limits | Direct in-process runtime ([#89](https://github.com/rick-mingyu-liu/TermPocket/pull/89), hardened in #93 and #99); concurrency cap (#88) and `agent_busy` for the user's own turn (#100); per-user cap of 60 turns a day and all-users cap of 600 (#90); planning limit and habits fixes (#84, #87); test flake (#91) |
| Pocky evaluation | Explicit year in a plan case (#112); scenario occurrence counts (#113) |
| Pocky and product features | Enter to send in Pocky, safe with IME composition (#128); in-app MCP setup dialog (#129, sized for small screens in #132); goal top-up suggestion card on Goals (#130) and dashboard badge (#131); first-run onboarding tour with a "Show tour again" button in Settings (#135); 200 transactions per page (#83) |
| Data and accounts | Retention setting stored and enforced, migration 016 (#103); account deletion from Settings (#114); demo refresh driven by staleness (#95) |
| Email | Configurable SMTP (#122); redesigned emails with a shared layout, HTML escaping of user-typed values (this fixed an injection in the verification email's first name), CAD conversion, term-so-far and goals with progress bars (#124); leftover-to-goal section in the first weekly report of each month (#134); weekly report gate (#105). A failed MailboxLayer SMTP probe no longer rejects a registration (#126): university mail refused probes |
| Domain and hosting | `CORS_ORIGIN` as a list (#120); backend moved next to the database (#92); frontend skips unchanged builds (#98); FSL license (#96) |
| Legal and contact | Privacy policy and terms drafts (#101, #104); contact addresses in the legal pages and the login "Contact Us" (#121); GitHub-linked operator name (#123); wording: run from Canada, DeepSeek and China mentioned once, Resend rather than Gmail, "snowfluke" in acknowledgements (#127); governing law Ontario with users' own consumer protections (#133); 13+ with parent or guardian permission under the age of majority, and Quebec: the person in charge of personal information named (Mingyu Liu, `privacy@`), complaint rights to the OPC and the CAI, withdrawing consent (#136) |
| i18n | Eight pages used `getServerSideProps` and got an empty translation store on the hosted frontend (a raw `legalConsent` key on /register, Chinese pages in English); they now use `getStaticProps` and `localePath` (#125), verified on production; `check:locales` covers all namespaces (#107) |
| QA and security fixes | Token URLs redacted from logs (#108); analytics strips the query string (#106); QA findings (#97, #109, #110, #111, #115, #116, #118, #119) |
| Docs | Phase 2 plan (#82, #85); Pocky live (#81); hosting region (#80, #92) |

Not done on the legal side: a French version (Quebec's Charter of the French language), a written privacy impact assessment for transfers outside Quebec (the policy deliberately makes no claim of one), and review by someone qualified. "Pocky" is a Glico trademark, flagged as a naming risk; the owner has not decided.

Decision on goals: the owner chose a "suggested top-up" (#130, #131, #134) and dropped automatic linking of savings transactions to goals as too much.

## Open PRs

| PR | State |
| --- | --- |
| [#94](https://github.com/rick-mingyu-liu/TermPocket/pull/94) | Dictated-style English evaluation cases and a bare "dollars" meaning the conversation currency. Awaiting owner review |
| [#102](https://github.com/rick-mingyu-liu/TermPocket/pull/102) | Draft: remove the SDK runtime. Gated until about 2026-10-22, after a week of direct in production, a pasted production host preflight, and no open PR touching `runtime.ts` |
| [#86](https://github.com/rick-mingyu-liu/TermPocket/pull/86) | Draft: English voice dictation design and spike. Superseded by `feat/voice-input` |
| [#140](https://github.com/rick-mingyu-liu/TermPocket/pull/140) | Draft: voice spike round 2 (words prompt, dictated flag). Superseded by `feat/voice-input` |
| `feat/voice-input` | Voice dictation in Pocky's chat: on-device Whisper `base.en`, self-hosted, `input: "voice"` flag. Needs a phone check on the preview |

## Next

Owner checks before a public post (none can be verified from the repo):

- A DeepSeek provider-side spending limit or prepaid balance. The app-side caps are done (#90).
- `DEMO_REFRESH_ENABLED=true` in production.
- Whether migration 016 is applied to the production database.
- Screenshot import timed on a mid-range phone.
- Optional review of the privacy policy and terms by a lawyer or a clinic; when to do the French version and the Quebec impact assessment.
- The name "Pocky".

## Evidence and limitations

The [CI run for merge commit `7609cf3`](https://github.com/rick-mingyu-liu/TermPocket/actions/runs/38760784901) confirms 783 backend tests passed with none skipped. The earlier handoff reports live DeepSeek checks on fictional data matching SQL or a hand calculation; those historical checks are distinguished below from fresh verification.

- **Tests:** 783/783 backend tests against PostgreSQL 17. They cover isolation between users, concurrent confirms, stale goal versions, migrations applied twice, and process/database timezone combinations. Frontend build, lint and locale checks pass; two existing hook-dependency warnings remain. The frontend has no test runner.
- **Historical live model checks (from the handoff):** term totals, comparisons with last term, top expenses, a February total including its last day, Chinese questions, a 3-month baseline, a projection low point of −10,020.00 on 2027-01-05, and 6,200 over 18 months = 344.45 a month. Stock advice was declined. "Record this and answer that" drafted the entry without saving it.
- **Historical Linux rehearsal (from the handoff):** 18/18 preflight checks passed in a fresh Node 22 container, including one live turn (1 tool call, 1 drafted row, about 3.5 s). This does not verify the production host.
- **Historical browser checks (from the handoff):** the goal card, Confirm, the conflict warning and the phone layout were checked at desktop width and 375 px, in light and dark.
- **Fresh local read-only preflight:** 14 PASS, 3 WARN (migrations 013–015), 0 FAIL, 1 SKIP (live turn). The host was macOS arm64, not the production host. No migrations or application writes were performed.
- **Fresh evaluation acceptance:** 36 fictional cases through real DeepSeek and in-memory record tools. The original run scored 35/36 because an assertion incorrectly rejected "nothing has been saved." After a narrow assertion correction, captured results score 36/36, and three new confirmation repetitions pass 3/3. These are distinct measurements, not a second full live run. The [acceptance report](https://github.com/rick-mingyu-liu/TermPocket/blob/feat/agent-eval/backend/eval/reports/2026-10-15.md) preserves the original results, correction, token counts and remaining wording limitations. The evaluation branch passes 801/801 backend tests with no skips on Node 22 and disposable PostgreSQL 17; independent review is complete.

Limitations:

- Currency conversion uses today's rates. The new model evaluation covers mixed currencies with fixed fictional rates; the live exchange-rate service was not exercised by that evaluation.
- Monthly goal targets count whole calendar months, so they err high.
- The prior x64 Linux rehearsal failed under emulation on this Apple-silicon Mac. A check on the production host is still needed to verify the deployed x64 runtime.
- There are no saved plans or remembered facts yet, so planning inputs must be repeated in each conversation.
- The on-screen privacy notice does not name DeepSeek, by the owner's decision. DeepSeek is named in Open Source Acknowledgements.

## Hardening

The two hardening branches have been recovered from the interrupted session. Production migrations and agent enablement remain separate operator actions.

| Branch | What it adds | Done when |
| --- | --- | --- |
| `feat/agent-eval` — [PR #67](https://github.com/rick-mingyu-liu/TermPocket/pull/67) | 36 fictional prompts in English, Chinese and mixed, with expected tools, rows, goal proposals and reply checks. `npm run agent:eval` runs them against real DeepSeek. | Merged after independent review and all CI checks passed; harness, full backend tests and live acceptance complete. |
| `chore/dependency-upgrades` — [PR #66](https://github.com/rick-mingyu-liu/TermPocket/pull/66) | Backend audit clean; Next.js 15.5.28 retains React 18 and the Pages Router. Backend 783/783 tests, frontend build/lint/locales and HTTP route checks pass; independent review and all PR CI checks pass. | Merged with the owner's explicit approval to ship verified fixes while tracking the remaining findings. **Zero-high objective remains open:** frontend has 7 high and 2 moderate package findings from build-tool dependencies (`braces`, `postcss-selector-parser`). Details: [`frontend/DEPENDENCIES.md`](frontend/DEPENDENCIES.md). |

Ongoing dependency maintenance is configured in [`.github/dependabot.yml`](.github/dependabot.yml): weekly checks for the three npm projects and GitHub Actions, grouped minor/patch updates, separate major version PRs and separate security-update groups. Updates still require review and CI; no auto-merge is configured.

The first Dependabot round was resolved on 2026-10-15, and CI passed on `main` after each merge:

| PR | Update |
| --- | --- |
| #70 | `eval/` minor/patch group (2 packages) |
| #72, #73 | `actions/setup-node` and `actions/checkout` 4 → 7 |
| #74 | Backend minor/patch group (8 packages) |
| #75 | `helmet` 7 → 8.3.0 (merged after resolving a conflict with #74) |
| #76 | `express-rate-limit` 7 → 8.7.1 |
| #77 | Frontend minor/patch group (13 packages), with coordinated Radix patch versions |
| #78 | `lucide-react` 0.292 → 1.55.0 |
| #71 | Closed without merging: removing the vulnerable `postcss-selector-parser` pulled in Tailwind 4 without migrating the PostCSS configuration, and CI failed (see [`frontend/DEPENDENCIES.md`](frontend/DEPENDENCIES.md)) |

After that round, `npm audit` reports 0 findings for the backend and `eval/`. The frontend still has 7 high and 2 moderate findings, all in the build and lint toolchain (Tailwind 3's `chokidar`/`fast-glob`/`braces` chain and `eslint-config-next`).

## Plan

The next phase, from launch readiness to voice input, is in [`docs/PHASE-2.md`](docs/PHASE-2.md).

Launch preparation and hardening can proceed in parallel. Verify both gates before the week of real use, then build memory from the observed failures.

| Step | Work | Gate before the next step |
| --- | --- | --- |
| 1. Go live | Backend on a paid instance, migrations 013–015 applied, agent enabled, `--live` preflight passes. The planning limit found in the first real use was fixed (#84, #87). The in-app smoke test is not recorded here: owner check | A fictional lunch can be drafted, confirmed and undone in the app, and a planning question completes |
| 2. Harden (alongside 1) | Evaluation set and dependency upgrades are merged; the remaining frontend advisories are build-time only and left open until a Tailwind 4 migration after launch (owner decision, 2026-10-17) | One live evaluation run reviewed (done); the open advisories are accepted, not cleared |
| 3. Real use | Record real spending with Pocky for a week; note what it gets wrong | Real failures listed and added to the evaluation set |
| 4. Memory | Remembered facts (rent, co-op pay, reserve) with Remember and Forget, saved plans, per-account currency, timezone and reply language | Deleting a fact removes it from everything Pocky sees, and the evaluation set still passes |
| 5. Later | Dashboard summaries computed in SQL (unblocks an All time view), a frontend test runner | — |

Decisions needed from the owner:

- [x] Backend instance type: upgraded from the free plan on 2026-10-15. Revisit a larger instance (2 GB) if the preflight or real use shows memory pressure.
- [x] Migrations 013 and 015 applied on 2026-10-15.
- [x] Migration 014 applied on 2026-10-15 (the owner confirmed both features are gone for good).
- [x] `AGENT_ENABLED=true` and the AI provider key are set in production.
- [x] Domain and email provider: termpocket.com, Resend (2026-10-16).
- [x] Dependabot: the 2 open alerts (`braces` high, `postcss-selector-parser` moderate) are build-time only, via Tailwind 3 and `eslint-config-next`, and no patched `braces` release exists. On 2026-10-17 the owner decided to leave them open and revisit with a Tailwind 4 migration after launch ([`frontend/DEPENDENCIES.md`](frontend/DEPENDENCIES.md)).
- [ ] DeepSeek spending: the app-side caps exist (60 turns a day per user, 600 across all users). A provider-side limit or prepaid balance is an owner check.
