// Audio clean-up before Whisper (docs/VOICE.md, round 3). Pure functions on
// 16 kHz mono Float32Array samples, shared by public/voice/worker.js and the
// Node harness in eval/voice/, so the benchmark measures the shipped code.
// Nothing here keeps or sends audio.

/** Below this sample peak a recording is silence: Whisper is never asked to invent words for it. */
export const SILENCE_PEAK = 0.01
/**
 * A recording whose peak is below this is quiet (a phone held away from the
 * mouth, a low gain setting) and is brought up to TARGET_PEAK. A louder one is
 * left at its own level: on the synthetic set, rescaling healthy takes changed
 * four transcripts for a net loss of one (docs/VOICE.md, round 3), so the gain
 * only touches takes that need it.
 */
export const QUIET_PEAK = 0.3
/** A quiet recording is scaled so its loudest sample reaches this level. */
export const TARGET_PEAK = 0.9
/** Kept on each side of the speech so a clipped first or last consonant does not become a different word. */
export const PAD_MS = 200
/** Trim windows: energy is measured over this many milliseconds. */
export const WINDOW_MS = 20
/** A window is speech when its RMS is at least this fraction of the loudest window's ... */
export const RELATIVE_FLOOR = 0.08
/** ... and at least this absolute RMS, so room noise around a quiet take is not kept as "speech". */
export const ABSOLUTE_FLOOR = 0.004

/** The largest absolute sample. */
export function peakOf(audio) {
  let peak = 0
  for (let i = 0; i < audio.length; i++) {
    const v = Math.abs(audio[i])
    if (v > peak) peak = v
  }
  return peak
}

/** RMS of each consecutive window of `size` samples (the last one may be shorter). */
export function windowRms(audio, size) {
  const out = new Float32Array(Math.ceil(audio.length / size))
  for (let w = 0; w < out.length; w++) {
    const start = w * size
    const end = Math.min(audio.length, start + size)
    let sum = 0
    for (let i = start; i < end; i++) sum += audio[i] * audio[i]
    out[w] = Math.sqrt(sum / (end - start))
  }
  return out
}

/**
 * Trim the silence around the speech and bring it to a known level.
 *
 * Returns a new Float32Array. An empty one means no speech (the peak is below
 * SILENCE_PEAK), which the caller reports as such without running the model.
 * Trimming uses window RMS, not single samples, so a click does not count as
 * speech; PAD_MS of context stays on each side. A quiet take (peak below
 * QUIET_PEAK) is scaled so its peak is TARGET_PEAK; a louder one keeps its
 * level. Nothing ever clips.
 */
export function prepare(audio, { sampleRate = 16_000, quietPeak = QUIET_PEAK, targetPeak = TARGET_PEAK, padMs = PAD_MS } = {}) {
  const peak = peakOf(audio)
  if (peak < SILENCE_PEAK) return new Float32Array(0)

  const size = Math.max(1, Math.round(sampleRate * WINDOW_MS / 1000))
  const rms = windowRms(audio, size)
  let loudest = 0
  for (let w = 0; w < rms.length; w++) if (rms[w] > loudest) loudest = rms[w]
  const threshold = Math.max(ABSOLUTE_FLOOR, loudest * RELATIVE_FLOOR)

  let first = 0
  while (first < rms.length && rms[first] < threshold) first++
  let last = rms.length - 1
  while (last > first && rms[last] < threshold) last--
  // Every window is below the absolute floor: keep the whole take rather than nothing.
  if (first >= rms.length) { first = 0; last = rms.length - 1 }

  const pad = Math.round(sampleRate * padMs / 1000)
  const start = Math.max(0, first * size - pad)
  const end = Math.min(audio.length, (last + 1) * size + pad)

  const out = new Float32Array(end - start)
  const gain = peak < quietPeak ? targetPeak / peak : 1
  for (let i = start; i < end; i++) out[i - start] = audio[i] * gain
  return out
}
