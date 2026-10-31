/**
 * Scoring for dictation transcripts: the rule of docs/VOICE.md round 2.
 *
 * A clip's amount is "usable" when the transcript has the right digits with the
 * right decimal (`23.40`, `$23.40`, and the split digits `23 40`), or when its
 * number words unambiguously say it (`twenty three forty`, `nine fifty`,
 * `eighty four dollars and twenty cents`). "dollars", "and", "cents" and "us"
 * are ignored. Squashed digits (`2340`) and wrong numbers fail. "strict" also
 * fails split digits such as `42 17`.
 *
 * Merchant, date and keep words must be present after normalising case,
 * accents and apostrophes (domino's = dominos); a hyphen separates words, and
 * words may run together (co-op = coop = co op, no frills = nofrills).
 */

const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ZEROS = new Set(['zero', 'oh', 'o']);
const MULTIPLIERS = { hundred: 100, thousand: 1000 };
const IGNORED = new Set(['dollars', 'dollar', 'bucks', 'buck', 'and', 'cents', 'cent', 'us']);

export const NUMBER_WORDS = new Set([
  ...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(TENS), ...ZEROS, ...Object.keys(MULTIPLIERS),
]);

const isNumberWord = (w) => NUMBER_WORDS.has(w);
const DIGITS = /^\d{1,3}(,\d{3})+(\.\d+)?$|^\d+(\.\d+)?$/;

/** Tokens for amount parsing: lowercased, `$` and trailing punctuation stripped. */
export function amountTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9.,$]+/g, ' ')
    .split(' ')
    .map((t) => t.replace(/^\$+/, '').replace(/[.,]+$/, ''))
    .filter((t) => t.length > 0);
}

/**
 * A small number (below 100) starting at words[i], or null.
 * Returns { value, len, digits }: `digits` keeps a leading zero ("oh six" → "06").
 */
function parseSmall(words, i) {
  const w = words[i];
  if (w === undefined) return null;
  if (ZEROS.has(w)) {
    const unit = UNITS[words[i + 1]];
    if (unit !== undefined) return { value: unit, len: 2, digits: `0${unit}` };
    return { value: 0, len: 1, digits: '0' };
  }
  if (TEENS[w] !== undefined) return { value: TEENS[w], len: 1, digits: String(TEENS[w]) };
  if (TENS[w] !== undefined) {
    const unit = UNITS[words[i + 1]];
    if (unit !== undefined) return { value: TENS[w] + unit, len: 2, digits: String(TENS[w] + unit) };
    return { value: TENS[w], len: 1, digits: String(TENS[w]) };
  }
  if (UNITS[w] !== undefined) return { value: UNITS[w], len: 1, digits: String(UNITS[w]) };
  return null;
}

/**
 * Split a run of number words into groups. "twenty three forty" → [23, 40];
 * "one thousand one hundred fifty" → [1150]; "forty three oh six" → [43, 06].
 * A new group starts wherever the next word cannot extend the current number.
 */
export function numberGroups(words) {
  const groups = [];
  let i = 0;
  while (i < words.length) {
    let total = 0;
    let digits = null;
    let consumed = false;
    for (;;) {
      let seg = parseSmall(words, i);
      if (seg) {
        i += seg.len;
      } else if (MULTIPLIERS[words[i]] !== undefined && total === 0 && !consumed) {
        seg = { value: 1, len: 0, digits: '1' }; // "hundred fifty" (after "a")
      } else {
        break;
      }
      consumed = true;
      let value = seg.value;
      let segDigits = seg.digits;
      if (words[i] === 'hundred') {
        value *= 100;
        i += 1;
        const rest = parseSmall(words, i);
        if (rest) { value += rest.value; i += rest.len; }
        segDigits = null;
      }
      if (words[i] === 'thousand') {
        total += value * 1000;
        i += 1;
        digits = null;
        continue; // the part below a thousand may follow
      }
      total += value;
      digits = total === value ? segDigits : null;
      break;
    }
    if (!consumed) { i += 1; continue; } // a bare multiplier mid-run: skip it
    groups.push({ value: total, digits: digits ?? String(total), fromDigits: false });
  }
  return groups;
}

