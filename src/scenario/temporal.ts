// The island's temporal configuration — WHEN the stranded cast's world is.
//
// The @godspace/core temporal system is engine-agnostic; THIS file pins the
// island's epoch and calendar shape, and both god-view features (the World
// Ticker clock and the World Log stamps) read the calendar through
// `islandCalendar` so the whole view agrees on "when".
//
// The shape: a TRUE Earth calendar —
//   epoch      — the world is born at 10:00 on January 1, 1609 (the year
//                the Sea Venture wrecked on Bermuda's reef — the historical
//                stranding this scenario echoes)
//   months     — the real Gregorian month table (Jan 31 · Feb 28 · …), not
//                the even-spread default
//   leap years — the Gregorian rule (gregorianLeapYear: every 4th year,
//                except whole centuries not divisible by 400), with
//                February absorbing the leap day (leapMonth 2)
//   seasons    — Winter first: the real Earth seasons, months 1-3 = Winter
//                (the core default maps months 1-3 to Spring)
//
// The view scale decides the STEP size (scenario/island.ts); this shape
// decides what those steps MEAN on the calendar.

import { gregorianLeapYear, temporalCalendar, type TemporalCalendarPoint, type TemporalOptions } from '@godspace/core';

/** The true Gregorian common-year month table (sums to exactly 365). */
const GREGORIAN_MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The island's calendar shape — see the header for every choice. */
export const ISLAND_TEMPORAL_OPTIONS: TemporalOptions = {
    // The Sea Venture wrecked in 1609 — the cast's world starts there,
    // mid-morning of January 1 (600 minutes = 10:00)
    startYear: 1609,
    startMinuteOfDay: 600,
    monthLengths: GREGORIAN_MONTH_LENGTHS,
    leapYears: gregorianLeapYear,
    // February absorbs the leap day — the 29th exists on leap years
    leapMonth: 2,
    // Real Earth seasons: January opens Winter (the core default maps
    // months 1-3 to Spring)
    seasonNames: ['Winter', 'Spring', 'Summer', 'Autumn'],
};

/**
 * The island's calendar reading — elapsed world minutes → the calendar
 * point under the island's shape. Every god-view feature reads "when"
 * through this so clock and log always agree.
 */
export const islandCalendar = (minutes: number): TemporalCalendarPoint =>
    temporalCalendar(minutes, ISLAND_TEMPORAL_OPTIONS);
