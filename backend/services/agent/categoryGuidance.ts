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
  Utilities: 'phone and internet plans, electricity, gas and water, and recurring online services the user pays for, such as cloud hosting, domains, developer tools, software and app subscriptions',
  Entertainment: 'streaming, music, games, movies, events, sports and hobbies',
  Shopping: 'clothing, electronics, household goods, gifts and online orders of physical goods',
  Healthcare: 'pharmacy, prescriptions, dental, vision, therapy and medical fees',
  Education: 'tuition, textbooks, course materials, student fees and learning platforms',
  Travel: 'flights, trains and buses between cities, hotels and trips away from home',
  Savings: 'money moved into savings or investment accounts',
  'Other Expenses': 'only what fits none of the other expense categories, such as money given to friends, donations, fines and fees with no better home',
  Salary: 'wages from employment, including co-op and TA pay',
  Freelance: 'contract, gig and self-employed earnings',
  'Investment Returns': 'dividends, interest and capital gains',
  Business: "revenue from the user's own business",
  'Tax Refund': 'refunds and benefits from the CRA or another tax authority',
  'Other Income': 'only income that fits none of the other income categories, such as gifts received, reimbursements and resale',
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
