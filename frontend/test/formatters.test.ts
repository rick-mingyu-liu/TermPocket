// Prevents an amount from showing a country prefix such as CA$, the wrong symbol, or the wrong number of decimals.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCurrency, formatCompactCurrency } from '../utils/formatters.ts'

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

  // An amount that rounds to 0.00 (-$0.00) is covered in money.test.ts.
})

describe('formatCompactCurrency', () => {
  // At most one decimal. Whether a whole value keeps a ".0" ($3.0K or $3K, $0.0
  // or $0) depends on the ICU data Node ships: Node 22 (CI) keeps it, newer
  // releases drop it, and browsers differ the same way. Either is short enough
  // for the axis gutter, which is what the function is for, so both pass.
  const tick = (expected: string) => {
    const escaped = expected.replace(/[$.]/g, '\\$&')
    // Only a whole value can gain the ".0".
    return new RegExp(`^${expected.includes('.') ? escaped : escaped.replace(/(\d)(?=[KM]?$)/, '$1(\\.0)?')}$`)
  }
  const assertTick = (actual: string, expected: string, message?: string) =>
    assert.match(actual, tick(expected), message)

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
      assertTick(formatCompactCurrency(amount), expected, String(amount))
    }
  })

  test('drops the country prefix for Canadian dollars too', () => {
    assertTick(formatCompactCurrency(3000, 'CAD'), '$3K')
  })

  test('keeps the symbol of other currencies', () => {
    assertTick(formatCompactCurrency(3000, 'EUR'), '€3K')
    assertTick(formatCompactCurrency(1500, 'CNY'), '¥1.5K')
  })

  test('puts the minus sign before the symbol', () => {
    assertTick(formatCompactCurrency(-2500, 'CAD'), '-$2.5K')
  })
})
