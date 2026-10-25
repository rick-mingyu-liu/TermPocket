/// <reference lib="es2024.string" />
import config = require('../../config');
import { AgentError, type ConversationSettings, type DraftRow } from './types';
export const currencies = ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'CNY'];
/**
 * A remembered fact's text kept as data, with no invisible direction controls
 * or malformed UTF-16. Here rather than in memory.ts so the runtime, which
 * cleans facts again at read time, never imports the database.
 */
export function cleanMemoryText(text: string): string {
  // These are deliberately matched so untrusted text cannot hide instructions.
  // eslint-disable-next-line no-control-regex
  return text.toWellFormed().replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ');
}
export const categories = {
  income: ['Salary', 'Freelance', 'Investment Returns', 'Business', 'Tax Refund', 'Other Income'],
  expense: ['Groceries', 'Dining Out', 'Transportation', 'Housing', 'Utilities', 'Entertainment', 'Shopping', 'Healthcare', 'Education', 'Travel', 'Savings', 'Other Expenses'],
};
function invalid(): never { throw new AgentError('agent_invalid_input'); }
export function validateUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value.toLowerCase();
}
/** A real calendar day 'YYYY-MM-DD' between 1900 and 2100; 2026-02-30 is not one. */
export function validateDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const day = new Date(`${value}T00:00:00.000Z`); if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
export function validateSettings(value: unknown): ConversationSettings {
  if (!value || typeof value !== 'object') invalid();
  const { currency, timezone, language } = value as Record<string, unknown>;
  if (typeof currency !== 'string' || !currencies.includes(currency) || typeof timezone !== 'string' || timezone.length > 100 || typeof language !== 'string' || !['auto', 'en', 'zh'].includes(language)) invalid();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { invalid(); }
  return { currency, timezone, language: language as ConversationSettings['language'] };
}
export function validateMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > config.agent.maxInputChars || value.includes('\0')) invalid();
  return value.trim();
}
export function validateRows(value: unknown, allowEmpty = false): DraftRow[] {
  if (!Array.isArray(value) || value.length > config.agent.maxRows || (!allowEmpty && value.length === 0)) invalid();
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') invalid();
    const row = item as Record<string, unknown>;
    const id = validateUuid(row.id);
    if (ids.has(id)) invalid(); ids.add(id);
    const { amount, description, category, type, date, currency } = row;
    if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,7})\.\d{2}$/.test(amount) || amount === '0.00') invalid();
    if (typeof description !== 'string' || !description.trim() || description.length > 255 || description.includes('\0')) invalid();
    if ((type !== 'expense' && type !== 'income') || typeof category !== 'string' || !categories[type].includes(category)) invalid();
    const day = validateDay(date);
    if (typeof currency !== 'string' || !currencies.includes(currency)) invalid();
    return { id, amount, description: description.trim(), category, type, date: day, currency };
  });
}
export const validateDraftRows = validateRows;
/** The largest amount a DECIMAL(10,2) column holds, in cents. */
export const MAX_AMOUNT_CENTS = 9_999_999_999;
/**
 * A decimal string with at most two places ('12', '12.5', '12.50') as integer
 * cents, parsed from the digits, never through floating point.
 */
export function decimalCents(value: unknown, options: { min?: number; max?: number; negative?: boolean } = {}): number {
  const { min = 0, max = MAX_AMOUNT_CENTS, negative = false } = options;
  if (typeof value !== 'string' || !(negative ? /^-?\d{1,8}(\.\d{1,2})?$/ : /^\d{1,8}(\.\d{1,2})?$/).test(value)) invalid();
  const text = value as string;
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const cents = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (text.startsWith('-') ? -1 : 1);
  if (cents < min || cents > max) invalid();
  return cents === 0 ? 0 : cents;
}
/** Integer cents as a two-decimal string: -1234 -> '-12.34'. */
export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
