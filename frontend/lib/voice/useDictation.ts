import { useCallback, useEffect, useRef, useState } from 'react'

/** Whisper's input rate. */
const SAMPLE_RATE = 16_000
/** Recording stops by itself after this long. */
export const DICTATION_LIMIT_MS = 15_000
/** Below this peak level a recording is treated as silence, so Whisper is never asked to invent words for it. */
const SILENCE_PEAK = 0.01
/** A recording smaller than this holds no usable speech (a tap-tap, or a recorder that produced nothing). */
const MIN_RECORDING_BYTES = 1_000
/** A model download that reports no progress for this long is treated as failed. */
const LOAD_STALL_MS = 5 * 60_000

export type DictationState =
  | { status: 'idle' }
  | { status: 'loading'; loaded: number; total: number }
  // The model finished loading on this tap; the next tap records, so the
  // microphone and audio context start inside a user gesture (iOS).
  | { status: 'ready' }
  | { status: 'recording'; elapsed: number }
  | { status: 'transcribing' }

export type DictationError = 'denied' | 'noMic' | 'noSpeech' | 'loadFailed' | 'failed'

type WorkerReply =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; message: string }

type Waiting = { resolve: (text: string) => void; reject: (error: Error) => void }

/**
 * Whether this browser can dictate: a secure context with a microphone API,
 * MediaRecorder, module-capable workers, WebAssembly and Web Audio. Call it
 * only in the browser (after mount), never during server rendering.
 */
export function dictationSupported(): boolean {
  return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined' && typeof Worker !== 'undefined'
    && typeof WebAssembly !== 'undefined' && typeof AudioContext !== 'undefined' && typeof OfflineAudioContext !== 'undefined'
}

/**
 * Decode a recording (webm/opus in Chrome and Firefox, mp4/aac in Safari) and
 * resample it to 16 kHz mono, which Whisper expects.
 */
async function toWhisperInput(blob: Blob, context: AudioContext): Promise<Float32Array> {
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    return (await offline.startRendering()).getChannelData(0)
  } finally {
    // iOS allows only a few live AudioContexts per page.
    void context.close().catch(() => undefined)
  }
}

function silent(audio: Float32Array): boolean {
  for (let i = 0; i < audio.length; i++) if (Math.abs(audio[i]!) >= SILENCE_PEAK) return false
  return true
}

