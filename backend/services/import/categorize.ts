/**
 * A first guess at a category from the merchant name. Deliberately small: a
 * wrong guess costs the user a correction, and no guess costs them one pick,
 * so this only answers when a keyword is unambiguous.
 *
 * Every category named here must exist in the canonical list — the one in
 * frontend/pages/transactions/new.tsx, mirrored by db/demoData.ts and pinned
 * to it by test/demoData.test.ts. test/importClassify.test.ts checks this map
 * against that mirror.
 */
import type { TransactionType } from '../../types/import';

export const KEYWORDS: Record<TransactionType, Record<string, string[]>> = {
  expense: {
    Groceries: ['sobeys', 'loblaws', 'no frills', 'metro', 'freshco', 'food basics', 'zehrs',
      'fortinos', 't&t', 'farm boy', 'real canadian superstore', 'costco', 'safeway', 'longos'],
    'Dining Out': ['tim hortons', 'starbucks', 'mcdonald', 'subway', 'a&w', 'pizza', 'restaurant',
      'cafe', 'sushi', 'burrito', 'uber eats', 'doordash', 'skipthedishes', 'chipotle', 'popeyes'],
    Transportation: ['presto', 'grt', 'ttc', 'go transit', 'uber', 'lyft', 'petro canada', 'esso',
      'shell', 'pioneer', 'parking'],
    Utilities: ['rogers', 'bell canada', 'telus', 'fido', 'freedom mobile', 'koodo', 'enbridge',
      'hydro', 'kitchener utilities'],
    Entertainment: ['netflix', 'spotify', 'cineplex', 'steam', 'disney plus', 'crave'],
    Shopping: ['amazon', 'best buy', 'winners', 'ikea', 'canadian tire', 'dollarama', 'uniqlo',
      'walmart'],
    Healthcare: ['shoppers drug mart', 'rexall', 'pharmacy', 'dental', 'clinic', 'physio'],
    Education: ['university of waterloo', 'uwaterloo', 'w store', 'chegg', 'pearson', 'coursera'],
    Travel: ['air canada', 'westjet', 'via rail', 'airbnb', 'expedia', 'hotel', 'flair'],
    Housing: ['rent', 'property management'],
    'Software & Apps': ['github', 'openai', 'chatgpt', 'anthropic', 'vercel', 'render com', 'digitalocean',
      'icloud', 'google one', 'apple com bill', 'adobe', 'notion', 'figma', 'namecheap', 'godaddy'],
    'Personal Care': ['barber', 'hair salon', 'nail salon', 'sephora'],
    Fitness: ['goodlife', 'planet fitness', 'anytime fitness', 'warrior rec', 'gym'],
    'Gifts & Donations': ['donation', 'charity', 'red cross', 'unicef', 'gofundme'],
    'Fees & Charges': ['service charge', 'monthly fee', 'annual fee', 'overdraft', 'nsf', 'interest charge',
      'late fee', 'atm fee'],
  },
  income: {
    Salary: ['payroll', 'salary', 'pay deposit'],
    // "tax refund" and "cra refund" outrank the shorter "refund" below.
    'Tax Refund': ['canada revenue', 'cra', 'tax refund', 'cra refund'],
    'Investment Returns': ['dividend', 'interest'],
    'Scholarships & Grants': ['scholarship', 'bursary', 'osap'],
    Refunds: ['refund', 'reimbursement'],
  },
};

const normalize = (text: unknown): string =>
  ` ${String(text ?? '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim()} `;

interface KeywordEntry {
  type: string;
  category: string;
  word: string;
}

// Longest keyword first, so "uber eats" is dining before "uber" is transport.
const TABLE: KeywordEntry[] = Object.entries(KEYWORDS)
  .flatMap(([type, map]) => Object.entries(map)
    .flatMap(([category, words]) => words.map((word) => ({ type, category, word: normalize(word) }))))
  .sort((a, b) => b.word.length - a.word.length);

/** A category from the canonical list, or null. */
export function categorize(description: unknown, type: TransactionType): string | null {
  const text = normalize(description);
  const hit = TABLE.find((entry) => entry.type === type && text.includes(entry.word));
  return hit ? hit.category : null;
}
