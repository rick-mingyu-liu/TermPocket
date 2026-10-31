import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreClip, summarize, amountCandidates, numberGroups, hasWords } from '../lib/score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { phrases } = JSON.parse(readFileSync(join(HERE, '..', 'phrases.json'), 'utf8'));
const byId = (id) => phrases.find((p) => p.id === id);

describe('phrases.json', () => {
  test('has the 20 round-2 phrases, each with a two-decimal amount', () => {
    assert.equal(phrases.length, 20);
    for (const p of phrases) {
      assert.match(p.amount, /^\d+\.\d\d$/, p.id);
      assert.equal(p.text, p.text.toLowerCase(), p.id);
      assert.ok(Array.isArray(p.keep), p.id);
    }
  });
});

describe('scoreClip: amounts', () => {
  for (const p of phrases) {
    test(`${p.id} "${p.text}" is recognised from its own words`, () => {
      const s = scoreClip(p.text, p);
      assert.equal(s.amount, true);
      assert.equal(s.strict, true);
    });
    const digits = p.amount.replace(/\.00$/, '');
    test(`${p.id} is recognised from $${digits}, ${digits} and the split digits`, () => {
      assert.equal(scoreClip(`${p.merchant ?? 'x'} $${digits}`, p).strict, true);
      assert.equal(scoreClip(`${p.merchant ?? 'x'} ${digits}`, p).strict, true);
      assert.equal(scoreClip(`${p.merchant ?? 'x'} ${p.amount}`, p).strict, true);
      const [whole, cents] = p.amount.split('.');
      const split = scoreClip(`${p.merchant ?? 'x'} ${whole} ${cents}`, p);
      assert.equal(split.amount, true, 'split digits are usable');
      // "500 00" still has "500" on its own, which is strict; only real cents make the split non-strict.
      if (cents !== '00') assert.equal(split.strict, false, 'split digits are not strict');
    });
  }

  test('squashed digits fail', () => {
    assert.equal(scoreClip('uber 2340', byId('02')).amount, false);
    assert.equal(scoreClip('netflix 1699', byId('09')).amount, false);
    assert.equal(scoreClip('spent 950 on bubble tea yesterday', byId('16')).amount, false);
  });
  test('wrong numbers fail', () => {
    assert.equal(scoreClip('refund from best buy 1899', byId('20')).amount, false);
    assert.equal(scoreClip('refund from best buy eighteen ninety nine', byId('20')).amount, false);
    assert.equal(scoreClip('uber twenty three fourteen', byId('02')).amount, false);
  });
  test('strict fails split digits like 42 17 but not words or decimals', () => {
    const split = scoreClip('amazon order 42 17', byId('17'));
    assert.deepEqual([split.amount, split.strict], [true, false]);
    assert.equal(scoreClip('amazon order forty two seventeen', byId('17')).strict, true);
    assert.equal(scoreClip('amazon order 42.17', byId('17')).strict, true);
  });
  test('dollars, and, cents and us are ignored', () => {
    assert.equal(scoreClip('dinner at the keg 84 dollars and twenty cents last night', byId('10')).strict, true);
    assert.equal(scoreClip('twenty five us dollars on steam', byId('14')).strict, true);
    assert.equal(scoreClip('$25.00 on steam', byId('14')).strict, true);
  });
  test('bus pass one twenty eight is usable as words, 128 or 1.28', () => {
    const p = byId('06');
    assert.equal(scoreClip('bus pass one twenty eight yesterday', p).amount, true);
    assert.equal(scoreClip('bus pass 128 yesterday', p).amount, true);
    assert.equal(scoreClip('bus pass 1.28 yesterday', p).amount, true);
    assert.equal(scoreClip('bus pass 12.80 yesterday', p).amount, false);
  });
  test('thousands and hundreds build one number', () => {
    assert.equal(scoreClip('paid rent $1,150', byId('04')).strict, true);
    assert.equal(scoreClip('paid rent eleven fifty', byId('04')).strict, true);
    assert.equal(scoreClip('got paid 2480 from my co-op', byId('07')).strict, true);
    assert.equal(scoreClip('tuition deposit 500', byId('18')).strict, true);
    assert.deepEqual(numberGroups(['twelve', 'hundred']).map((g) => g.value), [1200]);
    assert.deepEqual(numberGroups(['forty', 'three', 'oh', 'six']).map((g) => g.digits), ['43', '06']);
    assert.equal(scoreClip('sobeys forty three oh six', { amount: '43.06', keep: [] }).strict, true);
  });
  test('an empty transcript fails everything the truth asks for', () => {
    const s = scoreClip('', byId('03'));
    assert.deepEqual([s.amount, s.strict, s.merchant, s.date, s.keep], [false, false, false, false, null]);
  });
  test('candidates carry the strict flag', () => {
    assert.deepEqual(amountCandidates('23 40').filter((c) => c.cents === 2340), [{ cents: 2340, strict: false }]);
    assert.deepEqual(amountCandidates('twenty three forty').filter((c) => c.cents === 2340), [{ cents: 2340, strict: true }]);
  });
});

