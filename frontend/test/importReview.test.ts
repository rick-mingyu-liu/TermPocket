// Prevents the screenshot import's review screen from ticking, totalling or sending a row the API would refuse or the user did not choose.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CURRENCIES, attentionReasons, isComplete, normalizeAmount, toImportPayload, toReviewRows, totalsByCurrency,
} from '../lib/import/review.ts'
import type { DraftFlag, DraftRow, ReviewRow } from '../lib/import/review.ts'

/**
 * `lib/import/review.ts` is the review table's state as plain functions: what
 * a parsed row looks like on screen, whether it may be ticked, the per-currency
 * totals above the Import button, and the body of POST /transactions/import.
 * The server's own checks are `importValidation` in
 * `backend/routes/transactions.ts`; `isComplete` is meant to agree with them.
 */

const draft = (overrides: Partial<DraftRow> = {}): DraftRow => ({
  date: '2026-11-02',
  amount: '12.50',
  currency: 'CAD',
  description: 'Coffee Shop',
  category: 'Food & Dining',
  type: 'expense',
  confidence: 0.95,
  flags: [],
  source: 'parser',
  boxes: [{ x: 0, y: 0, width: 10, height: 10 }],
  ...overrides,
})

const row = (overrides: Partial<ReviewRow> = {}): ReviewRow => ({
  key: '1-0',
  shotId: 1,
  selected: true,
  edited: false,
  date: '2026-11-02',
  amount: '12.50',
  currency: 'CAD',
  description: 'Coffee Shop',
  category: 'Food & Dining',
  type: 'expense',
  flags: [],
  source: 'parser',
  boxes: [],
  ...overrides,
})

describe('normalizeAmount: what the user typed, in the API\'s two-decimal form', () => {
  const accepted: [string, string][] = [
    ['12.5', '12.50'],
    ['12', '12.00'],
    ['12.05', '12.05'],
    ['0.5', '0.50'],
    ['0.01', '0.01'],
    ['$12.50', '12.50'],
    [' $ 7 ', '7.00'],
    ['1,234', '1234.00'],
    ['1,234,567.8', '1234567.80'],
    ['007.10', '7.10'],
    ['99999999.99', '99999999.99'],
  ]
  for (const [input, expected] of accepted) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(normalizeAmount(input), expected)
    })
  }

  const refused = [
    '', ' ', 'abc', '0', '0.00', '$0', '0,000', '-5', '+5', '.50', '12.', '12.345',
    '1,23', '12,34', '1.234,56', '1 234', '12.50 CAD', '100000000', '1,000,000,000',
  ]
  for (const input of refused) {
    test(`${JSON.stringify(input)} is not an amount`, () => {
      assert.equal(normalizeAmount(input), null)
    })
  }
})

describe('isComplete: a row may be ticked only when the API would take it', () => {
  test('a filled-in row', () => {
    assert.equal(isComplete(row()), true)
  })

  test('the offered currencies are the six the API accepts', () => {
    assert.deepEqual(CURRENCIES, ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'CNY'])
    for (const currency of CURRENCIES) assert.equal(isComplete(row({ currency })), true, currency)
    assert.equal(isComplete(row({ currency: 'JPY' })), false)
    assert.equal(isComplete(row({ currency: 'cad' })), false)
  })

  test('the date must be a real calendar day in YYYY-MM-DD', () => {
    for (const date of ['2026-01-31', '2028-02-29', '2000-02-29', '2026-12-31']) {
      assert.equal(isComplete(row({ date })), true, date)
    }
    for (const date of ['', '2026-02-29', '2100-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-11-00', '2026-1-5', '02/11/2026', '2026-11-02T00:00:00Z']) {
      assert.equal(isComplete(row({ date })), false, date)
    }
  })

  test('the amount must be a positive two-decimal string of at most eight whole digits', () => {
    assert.equal(isComplete(row({ amount: '0.01' })), true)
    assert.equal(isComplete(row({ amount: '99999999.99' })), true)
    for (const amount of ['0.00', '12.5', '12', '-1.00', '100000000.00', '']) {
      assert.equal(isComplete(row({ amount })), false, amount)
    }
  })

  test('the description must be 1 to 255 characters once trimmed', () => {
    assert.equal(isComplete(row({ description: '' })), false)
    assert.equal(isComplete(row({ description: '   ' })), false)
    assert.equal(isComplete(row({ description: 'x'.repeat(255) })), true)
    assert.equal(isComplete(row({ description: `  ${'x'.repeat(255)}  ` })), true)
    assert.equal(isComplete(row({ description: 'x'.repeat(256) })), false)
  })

  test('CURRENT BEHAVIOUR (stricter than the server): the 255 limit counts UTF-16 units, so 128 emoji are "too long"', () => {
    // The server's isLength counts a surrogate pair as one character, so it
    // would accept this description; the review table will not let it be ticked.
    const emoji = '🍜'.repeat(128)
    assert.equal(emoji.length, 256)
    assert.equal(isComplete(row({ description: emoji })), false)
  })

  test('a category must be chosen', () => {
    assert.equal(isComplete(row({ category: '' })), false)
    assert.equal(isComplete(row({ category: '  ' })), false)
  })
})

