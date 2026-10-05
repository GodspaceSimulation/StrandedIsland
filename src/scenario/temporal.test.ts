// Tests for the island's temporal configuration (scenario/temporal.ts).
// Every assertion pins an exact calendar reading — the epoch (10:00,
// January 1, 1609), the true Gregorian month table and the leap-year
// behaviour the god-view clock and log hang off.

import { describe, it, expect } from 'vitest';
import { islandCalendar } from './temporal';

describe('islandCalendar — the 1609 epoch', () => {
    it('the world is born at 10:00 on January 1, 1609 (a common year)', () => {
        // The Sea Venture wrecked in 1609 — the cast's world starts there,
        // mid-morning of New Year's Day. 1609 % 4 ≠ 0 → common (365 days).
        expect(islandCalendar(0)).toEqual({
            year: 1609,
            dayOfYear: 1,
            season: 0,
            seasonName: 'Winter',
            month: 1,
            monthName: 'January',
            dayOfMonth: 1,
            dayOfSeason: 1,
            hour: 10,
            minute: 0,
            daysInYear: 365,
        });
    });

    it('ten world minutes read 10:10 on the same day', () => {
        const point = islandCalendar(10);
        expect(point.year).toBe(1609);
        expect(point.dayOfYear).toBe(1);
        expect(point.hour).toBe(10);
        expect(point.minute).toBe(10);
    });

    it('the day turns over at midnight and re-reads the birth clock', () => {
        // 600 (birth clock) + 840 = 1440 → midnight of January 2
        const midnight = islandCalendar(840);
        expect(midnight.hour).toBe(0);
        expect(midnight.minute).toBe(0);
        expect(midnight.dayOfYear).toBe(2);
        // One full day later the clock reads 10:00 again
        const nextMorning = islandCalendar(1440);
        expect(nextMorning.dayOfYear).toBe(2);
        expect(nextMorning.hour).toBe(10);
    });

    it('months follow the true Gregorian table (February holds 28 days)', () => {
        // February 1 opens at dayOfYear 32 (January's 31 days)…
        const february = islandCalendar(31 * 1440);
        expect(february.month).toBe(2);
        expect(february.dayOfMonth).toBe(1);
        // …and March 1 lands at dayOfYear 60 — February kept 28 days
        const march = islandCalendar(59 * 1440);
        expect(march.month).toBe(3);
        expect(march.dayOfMonth).toBe(1);
        expect(march.dayOfYear).toBe(60);
        expect(march.season).toBe(0);
        expect(march.seasonName).toBe('Winter');
    });

    it('years count from 1609', () => {
        // 365 days after the birth: January 1, 1610, at the birth clock
        const point = islandCalendar(365 * 1440);
        expect(point.year).toBe(1610);
        expect(point.dayOfYear).toBe(1);
        expect(point.hour).toBe(10);
    });
});

describe('islandCalendar — Gregorian leap years', () => {
    it('February 29, 1612 exists (1612 is a leap year)', () => {
        // Three common years (1609-1611) = 1095 days, then January 1612
        // (31 days) + 28 days into February → dayIndex 1154 = February 29
        const leapDay = islandCalendar((3 * 365 + 59) * 1440);
        expect(leapDay.year).toBe(1612);
        expect(leapDay.month).toBe(2);
        expect(leapDay.monthName).toBe('February');
        expect(leapDay.dayOfMonth).toBe(29);
        expect(leapDay.dayOfYear).toBe(60);
        expect(leapDay.daysInYear).toBe(366);
        // March 1st follows the leap day
        const march = islandCalendar((3 * 365 + 60) * 1440);
        expect(march.month).toBe(3);
        expect(march.dayOfMonth).toBe(1);
        expect(march.dayOfYear).toBe(61);
    });

    it('1613 is common again — February holds 28 days', () => {
        // 1609-1612 span 3×365 + 366 = 1461 days; +58 days into 1613
        const februaryEnd = islandCalendar((3 * 365 + 366 + 58) * 1440);
        expect(februaryEnd.year).toBe(1613);
        expect(februaryEnd.month).toBe(2);
        expect(februaryEnd.dayOfMonth).toBe(28);
        expect(februaryEnd.daysInYear).toBe(365);
        // No February 29: dayOfYear 60 is already March 1
        const march = islandCalendar((3 * 365 + 366 + 59) * 1440);
        expect(march.month).toBe(3);
        expect(march.dayOfMonth).toBe(1);
    });

    it('century years follow the ÷400 rule (1700 common, 2000 leap)', () => {
        // 1609-1699 = 91 years with 22 leap years (1612…1696) → 33237 days
        // land on January 1, 1700 — a century NOT divisible by 400: common
        const seventeen = islandCalendar(33237 * 1440);
        expect(seventeen.year).toBe(1700);
        expect(seventeen.dayOfYear).toBe(1);
        expect(seventeen.daysInYear).toBe(365);
        // 1609-1999 = 391 years with 94 leap years (97 fourths − the 1700/
        // 1800/1900 century skips) → 142809 days land on January 1, 2000:
        // divisible by 400 → leap
        const twoThousand = islandCalendar(142809 * 1440);
        expect(twoThousand.year).toBe(2000);
        expect(twoThousand.dayOfYear).toBe(1);
        expect(twoThousand.daysInYear).toBe(366);
    });
});
