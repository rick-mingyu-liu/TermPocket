// Voice dictation worker (docs/VOICE.md): English speech to text, on the device.
//
// A module worker served as a static file, so webpack never sees it and OCR's
// `onnxruntime-web$` alias (next.config.js) and /ort/ are untouched.
// Transformers.js's self-contained build carries its own ONNX Runtime JS
// (1.31.0-dev); every file it loads is served from this site by
// scripts/voice-assets.js, which pins each one by version and SHA-256. The
// directory names below must match that script's; change them together.
// audio.js (silence trimming, level) and prompt.js (Whisper's prompt) are
// plain modules shared with the Node benchmark in eval/voice/, so what is
// measured there is what runs here.
//
// Messages in:  { type: 'load' }
//               { type: 'transcribe', id, audio: Float32Array (16 kHz mono), terms?: string[] }
//                 `terms` are the user's recent transaction descriptions,
//                 newest first; they bias recognition towards those words.
// Messages out: { type: 'progress', loaded, total }, { type: 'ready' },
//               { type: 'result', id, text }, { type: 'error', id?, message }
// Audio, terms and transcripts stay in this worker's memory; nothing is
// uploaded, stored or logged.
import { AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, Tensor, env } from '/voice/transformers-4.3.1/transformers.min.js'
import { prepare } from '/voice/audio.js'
import { buildPromptIds } from '/voice/prompt.js'

const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0'
const MODEL = 'whisper-base.en-51eefc0'

// Never reach Hugging Face: models come only from /voice/<MODEL>/.
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = '/voice/'

// Transformers.js points ONNX Runtime at jsDelivr, choosing the asyncify build
// or, on Safari before 26 without WebGPU, the plain one. Keep its choice and
// serve the same file from this site; anything else is a version mismatch.
const ort = env.backends.onnx
const cdn = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`
const local = name => {
  if (typeof name !== 'string' || !name.startsWith(cdn)) throw new Error('Unexpected ONNX Runtime path.')
  return new URL(`/voice/ort-${ORT_VERSION}/${name.slice(cdn.length)}`, self.location.href).href
}
let setup = null
try {
  if (ort?.versions?.web !== ORT_VERSION) throw new Error('Unexpected ONNX Runtime version.')
  ort.wasm.wasmPaths = { mjs: local(ort.wasm.wasmPaths?.mjs), wasm: local(ort.wasm.wasmPaths?.wasm) }
} catch (error) {
  setup = error
}

let loading = null

function load() {
  if (setup) return Promise.reject(setup)
  if (loading) return loading
  const files = new Map()
  const progress_callback = p => {
    if (p.status !== 'progress' && p.status !== 'done') return
    files.set(p.file, { loaded: p.loaded ?? p.total ?? 0, total: p.total ?? 0 })
    let loaded = 0, total = 0
    for (const f of files.values()) { loaded += f.loaded; total += f.total }
    postMessage({ type: 'progress', loaded, total })
  }
  loading = Promise.all([
    AutoProcessor.from_pretrained(MODEL, { progress_callback }),
    AutoTokenizer.from_pretrained(MODEL, { progress_callback }),
    WhisperForConditionalGeneration.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback }),
  ]).then(([processor, tokenizer, model]) => ({ processor, tokenizer, model }))
  // A failed load may be retried by the next request.
  loading.catch(() => { loading = null })
  return loading
}

// The prompt (prompt.js): the "w2" amount examples (58/60 usable amounts on
// synthetic voices, 20/20 on the owner's iPhone) — lowercase, no punctuation,
// amounts in words, so Whisper writes "uber twenty three forty" rather than
// "Uber 2340" — followed by the user's recent merchant names in the same
// style, within 200 tokens. Transformers.js 4.3.1 ignores
// generate({prompt_ids}), so the prompt goes in as decoder input:
// <|startofprev|> prompt <|startoftranscript|><|notimestamps|>.
// Encoded once per distinct terms list: a session whose terms do not change
// pays for the tokenizer once.
let cachedPrompt = null

function promptFor(tokenizer, terms) {
  const list = Array.isArray(terms) ? terms.filter(term => typeof term === 'string') : []
  const key = list.join('\n')
  if (cachedPrompt?.tokenizer === tokenizer && cachedPrompt.key === key) return cachedPrompt.ids
  const special = token => tokenizer.convert_tokens_to_ids(token)
  const encode = text => tokenizer.encode(text, { add_special_tokens: false })
  const ids = [special('<|startofprev|>'), ...buildPromptIds(encode, list), special('<|startoftranscript|>'), special('<|notimestamps|>')]
  cachedPrompt = { tokenizer, key, ids }
  return ids
}

// Whisper marks non-speech as "[BLANK_AUDIO]", "(silence)", "[Music]" and the like.
const clean = text => text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()

/** The transcript, or '' when the recording holds no speech (the model is not run). */
async function transcribe(audio, terms) {
  const { processor, tokenizer, model } = await load()
  // Trim the silence around the speech and bring it to a known level; a
  // silent take comes back empty and is reported as no speech.
  const speech = prepare(audio)
  if (speech.length === 0) return ''
  const ids = promptFor(tokenizer, terms)
  const { input_features } = await processor(speech)
  const decoder_input_ids = new Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length])
  const out = await model.generate({ inputs: input_features, decoder_input_ids, max_new_tokens: 96 })
  return clean(tokenizer.batch_decode(out.slice(null, [ids.length, null]), { skip_special_tokens: true })[0] ?? '')
}

const describe = error => String(error?.message ?? error).slice(0, 300)

self.onmessage = async ({ data }) => {
  if (data?.type === 'load') {
    try { await load(); postMessage({ type: 'ready' }) }
    catch (error) { postMessage({ type: 'error', message: describe(error) }) }
  } else if (data?.type === 'transcribe') {
    try { postMessage({ type: 'result', id: data.id, text: await transcribe(data.audio, data.terms) }) }
    catch (error) { postMessage({ type: 'error', id: data.id, message: describe(error) }) }
  }
}
