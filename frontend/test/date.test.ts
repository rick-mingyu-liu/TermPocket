// Prevents a calendar day (a transaction date, a goal's target, a term) from showing as the day before or after for a viewer outside UTC.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toDay, todayDay, formatDay, formatDayRange, daysUntil, previousMonth, formatMonth,
} from '../lib/date.ts'

/**
 * `lib/date.ts` is the frontend twin of the backend's `utils/dates.ts`
 * (`backend/test/dates.test.ts`). It exists so that a 'YYYY-MM-DD' day never
 * goes through `new Date(day)`, which reads it as UTC midnight and so names the
 * previous day anywhere west of Greenwich.
 *
 * What matters is the viewer's timezone, so most tests run under several.
 * Assigning `process.env.TZ` takes effect immediately in Node, for Date and
 * Intl alike; the first test checks that the switch really moves the clock,
 * without which every "in every timezone" test below would pass vacuously.
 *
 * Locales are always passed explicitly, so the output does not depend on the
 * machine running the suite. 'en' and 'zh' are what `i18n.language` holds.
 */

// West of UTC (Los Angeles, and Pago Pago at UTC-11), Toronto (the owner's,
// with DST), UTC itself, east of it, and Kiritimati at UTC+14.
const ZONES = [
  'America/Los_Angeles', 'Pacific/Pago_Pago', 'America/Toronto',
  'UTC', 'Asia/Shanghai', 'Pacific/Kiritimati',
]

function inZone<T>(tz: string, fn: () => T): T {
  const saved = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
}

function inEveryZone(fn: (tz: string) => void): void {
  for (const tz of ZONES) inZone(tz, () => fn(tz))
}

describe('the timezone switch these tests rely on', () => {
  test('moves the clock: the naive parse names the previous day west of UTC', () => {
    assert.equal(inZone('America/Los_Angeles', () => new Date('2026-08-28').toLocaleDateString('en-US')), '8/27/2026')
    assert.equal(inZone('Asia/Shanghai', () => new Date('2026-08-28').toLocaleDateString('en-US')), '8/28/2026')
  })
})

describe('toDay', () => {
  test('passes a day through', () => {
    assert.equal(toDay('2026-08-28'), '2026-08-28')
  })

  test('takes the day out of a timestamp, as a deploy from before the DATE type parser sends it', () => {
    assert.equal(toDay('2026-08-28T00:00:00.000Z'), '2026-08-28')
  })

  test('keeps the day as written rather than converting a timestamp with an offset', () => {
    // 23:30 at UTC-5 is already the 29th in UTC; the written day wins.
    assert.equal(toDay('2026-08-28T23:30:00-05:00'), '2026-08-28')
  })

  test('is null for nothing, and for text that does not start with a day', () => {
    for (const value of [null, undefined, '', 'yesterday', '28/08/2026', '2026-8-28', ' 2026-08-28']) {
      assert.equal(toDay(value), null, String(value))
    }
  })
})

describe('todayDay', () => {
  test('zero-pads the month and the day', () => {
    assert.equal(inZone('UTC', () => todayDay(new Date(2026, 0, 5, 9))), '2026-01-05')
  })

  test("is the viewer's date, not UTC's", () => {
    // 02:00 UTC on the 29th is still the evening of the 28th in Toronto, and
    // 20:00 UTC on the 28th is already the 29th in Shanghai.
    assert.equal(inZone('America/Toronto', () => todayDay(new Date('2026-08-29T02:00:00Z'))), '2026-08-28')
    assert.equal(inZone('Asia/Shanghai', () => todayDay(new Date('2026-08-28T20:00:00Z'))), '2026-08-29')
  })

  test('defaults to now', () => {
    const before = todayDay(new Date())
    const got = todayDay()
    const after = todayDay(new Date())
    assert.ok(got === before || got === after, got)
  })
})

