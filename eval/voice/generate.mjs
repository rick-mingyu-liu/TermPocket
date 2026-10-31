/**
 * The synthetic dictation set: the 20 fictional phrases of phrases.json spoken
 * by three macOS voices, as 16 kHz mono 16-bit WAV, plus a manifest.
 *
 *   node generate.mjs            -> synthetic/<voice>-<id>.wav + synthetic/manifest.json
 *   node generate.mjs --force    re-record clips that already exist
 *
 * macOS only (`say`); the clips take seconds to make, so they are not committed.
 * Same voices as docs/VOICE.md rounds 1 and 2: Samantha (en-US), Daniel
 * (en-GB), Karen (en-AU). The run is deterministic: `say` gives the same audio
 * for the same text and voice on the same macOS version.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseWav } from './lib/wav.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VOICES = ['Samantha', 'Daniel', 'Karen'];
const OUT = join(HERE, 'synthetic');

const { values: args } = parseArgs({ options: { force: { type: 'boolean', default: false } } });

const { phrases } = JSON.parse(readFileSync(join(HERE, 'phrases.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

const manifest = [];
let made = 0;
for (const voice of VOICES) {
  for (const phrase of phrases) {
    const file = `${voice}-${phrase.id}.wav`;
    const path = join(OUT, file);
    if (args.force || !existsSync(path)) {
      execFileSync('say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@16000', '-o', path, phrase.text], { stdio: 'inherit' });
      made += 1;
    }
    // `say` is asked for 16 kHz mono Int16; check it, since the reader refuses anything else.
    const { samples } = parseWav(readFileSync(path), path);
    manifest.push({ file, voice, ...phrase, seconds: Math.round((samples.length / 16_000) * 100) / 100 });
  }
}
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${manifest.length} clips (${made} recorded) in ${OUT}`);