/**
 * On-device English dictation. `toggle` loads the model on first use (and
 * cancels that load if tapped again), then stops at 'ready'; once the model is
 * loaded it starts or stops a recording. A transcript is handed to
 * `onText` and never sent anywhere. The model worker lives at
 * /voice/worker.js and is created on first use and terminated on unmount.
 * Audio exists only in this tab's memory: it is not uploaded, stored or logged.
 */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>({ status: 'idle' })
  const [error, setError] = useState<DictationError | null>(null)
  const worker = useRef<Worker | null>(null)
  const ready = useRef<Promise<void> | null>(null)
  const loaded = useRef(false)
  const rejectLoad = useRef<((error: Error) => void) | null>(null)
  const cancelled = useRef(false)
  const waiting = useRef(new Map<number, Waiting>())
  const nextId = useRef(1)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const discard = useRef(false)
  const timers = useRef<{ tick?: ReturnType<typeof setInterval>; limit?: ReturnType<typeof setTimeout> }>({})
  const mounted = useRef(true)
  const deliver = useRef(onText)
  deliver.current = onText

  const update = (next: DictationState) => { if (mounted.current) setState(next) }
  const fail = (code: DictationError) => { if (mounted.current) { setError(code); setState({ status: 'idle' }) } }

  const stopWorker = useCallback(() => {
    worker.current?.terminate()
    worker.current = null
    ready.current = null
    loaded.current = false
    // Settle a load in progress so nothing waits on a terminated worker.
    rejectLoad.current?.(new Error('The speech engine stopped.'))
    rejectLoad.current = null
    for (const { reject } of waiting.current.values()) reject(new Error('The speech engine stopped.'))
    waiting.current.clear()
  }, [])

  /** Create the worker and load the model, once; a failure lets the next tap start over. */
  const load = useCallback((): Promise<void> => {
    if (ready.current) return ready.current
    const w = new Worker('/voice/worker.js', { type: 'module' })
    worker.current = w
    const promise = new Promise<void>((resolve, reject) => {
      let stall: ReturnType<typeof setTimeout> | undefined
      const watch = () => { clearTimeout(stall); stall = setTimeout(() => reject(new Error('The speech model stopped downloading.')), LOAD_STALL_MS) }
      watch()
      rejectLoad.current = error => { clearTimeout(stall); reject(error) }
      w.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
        if (data.type === 'progress') { watch(); if (!cancelled.current) update({ status: 'loading', loaded: data.loaded, total: data.total }) }
        else if (data.type === 'ready') { clearTimeout(stall); rejectLoad.current = null; loaded.current = true; resolve() }
        else if (data.type === 'result') { waiting.current.get(data.id)?.resolve(data.text); waiting.current.delete(data.id) }
        else if (data.id === undefined) rejectLoad.current?.(new Error(data.message))
        else { waiting.current.get(data.id)?.reject(new Error(data.message)); waiting.current.delete(data.id) }
      }
      // A worker that cannot start (missing file, no module workers) or that
      // crashed later: fail the load and anything waiting, and start over next time.
      w.onerror = event => { event.preventDefault(); if (worker.current === w) stopWorker() }
    })
    ready.current = promise
    promise.catch(() => { if (worker.current === w) stopWorker() })
    w.postMessage({ type: 'load' })
    return promise
  }, [stopWorker])

  const transcribe = (audio: Float32Array) => new Promise<string>((resolve, reject) => {
    const w = worker.current
    if (!w) { reject(new Error('The speech engine is not running.')); return }
    const id = nextId.current++
    waiting.current.set(id, { resolve, reject })
    w.postMessage({ type: 'transcribe', id, audio }, [audio.buffer])
  })

  const release = () => {
    clearInterval(timers.current.tick); clearTimeout(timers.current.limit)
    timers.current = {}
    // Stopping every track turns off the browser's microphone indicator.
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null
  }

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }, [])

  /** Stop without transcribing: the page is hidden or closing. */
  const abandon = useCallback(() => {
    if (recorder.current?.state !== 'recording') return
    discard.current = true
    recorder.current.stop()
  }, [])

  const record = async () => {
    // Both are created synchronously in the tap's handler, inside its user
    // gesture, which iOS Safari wants for the microphone and Web Audio.
    const context = new AudioContext()
    const closeContext = () => { void context.close().catch(() => undefined) }
    let media: MediaStream
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (cause) {
      closeContext()
      const name = (cause as Error)?.name
      fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'noMic' : 'failed')
      return
    }
    if (!mounted.current) { media.getTracks().forEach(track => track.stop()); closeContext(); return }
    stream.current = media
    const chunks: Blob[] = []
    const r = new MediaRecorder(media)
    recorder.current = r
    discard.current = false
    r.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    r.onstop = async () => {
      release()
      recorder.current = null
      if (discard.current || !mounted.current) { closeContext(); update({ status: 'idle' }); return }
      const blob = new Blob(chunks, { type: r.mimeType })
      if (blob.size < MIN_RECORDING_BYTES) { closeContext(); fail('noSpeech'); return }
      update({ status: 'transcribing' })
      try {
        // toWhisperInput closes the context.
        const audio = await toWhisperInput(blob, context)
        const text = silent(audio) ? '' : await transcribe(audio)
        if (!mounted.current) return
        if (!text) { fail('noSpeech'); return }
        update({ status: 'idle' })
        deliver.current(text)
      } catch {
        fail('failed')
      }
    }
    const started = Date.now()
    r.start()
    update({ status: 'recording', elapsed: 0 })
    timers.current.tick = setInterval(() => update({ status: 'recording', elapsed: Date.now() - started }), 250)
    timers.current.limit = setTimeout(stop, DICTATION_LIMIT_MS)
  }

  const toggle = useCallback(async () => {
    if (state.status === 'recording') { stop(); return }
    if (state.status === 'loading') {
      // Cancel the download; the next tap starts it again (files already
      // fetched stay in the browser's cache).
      cancelled.current = true
      stopWorker()
      update({ status: 'idle' })
      return
    }
    if (state.status === 'transcribing') return
    setError(null)
    if (loaded.current) { await record(); return }
    cancelled.current = false
    update({ status: 'loading', loaded: 0, total: 0 })
    try {
      await load()
    } catch {
      if (!cancelled.current) fail('loadFailed')
      return
    }
    if (cancelled.current) return
    // Never start listening on its own after a download: wait for a tap.
    update({ status: 'ready' })
    // record and update are recreated each render but only touch refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, load, stop, stopWorker])

  useEffect(() => {
    mounted.current = true
    const hidden = () => { if (document.visibilityState === 'hidden') abandon() }
    document.addEventListener('visibilitychange', hidden)
    return () => {
      mounted.current = false
      document.removeEventListener('visibilitychange', hidden)
      abandon()
      release()
      stopWorker()
    }
    // release only touches refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abandon, stopWorker])

  return { state, error, toggle, clearError: useCallback(() => setError(null), []) }
}