describe('toReviewRows: parsed rows as they first appear in the table', () => {
  test('copies the draft, keys it by screenshot and position, and fills missing date and category with empty text', () => {
    const [first, second] = toReviewRows(3, [draft(), draft({ date: null, category: null, description: 'Refund', type: 'income', source: 'llm' })], [])
    assert.deepEqual(first, {
      key: '3-0', shotId: 3, selected: true, edited: false,
      date: '2026-11-02', amount: '12.50', currency: 'CAD', description: 'Coffee Shop', category: 'Food & Dining',
      type: 'expense', flags: [], source: 'parser', boxes: [{ x: 0, y: 0, width: 10, height: 10 }],
    })
    assert.equal(second.key, '3-1')
    assert.equal(second.date, '')
    assert.equal(second.category, '')
    assert.equal(second.type, 'income')
    assert.equal(second.source, 'llm')
  })

  test('a complete row starts ticked; an incomplete one starts unticked', () => {
    const rows = toReviewRows(1, [draft(), draft({ date: null }), draft({ category: null, description: 'Other' })], [])
    assert.deepEqual(rows.map((r) => r.selected), [true, false, false])
  })

  test('a row already on screen from another screenshot is a possible duplicate and starts unticked', () => {
    const existing = toReviewRows(1, [draft()], [])
    const [again] = toReviewRows(2, [draft()], existing)
    assert.deepEqual(again.flags, ['possible_duplicate'])
    assert.equal(again.selected, false)
    assert.deepEqual(existing[0].flags, [], 'the earlier row is not touched')
    assert.equal(existing[0].selected, true)
  })

  test('the duplicate check ignores case and surrounding spaces in the description, but not date, amount or currency', () => {
    const existing = toReviewRows(1, [draft()], [])
    const [sameButCased] = toReviewRows(2, [draft({ description: '  coffee shop ' })], existing)
    assert.ok(sameButCased.flags.includes('possible_duplicate'))
    for (const different of [draft({ date: '2026-11-03' }), draft({ amount: '12.51' }), draft({ currency: 'USD' }), draft({ description: 'Coffee Shop 2' })]) {
      const [r] = toReviewRows(2, [different], existing)
      assert.equal(r.flags.includes('possible_duplicate'), false, JSON.stringify(different))
      assert.equal(r.selected, true)
    }
  })

  test('the type is not part of the check: a refund matching an expense is still a possible duplicate', () => {
    const existing = toReviewRows(1, [draft()], [])
    const [refund] = toReviewRows(2, [draft({ type: 'income' })], existing)
    assert.ok(refund.flags.includes('possible_duplicate'))
  })

  test('two identical rows in one screenshot: the second is a possible duplicate', () => {
    // Two same-day coffees at the same price read as one purchase seen twice;
    // the user has to tick the second one themselves.
    const rows = toReviewRows(1, [draft(), draft()], [])
    assert.deepEqual(rows.map((r) => r.flags), [[], ['possible_duplicate']])
    assert.deepEqual(rows.map((r) => r.selected), [true, false])
  })

  test('a row the server already marked a possible duplicate is not marked twice, and starts unticked', () => {
    const existing = toReviewRows(1, [draft()], [])
    const [r] = toReviewRows(2, [draft({ flags: ['possible_duplicate'] })], existing)
    assert.deepEqual(r.flags, ['possible_duplicate'])
    assert.equal(r.selected, false)
  })

  test('the row gets its own copy of the flags', () => {
    const d = draft({ flags: ['low_confidence'] })
    const existing = toReviewRows(1, [d], [])
    toReviewRows(2, [d], existing)
    assert.deepEqual(d.flags, ['low_confidence'])
  })
})

