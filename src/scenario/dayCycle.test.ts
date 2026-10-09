// Tests for the shared day/night clock contract (scenario/dayCycle.ts).
//
// The contract's consumers read it as PURE truth: the sleep plugin
// (plugins/sleep) gates the 22:00–06:00 window through SLEEP_START_MINUTE /
// WAKE_MINUTE / minuteOfDay, and the god-view's dynamic lighting
// (features/worldGrid.tsx, R5) paints its night veil from daylightAt — so
// the shape pinned here is the shape both live on:
//   epoch      — elapsed minute 0 is the 10:00 birth (the 600 anchor this
//                contract and scenario/temporal.ts share by construction)
//   rollover   — the clock face turns at elapsed 840 = 00:00, the exact
//                minute the calendar (islandCalendar) turns its day
//   boundaries — night opens exactly at 18:00 (elapsed 480) and closes
//                exactly at 06:00 (elapsed 1200); 22:00 sits inside
//   ramps      — dusk (16:30→18:00) and dawn (06:00→07:30) ride the
//                smoothstep; midpoints and near-end values are pinned to
//                full float precision (the exact doubles the formula
//                produces, precomputed)
//   periodic   — every reading repeats EXACTLY at DAY_MINUTES shifts
//   agreement  — daylightAt keeps NIGHT_LIGHT_FLOOR through the whole
//                isNight window (⇔, except the single 06:00 boundary
//                minute, pinned explicitly — see the sweep test)
//
// Every expected value is exact: integers with toBe, doubles with the full
// precision literal, booleans with toBe. Nothing approximate.

import { describe, it, expect } from 'vitest';
import {
    DAY_MINUTES,
    SLEEP_START_MINUTE,
    WAKE_MINUTE,
    NIGHT_LIGHT_FLOOR,
    minuteOfDay,
    isNight,
    daylightAt,
} from './dayCycle';
import { islandCalendar } from './temporal';

// The epoch anchor, read FROM the contract and pinned in the first test —
// the tests address a minute-of-day m as elapsed (m − EPOCH), so no other
// magic number is needed anywhere below.
const EPOCH = minuteOfDay(0);

describe('dayCycle — the shared clock constants', () => {
    it('pins the day length, the sleep window and the night floor', () => {
        expect(DAY_MINUTES).toBe(1440);
        expect(SLEEP_START_MINUTE).toBe(1320); // 22:00 — inside the night window
        expect(WAKE_MINUTE).toBe(360); // 06:00 — the night window's end
        expect(NIGHT_LIGHT_FLOOR).toBe(0.35); // the readable night ambient
    });
});

describe('minuteOfDay — the epoch-anchored clock face', () => {
    it('elapsed 0 is the 10:00 birth and the face rolls at midnight', () => {
        // The anchor itself: elapsed 0 reads 10:00 — the same minute
        // temporal.ts's calendar is born at (pinned there too)
        expect(EPOCH).toBe(600);
        expect(minuteOfDay(0)).toBe(600); // 10:00
        expect(minuteOfDay(240)).toBe(840); // 14:00
        expect(minuteOfDay(839)).toBe(1439); // 23:59 — the day's last minute
        expect(minuteOfDay(840)).toBe(0); // 00:00 — the calendar turns here too
        expect(minuteOfDay(841)).toBe(1); // 00:01
    });

    it('negative elapsed normalizes into [0, 1440)', () => {
        expect(minuteOfDay(-1)).toBe(599); // 09:59 — one minute before birth
        expect(minuteOfDay(-600)).toBe(0); // 00:00
        expect(minuteOfDay(-660)).toBe(1380); // 23:00
    });

    it('is exactly periodic every DAY_MINUTES shift', () => {
        const bases = [0, 1, 240, 840, 1199, 1200, 435, 1439];
        const shifts = [
            DAY_MINUTES,
            2 * DAY_MINUTES,
            365 * DAY_MINUTES,
            -DAY_MINUTES,
            -2 * DAY_MINUTES,
        ];
        for (const base of bases) {
            for (const shift of shifts) {
                expect(minuteOfDay(base + shift)).toBe(minuteOfDay(base));
            }
        }
        // Year-scale spot pins: a year after the birth is the same face
        expect(minuteOfDay(365 * DAY_MINUTES)).toBe(600);
        expect(minuteOfDay(365 * DAY_MINUTES + 840)).toBe(0);
    });

    it('agrees with the calendar clock (scenario/temporal.ts) by construction', () => {
        // Both read the SAME elapsed minutes: the contract's minute-of-day
        // and the calendar's hour:minute must land on the same clock face
        // at every probe — day 0, mid-afternoon, midnight rollover, wake
        // minute, full days, a dusk midpoint a year+ later
        const probes = [0, 10, 240, 840, 1200, 1440, 1875, 4755];
        for (const probe of probes) {
            const point = islandCalendar(probe);
            expect(minuteOfDay(probe)).toBe(point.hour * 60 + point.minute);
        }
    });
});

