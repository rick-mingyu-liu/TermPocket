# Voice dictation — design and handoff

Status: **built** (2026-10-18, branch `feat/voice-input`, which supersedes draft PRs #86 and #140). Round 1 (2026-10-15) was no-go on amounts; round 2 (2026-10-17) passed the 18/20 bar on synthetic voices with a words-style Whisper prompt plus a "dictated" flag for Pocky; the owner's iPhone run got all 20 amounts right (see [Phone result](#phone-result-reported-2026-10-18)). The [Build](#build-2026-10-18) section says what shipped. Read [`CLAUDE.md`](../CLAUDE.md) (Conversation recording, On-device OCR) and [`PHASE-2.md`](PHASE-2.md) section C first.

## What we are building

A microphone button on `/agent` (Pocky). Tap to start and tap to stop recording up to 15 seconds of **English** speech; it is transcribed **in the browser**, and the text is put into the message box. The user edits it and presses Send as usual.

- **English only** for now (owner's decision, 2026-10-15). Chinese and mixed speech are later work.
- **Audio never leaves the device.** No audio is uploaded, stored or logged. This matches screenshot import, and adds nothing to the privacy policy.
- **Nothing is sent automatically.** The transcript lands in the textarea; Send stays a deliberate click. Recording rules are unchanged: only the Confirm button saves transactions.
- **One small backend change.** Pocky receives the text as if typed, plus an optional `input: "voice"` flag so it asks about amounts that speech-to-text may have run together (round 2, B).

Out of scope: a spoken, real-time voice agent (streaming audio to a provider, spoken replies); wake words; continuous listening.

## Interim, before any code

Phone keyboards (iOS, Android) and macOS dictation (Fn twice) already type speech into the message box. Use them during the week of real use and write down where they fail — garbled amounts, merchants, punctuation. Those notes become the spike's test phrases. If they turn out good enough, this feature can wait.

## Engine

| Option | Verdict |
| --- | --- |
| Whisper `tiny.en` / `base.en` via Transformers.js (`@huggingface/transformers`), quantized ONNX | **First choice.** English-only models are more accurate than the multilingual ones at the same size. Runs in a Web Worker on WASM, or WebGPU where available. |
| whisper.cpp compiled to WebAssembly | Fallback if Transformers.js cannot coexist with our ONNX Runtime setup (below). More build plumbing; no ONNX at all. |
| Browser Web Speech API | Rejected: Chrome sends audio to Google, Safari to Apple; no Firefox. |
| Hosted transcription (OpenAI, Deepgram, …) | Rejected: another data processor in the privacy policy, and another bill. |
| SenseVoice-Small via sherpa-onnx | Later, for Chinese and mixed speech. |

## Spike (1 day) — answer these before building

Record the answers in this file (a "Spike results" section) and in the PR.

1. **The `onnxruntime-web` alias.** `frontend/next.config.js` aliases `onnxruntime-web$` to `lib/ocr/ortRuntime.js`, which loads ONNX Runtime 1.30.0 from `/ort/` with `importScripts`, single-threaded, because Next's minifier cannot parse the library's ESM build. **Do not remove the alias** (OCR breaks). The alias will **not** catch Transformers.js. Checked against `@huggingface/transformers` 4.3.1 (2026-10-15):
   - It imports `onnxruntime-web/webgpu` and `onnxruntime-common`, not bare `onnxruntime-web`. The `$` in the alias matches only the bare name, so webpack would try to bundle the ESM build, which is the build Next's minifier cannot parse.
   - It pins `onnxruntime-web` `1.31.0-dev.20260914`, not our 1.30.0, so sharing our `/ort/` files means running it on an older runtime than it was built against.

   Try, in this order: (a) give the voice worker its own runtime copy, kept out of the bundle the way `ortRuntime.js` keeps OCR's, without widening the existing alias; (b) whisper.cpp built for WebAssembly, which needs no ONNX at all. Pointing Transformers.js at our `/ort/` 1.30.0 files via `env.backends.onnx` is the last resort, and only if it works with no version warnings. Whichever path is chosen, prove OCR import still works.
2. **Accuracy** on the owner's voice, 20 phrases taken from the interim notes, e.g. "lunch fifteen dollars", "uber twenty three forty", "groceries at No Frills 62.18 yesterday", "paid rent 1,150". Count phrases where the amount, merchant or date word is wrong. Compare `tiny.en` and `base.en`.
3. **Latency** for a 10-second clip, from releasing the button to text in the box: laptop (M-series, Chrome) and one mid-range phone, WASM single-threaded vs WebGPU. Also first-load time.
4. **Download size and caching.** Expect roughly 40 MB (`tiny.en`) to 80+ MB (`base.en`) quantized, on top of OCR's ~45 MB. Load only on first microphone use, with the OCR engine banner pattern, and confirm HTTP/Cache Storage keeps it to once per browser. Decide whether to self-host the model under `public/models/` (pinned and checksummed like `frontend/scripts/ocr-assets.js`) or fetch from the Hugging Face CDN; self-hosting is preferred for the same pinning reasons as OCR.
5. **iOS Safari.** `MediaRecorder` gives `audio/mp4`, not webm; confirm decode → 16 kHz mono `Float32Array` via `AudioContext.decodeAudioData` and resampling works there.

Go/no-go: proceed if a 10-second clip transcribes in under 5 s on the laptop with amounts right in at least 18 of 20 phrases, and the phone time is tolerable (record it either way).

## Spike results (2026-10-15)

Measured on an Apple-silicon MacBook in Chrome 155. The harness was the spike page `/voice-spike` (`frontend/pages/voice-spike.tsx` and `public/voice-spike/worker.js`: unlinked, noindex, to be deleted before the build) plus scripts kept outside the repo.

**Verdict: no-go for the mic button as specified.** Laptop latency passes easily. Amount accuracy misses the 18/20 bar on every configuration: the best is 17/20. The phone and iOS Safari are not measured yet. Two caveats cut in opposite directions: the phrases were spoken by macOS text-to-speech voices, not the owner, and a real voice may do better or worse; and some failures are systematic (below), which no voice fixes.

### 1. Runtime: a separate copy works, and OCR is untouched

- The worker is a module worker served as a static file (`/voice-spike/worker.js`), so webpack never sees it. It imports Transformers.js 4.3.1's self-contained build `dist/transformers.min.js`, which bundles its own ONNX Runtime **1.31.0-dev**. That build fetches its runtime file from the same CDN: `ort-wasm-simd-threaded.asyncify.wasm`, 5.5 MB. OCR keeps 1.30.0 from `/ort/`, and `next.config.js`, `lib/ocr/` and the frontend's dependencies are unchanged.
- **OCR import still works.** In one Chrome session I loaded the voice model, then imported `eval/synthetic/bank-balance-01.png` on the real `/import` page against a local backend on the compose database. It read in 1.3 s, with all 5 rows and the 103.64 row correct.
- `next build`, lint and `check:locales` pass.
- whisper.cpp was not needed.
- For the real build: self-host `transformers.min.js` and its `.wasm` under `public/voice/`, pinned and checksummed like `scripts/ocr-assets.js`, rather than importing from jsDelivr as the spike does.

### 2. Accuracy: Whisper squashes dollars and cents

There were 20 phrases, all fictional, each spoken by 3 voices (en-US Samantha, en-GB Daniel, en-AU Karen), so 60 clips. "Amount right" means the transcript keeps the amount usable: `23.40`, `23 40` or words, but not `2340`.

| Model (8-bit unless noted) | Amount right | Per voice (of 20) |
| --- | --- | --- |
| `tiny.en` | 30/60 | 11, 10, 9 |
| `base.en` | 42/60 | 15, 14, 13 |
| `tiny.en`, amount prompt | 44/60 | 14, 15, 15 |
| **`base.en`, amount prompt** | **49/60** | **17, 16, 16** |
| `base.en` fp32 encoder + q4 decoder, amount prompt | 44/60 | 16, 15, 13 |

- Dates ("yesterday", "today", "last night") were right in every clip.
- Merchant words were right in 53/60 for `base.en`. The misses: "Launch" for lunch, "No Freel", "Best by", "Shop is drug mark".
- **The main failure is systematic.** When dollars and cents are said without "dollars", Whisper writes them as one integer: "uber twenty three forty" → `Uber 2340`, "netflix sixteen ninety nine" → `Netflix 1699`, "nine fifty" → `950`. When the speaker says "dollars" ("fifteen dollars", "eighty four dollars and twenty cents"), the amount comes out right. Some outright errors also appeared: "eighty nine ninety nine" → `1899`, and "twenty five us dollars" → `$25.00`, which loses the currency.
- **The amount prompt** puts example amounts written as `$18.25` before the transcript, so Whisper follows that format. It's worth +7 to +14 clips. Transformers.js 4.3.1 declares `generate({prompt_ids})` but ignores it, so the worker passes the prompt as `decoder_input_ids` instead (`<|startofprev|>` + prompt + `<|startoftranscript|><|notimestamps|>`). That works.
- **Pocky does not reliably repair squashed amounts.** Live on the direct runtime, 2 runs each:

  | Transcript | Pocky drafted |
  | --- | --- |
  | `Netflix 1699` | 16.99 |
  | `Uber 2340.` | 23.40, or asked |
  | `Spent 950 on bubble tea yesterday.` | **950.00** (both runs) |
  | `Shoppers Drug Mart 1249 today.` / `Gas at Petro Canada 5130` | asked for the amount, or failed |

  The only safeguards would be the editable transcript and the Confirm button.

### 3. Latency on the laptop (10.1-second clip, from audio to text in the worker)

| Model | Engine and files | 10 s clip (3 runs) | 3 s clip |
| --- | --- | --- | --- |
| `tiny.en` | WASM, 8-bit | 1.18–1.23 s | 1.0 s |
| `base.en` | WASM, 8-bit | 2.41–2.54 s | 2.2 s |
| `tiny.en` | WebGPU, fp32 + q4 | 0.30–0.80 s | 0.19 s |
| `base.en` | WebGPU, fp32 + q4 | 0.39–0.59 s | 0.24 s |
| `base.en` | WebGPU, 8-bit | 2.29–2.49 s | 1.8 s |

- Everything is well under 5 s.
- WASM ran single-threaded: the app isn't cross-origin isolated, the same constraint OCR has.
- WebGPU is only faster with the large fp32 + q4 files; with 8-bit files it's no faster than WASM.
- **Phone: not measured.**

### 4. Download size and caching

| Files | `tiny.en` | `base.en` |
| --- | --- | --- |
| 8-bit (WASM, or WebGPU with no speedup) | 40.8 MB | 76.9 MB |
| fp32 encoder + q4 decoder (fast WebGPU) | 119.6 MB | 206.1 MB |

- Add 5.5 MB for the runtime file. All of this is on top of OCR's ~45 MB.
- First load is 2.6–4.6 s on this connection with 8-bit files, and 9.5–12.3 s with the large WebGPU files.
- **A reload fetched 0 bytes of model** (Transformers.js keeps the files in Cache Storage), and loading from the cache took 0.5–0.8 s.

### 5. iOS Safari: not measured

This needs a real device. Open `/voice-spike` on the PR's Vercel preview on an iPhone, load `base.en` (WASM), record an entry, and note:

- the reported `audio/mp4` type
- whether decoding and resampling succeed
- the "stop → text" time
- the same time on one mid-range Android phone

### What would change the verdict

1. **Run it on the owner's voice** (the 20 phrases above, on `/voice-spike`). If amounts reach 18/20 with the prompt, the bar is met.
2. **Speak amounts with "dollars"** ("nine dollars fifty"). It's reliable in every clip, but it puts the burden on the user.
3. **Compare the phone keyboard's dictation** with the same phrases. If it formats `$9.50` correctly, the interim (no feature) may be the answer.

Building the mic button anyway would mean relying on the user to catch `950` in the textarea and in the draft.

## Spike round 2 (2026-10-17)

The owner approved two experiments after round 1: **A**, a Whisper prompt that keeps amounts as words, and **B**, an optional "dictated" flag on the turn endpoint that makes Pocky ask about squashed numbers. Branch `spike/voice-round2` (draft PR into `feat/voice-dictation`), with `main` merged in.

**Verdict: A meets the 18/20 bar on synthetic voices.** The best prompt, `w2`, gets **58/60** clips with a usable amount: **18, 20 and 20** of 20 per voice. Round 1's best got 49/60. B makes Pocky ask about the squashed numbers that are left, and doesn't make it ask about clear amounts. It's a safety net, though, not a guarantee: it held in 26 of 28 flagged runs. **Recommendation: do both.** Ship the `w2` prompt as the transcriber's prompt, and send `input: "voice"` with dictated turns. The caveats from round 1 still apply. These were macOS voices, not the owner's, and the phone and iOS Safari are still unmeasured. The next step is the owner's voice on `/voice-spike`, which now uses `w2` by default.

### Method

- **Same 60 clips as round 1.** The 20 fictional phrases below, each spoken by macOS `say` with Samantha (en-US), Daniel (en-GB) and Karen (en-AU), converted to 16 kHz mono WAV. Model: `base.en`, 8-bit, WASM, Transformers.js 4.3.1.
- **Run in the browser.** The spike page `/voice-spike` ran under `next dev` in headless Chrome 155, driven by Playwright through `window.__voiceSpike.load/transcribe`. The worker now takes an optional `promptText` per clip, so all five prompts ran on one loaded model. The prompt goes in as `decoder_input_ids`, as in round 1. Round 1's digits prompt reproduced its 49/60 here; round 1 scored in Node.
- **Scoring.** An amount counts as usable when it has the right digits with the right decimal (round 1's rule, which also accepts `62 18`), or when the words unambiguously say it: `twenty three forty`, `nine fifty`, `84 dollars and twenty cents`. "dollars", "and" and "cents" are ignored when comparing words. Squashed digits (`2340`, `1699`) and wrong numbers fail. The "strict" column also fails split digits such as `42 17`.

Phrases (unchanged from round 1): lunch fifteen dollars · uber twenty three forty · groceries at no frills sixty two eighteen yesterday · paid rent one thousand one hundred fifty dollars · coffee at tim hortons four seventy five · bus pass one twenty eight yesterday · got paid two thousand four hundred eighty from my co-op · textbook from the bookstore ninety nine ninety nine · netflix sixteen ninety nine · dinner at the keg eighty four dollars and twenty cents last night · haircut thirty five dollars · phone bill sixty five dollars · shoppers drug mart twelve forty nine today · twenty five us dollars on steam · gas at petro canada fifty one thirty · spent nine fifty on bubble tea yesterday · amazon order forty two seventeen · tuition deposit five hundred dollars · movie tickets at cineplex thirty two fifty · refund from best buy eighty nine ninety nine.

### A. Prompts: clips with a usable amount (of 60; per voice of 20)

| Variant | Prompt (decoder input) | Amount usable | Samantha / Daniel / Karen | Strict | Merchant | Date | "US" kept |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `r1-digits` (round 1's best) | `Pizza at Domino's $18.25. Parking $7.50 yesterday. Paid $1,200 rent. Sobeys $43.06 today.` | 49 | 18 / 15 / 16 | 47 | 55 | 60 | 0/3 |
| `w1-words` | `Pizza at Domino's eighteen twenty five. Parking seven fifty yesterday. Paid twelve hundred rent. Sobeys forty three oh six today.` | 56 | 19 / 19 / 18 | 53 | 55 | 60 | 1/3 |
| **`w2-words-lower`** | `pizza at dominos eighteen twenty five parking seven fifty yesterday paid twelve hundred rent sobeys forty three oh six today` | **58** | **18 / 20 / 20** | 56 | **57** | 60 | **3/3** |
| `w3-words-more` | w1 plus `Sandwich eleven dollars. Gym membership thirty nine ninety nine. Train ticket two forty.` | 57 | 19 / 20 / 18 | 55 | 56 | 60 | 1/3 |
| `wd-words-dollars` | `Pizza at Domino's eighteen dollars twenty five. Parking seven dollars fifty yesterday. Paid twelve hundred dollars rent. Sobeys forty three dollars and six cents today.` | 52 | 18 / 19 / 15 | 51 | 56 | 60 | 0/3 |

- **The lowercase prompt without punctuation works best.** Whisper copies the prompt's style, so its transcripts read the way the speaker said them: `uber twenty three forty`, `spent nine fifty on bubble tea yesterday`, `twenty five us dollars on steam`. It's the only variant that kept "us" in all 3 clips. The digits prompt wrote `$25`, which loses the currency.
- **`w2`'s two misses:** `uber 2340` and `netflix 1699` (both Samantha). "netflix sixteen ninety nine" is the most persistent failure: every punctuated variant squashed it for at least two voices. Two more clips came out as split digits, `amazon order 42 17` (Samantha and Karen). Round 1's rule counts those, so under the strict rule `w2` gets 17 / 20 / 19.
- **Not always unambiguous even in words:** "bus pass one twenty eight" could mean 1.28 or 128 under any prompt. It's scored as usable because that's what was said.
- **Mishearings with `w2`:** "you but" for uber (Daniel), "god paid … from michael art" for "got paid … from my co-op" (Daniel), "best by", "drug mark". Dates were right in 60/60 for every variant.
- **Adding "dollars" to the prompt (`wd`) hurts.** Whisper then writes digits again (`Uber 2340`, `Cineplex 3250`, `Bus Pass 128`).
- **Latency is unchanged.** On the 10.1 s clip `w2` took 2.36–2.41 s (3 runs), against 2.36–2.39 s for the digits prompt. Clips of 2–5 s averaged 2.1 s for every variant. The prompt is about 25 tokens, so it's too short to change the time.

### A. Pocky on the real `w2` transcripts

Nine cases (`voice-words-*` in `backend/eval/agent-cases.json`) use `w2` output verbatim. Direct runtime, `deepseek-flash`, typed path (no flag):

| Transcript | Result |
| --- | --- |
| `coffee at tim hortons four seventy five` · `shoppers drug mark twelve forty nine today` · `gas at petro canada fifty one thirty` · `netflix sixteen ninety nine` · `textbook from the bookstore ninety nine ninety nine` · `movie tickets at cineplex thirty two fifty` · `god paid two thousand four hundred eighty from michael art` | Right amount, type and date, 2/2 each (14/14) |
| `amazon order forty two seventeen` | Drafted 42.17 in 3 of 6 runs and asked in the other 3 ("order forty two" reads like an order number). Never a wrong amount. The case now asserts that the reply names 42.17 and never 4217. |
| `amazon order 42 17` | Asked, 2/2. Same assertion as above. |

With the flag added, the same nine cases (1 run each) got 8/9. The miss was `amazon order 42 17`, where Pocky asked a muddled question ("$4.20 or $42.00 … and $17.00?") but drafted nothing.

### B. The dictated flag

**What changed (prototype, this branch only):**

- **Route.** `POST /agent/conversations/:id/messages` accepts an optional `input`: `'typed'` (the default) or `'voice'`. Anything else is a 400 `agent_invalid_input` before admission.
- **Envelope.** `'voice'` sets `AgentInput.dictated`, which adds `context.input = "dictated"` to the envelope. A typed turn's envelope is unchanged.
- **System prompt.** One added paragraph: when the input is dictated, a 3- or 4-digit amount with no decimal point, no thousands comma and not ending in 00 may be dollars and cents run together, and a `$` doesn't settle it because Whisper adds one. Pocky doesn't draft that row, and asks which amount was meant, quoting both readings. Amounts in words, with a decimal or comma, ending in 00, or of one or two digits are clear. Without the flag, Pocky ignores the rule and never mentions dictation. That last sentence was added after a typed control run replied "Because this was dictated, I read 1249 as 1249.00".
- **Eval harness.** Cases take `"input": "voice"` and pass it to the runtime as `dictated`.
- **Tests.** `agentEval.test.ts` (validation and pass-through), `agentRoutes.test.ts` (default, `typed`, `voice`, and five invalid values) and `agentRuntime.test.ts` (envelope and system prompt, on both runtimes).

**Pocky's results** (direct runtime, real squashed transcripts from round 1):

| Case (flag on) | Expectation | Prompt draft 1 (2 runs) | Final prompt (2 runs) |
| --- | --- | --- | --- |
| `Uber 2340.` | Ask, no draft | 2/2 | 2/2 |
| `Spent $950 on bubble tea yesterday.` | Ask, no draft | 2/2 | 1/2 (drafted 950.00 once, with a note) |
| `Shoppers drug mark 1249 today.` | Ask, no draft | 2/2 | 2/2 |
| `Dinner at the keg $84.20 last night.` | Draft 84.20 | 2/2 | 2/2 |
| `paid rent $1,150.` | Draft 1150.00 | 2/2 | 2/2 |
| `Tuition deposit $500.` | Draft 500.00 | 2/2 | 1/2 (asked once) |
| `Spent nine fifty on bubble tea yesterday.` | Draft 9.50 | 2/2 | 2/2 |

That's 26/28 over both versions of the prompt sentence. As a control, the three squashed transcripts were also run **without** the flag. Pocky drafted `950.00` for bubble tea in 4 of 4 runs and `1249.00` for Shoppers in 2 of 4. The flag is what turns those into questions.

### Cost

DeepSeek `deepseek-flash`, direct runtime, 73 eval runs in total: **524,620 input and 8,698 output tokens**. Every run sent the roughly 4.3k-token system prompt, and most made one tool round trip. The billed amount is on the DeepSeek dashboard. At deepseek-flash's list rates this is cents, well under the $0.50 budget. The full suite was not run.

### What's left before building

1. **The owner's voice**, using the 20 phrases on `/voice-spike` with the default (`w2`) prompt. Pass is at least 18/20.
2. **Phone and iOS Safari**, unchanged from round 1 §3 and §5.
3. **If building:** the mic button's composer sends `input: "voice"` when the textarea's text came from the transcriber, even if the user edited it afterwards. B's rule only asks about numbers, so an edited transcript costs at most one extra question. Move the paragraph and the `input` field from this prototype into the real change, with the tests. Mind the runtime rework under way elsewhere: the change to `runtime.ts` is two lines, the envelope field and the prompt paragraph.

## Phone result (reported 2026-10-18)

The owner opened `/voice-spike` on the round 2 preview on an iPhone in Safari and spoke the 20 phrases with the default `w2` prompt (`base.en`, 8-bit, WASM). **All 20 amounts were right.** A few non-amount words were wrong, which the owner accepts. Recording, decoding the `audio/mp4` recording through `AudioContext.decodeAudioData` and resampling worked. Latency, first-load time and the iPhone model were **not recorded**, and no Android phone has been tried.

## Build (2026-10-18)

What shipped, on `feat/voice-input`:

- **Assets, self-hosted.** `frontend/scripts/voice-assets.js` runs before `dev` and `build` (after `ocr-assets`) and puts, pinned by version or Hugging Face commit and SHA-256, under `frontend/public/voice/` (gitignored like the OCR assets): `transformers-4.3.1/transformers.min.js` (586 KB); `ort-1.31.0-dev.20260914-8d85527a0/` with the asyncify and plain `ort-wasm-simd-threaded` `.mjs`/`.wasm` pairs (26.9 MB and 14.3 MB raw, about 6.6 MB and 3.7 MB gzipped; a browser downloads one pair); and `whisper-base.en-51eefc0/` with the 8-bit encoder (23.2 MB) and merged decoder (53.7 MB), `tokenizer.json`, `tokenizer_config.json`, `config.json`, `generation_config.json` and `preprocessor_config.json`. About 116 MB on disk. Vercel sets no limit on build output files (its 100 MB limit is for CLI source uploads), so the cost is a download of about 160 MB (with OCR's) per build and the bandwidth of each first use.
- **Worker.** `frontend/public/voice/worker.js`, a static module worker, so webpack never sees it: `env.allowRemoteModels=false`, `env.localModelPath='/voice/'`, and ONNX Runtime's file paths rewritten from jsDelivr to `/voice/ort-<version>/`, keeping Transformers.js's own choice between the asyncify and plain builds, and refusing any other runtime version. Nothing is fetched from a CDN or Hugging Face at runtime. OCR's alias and `/ort/` are untouched. Whisper's non-speech markers (`[BLANK_AUDIO]`, `(silence)`) are stripped.
- **Client.** `frontend/lib/voice/useDictation.ts`: creates the worker on first tap, loads the model with byte progress, records with `MediaRecorder`, stops itself at 15 s, releases every track (the browser's mic indicator goes off), abandons a recording when the page is hidden, decodes and resamples to 16 kHz mono, treats a recording whose peak is below 0.01 as no speech without running the model, and terminates the worker on unmount.
- **UI.** A mic button beside Send in the `/agent` composer: idle → loading (MB progress) → recording (elapsed / 15 s, tap the square to stop) → transcribing → text inserted at the cursor for review, never sent automatically. While the text came from dictation, even if edited, the send carries `input: "voice"`; clearing the box resets that. Inline messages for denied permission, no microphone, no speech, model load failure and other failures keep the composer's text. The button is hidden without a secure context, `getUserMedia`, `MediaRecorder` or Web Audio, disabled while a run is pending, and Send is disabled while dictating. The tooltip says English only in both languages.
- **Backend.** Round 2's B, unchanged: the `input` field, the envelope's `context.input = "dictated"`, the prompt paragraph, eval support and the 70 cases.
- **Privacy policy.** One sentence (both languages): dictation runs in the browser, the recording never leaves the device and is not stored, only the transcript is sent; and the DeepSeek list now says whether a message was dictated.

Checked in headless Chrome against `next dev` with a fake microphone playing a `say` clip ("uber twenty three forty yesterday"): first model load 24 s from a cold dev server, then about 1.3 s; stop to text about 2.1 s for a 4 s recording; the transcript was `over twenty three forty yesterday`, the send carried `input: "voice"` after an edit and no `input` when typed; denied permission, silence, a missing model file and a missing worker each showed their message; the button was hidden over plain HTTP on a LAN address; the only origins requested were the site itself, the mocked API and the existing Vercel analytics script. **Still needs a phone check:** tap the mic on the PR's Vercel preview on an iPhone.

## Original build plan (2–3 days)

Kept for the record; the section above says what was actually built. Follow the OCR code's shape; it solved the same problems.

- `frontend/lib/voice/voice.worker.ts` — loads the model, transcribes `Float32Array` 16 kHz mono, posts `progress` / `ready` / `result` / `error`. Model of: `lib/ocr/ocr.worker.ts`.
- `frontend/lib/voice/useVoice.ts` — hook owning the worker (created on first use, terminated on unmount), the state machine `idle → loading(loaded,total) → ready → recording → transcribing → ready | unsupported | denied | failed`, and a serial queue. Model of: `lib/ocr/useOcr.ts`.
- `frontend/lib/voice/record.ts` — `getUserMedia({audio:true})`, `MediaRecorder`, a hard 15-second stop, decode and resample, and **always stopping every track** afterwards so the browser's mic indicator goes off.
- `frontend/pages/agent.tsx` — a mic button beside the composer textarea (`composer` ref, `content` state, `maxLength={4000}`). The transcript is **inserted at the cursor or appended** to existing text, never replaces it; focus returns to the textarea. Disable the button whenever the textarea is disabled (`locked || unresolved || available !== true`) and while a run is pending.
- States the UI must show: model downloading (progress), recording (elapsed / 15 s), transcribing, mic permission denied (how to re-enable), unsupported browser, failure (try again / type instead). Keyboard-accessible, `aria-pressed` on the button, a visible recording indicator.
- Strings in both `frontend/public/locales/en/common.json` and `zh/common.json` (the UI is bilingual even though recognition is English-only); run `npm run check:locales`.
- Evaluation: add voice-style **text** cases to `backend/eval/` — what the transcriber actually produces (spelled-out numbers, "um", missing punctuation, "twenty three forty") — so Pocky's drafting is checked against transcripts. Cases stay fictional.
- Privacy: no audio or transcript in `localStorage`, logs or analytics; release the `MediaStream` on unmount and on page hide.

## Done when

- A spoken English entry becomes a correct draft in under 5 s on a laptop, end to end.
- The measured phone time is recorded here and in `STATUS.md`.
- Denied permission, unsupported browser and model-download failure each show a usable message, and typing still works.
- OCR import still works (the `onnxruntime-web` alias untouched or proven compatible).
- `npm run lint`, `npm run check:locales` and `npm run build` pass in `frontend/` (in a worktree, never the main checkout while its dev server runs); the backend eval passes with the new cases.
- Browser-checked on desktop and at 375 px, light and dark. The frontend has no test runner, so this is the verification.

Status 2026-10-18: lint, `check:locales` and `build` pass; the error states and 375 px light/dark were checked in headless Chrome (Build, above). Not done: an end-to-end spoken draft through Pocky (needs the provider; transcription itself is about 2 s), the phone time (not recorded), OCR import re-run in a browser (its alias, `/ort/` and `lib/ocr/` are unchanged), and the paid eval run with the new cases.

## Open questions for the owner (resolved)

- `tiny.en` (smaller, faster) or `base.en` (more accurate) if both pass — decided by the spike numbers. *Spike: `base.en` 8-bit with the amount prompt is the most accurate (49/60), 2.5 s per 10 s clip on WASM; neither passes 18/20 on synthetic voices. Round 2 and the build: `base.en` 8-bit with the `w2` words prompt.*
- Self-host the model or use the Hugging Face CDN. *Spike: the 8-bit files are 41 MB / 77 MB and cache after the first load; self-hosting stays the recommendation, for the same pinning reasons as OCR. Built: self-hosted.*
- Push-to-talk (hold) or tap to start / tap to stop. Tap is easier on phones; proposed default. *Built: tap to start, tap to stop.*
