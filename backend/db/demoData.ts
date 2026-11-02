/**
 * The demo account's data, generated relative to whatever today is.
 *
 * The old seed hardcoded dates in March–June 2025. By August 2026 that meant a
 * demo account whose dashboard was **empty**: the app now defaults to
 * `?term=current`, and the newest transaction was fourteen months old. Its
 * three savings goals were all past their target date, so the first thing a
 * visitor saw was three red *Overdue* badges. Anchoring to `now` is the whole
 * point of this file — the demo is as current on its thousandth run as its
 * first.
 *
 * ## The story it tells
 *
 * A Waterloo co-op student, alternating study and work terms. That is not
 * decoration: it is what makes the period selector mean something. A study
 * term is tuition plus rent against a part-time income and runs at a loss; a
 * co-op term earns and saves. Toggling *This term* / *Last term* shows those
 * two shapes side by side, which is the comparison the whole app is for. The
 * old seed showed a salaried adult saving for a down payment on a $250,000
 * house — a different person with a different problem.
 *
 * The current term is truncated at today, so the demo reads as live rather
 * than as a finished ledger.
 *
 * ## Deterministic
 *
 * Amounts vary month to month — a flat line makes a bad chart — but the
 * variation comes from a seeded generator keyed on the term and the category,
 * not from `Math.random()`. Re-seeding on the same day produces byte-identical
 * data, which is what makes the refresh safe to run repeatedly and the output
 * possible to test.
 *
 * ## Categories
 *
 * Every category here appears in `CATEGORIES`, which mirrors the canonical
 * list exported from `frontend/pages/transactions/new.tsx`. A demo transaction
 * in an unlisted category renders with a hash-derived colour and an
 * untranslated name. `test/demoData.test.ts`
 * asserts the seed never invents one.
 */

import { currentTerm, previousTerm, nextTerm, boundsOf, monthsOf, labelOf } from '../utils/terms';
import { toDay } from '../utils/dates';
import type { TransactionType } from '../types/db';

const DEMO_EMAIL = 'john.doe@example.com';

/** Mirrors the canonical list in frontend/pages/transactions/new.tsx. */
const CATEGORIES = {
  income: [
    'Salary', 'Freelance', 'Investment Returns', 'Business', 'Tax Refund',
    'Scholarships & Grants', 'Refunds', 'Gifts Received', 'Other Income',
  ],
  expense: [
    'Groceries', 'Dining Out', 'Transportation', 'Housing', 'Utilities',
    'Entertainment', 'Shopping', 'Healthcare', 'Education', 'Travel',
    'Software & Apps', 'Personal Care', 'Fitness', 'Gifts & Donations', 'Fees & Charges',
    'Savings', 'Other Expenses',
  ],
};

/** How many terms of history to generate — five is 20 months, so `year=previous` is full. */
const TERMS_OF_HISTORY = 5;

/** One row of the demo transaction list before `currency`/`term` are attached. */
interface DemoTransactionInput {
  date: string;
  amount: number;
  description: string;
  category: string;
  type: TransactionType;
}

/** A demo transaction, as inserted by `demoAccountService` — narrower than `TransactionRow`, which is a read shape. */
interface DemoTransaction extends DemoTransactionInput {
  currency: string;
  term: string;
}

/** A demo savings goal, as inserted by `demoAccountService`. */
interface DemoGoal {
  name: string;
  target_amount: number;
  current_amount: number;
  target_date: string;
  description: string;
}

interface DemoData {
  email: string;
  transactions: DemoTransaction[];
  goals: DemoGoal[];
  terms: string[];
}

/**
 * A small deterministic generator. Keyed on a string so the same term and
 * category always produce the same jitter, and re-seeding is idempotent.
 */
