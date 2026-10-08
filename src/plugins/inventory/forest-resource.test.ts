// R7 — THE FOREST RESOURCE PROFILE: the deterministic tuning table behind
// the enriched forest (plugins/inventory/inventoryPlugin.ts). These tests
// import ONLY the exported profile constants — no world, no terrain, no
// engine — so they pin the enrichment decisions independently of the
// simulation modules and stay valid while sibling modules move under
// integration.
//
// WHAT R7 CHANGED (the decisions these tests pin exactly):
//   BIOME_STOCKS.forest   berry 2 → 4, mushroom 2 → 3 (the woods are the
//                         island's larder — a surveyed forest reads FILLED
//                         with berries and more from the first minute)
//   VINE_CHANCE           0.35 → 0.6 (the woods hang vines thick)
//   BUSH_CHANCE           split per biome: meadow stays 0.3, forest 0.6
//                         (the forest undergrowth is the standing berry
//                         reserve; the hash fold is unchanged so the raise
//                         only ADDS forest bushes — 0.3 ⊂ 0.6)
//   REGROW_CAPS           berry 5 → 6, mushroom 4 → 5, vine 2 → 3 — the
//                         caps sit a clear step ABOVE the seeded abundance
//                         so a picked forest refills past its start
// WHAT R7 PRESERVED (the depletion/regrowth ecosystem):
//   REGROW_RHYTHM         every clock untouched (berry 30/20, mushroom
//                         40/15, vine 80/30, …) — only the ceilings moved
//   finite minerals       stone/iron/shell/flint have NO cap and NO rhythm
//                         — depleted sources regrow ONLY where the survey
//                         seeded them (the eligibility registry, pinned in
//                         inventoryPlugin.test.ts); the TREE has no stock
//                         rhythm either (the forest ecology owns it)
//   meadow / beach        seeding exactly as tuned before

import { describe, it, expect } from 'vitest';
import {
    BIOME_STOCKS,
    REGROW_CAPS,
    REGROW_RHYTHM,
    VINE_CHANCE_PER_FOREST_CELL,
    BUSH_CHANCE_PER_MEADOW_CELL,
    BUSH_CHANCE_PER_FOREST_CELL,
    bushHash,
    bushAt,
} from './inventoryPlugin';

