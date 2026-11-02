import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryGuidance } from '../services/agent/categoryGuidance';
import { categories } from '../services/agent/validation';
import { KEYWORDS } from '../services/import/categorize';

const lines = categoryGuidance().split('\n');
const lineFor = (category: string) => lines.find(line => line.startsWith(`- ${category} (`));

test('every canonical category has one guidance line with a definition, expenses first', () => {
  const names = lines.map(line => /^- (.+?) \((expense|income)\)/.exec(line)?.[1]);
  assert.deepEqual(names, [...categories.expense, ...categories.income]);
  for (const type of ['expense', 'income'] as const) {
    for (const category of categories[type]) {
      const line = lineFor(category);
      assert.ok(line, category);
      // A category added without a definition would be listed by name only; that is the degraded form this test refuses.
      assert.match(line, new RegExp(`^- ${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(${type}\\): \\S`), category);
    }
  }
});

test('the importer\'s merchant keywords appear as examples under their category', () => {
  for (const type of ['expense', 'income'] as const) {
    for (const [category, words] of Object.entries(KEYWORDS[type])) {
      const line = lineFor(category);
      assert.ok(line, category);
      for (const word of words) assert.ok(line.includes(word), `${category}: ${word}`);
    }
  }
  // The two misses that motivated the guide.
  assert.ok(lineFor('Groceries')?.includes('t&t'));
  assert.match(lineFor('Software & Apps') ?? '', /hosting/);
  assert.doesNotMatch(lineFor('Utilities') ?? '', /hosting|software/);
});

test('the catch-all categories are marked as last resorts and nothing else is', () => {
  assert.match(lineFor('Other Expenses') ?? '', /^- Other Expenses \(expense\): only /);
  assert.match(lineFor('Other Income') ?? '', /^- Other Income \(income\): only /);
  for (const line of lines) if (!/^- Other /.test(line)) assert.doesNotMatch(line, /\): only /);
});

test('the guidance is static text: no digits, no newlines inside a line, same on every call', () => {
  assert.equal(categoryGuidance(), categoryGuidance());
  for (const line of lines) assert.doesNotMatch(line, /\d/);
});
