import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMemoryFields, validateMemoryDraft, cleanMemoryText } from '../services/agent/memory';

const fields = { kind: 'expense', text: 'Rent', amount: '950.00', currency: 'CAD', cadence: 'month' };
const id = '00000000-0000-4000-8000-000000000001';
const version = '2026-10-23 12:00:00.123456';
const remember = () => ({ action: 'remember', kind: 'expense', memory_id: null, expected_updated_at: null, before: null, after: fields });
const invalid = (fn: () => unknown) => assert.throws(fn, { code: 'agent_invalid_input' });

test('memory fields keep multilingual text and normalize optional fields without inventing money', () => {
  assert.deepEqual(validateMemoryFields({ kind: 'preference', text: '吃饭归为 Food 🐸' }), { kind: 'preference', text: '吃饭归为 Food 🐸', amount: null, currency: null, cadence: null });
  assert.deepEqual(validateMemoryFields(fields), fields);
  for (const kind of ['income', 'expense', 'reserve', 'preference', 'other']) assert.equal(validateMemoryFields({kind, text: 'Fact'}).kind, kind);
});

test('text replaces controls, bidi overrides and lone surrogates while retaining valid astral characters', () => {
  assert.equal(cleanMemoryText('Rent\nCAD\u0000\u007f\u202e\u2066\ud800x\udfff🐸'), 'Rent CAD    �x�🐸');
  assert.equal(validateMemoryFields({ kind: 'other', text: '🐸'.repeat(120) }).text, '🐸'.repeat(120));
  invalid(() => validateMemoryFields({ kind: 'other', text: '🐸'.repeat(121) }));
  for (const text of ['', '   ', '\n\u202e', 1, null, undefined]) invalid(() => validateMemoryFields({kind: 'other', text}));
});

test('memory fields reject unknown keys and invalid kinds', () => {
  for (const value of [null, [], 'rent', {}, {...fields, kind: 'system'}, {...fields, user_id: 7}, {...fields, text: 'x'.repeat(121)}]) invalid(() => validateMemoryFields(value));
});

test('amount requires an exact positive two-decimal string in DECIMAL(10,2) range', () => {
  for (const amount of ['0.00', '-1.00', '1', '1.0', '1.001', '100000000.00', '01.00', 1, NaN, true, '1e2']) invalid(() => validateMemoryFields({...fields, amount}));
  assert.equal(validateMemoryFields({...fields, amount: '0.01'}).amount, '0.01');
  assert.equal(validateMemoryFields({...fields, amount: '99999999.99'}).amount, '99999999.99');
});

test('currency and cadence require money and are limited to supported values', () => {
  for (const currency of [undefined, null, '', 'JPY', 'cad']) invalid(() => validateMemoryFields({...fields, currency}));
  for (const currency of ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'CNY']) assert.equal(validateMemoryFields({...fields, currency}).currency, currency);
  for (const cadence of ['week', 'two_weeks', 'month', 'once', null]) assert.equal(validateMemoryFields({...fields, cadence}).cadence, cadence);
  for (const cadence of ['day', 'year', '', 1]) invalid(() => validateMemoryFields({...fields, cadence}));
  invalid(() => validateMemoryFields({kind: 'other', text: 'x', currency: 'CAD'}));
  invalid(() => validateMemoryFields({kind: 'other', text: 'x', cadence: 'month'}));
});

test('updates retain omitted fields and amount null clears currency and cadence together', () => {
  const prior = validateMemoryFields(fields);
  assert.deepEqual(validateMemoryFields({text: 'New rent'}, prior), {...fields, text: 'New rent'});
  assert.deepEqual(validateMemoryFields({amount: null}, prior), {...fields, amount: null, currency: null, cadence: null});
  assert.deepEqual(validateMemoryFields({cadence: null}, prior), {...fields, cadence: null});
  invalid(() => validateMemoryFields({text: null}, prior));
});

test('remember drafts have no previous fact or version and are fully revalidated', () => {
  assert.deepEqual(validateMemoryDraft(remember()), remember());
  for (const over of [{memory_id:id}, {expected_updated_at:version}, {before:fields}, {after:null}, {kind:'income'}, {user_id:7}, {action:'save'}]) invalid(() => validateMemoryDraft({...remember(), ...over}));
  invalid(() => validateMemoryDraft({...remember(), after:{...fields, amount:'1.001'}}));
});

test('update and forget drafts require matching kind, owned-fact identifier and exact version shape', () => {
  const update = {action:'update',kind:'expense',memory_id:id,expected_updated_at:version,before:fields,after:{...fields,text:'New rent'}};
  assert.deepEqual(validateMemoryDraft(update), update);
  const forget = {...update,action:'forget',after:null};
  assert.deepEqual(validateMemoryDraft(forget), forget);
  for (const over of [{memory_id:null}, {memory_id:'bad'}, {expected_updated_at:null}, {expected_updated_at:'2026-10-23'}, {before:null}, {after:null}]) invalid(() => validateMemoryDraft({...update,...over}));
  invalid(() => validateMemoryDraft({...forget,after:fields}));
  invalid(() => validateMemoryDraft({...forget,kind:'reserve'}));
});

test('thirty maximal cleaned facts fit the documented fourteen-thousand-character envelope', () => {
  for (const text of ['"'.repeat(120), '\\'.repeat(120), '\ud800'.repeat(120)]) {
    const maximum = validateMemoryFields({kind:'preference',text,amount:'99999999.99',currency:'CAD',cadence:'two_weeks'});
    const facts = Array.from({length:30}, () => ({id,version,...maximum,saved_on:'2026-10-23'}));
    assert.ok(JSON.stringify(facts).length <= 14000);
  }
});