function seededRandom(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** `amount` jittered by up to `spread`, rounded to cents. */
const vary = (rand: () => number, amount: number, spread: number): number =>
  Math.round((amount + (rand() * 2 - 1) * spread) * 100) / 100;

/** The `day`th day of the month beginning `monthStart`, clamped to the month. */
function dayIn(monthStart: string, day: number): string {
  // monthsOf() always hands this a 'YYYY-MM-01' string, so the split always
  // has exactly 2 numeric parts; noUncheckedIndexedAccess would otherwise
  // type each as `number | undefined` from the generic `.map(Number)` array.
  const [year, month] = monthStart.split('-').map(Number) as [number, number];
  const lastDay = new Date(year, month, 0).getDate();
  return `${monthStart.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/**
 * Study terms and co-op terms alternate. Anchored so the *current* term is a
 * co-op term: the demo opens on a healthy, positive month, and the contrast
 * only appears when a visitor clicks Last term. That is the more interesting
 * order to discover them in.
 */
const isCoopTerm = (offsetFromCurrent: number): boolean => offsetFromCurrent % 2 === 0;

/** One month of a study term: tuition and rent against a part-time income. */
function studyMonth(monthStart: string, indexInTerm: number, rand: () => number): DemoTransactionInput[] {
  const rows: DemoTransactionInput[] = [];
  const add = (day: number, amount: number, description: string, category: string, type: TransactionType): void => {
    rows.push({ date: dayIn(monthStart, day), amount, description, category, type });
  };

  if (indexInTerm === 0) {
    add(5, 4380.00, 'Tuition — term fees', 'Education', 'expense');
    add(3, 3200.00, 'OSAP disbursement', 'Other Income', 'income');
    add(8, 420.00, 'Textbooks and course notes', 'Education', 'expense');
  }
  add(1, 795.00, 'Rent — student house', 'Housing', 'expense');
  add(15, vary(rand, 640, 90), 'TA hours', 'Salary', 'income');
  add(22, vary(rand, 180, 60), 'Tutoring', 'Freelance', 'income');
  add(6, vary(rand, 340, 55), 'Groceries', 'Groceries', 'expense');
  add(19, vary(rand, 145, 40), 'Groceries', 'Groceries', 'expense');
  add(12, vary(rand, 58, 14), 'Utilities — split with housemates', 'Utilities', 'expense');
  add(9, vary(rand, 96, 38), 'Dining out', 'Dining Out', 'expense');
  add(25, vary(rand, 52, 26), 'Coffee and study sessions', 'Dining Out', 'expense');
  add(17, vary(rand, 44, 22), 'Entertainment', 'Entertainment', 'expense');

  if (indexInTerm === 1) add(14, vary(rand, 128, 45), 'Winter clothes', 'Shopping', 'expense');
  if (indexInTerm === 2) add(20, vary(rand, 85, 30), 'Prescription and pharmacy', 'Healthcare', 'expense');
  if (indexInTerm === 3) add(11, vary(rand, 165, 50), 'Bus home for the break', 'Transportation', 'expense');
  return rows;
}

/** One month of a co-op term: a salary, a city rent, and room to save. */
function coopMonth(monthStart: string, indexInTerm: number, rand: () => number): DemoTransactionInput[] {
  const rows: DemoTransactionInput[] = [];
  const add = (day: number, amount: number, description: string, category: string, type: TransactionType): void => {
    rows.push({ date: dayIn(monthStart, day), amount, description, category, type });
  };

  add(15, vary(rand, 2010, 60), 'Co-op paycheque', 'Salary', 'income');
  add(30, vary(rand, 2010, 60), 'Co-op paycheque', 'Salary', 'income');
  add(1, 1240.00, 'Rent — sublet', 'Housing', 'expense');
  add(2, 156.00, 'Transit pass', 'Transportation', 'expense');
  add(5, vary(rand, 210, 45), 'Groceries', 'Groceries', 'expense');
  add(18, vary(rand, 195, 45), 'Groceries', 'Groceries', 'expense');
  add(10, vary(rand, 72, 16), 'Utilities and internet', 'Utilities', 'expense');
  add(8, vary(rand, 135, 50), 'Dining out', 'Dining Out', 'expense');
  add(21, vary(rand, 110, 45), 'Dining out with the team', 'Dining Out', 'expense');
  add(16, vary(rand, 105, 45), 'Entertainment', 'Entertainment', 'expense');
  add(28, 950.00, 'Transfer to savings', 'Savings', 'expense');

  if (indexInTerm === 0) add(7, vary(rand, 240, 70), 'Work clothes', 'Shopping', 'expense');
  if (indexInTerm === 1) add(24, vary(rand, 62, 20), 'Dividend', 'Investment Returns', 'income');
  if (indexInTerm === 2) add(13, vary(rand, 385, 120), 'Weekend trip', 'Travel', 'expense');
  if (indexInTerm === 3) {
    add(20, vary(rand, 148, 40), 'Dentist', 'Healthcare', 'expense');
    add(26, vary(rand, 310, 90), 'Flight home', 'Travel', 'expense');
  }
  return rows;
}

/**
 * The demo account's whole dataset, as of `now`.
 * Pure: no database, no clock of its own, no randomness that is not seeded.
 */
function buildDemoData(now: Date = new Date()): DemoData {
  // toDay only returns null for an invalid Date; every caller here passes a
  // genuine one, and the default parameter is `new Date()`.
  const today = toDay(now) as string;
  const terms: { id: string; offset: number }[] = [];
  let term = currentTerm(now);
  for (let i = 0; i < TERMS_OF_HISTORY; i++) {
    terms.unshift({ id: term, offset: i });
    term = previousTerm(term);
  }

  const transactions: DemoTransaction[] = [];
  for (const { id, offset } of terms) {
    const coop = isCoopTerm(offset);
    monthsOf(id).forEach((monthStart, indexInTerm) => {
      const rand = seededRandom(`${id}:${indexInTerm}`);
      const rows = coop
        ? coopMonth(monthStart, indexInTerm, rand)
        : studyMonth(monthStart, indexInTerm, rand);
      for (const row of rows) {
        // The current term stops at today. A demo showing next month's rent
        // already paid reads as fake, and it would put future-dated rows in
        // every total.
        if (row.date <= today) transactions.push({ ...row, currency: 'CAD', term: id });
      }
    });
  }
  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Goals are dated forward from today, so none of them opens as Overdue —
  // which is exactly how the old seed greeted every visitor.
  const nextTermStart = boundsOf(currentTerm(now)).end;
  // toDay guarantees 'YYYY-MM-DD', so the split always has exactly 3 numeric
  // parts; noUncheckedIndexedAccess would otherwise type each as
  // `number | undefined` from the generic `.map(Number)` array.
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const plus = (months: number): string => {
    const absolute = y * 12 + (m - 1) + months;
    const year = Math.floor(absolute / 12);
    const month = absolute % 12;
    // Clamped, so `plus(6)` from the 31st does not ask for the 31st of a month
    // that has 30 days.
    const day = Math.min(d, new Date(year, month + 1, 0).getDate());
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  const goals: DemoGoal[] = [
    {
      name: `Tuition for ${labelOf(nextTerm(currentTerm(now)))}`,
      target_amount: 4800.00,
      current_amount: 2950.00,
      target_date: nextTermStart,
      description: 'Cover next term of tuition without touching the emergency fund.',
    },
    {
      name: 'Emergency fund',
      target_amount: 6000.00,
      current_amount: 3350.00,
      target_date: plus(12),
      description: 'Three months of rent and groceries, so one bad month is not a crisis.',
    },
    {
      name: 'Exchange term abroad',
      target_amount: 8500.00,
      current_amount: 2100.00,
      target_date: plus(18),
      description: 'Flights, housing and fees for an exchange term.',
    },
  ];

  return { email: DEMO_EMAIL, transactions, goals, terms: terms.map((t) => t.id) };
}

export { buildDemoData, CATEGORIES, DEMO_EMAIL, TERMS_OF_HISTORY, isCoopTerm };
