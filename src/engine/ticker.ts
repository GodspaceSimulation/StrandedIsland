// The world clock (ticker).
//
// The whole simulation runs on this beat: every `step()` advances world time
// by `tickSize` minutes. `tickSize` is configurable at any moment — the VIEW
// SCALE drives it (scenario/island.ts binds scale → tick size: one zoom rung
// is one factor of 10 of step time, scale 0 = 10 min, scale +1 = 1 min,
// scale −1 = 100 min). On top of manual stepping there is the AUTO loop:
// play() runs the simulation AS FAST AS POSSIBLE — no ticks-per-second cap,
// each animation frame processes a batch of steps bounded only by a small
// CPU budget so the browser keeps breathing and the god-view keeps painting.

import { arrayEach } from '@presource/core';

/** Callback fired after every tick with the new tick number. */
export type TickerListener = (tick: number) => void;

export type TickerOptions = {
    /** Minutes of world time per tick. Default 10 (the scale-0 step time). */
    tickSize?: number;
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
    /**
     * Starts the AUTO loop — the simulation runs as fast as the browser
     * allows (no per-second cap). No-op when already running.
     */
    play(): void;
    /** Stops the AUTO loop (no-op when already paused). */
    pause(): void;
    /** Whether the AUTO loop is currently running. */
    running(): boolean;
    /** Calendar derivation from elapsed minutes: day is 1-based. */
    clock(): { day: number; hour: number; minute: number };
    /** Subscribes to every tick; returns the unsubscribe function. */
    subscribe(listener: TickerListener): () => void;
    /**
     * Overrides what the AUTO loop executes per pulse. The world binds
     * its full `step()` here so auto ticks also run plugin ticks —
     * without this, play() would advance the clock but the world would
     * stand still. Unbound, the pulse is a plain internal step.
     */
    bindPulse(pulse: () => void): void;
};

/** Fallback when no tickSize is provided — the scale-0 step time. */
const DEFAULT_TICK_SIZE = 10;

// ── AUTO loop constants ──────────────────────────────────────────────────────
// Each animation frame runs a batch of steps: as many as fit the frame's CPU
// budget (the simulation races), capped so a frozen clock (fake timers) can
// never spin the batch forever.

/** CPU budget per animation frame, in milliseconds. */
const FRAME_BUDGET_MS = 10;
/** Hard cap of steps per frame — the frozen-clock safety valve. */
const FRAME_STEP_CAP = 100;

/** Millisecond reader — performance.now when present, Date.now otherwise. */
const nowMs = (): number => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
};

/** A scheduled auto pulse plus how to cancel it (rAF id or timeout id). */
type AutoHandle = { cancel(): void };

export const createTicker = (options: TickerOptions = {}): Ticker => {
    // Simulation state — `minutes` accumulates every step so a mid-run
    // tickSize change keeps all previously elapsed world time intact
    let count = 0;
    let minutes = 0;
    let minutesPerTick = options.tickSize ?? DEFAULT_TICK_SIZE;

    // Subscriber set — insertion order preserved, listeners run oldest first
    const listeners = new Set<TickerListener>();

    // Bound pulse — set by the world so auto ticks run the full step
    let boundPulse: (() => void) | null = null;

    // AUTO loop state — `autoActive` is the loop's on/off bit (pause() may
    // land mid-batch, after the frame handle was already consumed);
    // `autoHandle` is the PENDING frame between scheduling and firing
    let autoActive = false;
    let autoHandle: AutoHandle | null = null;

    // Internal: fires one auto tick when the loop is active
    const pulse = () => {
        if (boundPulse) {
            boundPulse();
        } else {
            step();
        }
    };

    // Internal: queues the next auto frame — requestAnimationFrame in the
    // browser (the loop yields to rendering, the browser's fastest safe
    // cadence), a zero-delay timeout anywhere else (tests, workers)
    const scheduleAuto = () => {
        const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
        const cancelRaf = (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame;
        if (typeof raf === 'function' && typeof cancelRaf === 'function') {
            const id = raf(() => autoPulse());
            autoHandle = { cancel: () => cancelRaf(id) };
            return;
        }
        const timeout = setTimeout(() => autoPulse(), 0);
        autoHandle = { cancel: () => clearTimeout(timeout) };
    };

    // Internal: one auto frame — a batch of pulses bounded by the CPU
    // budget (and the cap). Each pulse is a FULL step.
    const autoPulse = () => {
        // The frame handle is consumed the moment it fires
        autoHandle = null;
        if (!autoActive) {
            return;
        }
        const start = nowMs();
        let ran = 0;
        while (ran < FRAME_STEP_CAP) {
            pulse();
            ran = ran + 1;
            // Budget spent — hand the remainder of the frame back to the
            // browser so rendering and input never starve
            if (nowMs() - start >= FRAME_BUDGET_MS) {
                break;
            }
        }
        // Pause may have landed mid-batch — only continue when still active
        if (autoActive) {
            scheduleAuto();
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
            // Already running — do not stack a second loop
            if (autoActive) {
                return;
            }
            autoActive = true;
            scheduleAuto();
        },
        pause: () => {
            if (!autoActive) {
                return;
            }
            autoActive = false;
            // A pending frame (between scheduling and firing) is cancelled;
            // mid-batch pauses simply let the batch end without rescheduling
            if (autoHandle !== null) {
                autoHandle.cancel();
                autoHandle = null;
            }
        },
        running: () => autoActive,
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
