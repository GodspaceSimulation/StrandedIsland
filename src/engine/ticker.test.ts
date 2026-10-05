// Tests for the world clock (engine/ticker.ts).
// Fake timers drive the AUTO loop — requestAnimationFrame (the browser loop
// the ticker schedules on) plus performance (the frame CPU budget's clock)
// are faked explicitly, so every frame is deterministic: with performance
// frozen the per-frame batch always runs the FRAME_STEP_CAP of 100 steps,
// and a fake second holds 62 animation frames → 62 × 100 = 6200 steps.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTicker } from './ticker';

// The fake timer set the AUTO loop needs: rAF schedules the frames,
// performance.now budgets each frame's batch
const fakeTimers = () =>
    vi.useFakeTimers({
        toFake: [
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
            'Date',
            'requestAnimationFrame',
            'cancelAnimationFrame',
            'performance',
        ],
    });

describe('createTicker', () => {
    beforeEach(() => {
        fakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('steps one tick at a time, 1-based', () => {
        const ticker = createTicker();
        expect(ticker.ticks()).toBe(0);
        expect(ticker.step()).toBe(1);
        expect(ticker.step()).toBe(2);
        expect(ticker.ticks()).toBe(2);
    });

    it('elapsed = ticks × tickSize', () => {
        const ticker = createTicker({ tickSize: 10 });
        ticker.step();
        ticker.step();
        ticker.step();
        expect(ticker.elapsed()).toBe(30);
    });

    it('tickSize defaults to 10 minutes and can be changed mid-run', () => {
        const ticker = createTicker();
        expect(ticker.tickSize()).toBe(10);
        ticker.step();
        ticker.tickSize(60);
        ticker.step();
        // First tick at 10 min + second tick at 60 min
        expect(ticker.elapsed()).toBe(70);
    });

    it('clock derives day/hour/minute within a 24-hour day', () => {
        const ticker = createTicker({ tickSize: 60 });
        for (let index = 0; index < 23; index++) {
            ticker.step();
        }
        ticker.tickSize(15);
        ticker.step();
        // 23 ticks × 60 min = 23:00, then one 15-min tick → 23:15, day 1
        expect(ticker.clock()).toEqual({ day: 1, hour: 23, minute: 15 });
    });

    it('clock crosses into day 2', () => {
        const ticker = createTicker({ tickSize: 60 });
        for (let index = 0; index < 26; index++) {
            ticker.step();
        }
        expect(ticker.clock()).toEqual({ day: 2, hour: 2, minute: 0 });
    });

    it('subscribers fire once per tick and unsubscribe works', () => {
        const ticker = createTicker();
        const seen: number[] = [];
        const unsubscribe = ticker.subscribe((tick) => seen.push(tick));
        ticker.step();
        ticker.step();
        unsubscribe();
        ticker.step();
        expect(seen).toEqual([1, 2]);
    });

    // ── AUTO mode — the simulation runs as fast as possible ────────────────

    it('AUTO runs steps back-to-back with no per-second cap', () => {
        const ticker = createTicker();
        expect(ticker.running()).toBe(false);
        ticker.play();
        expect(ticker.running()).toBe(true);
        // One fake second = 62 animation frames (the first fires at t = 0)
        // × the 100-step per-frame cap (performance is frozen, so the CPU
        // budget never binds) — the loop races, no ticks-per-second throttle
        vi.advanceTimersByTime(1000);
        expect(ticker.ticks()).toBe(6200);
        ticker.pause();
        expect(ticker.running()).toBe(false);
        vi.advanceTimersByTime(1000);
        // Paused — no more steps
        expect(ticker.ticks()).toBe(6200);
    });

    it('play is idempotent (no stacked loops)', () => {
        const ticker = createTicker();
        ticker.play();
        ticker.play();
        vi.advanceTimersByTime(1000);
        expect(ticker.ticks()).toBe(6200);
    });

    it('pause mid-run stops the loop and play resumes it', () => {
        const ticker = createTicker();
        ticker.play();
        vi.advanceTimersByTime(500);
        const halfway = ticker.ticks();
        ticker.pause();
        vi.advanceTimersByTime(500);
        expect(ticker.ticks()).toBe(halfway);
        ticker.play();
        vi.advanceTimersByTime(500);
        expect(ticker.ticks()).toBeGreaterThan(halfway);
    });

    it('bindPulse replaces the auto pulse with the full world step', () => {
        const ticker = createTicker();
        let fullSteps = 0;
        // The world binds its step() here — a "full step" also advances the
        // clock, so the pulse must not double-count
        ticker.bindPulse(() => {
            fullSteps = fullSteps + 1;
            ticker.step();
        });
        ticker.play();
        vi.advanceTimersByTime(1000);
        expect(fullSteps).toBe(6200);
        expect(ticker.ticks()).toBe(6200);
    });
});