describe('R7 — the forest resource profile', () => {
    it('seeds the forest as the island\'s larder — berry 4 + mushroom 3 per wood', () => {
        // The EXACT living-stock seeding map, biome by biome: the forest is
        // enriched, the meadow (3 berries) and beach (2 coconuts) stay
        // exactly as tuned (no biome topology or non-forest changes)
        expect(BIOME_STOCKS).toEqual({
            meadow: { berry: 3 },
            forest: { berry: 4, mushroom: 3 },
            beach: { coconut: 2 },
        });
        // The berry seeds BEFORE the mushroom in the forest stock's
        // insertion order — the hunger gather still picks the berry first
        expect(Object.keys(BIOME_STOCKS.forest)).toEqual(['berry', 'mushroom']);
    });

    it('raises the regrowth caps to match the enriched seeding', () => {
        // R7 ceilings: berry 6 (above the forest's seeded 4), mushroom 5
        // (above the seeded 3), vine 3 (the denser 0.6-chance map re-hangs
        // richer per cell). The non-forest ceilings stay as tuned.
        expect(REGROW_CAPS.berry).toBe(6);
        expect(REGROW_CAPS.mushroom).toBe(5);
        expect(REGROW_CAPS.vine).toBe(3);
        expect(REGROW_CAPS.bush).toBe(3);
        expect(REGROW_CAPS.coconut).toBe(3);
        expect(REGROW_CAPS.fish).toBe(3);
        expect(REGROW_CAPS.seaweed).toBe(2);
        expect(REGROW_CAPS.water).toBe(2);
        expect(REGROW_CAPS.frond).toBe(1);
    });

    it('keeps the regrowth rhythms exactly as tuned — only the ceilings moved', () => {
        // The depletion/regrowth ECOSYSTEM clock is untouched by R7: every
        // item fires on its original staggered world-minute rhythm.
        expect(REGROW_RHYTHM).toEqual({
            berry: { every: 30, offset: 20 },
            fish: { every: 40, offset: 0 },
            coconut: { every: 60, offset: 10 },
            mushroom: { every: 40, offset: 15 },
            seaweed: { every: 50, offset: 25 },
            vine: { every: 80, offset: 30 },
        });
        // The berry BUSH is a permanent plant, not a loose stock — it is
        // deliberately absent from the generic rhythm table (the dedicated
        // BUSH_RHYTHM pass over the bushCells registry refills it), and the
        // frond shed keys off the TREE stock, not the frond key.
        expect(REGROW_RHYTHM.bush).toBeUndefined();
        expect(REGROW_RHYTHM.frond).toBeUndefined();
    });

    it('keeps the finite minerals finite — no cap, no rhythm, no regrowth', () => {
        // Depleted sources regrow ONLY where the survey seeded a renewable
        // (the eligibility registry); the finite draws never come back:
        // stone and iron (the mined deposits), shell and flint (the chance
        // hides) carry NO regrowth entry at all.
        expect(REGROW_CAPS.stone).toBeUndefined();
        expect(REGROW_CAPS.iron).toBeUndefined();
        expect(REGROW_CAPS.shell).toBeUndefined();
        expect(REGROW_CAPS.flint).toBeUndefined();
        expect(REGROW_RHYTHM.stone).toBeUndefined();
        expect(REGROW_RHYTHM.iron).toBeUndefined();
        expect(REGROW_RHYTHM.shell).toBeUndefined();
        expect(REGROW_RHYTHM.flint).toBeUndefined();
        // The standing TREE is not a stock rhythm either — the forest
        // ecology's recruitment owns the mirror (the old toy clock is gone)
        expect(REGROW_CAPS.tree).toBeUndefined();
        expect(REGROW_RHYTHM.tree).toBeUndefined();
    });

    it('hangs vines thick in the woods — the forest vine chance is 0.6', () => {
        // R7: 0.35 → 0.6. The survey still spends exactly ONE stream draw
        // per forest cell in row-major order (only the threshold moved), so
        // the shell/flint/seaweed/rain stream pins never shift — the vine
        // map grows as a provable superset of the old 0.35 draw.
        expect(VINE_CHANCE_PER_FOREST_CELL).toBe(0.6);
    });

    it('thickens the forest undergrowth with berry bushes — meadow chance untouched', () => {
        // R7: the bush chance is BIOME-SPECIFIC — the forest seeds bushes
        // at 0.6 (the woods' standing berry reserve beside the enriched
        // loose berries), the meadow keeps its original 0.3.
        expect(BUSH_CHANCE_PER_MEADOW_CELL).toBe(0.3);
        expect(BUSH_CHANCE_PER_FOREST_CELL).toBe(0.6);
    });

    it('places every bush on the deterministic coordinate hash — exact folds', () => {
        // The fnv-1a fold (mod 1000, /1000) is a PURE per-address roll —
        // stable seed for seed, no random-stream draw. These exact fold
        // values are the placement map for the reference cells the survey
        // tests pin.
        expect(bushHash(-7, 0)).toBe(0.408); // forest — gains a bush at 0.6
        expect(bushHash(0, 3)).toBe(0.22); // meadow — bush stands under both chances
        expect(bushHash(2, 3)).toBe(0.125); // meadow — bush stands under both chances
        expect(bushHash(-1, -5)).toBe(0.22); // meadow — the R2 bush fixture cell
        expect(bushHash(1, -2)).toBe(0.74); // meadow — no bush under either chance
        expect(bushHash(1, 5)).toBe(0.844); // forest — no bush even at 0.6
        expect(bushHash(-1, -3)).toBe(0.852); // forest (21×13 board) — no bush at 0.6
    });

    it('the raised forest chance only ADDS bushes — the map is monotonic', () => {
        // 0.3 ⊂ 0.6: every cell that carried a bush under the old flat 0.3
        // still carries one (the meadow pins never move), and the forest
        // raise flips only misses into hits.
        // (-7,0) fold 0.408 — the forest raise ADDS this bush:
        expect(bushAt(-7, 0, BUSH_CHANCE_PER_MEADOW_CELL)).toBe(false);
        expect(bushAt(-7, 0, BUSH_CHANCE_PER_FOREST_CELL)).toBe(true);
        // (0,3) fold 0.22 — the meadow bush STAYS put:
        expect(bushAt(0, 3, BUSH_CHANCE_PER_MEADOW_CELL)).toBe(true);
        expect(bushAt(0, 3, BUSH_CHANCE_PER_FOREST_CELL)).toBe(true);
        // (1,5) fold 0.844 — above both chances, bare either way:
        expect(bushAt(1, 5, BUSH_CHANCE_PER_MEADOW_CELL)).toBe(false);
        expect(bushAt(1, 5, BUSH_CHANCE_PER_FOREST_CELL)).toBe(false);
        // (1,-2) fold 0.74 — the meadow fixture cell stays bush-free:
        expect(bushAt(1, -2, BUSH_CHANCE_PER_MEADOW_CELL)).toBe(false);
        expect(bushAt(1, -2, BUSH_CHANCE_PER_FOREST_CELL)).toBe(false);
    });
});
