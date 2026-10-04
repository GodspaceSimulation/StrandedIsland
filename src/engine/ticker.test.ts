// Tests for the world clock (engine/ticker.ts).
// Fake timers are used for the realtime loop; manual stepping is time-free.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTicker } from './ticker';

describe('createTicker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
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

    it('clock derives day/hour/minute from accumulated world minutes', () => {
        // 23 ticks × 60 min = 23:00, then one 15-min tick → 23:15, day 1
        const ticker = createTicker({ tickSize: 60 });
        for (let index = 0; index < 23; index++) {
            ticker.step();
        }
        ticker.tickSize(15);
        ticker.step();
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

    it('realtime loop fires at the configured speed', () => {
        const ticker = createTicker({ speed: 2 });
        ticker.play();
        // 2 ticks per second → 4 ticks after 2 seconds
        vi.advanceTimersByTime(2000);
        expect(ticker.ticks()).toBe(4);
        expect(ticker.running()).toBe(true);
        ticker.pause();
        expect(ticker.running()).toBe(false);
        vi.advanceTimersByTime(5000);
        // Paused — no more ticks
        expect(ticker.ticks()).toBe(4);
    });

    it('play is idempotent (no stacked intervals)', () => {
        const ticker = createTicker({ speed: 2 });
        ticker.play();
        ticker.play();
        vi.advanceTimersByTime(1000);
        expect(ticker.ticks()).toBe(2);
    });

    it('changing speed while running reschedules the interval', () => {
        const ticker = createTicker({ speed: 1 });
        ticker.play();
        vi.advanceTimersByTime(1000);
        expect(ticker.ticks()).toBe(1);
        ticker.speed(4);
        vi.advanceTimersByTime(1000);
        // 4 more ticks at 4 tps
        expect(ticker.ticks()).toBe(5);
        expect(ticker.speed()).toBe(4);
    });

    it('bindPulse replaces the realtime pulse with the full world step', () => {
        const ticker = createTicker({ speed: 2 });
        let fullSteps = 0;
        // The world binds its step() here — a "full step" also advances the
        // clock, so the pulse must not double-count
        ticker.bindPulse(() => {
            fullSteps = fullSteps + 1;
            ticker.step();
        });
        ticker.play();
        vi.advanceTimersByTime(1000);
        expect(fullSteps).toBe(2);
        expect(ticker.ticks()).toBe(2);
    });
});
