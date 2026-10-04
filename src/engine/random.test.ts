// Tests for the seeded PRNG (engine/random.ts).
// Determinism is the contract: same seed → exact same sequence.

import { describe, it, expect } from 'vitest';
import {
    randomCreate,
    randomKeyed,
    randomRange,
    randomInteger,
    randomPick,
    randomChance,
} from './random';

describe('randomCreate', () => {
    // Exact mulberry32(1) output sequence — hardcoded from a reference run
    // (vite-node capture, 2026-10). If these change, the PRNG changed.
    it('produces the exact same sequence for the same seed', () => {
        const source = randomCreate(1);
        const sequence = [source(), source(), source(), source(), source(), source()];
        expect(sequence).toEqual([
            0.6270739405881613,
            0.002735721180215478,
            0.5274470399599522,
            0.9810509674716741,
            0.9683778982143849,
            0.281103502959013,
        ]);
    });

    it('produces the exact same sequence for seed 7', () => {
        const source = randomCreate(7);
        expect([source(), source(), source(), source()]).toEqual([
            0.011704753153026104,
            0.06195825757458806,
            0.97690763277933,
            0.6990287057124078,
        ]);
    });

    it('different seeds start on different values', () => {
        // Both streams' first draws — they must differ
        const firstOfOne = randomCreate(1)();
        const firstOfTwo = randomCreate(2)();
        expect(firstOfTwo).not.toBe(firstOfOne);
        // Exact value so drift is caught immediately
        expect(firstOfTwo).toBe(0.7342509443406016);
    });
});

describe('randomKeyed', () => {
    it('derives a stable independent stream from seed + key', () => {
        const source = randomKeyed(42, 'island-terrain');
        expect([source(), source(), source()]).toEqual([
            0.38134754030033946,
            0.19159193197265267,
            0.5413900271523744,
        ]);
    });

    it('different keys derive different streams from the same seed', () => {
        expect(randomKeyed(42, 'inventory')()).not.toBe(randomKeyed(42, 'behavior')());
    });
});

describe('helpers', () => {
    it('randomRange maps [0,1) into [min, max)', () => {
        // 0.6270739405881613 of seed 1 → 0 + value * (100 - 0)
        const source = randomCreate(1);
        expect(randomRange(source, 0, 100)).toBe(62.707394058816135);
    });

    it('randomInteger is inclusive on both ends and deterministic', () => {
        const source = randomCreate(123);
        expect([randomInteger(source, 0, 9), randomInteger(source, 0, 9), randomInteger(source, 0, 9), randomInteger(source, 0, 9)]).toEqual([7, 1, 4, 2]);
    });

    it('randomPick indexes deterministically', () => {
        const source = randomCreate(5);
        expect([randomPick(source, ['a', 'b', 'c']), randomPick(source, ['a', 'b', 'c']), randomPick(source, ['a', 'b', 'c'])]).toEqual(['c', 'c', 'a']);
    });

    it('randomChance thresholds exactly', () => {
        const source = randomCreate(9);
        expect([randomChance(source, 0.5), randomChance(source, 0.5), randomChance(source, 0.5)]).toEqual([true, false, true]);
    });
});
