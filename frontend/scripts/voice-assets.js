#!/usr/bin/env node
/**
 * Puts the files voice dictation needs where this site serves them, so the
 * browser never fetches anything from a CDN or Hugging Face at runtime:
 *
 *   public/voice/transformers-<version>/  Transformers.js's self-contained browser build
 *   public/voice/ort-<version>/           the ONNX Runtime WASM files that build loads
 *   public/voice/whisper-<model>-<rev>/   the Whisper model (8-bit encoder and merged decoder) and its configs
 *
 * All three are gitignored; public/voice/worker.js, which loads them, is not.
 * Runs before `dev` and `build` next to ocr-assets, and is quick when the files
 * are already in place, because it checks hashes before downloading anything.
 *
 * Every file is pinned by version (or Hugging Face commit) and SHA-256, so a
 * changed file fails the build rather than silently changing what was measured
 * (docs/VOICE.md). The directory names carry the version so a browser's cache
 * never mixes two of them. To move to another version, change the entries
 * below and the matching constants in public/voice/worker.js together.
 *
 * This is a separate copy of ONNX Runtime from OCR's (public/ort/, 1.30.0):
 * Transformers.js 4.3.1 is built against 1.31.0-dev and bundles its JS.
 *
 * Run: npm run voice-assets
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VOICE_DIR = path.join(__dirname, '..', 'public', 'voice');

const TRANSFORMERS_VERSION = '4.3.1';
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
const MODEL = 'whisper-base.en';
const MODEL_REVISION = '51eefc0af78b103839eda9e7e4f4186acc6517fe';

const TRANSFORMERS_BASE = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist`;
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist`;
const MODEL_BASE = `https://huggingface.co/onnx-community/${MODEL}/resolve/${MODEL_REVISION}`;

const TRANSFORMERS_DIR = `transformers-${TRANSFORMERS_VERSION}`;
const ORT_DIR = `ort-${ORT_VERSION}`;
const MODEL_DIR = `${MODEL}-${MODEL_REVISION.slice(0, 7)}`;

const FILES = [
  {
    file: `${TRANSFORMERS_DIR}/transformers.min.js`,
    url: `${TRANSFORMERS_BASE}/transformers.min.js`,
    sha256: '8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743',
  },
  // Transformers.js picks the asyncify build, or the plain one on Safari
  // before 26 without WebGPU; the worker keeps its choice, so ship both.
  {
    file: `${ORT_DIR}/ort-wasm-simd-threaded.asyncify.mjs`,
    url: `${ORT_BASE}/ort-wasm-simd-threaded.asyncify.mjs`,
    sha256: '0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611',
  },
  {
    file: `${ORT_DIR}/ort-wasm-simd-threaded.asyncify.wasm`,
    url: `${ORT_BASE}/ort-wasm-simd-threaded.asyncify.wasm`,
    sha256: '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082',
  },
  {
    file: `${ORT_DIR}/ort-wasm-simd-threaded.mjs`,
    url: `${ORT_BASE}/ort-wasm-simd-threaded.mjs`,
    sha256: 'c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f',
  },
  {
    file: `${ORT_DIR}/ort-wasm-simd-threaded.wasm`,
    url: `${ORT_BASE}/ort-wasm-simd-threaded.wasm`,
    sha256: '06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3',
  },
  ...[
    ['config.json', 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1'],
    ['generation_config.json', '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120'],
    ['preprocessor_config.json', 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'],
    ['tokenizer.json', '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0'],
    ['tokenizer_config.json', '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c'],
    ['onnx/encoder_model_quantized.onnx', '6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10'],
    ['onnx/decoder_model_merged_quantized.onnx', 'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909'],
  ].map(([file, sha256]) => ({ file: `${MODEL_DIR}/${file}`, url: `${MODEL_BASE}/${file}`, sha256 })),
];

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function ensure({ file, url, sha256: expected }) {
  const target = path.join(VOICE_DIR, file);
  if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === expected) return 'present';

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status} from ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buffer);
  if (actual !== expected) {
    throw new Error(`${file}: checksum mismatch (expected ${expected}, got ${actual}). Not writing it.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return 'downloaded';
}

async function main() {
  for (const entry of FILES) {
    console.log(`voice-assets: ${entry.file} ${await ensure(entry)}`);
  }
}

main().catch((error) => {
  console.error(`✖ voice-assets: ${error.message}`);
  process.exit(1);
});
