// The island's day/night cycle — the SHARED CLOCK CONTRACT (R6).
//
// One module owns "what time of day is it" for every consumer that wants the
// DAY/NIGHT shape of the world clock (the sleep window, the god-view's
// dynamic lighting), separate from the Gregorian calendar readout that
// scenario/temporal.ts owns. The two agree by construction: both are pure
// functions of the SAME input — elapsed world minutes (world.ticker.elapsed())
// — and both anchor the day at the island's birth hour, 10:00
// (ISLAND_TEMPORAL_OPTIONS.startMinuteOfDay = 600, scenario/temporal.ts).
//
// The shape:
//   DAY_MINUTES        — 1440 world minutes per day (the ticker's minute is
//                        1/1440 of a day, plugins/forest pacing).
//   SLEEP_START_MINUTE — 1320 → 22:00, the bedtime the sleep window starts.
//   WAKE_MINUTE        — 360 → 06:00, the wake time (and dawn's anchor).
//   minuteOfDay()      — elapsed minutes → the minute within the CURRENT
//                        day, epoch-anchored: elapsed 0 is 10:00, so
//                        minuteOfDay(0) = 600 (temporal.ts agrees — the
//                        calendar rolls Jan 1 → Jan 2 exactly at elapsed
//                        840 = midnight).
//   isNight()          — night is 18:00–06:00: minuteOfDay ≥ 1080 OR < 360.
//                        The flag flips exactly at the night floor's window
//                        (daylightAt reads the floor there — see below).
//   daylightAt()       — the smooth ambient light level in [NIGHT_LIGHT_FLOOR, 1]
//                        for the god-view's night veil (features/worldGrid):
//                        full daylight 07:30–16:30, the night floor through
//                        18:00–06:00, and smoothstep ramps across the 90
//                        minutes of dusk (16:30→18:00) and dawn (06:00→07:30)
//                        so the light never jumps. The floor window and
//                        isNight's window agree on every minute of the day
//                        except the single dawn-boundary minute: the dawn
//                        ramp OPENS at the floor (06:00 itself sits at
//                        ambient === NIGHT_LIGHT_FLOOR — continuity with
//                        05:59) while isNight already reads day there (its
//                        window is half-open [1080, 360)). Every other
//                        minute: ambient === NIGHT_LIGHT_FLOOR ⇔ isNight.
//
// Everything is PURE — no ticking of its own, no React, no world handle:
// callers pass the elapsed minutes they read from the world clock. The
// survival/sleep workers may import these exact functions (the shared clock
// contract) before any wiring exists.

/** World minutes in one island day — the calendar's day length (temporal.ts). */
export const DAY_MINUTES = 1440;

/** Minute of day the sleep window starts — 22:00. */
export const SLEEP_START_MINUTE = 1320;

/** Minute of day the sleep window ends (the wake time) — 06:00. */
export const WAKE_MINUTE = 360;

/**
 * The day's epoch anchor: elapsed world minute 0 is the island's birth at
 * 10:00 (scenario/temporal.ts ISLAND_TEMPORAL_OPTIONS.startMinuteOfDay), so
 * the day's clock face starts 600 minutes in.
 */
const EPOCH_MINUTE_OF_DAY = 600;

/** 18:00 — where the night window opens (and dusk ends). */
const NIGHT_START_MINUTE = 1080;

/**
 * The night light floor — the ambient the world keeps at night. Chosen so
 * the god-view's night veil (1 − ambient = 0.2 alpha at full night) is a
 * SLIGHT moonlit shade, not a blackout: the night phase still reads, but
 * every tile stays plainly visible (the R6 "nonblocking readable night
 * floor" rule, retuned per user feedback that the old 0.35 floor — a 0.65
 * veil — was too dark to play by).
 */
export const NIGHT_LIGHT_FLOOR = 0.8;

/** The twilight ramp length in minutes — dusk 16:30→18:00, dawn 06:00→07:30. */
const TWILIGHT_MINUTES = 90;

/** Dusk opens at 16:30 (the ramp runs 16:30→18:00 down to the floor). */
const DUSK_START_MINUTE = NIGHT_START_MINUTE - TWILIGHT_MINUTES;

/** Dawn ends at 07:30 (the ramp runs 06:00→07:30 up to full daylight). */
const DAWN_END_MINUTE = WAKE_MINUTE + TWILIGHT_MINUTES;

/** The smoothstep fade — x²(3−2x): zero slope at both ends, smooth middle. */
const smoothstep = (x: number): number => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
};

/**
 * The minute within the CURRENT day for `elapsedMinutes` of world time —
 * epoch-anchored (elapsed 0 → 600, the 10:00 birth). Rolls over at
 * midnight: minuteOfDay(840) = 0 (temporal.ts's calendar turns the day at
 * the same elapsed minute). Negative elapsed is normalized too (mod arithmetic
 * keeps the result in [0, 1440)) so callers never see a negative clock.
 */
export const minuteOfDay = (elapsedMinutes: number): number => {
    const raw = (EPOCH_MINUTE_OF_DAY + elapsedMinutes) % DAY_MINUTES;
    return (raw + DAY_MINUTES) % DAY_MINUTES;
};

/**
 * Whether the world stands in NIGHT — the 18:00–06:00 window (the sleep
 * hours bracket it: 22:00 falls inside, 06:00 wake is the window's end).
 * Exactly the window where daylightAt keeps the night floor.
 */
export const isNight = (elapsedMinutes: number): boolean => {
    const minute = minuteOfDay(elapsedMinutes);
    return minute >= NIGHT_START_MINUTE || minute < WAKE_MINUTE;
};

/**
 * The smooth ambient daylight level in [NIGHT_LIGHT_FLOOR, 1] for
 * `elapsedMinutes` of world time — the number the god-view's night veil
 * dims against (alpha = 1 − ambient). Full daylight 07:30–16:30; the night
 * floor through the 18:00–06:00 night; a 90-minute smoothstep ramp down
 * through dusk (16:30→18:00) and up through dawn (06:00→07:30). The dusk
 * ramp ENDS at the night boundary and the dawn ramp OPENS at it, so the
 * floor window and isNight() agree on every minute EXCEPT 06:00 itself —
 * the dawn ramp's first minute still sits at the floor (continuity with
 * 05:59) while isNight already reads day (its window is half-open
 * [1080, 360)). Every other minute: ambient === NIGHT_LIGHT_FLOOR ⇔
 * isNight(elapsedMinutes).
 */
export const daylightAt = (elapsedMinutes: number): number => {
    const minute = minuteOfDay(elapsedMinutes);
    // Dusk — full daylight easing down to the floor across 16:30→18:00
    if (minute >= DUSK_START_MINUTE && minute < NIGHT_START_MINUTE) {
        return 1 - (1 - NIGHT_LIGHT_FLOOR) * smoothstep((minute - DUSK_START_MINUTE) / TWILIGHT_MINUTES);
    }
    // Dawn — the floor easing up to full daylight across 06:00→07:30
    if (minute >= WAKE_MINUTE && minute < DAWN_END_MINUTE) {
        return NIGHT_LIGHT_FLOOR + (1 - NIGHT_LIGHT_FLOOR) * smoothstep((minute - WAKE_MINUTE) / TWILIGHT_MINUTES);
    }
    // Full day — the long daylight plateau 07:30→16:30
    if (minute >= DAWN_END_MINUTE && minute < DUSK_START_MINUTE) {
        return 1;
    }
    // Night — 18:00→06:00 holds the floor (exactly isNight's window)
    return NIGHT_LIGHT_FLOOR;
};
