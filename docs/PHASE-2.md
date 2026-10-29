# TermPocket — phase 2 plan

Drafted 2026-10-15. Updated 2026-10-20. Phase 1 put Pocky into production: recording, investigation and planning, live in production with migrations 013–015 applied ([`STATUS.md`](../STATUS.md)). Phase 2 takes TermPocket from "works for its owner" to "safe to post publicly", and adds voice input.

## Goals

1. **Public launch.** Strangers can sign up without risking their data, the owner's bill, or a broken first impression.
2. **Pocky, proven by real use.** A week of real recording shapes the fixes, and the evaluation set grows from real failures.
3. **Voice dictation.** Speak an entry in English (Chinese and mixed speech later); the transcript is produced on the device and edited before sending.

Out of scope: a spoken, real-time voice agent; stocks or one-shot AI plans (retired for good, and their tables are dropped); native mobile apps.

## Workstreams

### A. Launch blockers

These must be done before any public post. Status as of 2026-10-17; "owner check" means the repo cannot show it.

| Item | Why | Done when | Size | Status |
| --- | --- | --- | --- | --- |
| Privacy policy and terms | The app stores financial records, and Pocky sends messages, matching records, dates, currencies and timezone to DeepSeek, outside Canada. The current notice does not name DeepSeek, which was a deliberate choice for personal use. Most users will be Canadian students, and PIPEDA expects cross-border processing to be disclosed. | `/privacy` and `/terms` pages in en and zh, linked from registration and the Pocky notice; the notice names the provider; reviewed against a template or by someone qualified | 1 day | Drafted and linked (#101, #104, #121, #123, #127, #133, #136); accepted with a required tick box at sign-up and a one-time card for existing accounts, recorded per user (#156, migration 017 is an owner step); the Pocky notice still does not name DeepSeek, by the owner's decision, but the policy does. Review by someone qualified, a French version and a Quebec impact assessment: not done |
| Provider spending cap (DeepSeek, Claude since #184) | Sign-up is open, and each account gets 20 turns per hour. Nothing caps the total. | A provider-side spending limit or prepaid balance, plus an app-side daily turn cap per account (`config.agent`). Login already requires a verified email, so throwaway accounts each need a working mailbox | ½ day | App-side done (60 turns a day per user, 600 across all users, #90). Provider-side limit or balance: owner check |
| Retention setting | Settings shows an auto-delete preference that is never stored and never acts. | It is stored and enforced by the hourly job through `utils/terms.ts`, or removed from the UI | ½–1 day | Done (#103, migration 016). Whether 016 is applied to the production database: owner check |
| Transactional email on our own domain | Verification mail comes from a personal mailbox, which hits spam and sending limits once volume grows. | Resend or Postmark sending from `noreply@<domain>`, SPF/DKIM/DMARC passing, `EMAIL_*` config switched | ½ day, after the domain | Done: Resend, domain verified, delivery tested by the owner (#122, #124). QA on 2026-10-20: the verification email lands in junk (new-domain reputation; the records are published). The screens now point to the junk folder (#155); Resend tracking off, DMARC `rua` and a mail-tester score: owner check |
| Custom domain | A real address for posting. | Apex domain for the site and `api.` for the backend, both with TLS; `CORS_ORIGIN`, `FRONTEND_URL` and `NEXT_PUBLIC_API_URL` updated; the old frontend URL still works | ½ day | Done with a change: https://www.termpocket.com, apex redirects, the old frontend URL redirects (307) to www; the API keeps its existing address (no `api.` subdomain); `CORS_ORIGIN` list (#120) |
| Demo account refresh | The demo dashboard empties about monthly. | `DEMO_REFRESH_ENABLED=true` in production | 5 min | Owner check |
| Phone OCR speed | Screenshot import is the headline feature, and it has only been timed on a laptop. | Timed on one mid-range phone; if it is slow, a clear in-app expectation | 1 hour | Owner check |

### B. Pocky quality

| Item | Done when |
| --- | --- |
| Planning limit (found on the first real planning question: `agent_limit_exceeded` after 31 s) | Fixed in #84: thinking disabled for DeepSeek, the question is an evaluation case, failed runs record which limit tripped |
| Planning habits and projection start (second real question: 3-month baseline for "habits", a projection offered from a past date) | `fix/agent-planning-habits`: 12 months or term comparison for habits, projections from today |
| A week of real use | Every wrong draft, wrong number or refusal is written down and added to `backend/eval/` as a fictional case |
| Evaluation in the loop | `npm run agent:eval` passes before any prompt, tool or limit change merges |
| Runtime | In-process runtime (#89, #93, #99, #100), the only one since #102 removed the Agent SDK on 2026-10-22 after a week in production |
| Status | The week of real use has started; nothing is recorded in the repo yet. Evaluation cases added: #94 (dictated-style cases, bare "dollars" is the conversation currency), #112, #113 |

### C. Voice dictation

**Built and merged 2026-10-18** (#142; the spike drafts #86 and #140 were closed): a mic button in Pocky's composer, tap to start and tap to stop, **English only for now** (owner's decision, 2026-10-15). The transcript is placed in the message box for the user to edit before Send. Recording rules do not change: only the confirm button saves. The full design and handoff is [`VOICE.md`](VOICE.md).

- **Engine:** an English-only on-device Whisper model (`tiny.en` or `base.en`) through Transformers.js, or whisper.cpp built for WebAssembly. Audio never leaves the device, which matches screenshot import's promise and adds nothing to the privacy policy. Rejected alternatives: the browser's built-in speech recognition (audio goes to Google or Apple, no Firefox support) and hosted transcription APIs (another data processor and another bill). Chinese and mixed speech can come later, with SenseVoice-Small as the first candidate.
- **Interim:** the phone keyboard's or macOS's own dictation already fills the message box; use it during the week of real use and note where it fails.
- **Spike (1 day), before committing:** see `VOICE.md` — the `onnxruntime-web` alias, accuracy on amounts and merchants, latency on a laptop and a phone, and the model download.
- **Build:** a microphone button on `/agent`, permission and error states, a 15-second cap, transcription in a worker, en and zh UI strings, and voice-style evaluation cases (spoken numbers, filler words). Whisper `base.en` 8-bit with the `w2` words prompt, all assets self-hosted; one backend change, the optional `input: "voice"` flag that makes Pocky ask about run-together amounts. Done.
- **Done when:** a spoken English entry becomes a correct draft in under 5 s on a laptop, and the measured phone time is recorded. Status: transcription takes about 2 s on a laptop; on the owner's iPhone all 20 amounts were right, but the phone time was not recorded.

### D. Pocky memory (after B's week of use)

Designed, not built: [`MEMORY.md`](MEMORY.md) (2026-10-21).

Remembered facts (rent, co-op pay, reserve) that Pocky offers and only the Remember button saves, forgotten from chat or from Settings → Pocky memory. Built on the in-process runtime (the SDK is gone, #102), in three pull requests (storage and routes; Pocky's tool, prompt, card and the Settings list; privacy policy with a `termsVersion` bump). Saved plans and per-account currency, timezone and reply language were split out as later, smaller changes. **Done when** deleting a fact removes it from everything Pocky sees, and the evaluation set still passes.

### E. Data growth

The production database is 8.7 MB, within the database plan's 0.5 GB limit. A Pocky turn stores about 1 KB: the user's message and the reply. Drafts, runs and admission records are swept after 24 hours to 30 days, so conversation messages are what accumulates.

| Scenario | Growth | Time to 0.5 GB |
| --- | --- | --- |
| Today (a handful of users) | Under 1 MB a month | Decades |
| 100 active users, about 10 turns a day each | About 30 MB a month | About 15 months |
| One account at its cap (100 conversations × 200 messages) | About 20–40 MB, and it takes at least 500 hours at 20 turns an hour | — |

Status 2026-10-17: not started; idle-conversation retention is still undecided. Work: before launch, add a usage panel (database size and agent turns per day) to the owner's routine checks. After launch, delete conversations idle for 12 months (policy text in A), and lower `maxConversations` if one account approaches its cap. Upgrading the database plan is the fallback, not the plan.

### F. Product polish

- **Transactions list:** 200 per page with "Load more" and a keyset cursor (#83, merged).
- **Goals decision (2026-10-17):** the owner chose a "suggested top-up" (a card on Goals, #130, a dashboard badge, #131, and a leftover-to-goal section in the first weekly report of each month, #134) and dropped automatic linking of savings transactions to goals as too much.
- **Also merged:** account deletion from Settings (#114), Enter to send in Pocky (#128), an in-app MCP setup dialog (#129, #132), a first-run onboarding tour (#135), redesigned emails (#124), and many QA and layout fixes (#97, #109–#111, #115–#119).
- **Dashboard summaries in SQL:** removes the double serialisation in `/summary/rolling`, which blocks an "All time" period.
- **A frontend test runner:** starting with `lib/date.ts`, the untested twin of a tested backend module.

### G. Later

- Clear the frontend's remaining advisories (2 open Dependabot alerts: `braces` high, `postcss-selector-parser` moderate), which come only from build tooling, by migrating to Tailwind 4. No patched `braces` release exists; the owner decided on 2026-10-17 to leave them open and revisit after launch. See [`frontend/DEPENDENCIES.md`](../frontend/DEPENDENCIES.md).
- French version of the legal pages (Quebec's Charter of the French language) and a written privacy impact assessment for transfers outside Quebec.
- Decide on the name "Pocky", a Glico trademark flagged as a naming risk.

## Order

| Week | Work | Gate |
| --- | --- | --- |
| 1 | B: fix the planning limit, start the week of real use. A: privacy policy, spending cap, demo refresh. Buy the domain. F: transactions list | Planning question passes; spending cap in place. Status 2026-10-17: planning fixed (#84, #87), app-side cap done, privacy policy drafted, domain bought, transactions list done |
| 2 | A: retention setting, email and domain, phone OCR timing. C: voice spike | Every launch blocker in A is done. Status 2026-10-17: retention, email, domain done; open owner checks are the provider-side spending limit, demo refresh, phone OCR timing, and 016 in production. The voice spike has not started |
| 3 | Public post. C: build voice if the spike passes. B: evaluation cases from real failures | Spike measurements meet "Done when" in C |
| 4+ | D: memory. E: idle-conversation deletion. F: summaries in SQL | — |

## Decisions needed from the owner

- [x] The privacy policy: drafted in the repo (#101, #104 and later); the Pocky notice still does not name DeepSeek by the owner's decision, the policy does.
- [ ] Review of the privacy policy and terms by someone qualified.
- [ ] The spending cap: the app-side caps are done (60 turns a day per user, 600 across all users). A provider-side limit or prepaid balance is an owner check.
- [x] The retention setting: implemented — stored per user (migration 016), enforced by the hourly job through `utils/terms.ts`.
- [x] The domain name and email provider: termpocket.com, Resend (2026-10-16).
- [ ] How long idle conversations are kept (proposed: 12 months).
- [ ] When to do the French version and the Quebec impact assessment, and whether to keep the name "Pocky".
