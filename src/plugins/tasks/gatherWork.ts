// THE GATHER WORK HELPER — the shared tile-work seam every GATHERING path
// rides on (behavior's hunger/thirst rungs, construction's fetch rungs).
//
// WHY THIS EXISTS — the chop/fell jobs (plugins/lumber) proved the pattern:
// one PERSISTENT SHARED job per tile in the tasks plugin's tile work ledger
// (@godspace/core src/work), 1-minute beat tasks feeding it, an ATOMIC claim
// paying out exactly once. Gathering (berries, water, vines, fronds, stone…)
// is the same kind of world-remembered labor: several skilled hands can work
// one bush, and a hand that gets pre-empted mid-forage must leave its
// minutes STANDING, not restart them. This module is the small shared
// vocabulary so every gather path composes the SAME key and the SAME
// claim/rollback discipline — no per-plugin dialects.
//
// THE KEY — `tileWorkKey(x, y, item)`: the work KIND is the resource item id
// ('berry', 'water', 'vine', 'stone', …), so two different resources on one
// tile are two independent jobs, and the same resource on one tile is ONE
// job every skilled contributor shares. The UI (features/tileDetails'
// tileProgress) reads the ledger generically — gather jobs appear as
// progress bars with zero extra wiring.
//
// THE PAYOUT — the claim is atomic (ledger.complete hands the finished job
// to exactly ONE contributor, never duplicated). The payout itself is the
// caller's inventory take (takeFromCell / gather), re-validated at claim
// time: stock, capacity and the mine gate all still apply. A payout that
// FAILS (the pool ran dry, the bag filled mid-job) puts the claimed unit
// BACK with its progress intact — the labor is never lost, the next beat
// retries.
//
// WHAT STAYS PRIVATE — CRAFTING (frond→thatch, vine→rope, wood→plank) is
// NOT tile work: a craft is a bag-atomic input→output transformation owned
// by the crafting bag, not location-bound labor several hands share. The
// tile ledger would have no meaningful "standing work" for it (the inputs
// live in one actor's bag), so crafts remain private actor tasks by design.

import { tileWorkKey, type TileWorkLedger, type TileWorkUnit } from '@godspace/core';

/** The shared gather job key — one job per tile per resource item. */
export const gatherWorkKey = (x: number, y: number, item: string): string =>
    tileWorkKey(x, y, item);

/** Opens (or joins — idempotent, never restarts) a gather job. */
export const openGatherJob = (
    ledger: TileWorkLedger,
    spec: { x: number; y: number; item: string; units: number; skill: string },
): TileWorkUnit =>
    ledger.open({
        key: gatherWorkKey(spec.x, spec.y, spec.item),
        kind: spec.item,
        units: spec.units,
        skill: spec.skill,
    });

/** The outcome of one completed gather beat. */
export type GatherBeatOutcome = {
    /** The standing unit after the beat, or undefined when the job was
     * already claimed/removed (a co-worker won the race). */
    unit: TileWorkUnit | undefined;
    /** The unit this beat CLAIMED (finished + paid out), if any. */
    claimed: TileWorkUnit | undefined;
};

/**
 * Advances one gather job by a work-minute and pays out on the atomic
 * claim. `payout` performs the actual inventory take and reports whether
 * it landed; a failed payout ROLLS THE JOB BACK (ledger.put) so the
 * standing minutes survive for the next contributor. The tile coordinates
 * come from the BEAT's payload (the actor may have walked since planning —
 * the job they committed to is the one they finish).
 */
export const beatGatherJob = (
    ledger: TileWorkLedger,
    spec: { x: number; y: number; item: string },
    payout: () => boolean,
): GatherBeatOutcome => {
    const key = gatherWorkKey(spec.x, spec.y, spec.item);
    const unit = ledger.add(key, 1);
    // No standing job (claimed away mid-beat) or still unfinished — the
    // minute is banked (or landed nowhere); nothing to claim this beat
    if (!unit || unit.progress < unit.units) {
        return { unit, claimed: undefined };
    }
    // THE ATOMIC CLAIM — exactly one contributor ever receives this job
    const claimed = ledger.complete(key);
    if (!claimed) {
        return { unit, claimed: undefined };
    }
    if (!payout()) {
        // The take failed (dry pool, full bag, mine gate) — the finished
        // work returns untouched; the next beat retries the payout
        ledger.put(claimed);
        return { unit: claimed, claimed: undefined };
    }
    return { unit, claimed };
};
