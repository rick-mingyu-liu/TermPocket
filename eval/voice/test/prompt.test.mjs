// The shared prompt module shipped to the browser (frontend/public/voice/prompt.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AMOUNT_EXAMPLES, MAX_TERMS, MAX_TERM_WORDS, MAX_PROMPT_TOKENS, cleanTerm, vocabulary, promptText, buildPromptIds } from '../../../frontend/public/voice/prompt.js';

// One token per word, so token counts are word counts.
// Distinct letter-only words (cleanTerm drops digits, which would make numbered terms collapse).
const word = (i) => String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)) + 'x';
const encode = (text) => text.trim().split(/\s+/).filter(Boolean).map((w) => w.length);

describe('AMOUNT_EXAMPLES', () => {
  test('is lowercase, letters and spaces only, with no digit', () => {
    assert.match(AMOUNT_EXAMPLES, /^[a-z]+( [a-z]+)*$/);
  });
});

describe('cleanTerm', () => {
  test('lowercases and folds accents', () => {
    assert.equal(cleanTerm('Williams Fresh Café'), 'williams fresh cafe');
  });
  test('removes apostrophes without a space', () => {
    assert.equal(cleanTerm("Domino's"), 'dominos');
    assert.equal(cleanTerm('McDonald’s'), 'mcdonalds');
  });
  test('drops digits and punctuation, hyphen becomes a space', () => {
    assert.equal(cleanTerm('Zehrs #412'), 'zehrs');
    assert.equal(cleanTerm('Petro-Canada'), 'petro canada');
    assert.equal(cleanTerm('Amazon.ca order'), 'amazon ca order');
    assert.equal(cleanTerm('Laundry 3.50'), 'laundry');
    assert.equal(cleanTerm('T&T Supermarket'), 'supermarket');
  });
  test('keeps at most MAX_TERM_WORDS words and returns empty for nothing usable', () => {
    assert.equal(cleanTerm('a b c d e f g h').split(' ').filter(Boolean).length, 0, 'one-letter words are dropped');
    const long = cleanTerm('alpha beta gamma delta epsilon zeta eta theta');
    assert.equal(long.split(' ').length, MAX_TERM_WORDS);
    assert.equal(cleanTerm('12345 !!'), '');
    assert.equal(cleanTerm(null), '');
    assert.equal(cleanTerm(42), '');
  });
});

describe('vocabulary', () => {
  test('dedupes after cleaning and keeps the given order', () => {
    assert.deepEqual(vocabulary(['Uber', 'uber ', 'UBER #1', 'Netflix']), ['uber', 'netflix']);
  });
  test('caps at MAX_TERMS', () => {
    const many = Array.from({ length: MAX_TERMS + 10 }, (_, i) => `${word(i)} store`);
    assert.equal(vocabulary(many).length, MAX_TERMS);
    assert.equal(vocabulary(many, 3).length, 3);
  });
  test('drops terms made only of example words', () => {
    assert.deepEqual(vocabulary(['Sobeys', 'Rent', 'Paid rent', 'Sobeys Waterloo']), ['sobeys waterloo']);
  });
  test('tolerates no terms', () => {
    assert.deepEqual(vocabulary(undefined), []);
    assert.deepEqual(vocabulary([]), []);
  });
});

describe('promptText', () => {
  test('is the examples followed by the vocabulary', () => {
    assert.equal(promptText(), AMOUNT_EXAMPLES);
    assert.equal(promptText(['Tim Hortons']), `${AMOUNT_EXAMPLES} tim hortons`);
  });
});

describe('buildPromptIds', () => {
  const exampleTokens = encode(` ${AMOUNT_EXAMPLES}`).length;
  test('starts with the examples and adds whole terms', () => {
    const ids = buildPromptIds(encode, ['No Frills', 'Uber']);
    assert.equal(ids.length, exampleTokens + 3);
    assert.deepEqual(ids.slice(0, exampleTokens), encode(` ${AMOUNT_EXAMPLES}`));
  });
  test('never cuts a term and respects the cap', () => {
    const cap = exampleTokens + 4;
    const ids = buildPromptIds(encode, ['one two three', 'four five', 'six'], cap);
    // "one two three" fits (3), "four five" would exceed (5 > 4) and stops the loop.
    assert.equal(ids.length, exampleTokens + 3);
    assert.ok(ids.length <= cap);
  });
  test('uses MAX_PROMPT_TOKENS by default', () => {
    const terms = Array.from({ length: MAX_TERMS }, (_, i) => `${word(i)} store on king street west`); // 6 words each
    const ids = buildPromptIds(encode, terms);
    assert.ok(ids.length <= MAX_PROMPT_TOKENS);
    assert.ok(ids.length > MAX_PROMPT_TOKENS - 6, 'filled close to the cap');
  });
  test('the examples alone stay within the cap', () => {
    assert.ok(buildPromptIds(encode, []).length < MAX_PROMPT_TOKENS);
  });
});
