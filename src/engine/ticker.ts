// The world clock (ticker).
//
// The whole simulation runs on this beat: every `step()` advances world time
// by `tickSize` minutes. `tickSize` is configurable at any moment — a tick can
// represent a minute, ten minutes or an hour depending on how the god sets it
// up. On top of manual stepping there is an optional realtime loop driven by
// setInterval with a speed multiplier (ticks per real second).

import { arrayEach } from '@presource/core';

/** Callback fired after every tick with the new tick number. */
export type TickerListener = (tick: number) => void;

export type TickerOptions = {
    /** Minutes of world time per tick. Default 10. */
    tickSize?: number;
    /** Realtime speed in ticks per second. Default 2. */
    speed?: number;
};

export type Ticker = {
    /** Advances exactly one tick. Returns the new tick number (1-based). */
    step(): number;
    /** Number of ticks elapsed so far. */
    ticks(): number;
    /** Total elapsed world minutes (ticks × tickSize). */
    elapsed(): number;
    /**
     * Minutes per tick. Called with no argument reads the current value;
     * called with a number changes it for all subsequent ticks.
     */
    tickSize(): number;
    tickSize(minutes: number): void;
    /** Starts the realtime loop (no-op when already running). */
    play(): void;
    /** Stops the realtime loop (no-op when already paused). */
    pause(): void;
    /** Whether the realtime loop is currently running. */
    running(): boolean;
    /** Ticks per real second. Read with no argument, set with a number. */
    speed(): number;
    speed(value: number): void;
    /** Calendar derivation from elapsed minutes: day is 1-based. */
    clock(): { day: number; hour: number; minute: number };
    /** Subscribes to every tick; returns the unsubscribe function. */
    subscribe(listener: TickerListener): () => void;
    /**
     * Overrides what the realtime loop executes per pulse. The world binds
     * its full `step()` here so realtime ticks also run plugin ticks —
     * without this, play() would advance the clock but the world would
     * stand still. Unbound, the pulse is a plain internal step.
     */
    bindPulse(pulse: () => void): void;
};

/** Fallback when no tickSize is provided. */
const DEFAULT_TICK_SIZE = 10;
/** Fallback realtime speed — 2 ticks per second feels lively for a small map. */
const DEFAULT_SPEED = 2;

export const createTicker = (options: TickerOptions = {}): Ticker => {
    // Simulation state — `minutes` accumulates every step so a mid-run
    // tickSize change keeps all previously elapsed world time intact
    let count = 0;
    let minutes = 0;
    let minutesPerTick = options.tickSize ?? DEFAULT_TICK_SIZE;
    let ticksPerSecond = options.speed ?? DEFAULT_SPEED;
    let timer: ReturnType<typeof setInterval> | null = null;

    // Subscriber set — insertion order preserved, listeners run oldest first
    const listeners = new Set<TickerListener>();

    // Bound pulse — set by the world so realtime ticks run the full step
    let boundPulse: (() => void) | null = null;

    // Internal: fires one realtime tick when the loop is active
    const pulse = () => {
        if (boundPulse) {
            boundPulse();
        } else {
            step();
        }
    };

    // Internal: (re)schedule the realtime interval at the current speed
    const schedule = () => {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        if (ticksPerSecond > 0) {
            // Interval is the reciprocal of speed: 2 tps → 500ms per tick
            timer = setInterval(pulse, 1000 / ticksPerSecond);
        }
    };

    const step = () => {
        count = count + 1;
        minutes = minutes + minutesPerTick;
        // Block body so a listener's return value can never short-circuit the
        // loop (arrayEach breaks on non-undefined returns). Array.from because
        // arrayEach needs index access — a Set has neither length nor [i].
        arrayEach(Array.from(listeners), ({ value: listener }) => {
            listener(count);
        });
        return count;
    };

    const ticker: Ticker = {
        step,
        ticks: () => count,
        elapsed: () => minutes,
        tickSize: ((minutes?: number) => {
            if (minutes === undefined) {
                return minutesPerTick;
            }
            minutesPerTick = minutes;
        }) as Ticker['tickSize'],
        play: () => {
            // Already running — do not stack a second interval
            if (timer !== null) {
                return;
            }
            schedule();
        },
        pause: () => {
            if (timer === null) {
                return;
            }
            clearInterval(timer);
            timer = null;
        },
        running: () => timer !== null,
        speed: ((value?: number) => {
            if (value === undefined) {
                return ticksPerSecond;
            }
            ticksPerSecond = value;
            // Reschedule only when the loop is active; a paused ticker keeps
            // its paused state and simply uses the new speed when played.
            if (timer !== null) {
                schedule();
            }
        }) as Ticker['speed'],
        clock: () => {
            // World day = 24 × 60 minutes; day 1 starts at minute 0
            const day = Math.floor(minutes / 1440) + 1;
            const within = minutes % 1440;
            const hour = Math.floor(within / 60);
            const minute = Math.floor(within % 60);
            return { day, hour, minute };
        },
        subscribe: (listener) => {
            listeners.add(listener);
            // Unsubscribe — safe to call more than once
            return () => {
                listeners.delete(listener);
            };
        },
        bindPulse: (pulse) => {
            boundPulse = pulse;
        },
    };

    return ticker;
};
