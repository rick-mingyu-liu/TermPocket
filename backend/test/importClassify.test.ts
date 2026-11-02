import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupRows } from '../services/import/rows';
import { classifyLayout } from '../services/import/classify';
import { categorize, KEYWORDS } from '../services/import/categorize';
import { CATEGORIES } from '../db/demoData';
import { TODAY, line, bankScreenshot, receiptPhoto, stackedBalanceLines } from './helpers/ocrLayouts';
import type { TransactionType } from '../types/import';

/**
 * Which parser a screenshot goes to, and the first-guess category of each row.
 */
describe('classifyLayout', () => {
  test('a bank list', () => {
    const result = classifyLayout(bankScreenshot(), TODAY);
    assert.equal(result.layout, 'bank-list');
    assert.ok(result.confidence >= 0.6, `confidence ${result.confidence}`);
  });

  test('a receipt', () => {
    const result = classifyLayout(receiptPhoto(), TODAY);
    assert.equal(result.layout, 'receipt');
    assert.ok(result.confidence >= 0.6, `confidence ${result.confidence}`);
  });

  test('a bank list with squeezed dates, chevrons and INTERAC in every row', () => {
    const result = classifyLayout(groupRows(stackedBalanceLines()), TODAY);
    assert.equal(result.layout, 'bank-list');
    assert.ok(result.confidence >= 0.6, `confidence ${result.confidence}`);
  });

  test('text with no signals is unknown', () => {
    assert.deepEqual(classifyLayout(groupRows([line('hello world')]), TODAY),
      { layout: 'unknown', confidence: 0 });
  });
});

describe('categorize', () => {
  test('guesses from the merchant, longest keyword first', () => {
    assert.equal(categorize('SOBEYS #1234', 'expense'), 'Groceries');
    assert.equal(categorize('UBER EATS *ORDER', 'expense'), 'Dining Out');
    assert.equal(categorize('UBER *TRIP', 'expense'), 'Transportation');
    assert.equal(categorize("McDonald's #40", 'expense'), 'Dining Out');
    assert.equal(categorize('PAYROLL DEPOSIT', 'income'), 'Salary');
    assert.equal(categorize('GITHUB, INC.', 'expense'), 'Software & Apps');
    assert.equal(categorize('RENDER.COM', 'expense'), 'Software & Apps');
    assert.equal(categorize('APPLE.COM/BILL', 'expense'), 'Software & Apps');
    assert.equal(categorize('GOODLIFE FITNESS', 'expense'), 'Fitness');
    assert.equal(categorize('MONTHLY FEE', 'expense'), 'Fees & Charges');
    assert.equal(categorize('OSAP DISBURSEMENT', 'income'), 'Scholarships & Grants');
    assert.equal(categorize('AMAZON REFUND', 'income'), 'Refunds');
    // The longer tax-refund keywords outrank "refund".
    assert.equal(categorize('CRA REFUND', 'income'), 'Tax Refund');
    assert.equal(categorize('CANADA FED TAX REFUND', 'income'), 'Tax Refund');
    // "interest charge" is a fee on the expense side; "interest" stays income.
    assert.equal(categorize('INTEREST CHARGE', 'expense'), 'Fees & Charges');
    assert.equal(categorize('INTEREST', 'income'), 'Investment Returns');
    // A bare "render" is not how Render bills; only "render.com" is.
    assert.equal(categorize('RENDER FARM PRINTS', 'expense'), null);
  });

  test('answers only within the transaction type, and only when sure', () => {
    assert.equal(categorize('PAYROLL DEPOSIT', 'expense'), null);
    assert.equal(categorize('Some Local Shop', 'expense'), null);
    assert.equal(categorize('', 'expense'), null);
    // "interest" in "INTERESTING" is not a match.
    assert.equal(categorize('INTERESTING BOOKS', 'income'), null);
  });

  test('every category it can answer is one the picker offers', () => {
    // Object.entries's type widens KEYWORDS's keys to string (TS7053 without
    // this), though KEYWORDS is declared Record<TransactionType, ...> and only
    // ever has the two.
    for (const [type, map] of Object.entries(KEYWORDS) as [TransactionType, Record<string, string[]>][]) {
      for (const category of Object.keys(map)) {
        assert.ok(CATEGORIES[type].includes(category), `${category} is not a ${type} category`);
      }
    }
  });
});
