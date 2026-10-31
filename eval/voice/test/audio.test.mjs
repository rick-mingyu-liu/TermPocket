// The shared audio clean-up shipped to the browser (frontend/public/voice/audio.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, peakOf, windowRms, SILENCE_PEAK, QUIET_PEAK, TARGET_PEAK, ABSOLUTE_FLOOR } from '../../../frontend/public/voice/audio.js';

const RATE = 16_000;
const seconds = (s) => Math.round(s * RATE);
function tone(length, amplitude, hz = 440) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

describe('peakOf / windowRms', () => {
  test('peak is the largest absolute sample', () => {
    assert.ok(Math.abs(peakOf(Float32Array.from([0.1, -0.7, 0.3])) - 0.7) < 1e-6);
    assert.equal(peakOf(new Float32Array(0)), 0);
  });
  test('window rms covers a shorter last window', () => {
    const rms = windowRms(Float32Array.from([1, 1, 1, 1, 1]), 2);
    assert.equal(rms.length, 3);
    for (const v of rms) assert.ok(Math.abs(v - 1) < 1e-6);
  });
});

describe('prepare', () => {
  test('silence gives an empty array', () => {
    assert.equal(prepare(new Float32Array(seconds(2))).length, 0);
    assert.equal(prepare(tone(seconds(1), SILENCE_PEAK / 2)).length, 0);
  });

  test('a quiet 3 s take with 1 s of tone in the middle trims to about 1.4 s at peak 0.9', () => {
    const audio = new Float32Array(seconds(3));
    audio.set(tone(seconds(1), 0.1), seconds(1));
    const out = prepare(audio, { sampleRate: RATE });
    const length = out.length / RATE;
    assert.ok(length > 1.35 && length < 1.45, `got ${length.toFixed(3)} s`);
    assert.ok(Math.abs(peakOf(out) - TARGET_PEAK) < 1e-3, `peak ${peakOf(out)}`);
  });

  test('a quiet take lands on the target peak', () => {
    for (const amplitude of [0.02, 0.1, QUIET_PEAK - 0.01]) {
      const out = prepare(tone(seconds(1), amplitude));
      const peak = peakOf(out);
      assert.ok(Math.abs(peak - TARGET_PEAK) < 1e-3, `amplitude ${amplitude}: peak ${peak}`);
    }
  });

  test('a take at a healthy level keeps its level, sample for sample', () => {
    for (const amplitude of [QUIET_PEAK, 0.5, 0.9]) {
      const audio = tone(seconds(1), amplitude);
      const out = prepare(audio);
      assert.equal(out.length, audio.length, `amplitude ${amplitude}: trimmed`);
      assert.ok(Math.abs(peakOf(out) - amplitude) < 1e-6, `amplitude ${amplitude}: peak ${peakOf(out)}`);
      assert.equal(out[1000], audio[1000]);
    }
  });

  test('keeps the whole take when every window is below the absolute floor but the peak is above the silence level', () => {
    const audio = new Float32Array(seconds(1));
    audio[seconds(0.5)] = SILENCE_PEAK * 2; // one click: window RMS far below ABSOLUTE_FLOOR
    const rms = windowRms(audio, 320);
    assert.ok(Math.max(...rms) < ABSOLUTE_FLOOR);
    const out = prepare(audio, { sampleRate: RATE });
    assert.equal(out.length, audio.length);
    assert.ok(Math.abs(peakOf(out) - TARGET_PEAK) < 1e-3);
  });

  test('returns a new array and leaves the input alone', () => {
    const audio = tone(seconds(1), 0.2);
    const before = audio[100];
    const out = prepare(audio);
    assert.notEqual(out, audio);
    assert.equal(audio[100], before);
  });
});