function digitGroup(token) {
  const plain = token.replace(/,/g, '');
  const [whole, frac] = plain.split('.');
  return {
    value: Number(plain),
    digits: whole,
    fromDigits: true,
    cents: frac !== undefined ? Math.round(Number(plain) * 100) : null,
  };
}

/**
 * Every amount a transcript could be read as, in cents, each flagged `strict`
 * (false when it comes from two digit tokens such as `42 17`).
 */
export function amountCandidates(text) {
  const tokens = amountTokens(text);
  const runs = [];
  let run = [];
  let words = [];
  const flushWords = () => { if (words.length) { run.push(...numberGroups(words)); words = []; } };
  const flushRun = () => { flushWords(); if (run.length) runs.push(run); run = []; };
  for (const token of tokens) {
    if (IGNORED.has(token)) continue;
    if (DIGITS.test(token)) { flushWords(); run.push(digitGroup(token)); }
    else if (isNumberWord(token)) words.push(token);
    else flushRun();
  }
  flushRun();

  const out = [];
  const add = (cents, strict) => { if (Number.isFinite(cents)) out.push({ cents, strict }); };
  for (const groups of runs) {
    for (let g = 0; g < groups.length; g++) {
      const a = groups[g];
      if (a.cents !== null && a.cents !== undefined) { add(a.cents, true); continue; }
      add(a.value * 100, true);
      const b = groups[g + 1];
      if (!b || (b.cents !== null && b.cents !== undefined)) continue;
      const strict = !(a.fromDigits && b.fromDigits);
      if (b.value < 100 && b.digits.length <= 2) add(a.value * 100 + b.value, strict);
      // "one twenty eight" can be 128 as well as 1.28: the digit concatenation.
      if (!a.fromDigits && !b.fromDigits) add(Number(a.digits + b.digits) * 100, strict);
    }
  }
  return out;
}

export const toCents = (amount) => Math.round(Number(String(amount).replace(/[$,]/g, '')) * 100);

/** The words of a transcript for merchant/date/keep checks. */
export function normalizeWords(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Whether `phrase`'s words appear in `text`, as consecutive words or run
 * together ("no frills" matches "nofrills"; "co-op" matches "coop" and "co op").
 */
export function hasWords(text, phrase) {
  const want = normalizeWords(phrase);
  if (!want.length) return true;
  const target = want.join('');
  const words = normalizeWords(text);
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < words.length && joined.length < target.length; j++) {
      joined += words[j];
      if (joined === target) return true;
    }
  }
  return false;
}

/**
 * Score one transcript against a phrase's truth. Each flag is null when the
 * truth has nothing to check (no merchant, no date, no keep words).
 */
export function scoreClip(transcript, truth) {
  const text = transcript ?? '';
  const wanted = new Set([truth.amount, ...(truth.alsoAccept ?? [])].map(toCents));
  const candidates = amountCandidates(text);
  const amount = candidates.some((c) => wanted.has(c.cents));
  const strict = candidates.some((c) => c.strict && wanted.has(c.cents));
  const merchant = truth.merchant ? hasWords(text, truth.merchant) : null;
  const date = truth.date ? hasWords(text, truth.date) : null;
  const keep = truth.keep?.length ? truth.keep.every((w) => hasWords(text, w)) : null;
  return { amount, strict, merchant, date, keep, transcript: text };
}

/** Totals over scored clips: `{ amount: {ok, of}, ..., perVoice: { Samantha: {ok, of} } }`. */
export function summarize(results) {
  const tally = () => ({ ok: 0, of: 0 });
  const bump = (t, flag) => { if (flag !== null) { t.of += 1; if (flag) t.ok += 1; } };
  const totals = { amount: tally(), strict: tally(), merchant: tally(), date: tally(), keep: tally(), perVoice: {} };
  for (const r of results) {
    for (const key of ['amount', 'strict', 'merchant', 'date', 'keep']) bump(totals[key], r[key]);
    if (r.voice) {
      totals.perVoice[r.voice] ??= { amount: tally(), strict: tally(), merchant: tally() };
      bump(totals.perVoice[r.voice].amount, r.amount);
      bump(totals.perVoice[r.voice].strict, r.strict);
      bump(totals.perVoice[r.voice].merchant, r.merchant);
    }
  }
  return totals;
}

export const ratio = (t) => `${t.ok}/${t.of}`;
