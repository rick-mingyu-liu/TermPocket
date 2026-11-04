// Prevents an amount from showing a country prefix such as CA$, the wrong symbol, or the wrong number of decimals.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCurrency, formatCompactCurrency } from '../utils/formatters'

/**
 * `utils/formatters.ts` prints money: `formatCurrency` everywhere an amount is
 * shown, `formatCompactCurrency` on the dashboard's chart axis. Both always
 * format in 'en-US' with the narrow symbol, so these expectations hold
 * whatever locale the machine running the suite has.
 *
 * The currencies are the six the app offers (`currencies` in
 * `pages/transactions/new.tsx`, `CURRENCIES` in `lib/import/review.ts`).
 */

describe('formatCurrency', () => {
  test('defaults to US dollars, with two decimals and thousands separators', () => {
    assert.equal(formatCurrency(1234.5), '$1,234.50')
  })

  test('prints each currency the app offers with its symbol and no country prefix', () => {
    for (const [currency, expected] of [
      ['CAD', '$1,234.50'],
      ['USD', '$1,234.50'],
      ['EUR', '€1,234.50'],
      ['GBP', '£1,234.50'],
      // Not a USD/CAD special case: the narrow symbol for the Australian dollar is '$' too.
      ['AUD', '$1,234.50'],
      ['CNY', '¥1,234.50'],
    ]) {
      assert.equal(formatCurrency(1234.5, currency), expected, currency)
    }
  })

  test('always shows exactly two decimals', () => {
    assert.equal(formatCurrency(5, 'CAD'), '$5.00')
    assert.equal(formatCurrency(0, 'CAD'), '$0.00')
    assert.equal(formatCurrency(0.1 + 0.2, 'CAD'), '$0.30')
    assert.equal(formatCurrency(19.999, 'CAD'), '$20.00')
    assert.equal(formatCurrency(1_000_000, 'EUR'), '€1,000,000.00')
  })

  test('puts the minus sign before the symbol', () => {
    assert.equal(formatCurrency(-42.1, 'CAD'), '-$42.10')
    assert.equal(formatCurrency(-42.1, 'GBP'), '-£42.10')
  })

  test('BUG (current behaviour): a total that rounds to zero from below prints as -$0.00', () => {
    // The backend sums amounts as floating point (summaryController.ts:
    // `totalIncome += convertedAmount`, `netIncome = totalIncome - totalExpenses`),
    // so a month that breaks even can come back a hair below zero: an income of
    // 0.30 against expenses of 0.10 and 0.20 gives 0.3 - (0.1 + 0.2), which is
    // about -5.6e-17. Intl keeps the sign of a negative number that rounds to
    // zero, so the dashboard's Net Income card shows "-$0.00", in red because
    // it tests `>= 0` on the raw number (the monthly average does the same).
    // Pinned as it is; not fixed here.
    assert.equal(formatCurrency(0.3 - (0.1 + 0.2), 'CAD'), '-$0.00')
    assert.equal(formatCurrency(-0.001, 'CAD'), '-$0.00')
    // The other direction is fine.
    assert.equal(formatCurrency((0.1 + 0.2) - 0.3, 'CAD'), '$0.00')
  })
})

describe('formatCompactCurrency', () => {
  test('shortens axis ticks to at most one decimal', () => {
    for (const [amount, expected] of [
      [0, '$0'],
      [500, '$500'],
      [1000, '$1K'],
      [1500, '$1.5K'],
      [3000, '$3K'],
      [12_345, '$12.3K'],
      [1_250_000, '$1.3M'],
    ] as const) {
      assert.equal(formatCompactCurrency(amount), expected, String(amount))
    }
  })

  test('drops the country prefix for Canadian dollars too', () => {
    assert.equal(formatCompactCurrency(3000, 'CAD'), '$3K')
  })

  test('keeps the symbol of other currencies', () => {
    assert.equal(formatCompactCurrency(3000, 'EUR'), '€3K')
    assert.equal(formatCompactCurrency(1500, 'CNY'), '¥1.5K')
  })

  test('puts the minus sign before the symbol', () => {
    assert.equal(formatCompactCurrency(-2500, 'CAD'), '-$2.5K')
  })
})