describe('attentionReasons: why a row needs checking, most serious first', () => {
  test('no flags, no reasons', () => {
    assert.deepEqual(attentionReasons({ flags: [] }), [])
  })

  test('flags that are not problems give no reason', () => {
    assert.deepEqual(attentionReasons({ flags: ['arithmetic_verified', 'pending', 'possible_duplicate'] }), [])
  })

  test('ordered by seriousness, whatever order the flags arrive in', () => {
    const flags: DraftFlag[] = ['type_guessed', 'missing_date', 'low_confidence', 'corrected_chars', 'arithmetic_failed', 'balance_mismatch']
    assert.deepEqual(attentionReasons({ flags }), [
      'Does not match the running balance',
      'Receipt totals do not add up',
      'Some characters were guessed',
      'Hard to read',
      'No date found',
      'Income or expense was guessed',
    ])
  })

  test('every reason is translated in English and Chinese', () => {
    const reasons = attentionReasons({ flags: ['balance_mismatch', 'arithmetic_failed', 'corrected_chars', 'low_confidence', 'missing_date', 'type_guessed'] })
    for (const locale of ['en', 'zh']) {
      const strings = JSON.parse(readFileSync(new URL(`../public/locales/${locale}/common.json`, import.meta.url), 'utf8')) as Record<string, string>
      for (const reason of reasons) {
        assert.equal(typeof strings[reason], 'string', `${locale}: ${reason}`)
        assert.ok(strings[reason].length > 0, `${locale}: ${reason}`)
      }
    }
  })
})

describe('totalsByCurrency: the sums above the Import button', () => {
  test('nothing ticked, no totals', () => {
    assert.deepEqual(totalsByCurrency([]), [])
    assert.deepEqual(totalsByCurrency([row({ selected: false })]), [])
  })

  test('only ticked rows count, split by currency and by income and expense, in first-seen order', () => {
    const totals = totalsByCurrency([
      row({ currency: 'USD', amount: '5.00' }),
      row({ amount: '12.50' }),
      row({ amount: '100.00', selected: false }),
      row({ amount: '2000.00', type: 'income' }),
      row({ amount: '0.25' }),
    ])
    assert.deepEqual(totals, [
      { currency: 'USD', income: '0.00', expense: '5.00' },
      { currency: 'CAD', income: '2000.00', expense: '12.75' },
    ])
  })

  test('summed in whole cents, so ten 0.10 rows are exactly 1.00', () => {
    const rows = Array.from({ length: 10 }, () => row({ amount: '0.10' }))
    assert.deepEqual(totalsByCurrency(rows), [{ currency: 'CAD', income: '0.00', expense: '1.00' }])
    assert.deepEqual(
      totalsByCurrency([row({ amount: '0.10' }), row({ amount: '0.20' })]),
      [{ currency: 'CAD', income: '0.00', expense: '0.30' }],
    )
  })

  test('the largest amounts add up without losing a cent', () => {
    assert.deepEqual(
      totalsByCurrency([row({ amount: '99999999.99' }), row({ amount: '99999999.99' })]),
      [{ currency: 'CAD', income: '0.00', expense: '199999999.98' }],
    )
  })

  test('a ticked row whose amount is not in the two-decimal form is left out', () => {
    assert.deepEqual(totalsByCurrency([row({ amount: '12.5' }), row({ amount: '1.00' })]), [
      { currency: 'CAD', income: '0.00', expense: '1.00' },
    ])
  })
})

describe('toImportPayload: the body of POST /transactions/import', () => {
  test('ticked rows only, in table order, with exactly the fields the API validates', () => {
    const payload = toImportPayload([
      row({ key: '1-0', description: '  Coffee Shop  ', edited: true }),
      row({ key: '1-1', selected: false, description: 'Skipped' }),
      row({ key: '2-0', description: 'Payroll', type: 'income', category: 'Salary', amount: '2000.00', currency: 'USD', source: 'llm', flags: ['low_confidence'] }),
    ])
    assert.deepEqual(payload, {
      rows: [
        { date: '2026-11-02', amount: '12.50', description: 'Coffee Shop', category: 'Food & Dining', type: 'expense', currency: 'CAD', source: 'ocr', edited: true },
        { date: '2026-11-02', amount: '2000.00', description: 'Payroll', category: 'Salary', type: 'income', currency: 'USD', source: 'ocr_llm', edited: false },
      ],
    })
  })

  test('nothing ticked sends an empty list', () => {
    assert.deepEqual(toImportPayload([row({ selected: false })]), { rows: [] })
  })

  test('CURRENT BEHAVIOUR (bug): a ticked row that has since become incomplete is still sent', () => {
    // Switching a ticked row's type clears its category (ReviewTable keeps a
    // category only if it fits the new type). The row stays ticked, its
    // checkbox is then disabled so it cannot be unticked, and the Import
    // button sends it; the server refuses the whole import with a 400.
    const r = row({ type: 'income', category: '', edited: true })
    assert.equal(r.selected, true)
    assert.equal(isComplete(r), false)
    assert.equal(toImportPayload([r]).rows.length, 1)
  })
})
