// Voice dictation worker (docs/VOICE.md): English speech to text, on the device.
//
// A module worker served as a static file, so webpack never sees it and OCR's
// `onnxruntime-web$` alias (next.config.js) and /ort/ are untouched.
// Transformers.js's self-contained build carries its own ONNX Runtime JS
// (1.31.0-dev); every file it loads is served from this site by
// scripts/voice-assets.js, which pins each one by version and SHA-256. The
// directory names below must match that script's; change them together.
//
// Messages in:  { type: 'load' }, { type: 'transcribe', id, audio: Float32Array (16 kHz mono) }
// Messages out: { type: 'progress', loaded, total }, { type: 'ready' },
//               { type: 'result', id, text }, { type: 'error', id?, message }
// Audio stays in this worker's memory; nothing is uploaded, stored or logged.
import { AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, Tensor, env } from '/voice/transformers-4.3.1/transformers.min.js'

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

// The words prompt ("w2" in docs/VOICE.md: 58/60 usable amounts on synthetic
// voices, 20/20 on the owner's iPhone). Lowercase, no punctuation, amounts in
// words, so Whisper writes "uber twenty three forty" rather than "Uber 2340".
// Transformers.js 4.3.1 ignores generate({prompt_ids}), so the prompt goes in
// as decoder input: <|startofprev|> prompt <|startoftranscript|><|notimestamps|>.
const PROMPT = 'pizza at dominos eighteen twenty five parking seven fifty yesterday paid twelve hundred rent sobeys forty three oh six today'

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
  ]).then(([processor, tokenizer, model]) => {
    const special = token => tokenizer.convert_tokens_to_ids(token)
    const ids = [special('<|startofprev|>'), ...tokenizer.encode(' ' + PROMPT, { add_special_tokens: false }),
      special('<|startoftranscript|>'), special('<|notimestamps|>')]
    return { processor, tokenizer, model, ids }
  })
  // A failed load may be retried by the next request.
  loading.catch(() => { loading = null })
  return loading
}

// Whisper marks non-speech as "[BLANK_AUDIO]", "(silence)", "[Music]" and the like.
const clean = text => text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()

async function transcribe(audio) {
  const { processor, tokenizer, model, ids } = await load()
  const { input_features } = await processor(audio)
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
    try { postMessage({ type: 'result', id: data.id, text: await transcribe(data.audio) }) }
    catch (error) { postMessage({ type: 'error', id: data.id, message: describe(error) }) }
  }
}