describe('isNight — the 18:00–06:00 window', () => {
    it('is false through the day and the whole dusk ramp', () => {
        expect(isNight(0)).toBe(false); // 10:00
        expect(isNight(389)).toBe(false); // 16:29 — the plateau's last minute
        expect(isNight(390)).toBe(false); // 16:30 — dusk opens, still day
        expect(isNight(435)).toBe(false); // 17:15 — dusk midpoint
        expect(isNight(479)).toBe(false); // 17:59 — dusk's last minute
    });

    it('opens exactly at 18:00 and holds through the night', () => {
        expect(isNight(480)).toBe(true); // 18:00 — the window opens exactly here
        expect(isNight(720)).toBe(true); // 22:00 — SLEEP_START_MINUTE sits inside
        expect(isNight(-660)).toBe(true); // 23:00 (negative elapsed form)
        expect(isNight(1199)).toBe(true); // 05:59 — the window's last minute
    });

    it('closes exactly at 06:00', () => {
        expect(isNight(1200)).toBe(false); // 06:00 — WAKE_MINUTE, day again
        expect(isNight(-240)).toBe(false); // 06:00 (negative elapsed form)
        expect(isNight(-239)).toBe(false); // 06:01
        expect(isNight(-150)).toBe(false); // 07:30 — full daylight again
    });
});

describe('daylightAt — the smooth ambient', () => {
    it('holds full daylight across the 07:30–16:30 plateau', () => {
        expect(daylightAt(-150)).toBe(1); // 07:30 — the plateau opens
        expect(daylightAt(0)).toBe(1); // 10:00
        expect(daylightAt(240)).toBe(1); // 14:00
        expect(daylightAt(389)).toBe(1); // 16:29 — the plateau's last minute
        expect(daylightAt(390)).toBe(1); // 16:30 — dusk starts at full light
    });

    it('rides the dusk ramp down with exact smoothstep values', () => {
        expect(daylightAt(420)).toBe(0.8314814814814815); // 17:00 — t 30/90 = 1/3
        expect(daylightAt(435)).toBe(0.675); // 17:15 — t 45/90 = 1/2
        expect(daylightAt(479)).toBe(0.35023895747599443); // 17:59 — t 89/90
    });

    it('lands the exact night floor at 18:00 and holds it through the night', () => {
        expect(daylightAt(480)).toBe(NIGHT_LIGHT_FLOOR); // 18:00 — the boundary
        expect(daylightAt(720)).toBe(NIGHT_LIGHT_FLOOR); // 22:00
        expect(daylightAt(-660)).toBe(NIGHT_LIGHT_FLOOR); // 23:00 (negative form)
        expect(daylightAt(1199)).toBe(NIGHT_LIGHT_FLOOR); // 05:59 — the floor's last minute
    });

    it('opens the dawn ramp at the floor and rides up with exact smoothstep values', () => {
        expect(daylightAt(1200)).toBe(NIGHT_LIGHT_FLOOR); // 06:00 — the ramp starts AT the floor
        expect(daylightAt(-210)).toBe(0.5185185185185185); // 06:30 — t 1/3
        expect(daylightAt(-195)).toBe(0.675); // 06:45 — t 1/2
        expect(daylightAt(-151)).toBe(0.9997610425240055); // 07:29 — t 89/90
        expect(daylightAt(-150)).toBe(1); // 07:30 — full daylight again
    });

    it('repeats exactly every full day', () => {
        const bases = [0, 435, 480, 1199, 1200];
        const shifts = [DAY_MINUTES, 3 * DAY_MINUTES, -2 * DAY_MINUTES];
        for (const base of bases) {
            for (const shift of shifts) {
                expect(daylightAt(base + shift)).toBe(daylightAt(base));
            }
        }
    });

    it('the floor window matches the night flag across the whole day — save the single 06:00 boundary minute', () => {
        // A full sweep of all 1440 minutes of the day (a minute-of-day m is
        // elapsed m − EPOCH). Asserted per minute:
        //   ambient === NIGHT_LIGHT_FLOOR ⇔ isNight — for EVERY minute
        //   except 06:00 itself, where the dawn ramp's first minute still
        //   sits at the floor while the phase flag has already flipped to
        //   day (isNight's window is half-open [1080, 360)). That minute is
        //   pinned explicitly after the sweep — divergence by design
        //   (ramp continuity), never skipped silently.
        // Sweep aggregates (exact): the darkest ambient IS the floor, the
        // brightest IS full daylight, and the floor's minutes number
        // exactly 721 — the 720 night minutes plus the single 06:00 ramp
        // minute.
        let darkest = 2;
        let brightest = -1;
        let floorMinutes = 0;
        for (let minute = 0; minute < DAY_MINUTES; minute++) {
            const elapsed = minute - EPOCH;
            const ambient = daylightAt(elapsed);
            if (ambient < darkest) {
                darkest = ambient;
            }
            if (ambient > brightest) {
                brightest = ambient;
            }
            if (ambient === NIGHT_LIGHT_FLOOR) {
                floorMinutes += 1;
            }
            if (minute !== WAKE_MINUTE) {
                expect(ambient === NIGHT_LIGHT_FLOOR).toBe(isNight(elapsed));
            }
        }
        expect(darkest).toBe(NIGHT_LIGHT_FLOOR);
        expect(brightest).toBe(1);
        expect(floorMinutes).toBe(721);
        // The pinned boundary minute: at the floor, yet already day
        expect(daylightAt(WAKE_MINUTE - EPOCH)).toBe(NIGHT_LIGHT_FLOOR);
        expect(isNight(WAKE_MINUTE - EPOCH)).toBe(false);
    });
});
