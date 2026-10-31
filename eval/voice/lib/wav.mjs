/**
 * Read a WAV clip into the Float32Array the dictation worker gets from the
 * browser: 16 kHz, mono, 16-bit PCM only. Anything else throws a message that
 * names the file and says how to convert it; the benchmark must never resample
 * on its own, or it would measure its resampler rather than the model.
 */
import { readFileSync } from 'node:fs';

export const SAMPLE_RATE = 16_000;

const CONVERT = 'convert it with `afconvert -f WAVE -d LEI16@16000 -c 1 in.m4a out.wav`';

/** Parse WAV bytes. Exported for tests; `readWav(file)` is the usual entry. */
export function parseWav(buffer, name = 'buffer') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const fail = (what) => { throw new Error(`${name}: ${what}; ${CONVERT}`); };
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    fail('not a RIFF/WAVE file');
  }
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      };
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (fmt.format === 0xfffe && size >= 26) fmt.format = bytes.readUInt16LE(start + 24);
    } else if (id === 'data') {
      data = bytes.subarray(start, Math.min(bytes.length, start + size));
    }
    offset = start + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt) fail('no fmt chunk');
  if (!data) fail('no data chunk');
  if (fmt.format !== 1) fail(`not PCM (format ${fmt.format})`);
  if (fmt.bitsPerSample !== 16) fail(`${fmt.bitsPerSample}-bit samples, need 16-bit`);
  if (fmt.channels !== 1) fail(`${fmt.channels} channels, need mono`);
  if (fmt.sampleRate !== SAMPLE_RATE) fail(`${fmt.sampleRate} Hz, need ${SAMPLE_RATE} Hz`);

  const samples = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample };
}

/** Read one clip; returns the samples as Float32Array in [-1, 1). */
export function readWav(file) {
  return parseWav(readFileSync(file), file).samples;
}

/** Build a 16-bit PCM WAV buffer from Float32 samples (tests, and nothing else). */
export function encodeWav(samples, { sampleRate = SAMPLE_RATE, channels = 1, bitsPerSample = 16 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  out.writeUInt16LE(channels * bytesPerSample, 32);
  out.writeUInt16LE(bitsPerSample, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    if (bitsPerSample === 16) out.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    else out.writeUInt8(Math.round((v + 1) * 127.5), 44 + i);
  }
  return out;
}
