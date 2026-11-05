/**
 * Money only. Day formatting lives in `lib/date.ts`, which treats a day as a
 * day rather than an instant.
 *
 * This file used to also export formatDate, formatDateTime and
 * formatRelativeDate, all of which did `new Date(string)` on a 'YYYY-MM-DD'
 * value. That parses as UTC midnight, so anything west of UTC rendered the day
 * before — the bug the DATE type parser and `lib/date.ts` exist to fix. They
 * were unused, and leaving them would have handed the next caller the same
 * bug, so they are gone. Use `toDay`/`formatDay` from `lib/date.ts`.
 */

// Any amount that rounds to 0.00 is zero. Totals are summed as floating point,
// so a month whose income equals its spending can net 0.3 - (0.1 + 0.2), about
// -5.6e-17. Intl keeps the sign of a negative that rounds to zero, so that
// printed "-$0.00", and `>= 0` on the raw number coloured it red. Amounts are
// shown with two decimals and Intl rounds half away from zero, so this is
// exactly the set that prints as 0.00.
const roundsToZero = (amount: number): boolean => Math.abs(amount) < 0.005

// The sign of what formatCurrency shows. Pick a net amount's colour with
// `moneySign(net) < 0`, never `net < 0` or `net >= 0` on the raw number.
export const moneySign = (amount: number): -1 | 0 | 1 =>
  roundsToZero(amount) ? 0 : amount < 0 ? -1 : 1

export const formatCurrency = (amount: number, currency: string = 'USD'): string => {
  // For USD and CAD, always use '$' only
  const dollarCurrencies = ['USD', 'CAD'];
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(roundsToZero(amount) ? 0 : amount);
  if (dollarCurrencies.includes(currency)) {
    // Remove any country code prefix (e.g., 'CA$', 'US$'), keep only '$'
    return formatted.replace(/[A-Z]*\$/g, '$');
  }
  return formatted;
}

// Short form for axis ticks, where "$3,000.00" is noise and overflows the gutter.
export const formatCompactCurrency = (amount: number, currency: string = 'USD'): string => {
  const dollarCurrencies = ['USD', 'CAD'];
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);
  if (dollarCurrencies.includes(currency)) {
    return formatted.replace(/[A-Z]*\$/g, '$');
  }
  return formatted;
}

