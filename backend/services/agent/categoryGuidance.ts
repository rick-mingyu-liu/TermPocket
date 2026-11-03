/**
 * What each canonical category holds, for Pocky's system prompt.
 *
 * The bare category list left the model guessing cold: "tnt" went to Other
 * Expenses although T&T is a supermarket, and a hosting bill had no obvious
 * home. Each line here gives a definition and, where the screenshot importer's
 * keyword table (services/import/categorize.ts) knows merchants for the
 * category, those merchants as examples, so the importer's first guess and
 * Pocky's cannot disagree about where a merchant goes. The text is static —
 * nothing per user or per turn — so it stays inside the cached system prompt.
 *
 * `definitions` must name every canonical category; test/agentCategoryGuidance
 * .test.ts fails otherwise. A category without one would still be listed by
 * name, so a miss degrades the guidance rather than the turn.
 */
import { KEYWORDS } from '../import/categorize';
import { categories } from './validation';

const definitions: Record<string, string> = {
  Groceries: 'food and household supplies from supermarkets and grocery stores, including Asian, bulk and discount grocers',
  'Dining Out': 'restaurants, cafes, fast food, food delivery, bubble tea and anything bought ready to eat',
  Transportation: 'transit fares and passes, rideshare, taxis, fuel, parking and other vehicle costs',
  Housing: 'rent, residence fees, deposits and renter insurance',
  Utilities: 'phone and internet plans, electricity, gas, water and heating',
  Entertainment: 'streaming video and music, games, movies, concerts, sports tickets, events and hobbies',
  Shopping: 'clothing, electronics, household goods and online orders of physical goods for the user',
  Healthcare: 'pharmacy, prescriptions, dental, vision, therapy and medical fees',
  Education: 'tuition, textbooks, course materials, student fees and learning platforms',
  Travel: 'flights, trains and buses between cities, hotels and trips away from home',
  'Software & Apps': 'software, apps and online services the user pays for, such as cloud hosting, domains, developer tools, AI tools, cloud storage and app subscriptions (streaming video and music stay in Entertainment)',
  'Personal Care': 'haircuts, barbers, salons, cosmetics, skincare and toiletries',
  Fitness: 'gym and recreation memberships, fitness classes, sports leagues and equipment rental',
  'Gifts & Donations': 'gifts bought for others, red envelopes given, and donations to charities and fundraisers',
  'Fees & Charges': 'bank and card fees, interest charges, overdraft and late payment fees, ATM and currency exchange fees, fines and tickets',
  Savings: 'money moved into savings or investment accounts',
  'Other Expenses': 'only what fits none of the other expense categories, such as lost money and government application fees',
  Salary: 'wages from employment, including co-op and TA pay',
  Freelance: 'contract, gig and self-employed earnings',
  'Investment Returns': 'dividends, interest and capital gains',
  Business: "revenue from the user's own business",
  'Tax Refund': 'refunds and benefits from the CRA or another tax authority',
  'Scholarships & Grants': 'scholarships, bursaries, awards, grants and student aid such as OSAP',
  Refunds: 'money back for a purchase, and reimbursements from an employer or a friend',
  'Gifts Received': 'money from family, gifts and red envelopes received',
  'Other Income': "only income that fits none of the other income categories, such as resale of the user's belongings and prize money",
};

/**
 * One line per canonical category, expenses then income: the exact name, its
 * type, the definition, and the importer's merchant examples where it has any.
 */
export function categoryGuidance(): string {
  const lines: string[] = [];
  for (const type of ['expense', 'income'] as const) {
    for (const category of categories[type]) {
      const definition = definitions[category];
      const examples = KEYWORDS[type][category] ?? [];
      lines.push(`- ${category} (${type})${definition ? `: ${definition}` : ''}${examples.length ? `; e.g. ${examples.join(', ')}` : ''}`);
    }
  }
  return lines.join('\n');
}
