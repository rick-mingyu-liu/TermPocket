import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWav, encodeWav, parseWav } from '../lib/wav.mjs';

const dir = mkdtempSync(join(tmpdir(), 'voice-wav-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const samples = Float32Array.from([0, 0.5, -0.5, 0.25, -1]);

describe('readWav', () => {
  test('reads 16 kHz mono 16-bit PCM into Float32Array', () => {
    const file = join(dir, 'ok.wav');
    writeFileSync(file, encodeWav(samples));
    const out = readWav(file);
    assert.ok(out instanceof Float32Array);
    assert.equal(out.length, samples.length);
    for (let i = 0; i < samples.length; i++) assert.ok(Math.abs(out[i] - samples[i]) < 1e-4, `sample ${i}`);
  });

  test('rejects stereo, naming the file and the afconvert command', () => {
    const file = join(dir, 'stereo.wav');
    writeFileSync(file, encodeWav(samples, { channels: 2 }));
    assert.throws(() => readWav(file), (e) => e.message.includes('stereo.wav') && e.message.includes('channels') && e.message.includes('afconvert -f WAVE -d LEI16@16000 -c 1'));
  });

  test('rejects 44.1 kHz', () => {
    const file = join(dir, 'cd.wav');
    writeFileSync(file, encodeWav(samples, { sampleRate: 44_100 }));
    assert.throws(() => readWav(file), /cd\.wav: 44100 Hz, need 16000 Hz/);
  });

  test('rejects 8-bit samples and non-WAV bytes', () => {
    assert.throws(() => parseWav(encodeWav(samples, { bitsPerSample: 8 }), 'eight.wav'), /8-bit samples, need 16-bit/);
    assert.throws(() => parseWav(Buffer.from('not a wav file at all'), 'text.wav'), /text\.wav: not a RIFF\/WAVE file/);
  });

  test('skips unknown chunks before the data', () => {
    const base = encodeWav(samples);
    const list = Buffer.alloc(8 + 4);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(4, 4);
    list.write('INFO', 8, 'ascii');
    const withList = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    withList.writeUInt32LE(withList.length - 8, 4);
    assert.equal(parseWav(withList, 'list.wav').samples.length, samples.length);
  });
});