describe('formatDay', () => {
  test('names the same day in every timezone', () => {
    inEveryZone((tz) => {
      assert.equal(formatDay('2026-08-28', 'en-US'), '8/28/2026', tz)
      assert.equal(formatDay('2026-01-01', 'en-US'), '1/1/2026', tz)
      assert.equal(formatDay('2026-12-31', 'en-US'), '12/31/2026', tz)
    })
  })

  test('names the same day for the timestamp form, too', () => {
    inEveryZone((tz) => {
      assert.equal(formatDay('2026-08-28T00:00:00.000Z', 'en-US'), '8/28/2026', tz)
    })
  })

  test("keeps both of Toronto's DST change days", () => {
    inZone('America/Toronto', () => {
      assert.equal(formatDay('2026-03-08', 'en-US'), '3/8/2026')
      assert.equal(formatDay('2026-11-01', 'en-US'), '11/1/2026')
    })
  })

  test('follows the locale it is given', () => {
    inZone('UTC', () => {
      assert.equal(formatDay('2026-08-28', 'zh-CN'), '2026/8/28')
      assert.equal(formatDay('2026-08-28', 'en-GB'), '28/08/2026')
    })
  })

  test('is empty when there is no day', () => {
    for (const value of [null, undefined, '', 'not a date']) {
      assert.equal(formatDay(value, 'en-US'), '', String(value))
    }
  })
})

