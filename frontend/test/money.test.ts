// Prevents a net amount that rounds to zero from showing as "-$0.00" or in red.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCurrency, moneySign } from '../utils/formatters.ts'

// A month whose income equals its spending, summed as floating point the way
// the backend's summary does: about -5.6e-17.
const breakEven = 0.3 - (0.1 + 0.2)

describe('an amount that rounds to 0.00 is zero', () => {
  test('0', () => {
    assert.equal(formatCurrency(0, 'CAD'), '$0.00')
    assert.equal(moneySign(0), 0)
  })

  test('-0', () => {
    assert.equal(formatCurrency(-0, 'CAD'), '$0.00')
    assert.equal(moneySign(-0), 0)
  })

  test('-0.004', () => {
    assert.equal(formatCurrency(-0.004, 'CAD'), '$0.00')
    assert.equal(formatCurrency(-0.004, 'EUR'), '€0.00')
    assert.equal(moneySign(-0.004), 0)
  })

  test('a break-even month summed as floating point', () => {
    assert.ok(breakEven < 0)
    assert.equal(formatCurrency(breakEven, 'CAD'), '$0.00')
    assert.equal(moneySign(breakEven), 0)
  })

  test('0.004 too', () => {
    assert.equal(formatCurrency(0.004, 'CAD'), '$0.00')
    assert.equal(moneySign(0.004), 0)
  })
})

describe('an amount that rounds to a cent keeps its sign', () => {
  test('-0.005 rounds away from zero, to -$0.01', () => {
    assert.equal(formatCurrency(-0.005, 'CAD'), '-$0.01')
    assert.equal(moneySign(-0.005), -1)
  })

  test('-0.01 and 0.01', () => {
    assert.equal(formatCurrency(-0.01, 'CAD'), '-$0.01')
    assert.equal(moneySign(-0.01), -1)
    assert.equal(formatCurrency(0.01, 'CAD'), '$0.01')
    assert.equal(moneySign(0.01), 1)
  })

  test('ordinary amounts', () => {
    assert.equal(formatCurrency(-42.1, 'CAD'), '-$42.10')
    assert.equal(moneySign(-42.1), -1)
    assert.equal(formatCurrency(1234.5, 'USD'), '$1,234.50')
    assert.equal(moneySign(1234.5), 1)
  })
})