describe('scoreClip: merchant, date, keep', () => {
  test('merchant words must all be present, case and punctuation aside', () => {
    assert.equal(scoreClip('Shoppers Drug Mart 12.49 today.', byId('13')).merchant, true);
    assert.equal(scoreClip('shoppers drug mark twelve forty nine today', byId('13')).merchant, false);
    assert.equal(scoreClip('refund from best by eighty nine ninety nine', byId('20')).merchant, false);
    assert.equal(scoreClip('you but twenty three forty', byId('02')).merchant, false);
    assert.equal(scoreClip('Groceries at No-Frills 62.18 yesterday', byId('03')).merchant, true);
  });
  test("domino's and dominos, co-op, coop and co op are alike", () => {
    assert.equal(hasWords("pizza at Domino's", 'dominos'), true);
    assert.equal(hasWords('pizza at dominos', "domino's"), true);
    for (const t of ['from my co-op', 'from my coop', 'from my co op']) assert.equal(hasWords(t, 'co-op'), true, t);
    assert.equal(hasWords('from michael art', 'co-op'), false);
  });
  test('date words', () => {
    assert.equal(scoreClip('dinner at the keg 84.20 last night', byId('10')).date, true);
    assert.equal(scoreClip('dinner at the keg 84.20 tonight', byId('10')).date, false);
    assert.equal(scoreClip('uber 23.40', byId('02')).date, null);
  });
  test('keep words', () => {
    assert.equal(scoreClip('twenty five us dollars on steam', byId('14')).keep, true);
    assert.equal(scoreClip('$25 on steam', byId('14')).keep, false);
    assert.equal(scoreClip('twenty five-us-dollars on steam', byId('14')).keep, true, 'hyphens separate words');
    assert.equal(scoreClip('twenty five-us-dollars on steam', byId('14')).strict, true);
    assert.equal(scoreClip('launch fifteen dollars', byId('01')).keep, false);
    assert.equal(scoreClip('uber 23.40', byId('02')).keep, null);
  });
  test('null when the truth has no merchant', () => {
    assert.equal(scoreClip('haircut 35', byId('11')).merchant, null);
  });
});

describe('summarize', () => {
  test('counts only the flags a truth asks for, per voice too', () => {
    const results = [
      { voice: 'A', amount: true, strict: false, merchant: null, date: true, keep: null },
      { voice: 'A', amount: false, strict: false, merchant: true, date: null, keep: false },
      { voice: 'B', amount: true, strict: true, merchant: false, date: null, keep: null },
    ];
    const t = summarize(results);
    assert.deepEqual(t.amount, { ok: 2, of: 3 });
    assert.deepEqual(t.strict, { ok: 1, of: 3 });
    assert.deepEqual(t.merchant, { ok: 1, of: 2 });
    assert.deepEqual(t.date, { ok: 1, of: 1 });
    assert.deepEqual(t.keep, { ok: 0, of: 1 });
    assert.deepEqual(t.perVoice.A.amount, { ok: 1, of: 2 });
    assert.deepEqual(t.perVoice.B.amount, { ok: 1, of: 1 });
  });
});
