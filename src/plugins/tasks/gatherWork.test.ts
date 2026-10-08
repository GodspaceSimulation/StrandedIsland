// Tests for the gather work helper (plugins/tasks/gatherWork.ts) — the
// shared tile-work seam the hunger/thirst gathers and the construction
// fetches ride on. Pure ledger logic: no world, no clock, no randomness —
// every expectation is exact.
import { describe, it, expect } from 'vitest';
import { createTileWorkLedger } from '@godspace/core';
import { beatGatherJob, gatherWorkKey, openGatherJob } from './gatherWork';

describe('gatherWork', () => {
    it('keys one job per tile per resource — two resources never share a record', () => {
        expect(gatherWorkKey(-7, 0, 'berry')).toBe('tile:-7,0:berry');
        expect(gatherWorkKey(-7, 0, 'water')).toBe('tile:-7,0:water');
        expect(gatherWorkKey(-7, 1, 'berry')).toBe('tile:-7,1:berry');
    });

    it('opens the job with the item as its kind and the skill tag standing', () => {
        const ledger = createTileWorkLedger();
        const job = openGatherJob(ledger, { x: 1, y: 5, item: 'vine', units: 2, skill: 'forage' });
        expect(job).toEqual({
            key: 'tile:1,5:vine',
            kind: 'vine',
            units: 2,
            progress: 0,
            skill: 'forage',
        });
    });

    it('joining is idempotent — a second opener never restarts standing work', () => {
        const ledger = createTileWorkLedger();
        openGatherJob(ledger, { x: 0, y: 0, item: 'berry', units: 10, skill: 'forage' });
        beatGatherJob(ledger, { x: 0, y: 0, item: 'berry' }, () => true);
        const joined = openGatherJob(ledger, { x: 0, y: 0, item: 'berry', units: 10, skill: 'forage' });
        // The half-done forage survives the join untouched (the ledger's
        // open never re-prices or resets)
        expect(joined).toEqual({
            key: 'tile:0,0:berry',
            kind: 'berry',
            units: 10,
            progress: 1,
            skill: 'forage',
        });
    });

    it('beats accumulate across contributors and the claim pays exactly once', () => {
        const ledger = createTileWorkLedger();
        openGatherJob(ledger, { x: 3, y: -2, item: 'mushroom', units: 2, skill: 'forage' });
        let payouts = 0;
        const payout = () => {
            payouts = payouts + 1;
            return true;
        };
        // Worker one banks a minute — the job stands unfinished
        const first = beatGatherJob(ledger, { x: 3, y: -2, item: 'mushroom' }, payout);
        expect(first.unit?.progress).toBe(1);
        expect(first.claimed).toBeUndefined();
        // Worker two finishes it — the claim lands on THIS beat only
        const second = beatGatherJob(ledger, { x: 3, y: -2, item: 'mushroom' }, payout);
        expect(second.claimed).toEqual({
            key: 'tile:3,-2:mushroom',
            kind: 'mushroom',
            units: 2,
            progress: 2,
            skill: 'forage',
        });
        expect(payouts).toBe(1);
        // A late third beat lands nowhere — the job is gone, no second take
        const third = beatGatherJob(ledger, { x: 3, y: -2, item: 'mushroom' }, payout);
        expect(third.unit).toBeUndefined();
        expect(third.claimed).toBeUndefined();
        expect(payouts).toBe(1);
    });

    it('a failed payout rolls the finished job back with its minutes intact', () => {
        const ledger = createTileWorkLedger();
        openGatherJob(ledger, { x: -4, y: -7, item: 'coconut', units: 1, skill: 'forage' });
        // The take fails (a full bag / a dry pool) — the claim returns the
        // unit to the ledger untouched, and NO output is paid
        const failed = beatGatherJob(ledger, { x: -4, y: -7, item: 'coconut' }, () => false);
        expect(failed.claimed).toBeUndefined();
        expect(ledger.get('tile:-4,-7:coconut')).toEqual({
            key: 'tile:-4,-7:coconut',
            kind: 'coconut',
            units: 1,
            progress: 1,
            skill: 'forage',
        });
        // The next beat retries the payout and lands
        const retry = beatGatherJob(ledger, { x: -4, y: -7, item: 'coconut' }, () => true);
        expect(retry.claimed?.progress).toBe(1);
        expect(ledger.get('tile:-4,-7:coconut')).toBeUndefined();
    });

    it('different resources on one tile advance independently', () => {
        const ledger = createTileWorkLedger();
        openGatherJob(ledger, { x: 0, y: 3, item: 'berry', units: 10, skill: 'forage' });
        openGatherJob(ledger, { x: 0, y: 3, item: 'water', units: 3, skill: 'forage' });
        beatGatherJob(ledger, { x: 0, y: 3, item: 'berry' }, () => true);
        beatGatherJob(ledger, { x: 0, y: 3, item: 'berry' }, () => true);
        expect(ledger.get('tile:0,3:berry')?.progress).toBe(2);
        expect(ledger.get('tile:0,3:water')?.progress).toBe(0);
        // The water job finishes on its own schedule — the berry job keeps
        // standing (no cross-kind claim, no mismatched payout)
        beatGatherJob(ledger, { x: 0, y: 3, item: 'water' }, () => true);
        beatGatherJob(ledger, { x: 0, y: 3, item: 'water' }, () => true);
        const done = beatGatherJob(ledger, { x: 0, y: 3, item: 'water' }, () => true);
        expect(done.claimed?.kind).toBe('water');
        expect(ledger.get('tile:0,3:berry')?.progress).toBe(2);
    });
});
