// R7 — THE FOREST RESOURCE PROFILE: the deterministic tuning table behind
// the enriched forest (plugins/inventory/inventoryPlugin.ts). These tests
// import ONLY the exported profile constants — no world, no terrain, no
// engine — so they pin the enrichment decisions independently of the
// simulation modules and stay valid while sibling modules move under
// integration.
//
// WHAT R7 CHANGED (the decisions these tests pin exactly):
//   VINE_CHANCE           0.35 → 0.6 (the woods hang vines thick)
//   BUSH_CHANCE           split per biome: meadow stays 0.3, forest 0.6
//                         (the forest undergrowth is the standing berry
//                         reserve; the hash fold is unchanged so the raise
//                         only ADDS forest bushes — 0.3 ⊂ 0.6)
//   REGROW_CAPS           mushroom 4 → 5, vine 2 → 3 — the caps sit a clear
//                         step ABOVE the seeded abundance so a picked forest
//                         refills past its start
// WHAT R7 PRESERVED (the depletion/regrowth ecosystem):
//   REGROW_RHYTHM         every remaining clock untouched (mushroom 40/15,
//                         vine 80/30, …)
//   finite minerals       stone/iron/shell/flint have NO cap and NO rhythm
//                         — depleted sources regrow ONLY where the survey
//                         seeded them (the eligibility registry, pinned in
//                         inventoryPlugin.test.ts); the TREE has no stock
//                         rhythm either (the forest ecology owns it)
//   beach                 seeding exactly as tuned before
//
// WHAT T4 CHANGED (the ecology request — the decisions these tests now pin):
//   BIOME_STOCKS          the AMBIENT LOOSE BERRIES are GONE: the meadow
//                         stocks nothing loose, the forest keeps only its
//                         mushroom ring — berries are BUSH AND FARM produce
//                         (the bushes' lazy fruit batches + the farming
//                         plugin's clock-driven plots; "Berries shouldn't
//                         appear on the ground randomly, but in bushes")
//   REGROW_CAPS/RHYTHM    berry, fish and bush LEFT the tables: no loose
//                         berry pool exists to regrow, the water is an
//                         UNLIMITED fish source (the fishing tools + the
//                         constructed nets draw it forever — the source is
//                         never a drawn-down stock), and the `bush` stock
//                         key IS the standing plant (a constant one — the
//                         BERRIES it bears regrow lazily per plant through
//                         BUSH_BERRY_CAP / BUSH_RIPEN_MINUTES)

import { describe, it, expect } from 'vitest';
import {
    BIOME_STOCKS,
    REGROW_CAPS,
    REGROW_RHYTHM,
    VINE_CHANCE_PER_FOREST_CELL,
    BUSH_CHANCE_PER_MEADOW_CELL,
    BUSH_CHANCE_PER_FOREST_CELL,
    BUSH_BERRY_CAP,
    BUSH_RIPEN_MINUTES,
    bushHash,
    bushAt,
} from './inventoryPlugin';

describe('R7/T4 — the forest resource profile', () => {
    it('seeds NO ambient loose berries — the bushes bear them (T4)', () => {
        // The EXACT living-stock seeding map, biome by biome: the meadow
        // stocks NOTHING loose (T4 — the loose berry seeding left; the
        // deterministic bush hash seeds the standing plants the berries
        // hang on), the forest keeps its mushroom ring, the beach keeps
        // its coconuts exactly as tuned.
        expect(BIOME_STOCKS).toEqual({
            meadow: {},
            forest: { mushroom: 3 },
            beach: { coconut: 2 },
        });
        // No berry entry survives anywhere in the seeding map
        Object.values(BIOME_STOCKS).forEach((stock) => {
            expect(stock.berry).toBeUndefined();
        });
    });

    it('raises the regrowth caps to match the enriched seeding', () => {
        // R7 ceilings: mushroom 5 (above the seeded 3), vine 3 (the denser
        // 0.6-chance map re-hangs richer per cell). The non-forest ceilings
        // stay as tuned.
        expect(REGROW_CAPS.mushroom).toBe(5);
        expect(REGROW_CAPS.vine).toBe(3);
        expect(REGROW_CAPS.coconut).toBe(3);
        expect(REGROW_CAPS.seaweed).toBe(2);
        expect(REGROW_CAPS.water).toBe(2);
        expect(REGROW_CAPS.frond).toBe(1);
        // T4 — berry, fish and bush left the table (see the header)
        expect(REGROW_CAPS.berry).toBeUndefined();
        expect(REGROW_CAPS.fish).toBeUndefined();
        expect(REGROW_CAPS.bush).toBeUndefined();
    });

    it('keeps the regrowth rhythms exactly as tuned — only the ceilings moved', () => {
        // The depletion/regrowth ECOSYSTEM clock is untouched by R7: every
        // remaining item fires on its original staggered world-minute
        // rhythm. T4 — the berry (no loose pool to regrow) and fish (the
        // unlimited water source is never a stock) rhythms LEFT the table.
        expect(REGROW_RHYTHM).toEqual({
            coconut: { every: 60, offset: 10 },
            mushroom: { every: 40, offset: 15 },
            seaweed: { every: 50, offset: 25 },
            vine: { every: 80, offset: 30 },
        });
        expect(REGROW_RHYTHM.berry).toBeUndefined();
        expect(REGROW_RHYTHM.fish).toBeUndefined();
        // The berry BUSH is a permanent plant, not a loose stock — its
        // berries regrow through the lazy per-bush fruit record (the
        // exported batch tuning below), and the frond shed keys off the
        // TREE stock, not the frond key.
        expect(REGROW_RHYTHM.bush).toBeUndefined();
        expect(REGROW_RHYTHM.frond).toBeUndefined();
    });

    it('pins the bush fruit batch — the lazy ripening the plants obey (T4)', () => {
        // The standing bush carries BUSH_BERRY_CAP berries and ripens one
        // every BUSH_RIPEN_MINUTES world minutes after a pluck (a
        // plucked-bare bush refills its batch over cap × interval — 180
        // minutes, near the old 40-minute-rhythm refill pace but keyed to
        // the PLANT, so the bush stays visible and inspectable whatever
        // its fruit count)
        expect(BUSH_BERRY_CAP).toBe(3);
        expect(BUSH_RIPEN_MINUTES).toBe(60);
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
