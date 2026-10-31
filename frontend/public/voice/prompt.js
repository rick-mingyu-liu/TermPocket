// Whisper's prompt for dictation (docs/VOICE.md, rounds 2 and 3). Shared by
// public/voice/worker.js and the Node harness in eval/voice/, so the benchmark
// runs the shipped prompt. The prompt stays on the device like the audio.
//
// Whisper copies the style of the text before <|startoftranscript|> and leans
// towards the words in it. Two findings decide the shape here:
// - Lowercase, no punctuation, amounts in words ("w2": 58/60 usable amounts,
//   20/20 on the owner's phone). A digit anywhere in the prompt makes Whisper
//   write digits, and then dollars and cents come out as one number ("Uber
//   2340", round 1's digits prompt), so no digit may ever reach the prompt.
// - The user's own recent merchant names, in the same style, bias recognition
//   towards the words that were misheard most ("drug mark", "best by").

/** The amount examples; always first, so their style wins. */
export const AMOUNT_EXAMPLES = 'pizza at dominos eighteen twenty five parking seven fifty yesterday paid twelve hundred rent sobeys forty three oh six today'
/** At most this many vocabulary terms, newest first. */
export const MAX_TERMS = 40
/** Each term keeps at most this many words. */
export const MAX_TERM_WORDS = 6
/**
 * Whisper reads at most 224 prompt tokens (half of its 448-token text context).
 * The cap leaves room for the special tokens around the prompt.
 */
export const MAX_PROMPT_TOKENS = 200

const EXAMPLE_WORDS = new Set(AMOUNT_EXAMPLES.split(' '))

/**
 * One term in prompt style: lowercase ASCII letters and single spaces, at
 * most MAX_TERM_WORDS words. Accents are folded (café → cafe), apostrophes
 * removed without a space (domino's → dominos), digits and every other
 * character dropped. Returns '' when nothing usable is left.
 */
export function cleanTerm(term) {
  if (typeof term !== 'string') return ''
  return term
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(' ')
    .filter(word => word.length > 1)
    .slice(0, MAX_TERM_WORDS)
    .join(' ')
}

/**
 * The vocabulary terms to add after the amount examples: cleaned, deduplicated,
 * in the order given (callers pass newest first), without terms whose every
 * word the examples already contain, at most `limit`.
 */
export function vocabulary(terms, limit = MAX_TERMS) {
  const out = []
  const seen = new Set()
  for (const raw of terms ?? []) {
    if (out.length >= limit) break
    const term = cleanTerm(raw)
    if (!term || seen.has(term)) continue
    if (term.split(' ').every(word => EXAMPLE_WORDS.has(word))) continue
    seen.add(term)
    out.push(term)
  }
  return out
}

/** The prompt as text, for reports and tests. */
export function promptText(terms = []) {
  return [AMOUNT_EXAMPLES, ...vocabulary(terms)].join(' ')
}

/**
 * The prompt's token ids: the amount examples, then vocabulary terms one by
 * one while the total stays within MAX_PROMPT_TOKENS, so a term is never cut
 * in the middle. `encode(text)` is the tokenizer's plain encoding (no special
 * tokens); each piece is encoded with a leading space, as Whisper tokenizes
 * words inside a sentence. The caller wraps the result in <|startofprev|> …
 * <|startoftranscript|><|notimestamps|>.
 */
export function buildPromptIds(encode, terms = [], cap = MAX_PROMPT_TOKENS) {
  const ids = [...encode(' ' + AMOUNT_EXAMPLES)]
  for (const term of vocabulary(terms)) {
    const piece = encode(' ' + term)
    if (ids.length + piece.length > cap) break
    ids.push(...piece)
  }
  return ids
}