describe('formatDayRange', () => {
  test('ends on the last included day, not on the exclusive bound the API sends', () => {
    // Spring 2026 is [2026-05-01, 2026-09-01); September 1st is not in it.
    inEveryZone((tz) => {
      assert.equal(formatDayRange('2026-05-01', '2026-09-01', 'en-US'), '5/1/2026 – 8/31/2026', tz)
    })
  })

  test('steps back across a year boundary', () => {
    inEveryZone((tz) => {
      assert.equal(formatDayRange('2026-09-01', '2027-01-01', 'en-US'), '9/1/2026 – 12/31/2026', tz)
    })
  })

  test('steps back to the end of February, in leap years too', () => {
    inEveryZone((tz) => {
      assert.equal(formatDayRange('2026-01-01', '2026-03-01', 'en-US'), '1/1/2026 – 2/28/2026', tz)
      assert.equal(formatDayRange('2028-01-01', '2028-03-01', 'en-US'), '1/1/2028 – 2/29/2028', tz)
    })
  })

  test('steps back across a DST change', () => {
    inZone('America/Toronto', () => {
      assert.equal(formatDayRange('2026-03-01', '2026-03-09', 'en-US'), '3/1/2026 – 3/8/2026')
      assert.equal(formatDayRange('2026-10-01', '2026-11-02', 'en-US'), '10/1/2026 – 11/1/2026')
    })
  })

  test('accepts the timestamp form for both ends', () => {
    inEveryZone((tz) => {
      assert.equal(
        formatDayRange('2026-05-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'en-US'),
        '5/1/2026 – 8/31/2026',
        tz,
      )
    })
  })

  test('formats both ends in the locale it is given', () => {
    inZone('UTC', () => {
      assert.equal(formatDayRange('2026-05-01', '2026-09-01', 'zh-CN'), '2026/5/1 – 2026/8/31')
    })
  })

  test('is empty when either end is missing', () => {
    assert.equal(formatDayRange(null, '2026-09-01', 'en-US'), '')
    assert.equal(formatDayRange('2026-05-01', undefined, 'en-US'), '')
    assert.equal(formatDayRange('', '', 'en-US'), '')
    assert.equal(formatDayRange('2026-05-01', 'soon', 'en-US'), '')
  })
})

describe('daysUntil', () => {
  test('is 0 for today, 1 for tomorrow and -1 for yesterday, in every timezone', () => {
    inEveryZone((tz) => {
      const now = new Date(2026, 7, 28, 9)
      assert.equal(daysUntil('2026-08-28', now), 0, tz)
      assert.equal(daysUntil('2026-08-29', now), 1, tz)
      assert.equal(daysUntil('2026-08-27', now), -1, tz)
    })
  })

  test('counts calendar days, not elapsed hours', () => {
    inEveryZone((tz) => {
      // One minute before midnight, tomorrow is still a whole day away.
      assert.equal(daysUntil('2026-08-29', new Date(2026, 7, 28, 23, 59)), 1, tz)
      // One minute after midnight, yesterday is already a day ago.
      assert.equal(daysUntil('2026-08-27', new Date(2026, 7, 28, 0, 1)), -1, tz)
    })
  })

  test('is not thrown off by a 23- or 25-hour day', () => {
    inZone('America/Toronto', () => {
      assert.equal(daysUntil('2026-03-09', new Date(2026, 2, 7, 12)), 2)
      assert.equal(daysUntil('2026-11-02', new Date(2026, 9, 31, 12)), 2)
      assert.equal(daysUntil('2026-07-01', new Date(2026, 0, 1, 12)), 181)
    })
  })

  test('crosses years and leap days', () => {
    inEveryZone((tz) => {
      assert.equal(daysUntil('2027-01-01', new Date(2026, 11, 31, 12)), 1, tz)
      assert.equal(daysUntil('2028-03-01', new Date(2028, 1, 28, 12)), 2, tz)
      assert.equal(daysUntil('2027-03-01', new Date(2027, 1, 28, 12)), 1, tz)
    })
  })

  test('reads the timestamp form as the same day', () => {
    inEveryZone((tz) => {
      assert.equal(daysUntil('2026-08-28T00:00:00.000Z', new Date(2026, 7, 28, 12)), 0, tz)
    })
  })

  test('is null when there is no date', () => {
    for (const value of [null, undefined, '', 'someday']) {
      assert.equal(daysUntil(value, new Date(2026, 7, 28, 12)), null, String(value))
    }
  })
})

describe('previousMonth', () => {
  test('is the month before, with a zero-padded key', () => {
    inEveryZone((tz) => {
      assert.deepEqual(previousMonth(new Date(2026, 9, 15, 12)), { year: 2026, month: 9, key: '2026-09' }, tz)
      assert.deepEqual(previousMonth(new Date(2026, 11, 1, 12)), { year: 2026, month: 11, key: '2026-11' }, tz)
    })
  })

  test('goes from January back to December of the year before', () => {
    inEveryZone((tz) => {
      assert.deepEqual(previousMonth(new Date(2026, 0, 10, 12)), { year: 2025, month: 12, key: '2025-12' }, tz)
    })
  })

  test("follows the viewer's calendar, not UTC's", () => {
    // 03:00 UTC on September 1st is still August 31st in Toronto: last month is July.
    assert.deepEqual(
      inZone('America/Toronto', () => previousMonth(new Date('2026-09-01T03:00:00Z'))),
      { year: 2026, month: 7, key: '2026-07' },
    )
    // 17:00 UTC on August 31st is already September 1st in Shanghai: last month is August.
    assert.deepEqual(
      inZone('Asia/Shanghai', () => previousMonth(new Date('2026-08-31T17:00:00Z'))),
      { year: 2026, month: 8, key: '2026-08' },
    )
    // 11:00 UTC on December 31st is already New Year's Day in Kiritimati.
    assert.deepEqual(
      inZone('Pacific/Kiritimati', () => previousMonth(new Date('2025-12-31T11:00:00Z'))),
      { year: 2025, month: 12, key: '2025-12' },
    )
  })
})

describe('formatMonth', () => {
  test('names a month of this year without the year', () => {
    inZone('UTC', () => {
      assert.equal(formatMonth(2026, 7, 'en', new Date(2026, 7, 15)), 'July')
      assert.equal(formatMonth(2026, 7, 'zh', new Date(2026, 7, 15)), '七月')
    })
  })

  test('adds the year when the month is in another year', () => {
    inZone('UTC', () => {
      assert.equal(formatMonth(2025, 12, 'en', new Date(2026, 0, 10)), 'December 2025')
      assert.equal(formatMonth(2025, 12, 'zh', new Date(2026, 0, 10)), '2025年12月')
    })
  })

  test('names the same month in every timezone', () => {
    inEveryZone((tz) => {
      const now = new Date(2026, 5, 1, 12)
      assert.equal(formatMonth(2026, 1, 'en', now), 'January', tz)
      assert.equal(formatMonth(2026, 12, 'en', now), 'December', tz)
    })
  })

  test("decides 'this year' by the viewer's calendar", () => {
    inZone('Pacific/Kiritimati', () => {
      // Already January 1st, 2026 in Kiritimati, though still 2025 in UTC.
      const now = new Date('2025-12-31T11:00:00Z')
      assert.equal(formatMonth(2025, 12, 'en', now), 'December 2025')
      assert.equal(formatMonth(2026, 1, 'en', now), 'January')
    })
  })
})
