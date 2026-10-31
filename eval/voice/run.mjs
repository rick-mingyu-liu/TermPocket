/**
 * The dictation benchmark: the shipped Whisper model and prompt code, in Node.
 *
 *   node run.mjs                              synthetic set, the shipped prompt (amount examples), audio prepared
 *   node run.mjs --set private                your own clips (eval/private/voice/manifest.json + wavs)
 *   node run.mjs --prompt none|examples|vocabulary    no prompt / the amount examples / examples + terms.json
 *   node run.mjs --terms my-terms.json        another vocabulary (a JSON array, or {"terms": [...]})
 *   node run.mjs --no-prepare                 skip audio.js's trim + quiet-take gain
 *   node run.mjs --beams 3                    pass num_beams to generate. In Transformers.js 4.3.1 this is a
 *                                             no-op: its loop keeps only the first sampled token (greedy), so
 *                                             transcripts and timing are identical to --beams 1 (verified 2026-10-31).
 *   node run.mjs --model <dir>                another model under frontend/public/voice/
 *   node run.mjs --json                       machine-readable summary on stdout
 *   node run.mjs --limit N                    the first N clips only
 *
 * Runs the exact model files the browser is served, the shared prompt and audio
 * modules (frontend/public/voice/prompt.js, audio.js) and the worker's decoding
 * (prompt as decoder_input_ids, max_new_tokens 96, non-speech markers removed),
 * then scores each transcript (lib/score.mjs). Writes reports/<set>-<config>.md.
 *
 * Differences from the browser: onnxruntime-node on the CPU instead of WASM, so
 * numerics can differ slightly and a clip or two may score differently.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, Tensor, env } from '@huggingface/transformers';
import { readWav } from './lib/wav.mjs';
import { scoreClip, summarize, ratio, normalizeWords, NUMBER_WORDS } from './lib/score.mjs';
import { buildPromptIds } from '../../frontend/public/voice/prompt.js';
import { prepare } from '../../frontend/public/voice/audio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const VOICE_DIR = join(REPO, 'frontend', 'public', 'voice');
const DEFAULT_MODEL = 'whisper-base.en-51eefc0';
const MAX_NEW_TOKENS = 96; // the worker's

const { values: args } = parseArgs({
  options: {
    set: { type: 'string', default: 'synthetic' },
    prompt: { type: 'string', default: 'examples' },
    terms: { type: 'string', default: join(HERE, 'terms.json') },
    'no-prepare': { type: 'boolean', default: false },
    beams: { type: 'string', default: '1' },
    model: { type: 'string', default: DEFAULT_MODEL },
    json: { type: 'boolean', default: false },
    limit: { type: 'string' },
  },
});
if (!['none', 'examples', 'vocabulary'].includes(args.prompt)) {
  console.error(`--prompt must be none, examples or vocabulary (got ${args.prompt})`);
  process.exit(1);
}
const beams = Number(args.beams);
if (!Number.isInteger(beams) || beams < 1) { console.error('--beams must be a positive integer'); process.exit(1); }
const limit = args.limit === undefined ? Infinity : Number(args.limit);
const usePrepare = !args['no-prepare'];

const setDir = args.set === 'synthetic' ? join(HERE, 'synthetic') : join(HERE, '..', 'private', 'voice');
const manifestFile = join(setDir, 'manifest.json');
if (!existsSync(manifestFile)) {
  console.error(`no ${manifestFile}${args.set === 'synthetic' ? ' (run `node generate.mjs` first)' : ''}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')).slice(0, limit);

function loadTerms(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const terms = Array.isArray(parsed) ? parsed : parsed.terms;
  if (!Array.isArray(terms)) throw new Error(`${file}: expected an array or {"terms": [...]}`);
  return terms;
}
const terms = args.prompt === 'vocabulary' ? loadTerms(args.terms) : [];

const configName = [
  args.prompt,
  usePrepare ? 'prepare' : 'raw',
  beams > 1 ? `beams${beams}` : null,
  args.model !== DEFAULT_MODEL ? args.model : null,
].filter(Boolean).join('-');

// Model files come only from frontend/public/voice/<model>/, like the worker.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${VOICE_DIR}/`;
env.useFSCache = false;
const modelDir = join(VOICE_DIR, args.model);
if (!existsSync(join(modelDir, 'config.json'))) {
  console.error(`no model at ${modelDir}. Run \`npm run voice-assets\` in frontend/ first.`);
  process.exit(1);
}

const log = (...parts) => { if (!args.json) console.log(...parts); };
const ortVersion = createRequire(import.meta.url)('onnxruntime-node/package.json').version;

log(`loading ${args.model} (q8) with @huggingface/transformers in Node, onnxruntime-node ${ortVersion}, cpu …`);
const loadStarted = performance.now();
const [processor, tokenizer, model] = await Promise.all([
  AutoProcessor.from_pretrained(args.model),
  AutoTokenizer.from_pretrained(args.model),
  WhisperForConditionalGeneration.from_pretrained(args.model, { dtype: 'q8' }),
]);
const loadSeconds = (performance.now() - loadStarted) / 1000;

const special = (token) => tokenizer.convert_tokens_to_ids(token);
const encode = (text) => tokenizer.encode(text, { add_special_tokens: false });
const promptIds = args.prompt === 'none' ? [] : buildPromptIds(encode, terms);
const promptUsed = promptIds.length ? tokenizer.decode(promptIds).trim() : '';
const ids = [
  ...(promptIds.length ? [special('<|startofprev|>'), ...promptIds] : []),
  special('<|startoftranscript|>'),
  special('<|notimestamps|>'),
];
const decoderInput = new Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);

// The worker's clean-up of Whisper's non-speech markers.
const clean = (text) => text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

async function transcribe(audio) {
  if (audio.length === 0) return '';
  const { input_features } = await processor(audio);
  const out = await model.generate({
    inputs: input_features,
    decoder_input_ids: decoderInput,
    max_new_tokens: MAX_NEW_TOKENS,
    ...(beams > 1 ? { num_beams: beams } : {}),
  });
  return clean(tokenizer.batch_decode(out.slice(null, [ids.length, null]), { skip_special_tokens: true })[0] ?? '');
}

// Prompt words that could be copied into a transcript: anything in the prompt
// that is not a number word, long enough to be a merchant-like word.
const promptWords = [...new Set(normalizeWords(promptUsed))].filter((w) => w.length >= 4 && !NUMBER_WORDS.has(w));

const results = [];
const seconds = [];
log(`\n${'voice'.padEnd(9)} id  amt str mer dat kep  transcript`);
for (const entry of manifest) {
  const raw = readWav(join(setDir, entry.file));
  const audio = usePrepare ? prepare(raw, { sampleRate: 16_000 }) : raw;
  const started = performance.now();
  const transcript = await transcribe(audio);
  const took = (performance.now() - started) / 1000;
  seconds.push(took);
  const score = scoreClip(transcript, entry);
  const spoken = new Set(normalizeWords(entry.text));
  const heard = new Set(normalizeWords(transcript));
  const intrusions = promptWords.filter((w) => heard.has(w) && !spoken.has(w));
  const result = {
    voice: entry.voice, id: entry.id, file: entry.file, text: entry.text, ...score,
    intrusions, seconds: Math.round(took * 100) / 100, emptyAudio: audio.length === 0,
  };
  results.push(result);
  const flag = (v) => (v === null ? ' - ' : v ? ' Y ' : ' . ');
  log(`${entry.voice.padEnd(9)} ${entry.id} ${flag(score.amount)} ${flag(score.strict)} ${flag(score.merchant)} ${flag(score.date)} ${flag(score.keep)}  ${transcript}${intrusions.length ? `   [prompt words: ${intrusions.join(', ')}]` : ''}`);
}

const totals = summarize(results);
const mean = seconds.length ? seconds.reduce((a, b) => a + b, 0) / seconds.length : 0;
const misses = results.filter((r) => !r.amount);
const strictMisses = results.filter((r) => r.amount && !r.strict);
const merchantMisses = results.filter((r) => r.merchant === false);
const dateMisses = results.filter((r) => r.date === false);
const keepMisses = results.filter((r) => r.keep === false);
const intruded = results.filter((r) => r.intrusions.length);
const perVoiceLine = (key) => Object.entries(totals.perVoice).map(([v, t]) => `${v} ${ratio(t[key])}`).join(', ');

const summary = {
  set: args.set,
  config: configName,
  model: args.model,
  runtime: { library: '@huggingface/transformers', onnxruntimeNode: ortVersion, device: 'cpu', loadSeconds: Math.round(loadSeconds * 10) / 10 },
  prompt: { kind: args.prompt, text: promptUsed, tokens: promptIds.length, termsFile: args.prompt === 'vocabulary' ? relative(REPO, args.terms) : null, termsGiven: terms.length },
  prepare: usePrepare,
  beams,
  clips: results.length,
  totals: {
    amount: totals.amount, strict: totals.strict, merchant: totals.merchant, date: totals.date, keep: totals.keep,
    perVoice: totals.perVoice,
  },
  secondsPerClip: Math.round(mean * 100) / 100,
  intrusions: { clips: intruded.length, words: intruded.map((r) => ({ file: r.file, words: r.intrusions })) },
  misses: {
    amount: misses.map((r) => r.file), strict: strictMisses.map((r) => r.file), merchant: merchantMisses.map((r) => r.file),
    date: dateMisses.map((r) => r.file), keep: keepMisses.map((r) => r.file),
  },
  results,
};

const lines = [];
lines.push(`# Dictation benchmark: ${args.set}, ${configName}`, '');
lines.push(`- Model: \`${args.model}\` (q8), @huggingface/transformers in Node on onnxruntime-node ${ortVersion} (cpu). The browser runs the same files on WASM, so numerics can differ slightly and a clip or two may score differently.`);
lines.push(`- Prompt: \`${args.prompt}\`${args.prompt === 'vocabulary' ? ` (${terms.length} terms from \`${summary.prompt.termsFile}\`)` : ''}, ${promptIds.length} tokens${promptUsed ? `:\n\n  \`${promptUsed}\`` : ''}`);
lines.push(`- Audio: ${usePrepare ? 'prepared (audio.js trim + quiet-take gain)' : 'raw'}; beams: ${beams}${beams > 1 ? ' (Transformers.js 4.3.1 decodes greedily whatever num_beams says, so expect no change)' : ''}; max_new_tokens: ${MAX_NEW_TOKENS}`);
lines.push(`- ${results.length} clips, ${summary.secondsPerClip} s per clip (model load ${summary.runtime.loadSeconds} s), ${new Date().toISOString().slice(0, 10)}`, '');
lines.push('| Amount usable | Strict | Merchant | Date | Keep |', '| --- | --- | --- | --- | --- |');
lines.push(`| ${ratio(totals.amount)} | ${ratio(totals.strict)} | ${ratio(totals.merchant)} | ${ratio(totals.date)} | ${ratio(totals.keep)} |`, '');
lines.push(`Per voice, amount usable: ${perVoiceLine('amount')}. Strict: ${perVoiceLine('strict')}. Merchant: ${perVoiceLine('merchant')}.`, '');
lines.push(`Prompt words copied into a transcript that the phrase did not contain: ${intruded.length} clip(s)${intruded.length ? ` (${intruded.map((r) => `${r.file}: ${r.intrusions.join(' ')}`).join('; ')})` : ''}.`, '');
const listMisses = (title, list) => { if (list.length) lines.push(`- ${title}: ${list.map((r) => `${r.file} → \`${r.transcript}\``).join('; ')}`); };
lines.push('Misses:', '');
listMisses('amount', misses); listMisses('strict only', strictMisses); listMisses('merchant', merchantMisses); listMisses('date', dateMisses); listMisses('keep', keepMisses);
if (!misses.length && !strictMisses.length && !merchantMisses.length && !dateMisses.length && !keepMisses.length) lines.push('- none');
lines.push('', '| Voice | Id | Amount | Strict | Merchant | Date | Keep | s | Transcript |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const cell = (v) => (v === null ? '–' : v ? 'yes' : '**no**');
for (const r of results) {
  lines.push(`| ${r.voice} | ${r.id} | ${cell(r.amount)} | ${cell(r.strict)} | ${cell(r.merchant)} | ${cell(r.date)} | ${cell(r.keep)} | ${r.seconds} | \`${r.transcript.replace(/\|/g, '\\|') || '(empty)'}\` |`);
}
mkdirSync(join(HERE, 'reports'), { recursive: true });
const reportFile = join(HERE, 'reports', `${args.set}-${configName}.md`);
writeFileSync(reportFile, `${lines.join('\n')}\n`);

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('');
  console.log(`prompt (${args.prompt}, ${promptIds.length} tokens): ${promptUsed || '(none)'}`);
  console.log(`amount usable ${ratio(totals.amount)}  strict ${ratio(totals.strict)}  merchant ${ratio(totals.merchant)}  date ${ratio(totals.date)}  keep ${ratio(totals.keep)}`);
  console.log(`per voice (amount): ${perVoiceLine('amount')}`);
  console.log(`prompt-word intrusions: ${intruded.length} clip(s)`);
  console.log(`${summary.secondsPerClip} s per clip, model load ${summary.runtime.loadSeconds} s`);
  if (misses.length) console.log(`amount misses: ${misses.map((r) => r.file).join(', ')}`);
  console.log(`report: ${relative(process.cwd(), reportFile)}`);
}
