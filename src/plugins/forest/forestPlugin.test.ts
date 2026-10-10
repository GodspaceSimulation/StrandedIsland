// Tests for the forest ecology plugin (plugins/forest/forestPlugin.ts).
//
// THE LIVING WOODS: the terrain plugin seeds every forested tile with a
// persistent fine-scale stand (plugins/terrain ForestStand — the tile's
// NEIGHBORHOOD-COUNTED coverage of its fine cells under the 8-neighbor
// model, mixed seeded ages), this plugin grows the trees' wood pools,
// recruits saplings (even clearcut — the seed bank), and spreads mature
// woods over adjacent GRASS tiles only (ingressed meadows carry their
// fringe stands too — a conversion joins the sapling onto the meadow's
// existing ingress stand). Every outcome below was captured from reference
// runs — the ecology is fully deterministic.
//
// The default pacing is the DOCUMENTED REAL-WORLD pace (one year = 525,600
// world minutes; sources in forestPlugin.ts header), so realistic horizons
// do nothing inside test-sized marches — the accelerated tests override the
// pacing in direct world minutes (maturityMinutes/recruitMinutes/
// spreadMinutes) or fast-forward the ecology without stepping the world.

import { describe, it, expect } from 'vitest';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin, forestTreeCount } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { forestPlugin, type ForestPacingOptions } from './forestPlugin';
import { entityPlugin } from '../entity/entityPlugin';
import { inventoryWeight } from '../inventory/items';
import { position3 } from '@godspace/core';
import type { Actor } from '../../engine/types';

/** A 7×5 island with the ecology mounted (rain off — no stock interference). */
const buildEcology = (pacing: ForestPacingOptions = {}, terrainWidth = 7, terrainHeight = 5) => {
    const terrain = islandTerrainPlugin({ width: terrainWidth, height: terrainHeight });
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const ecology = forestPlugin({ terrain, inventory }, pacing);
    const world = createWorld({ seed: 7, plugins: [terrain, inventory, ecology] });
    return { world, terrain, inventory, ecology };
};

/** Tree counts + mirrors only — the wood sums move with lazy growth. */
const treeSnapshot = (
    world: ReturnType<typeof createWorld>,
    ecology: ReturnType<typeof forestPlugin>,
): string =>
    world.canvas.cells
        .filter((cell) => cell.biome === 'forest')
        .map((cell) => `${cell.x},${cell.y}:${ecology.standOf({ x: cell.x, y: cell.y })?.trees ?? 'none'}#${cell.resources.tree ?? 0}`)
        .join('|');

/** Total standing wood across the island's woods. */
const woodTotal = (world: ReturnType<typeof createWorld>, ecology: ReturnType<typeof forestPlugin>): number =>
    world.canvas.cells
        .filter((cell) => cell.biome === 'forest')
        .reduce((sum, cell) => sum + (ecology.standOf({ x: cell.x, y: cell.y })?.wood ?? 0), 0);

describe('forestPlugin — the seeded stands (neighborhood density)', () => {
    it('seeds every forest tile at its NEIGHBORHOOD coverage: the reference wood (−7,0) clamps to a full 425', () => {
        const { world, ecology } = buildEcology(undefined, 25, 17);
        // The pinned rounding choice of the ISOLATED base (T2's densified
        // 60% — the 45% uniform seeding is retired):
        // Math.round(0.6 × 425) = 255 — the neighborhood model moves every
        // forested tile from there (8-forest rings clamp to 425, edge woods
        // land below, rocky edges lower still)
        expect(forestTreeCount(25, 17)).toBe(255);
        // The reference wood (−7,0): a deep interior ring of eight forest
        // neighbours clamps to the FULL coverage price — and the stand's
        // POOL refuses the tile's river-edge waterline spots (R1's EDGE
        // WEAVE: no tree stands on water), so the mirror clamps to 412
        // (captured wood 1631 across their pools)
        expect(ecology.standOf({ x: -7, y: 0 })).toEqual({ trees: 412, wood: 1631 });
        // The whole census: every one of the island's 59 woods seeds
        // exactly the neighborhood count its terrain model priced (the
        // deposit IS the stand's size — captured per tile)
        const forests = world.canvas.cells.filter((cell) => cell.biome === 'forest');
        expect(forests.length).toBe(59);
        forests.forEach((cell) => {
            expect(ecology.standOf(cell)?.trees).toBe(cell.resources.tree);
        });
        // The captured distribution at the 0.8 wetland cutoff under T2's
        // densified base (the RAW coverage prices — the mirror clamps the
        // water-short pools at seeding): 30 full 425 interiors, 2 woods at
        // 424 (a 1-spot boulder band), 6 × 404 edges, 5 × 383, 2 × 382, and
        // 1 isolated 361 wood — the water-seam clamps spread the rest over
        // 422…405 (the exact counts the islandTerrainNeighbors regression
        // pins model-side)
        expect(forests.filter((cell) => cell.resources.tree === 425).length).toBe(30);
        expect(forests.filter((cell) => cell.resources.tree === 424).length).toBe(2);
        expect(forests.filter((cell) => cell.resources.tree === 404).length).toBe(6);
        expect(forests.filter((cell) => cell.resources.tree === 383).length).toBe(5);
        expect(forests.filter((cell) => cell.resources.tree === 382).length).toBe(2);
        expect(forests.filter((cell) => cell.resources.tree === 361).length).toBe(1);
        // The mixed seeded ages read as standing wood immediately (the
        // seeded woods hold mature trees and saplings side by side)
        expect(ecology.standOf({ x: -7, y: 0 })?.wood).toBe(1631);
        // The INGRESS MEADOWS carry real persistent stands too — the
        // meadow (1,−2) beside the woods seeds its 11-spot seam meander
        // fringe (R1's EDGE WEAVE, 51 wood); the bare meadow (0,−3)
        // carries none
        expect(ecology.standOf({ x: 1, y: -2 })).toEqual({ trees: 11, wood: 51 });
        expect(ecology.standOf({ x: 0, y: -3 })).toBeUndefined();
    });

    it('seeds the 15×9 island\u2019s woods at their neighborhood counts (isolated base 81)', () => {
        const { world, ecology } = buildEcology(undefined, 15, 9);
        // T2's densified base: Math.round(0.60 × 135) = 81 (the 45% base's
        // 61 is retired); most of the 14 woods now clamp at the grid size
        expect(forestTreeCount(15, 9)).toBe(81);
        // The 15×9 island's woods (14 forests, no wetlands — the compact
        // multi-wood fixture the 0.8 tiny-board collapse retired 7×5 for):
        // (0,0) a wide forest ring → now the FULL 135 clamp (488 wood);
        // (−2,0) an edge wood → 95; (1,0) a full ring → 135 (captured stand
        // sums per tile)
        expect(ecology.standOf({ x: 0, y: 0 })).toEqual({ trees: 135, wood: 488 });
        expect(ecology.standOf({ x: -2, y: 0 })).toEqual({ trees: 95, wood: 353 });
        expect(ecology.standOf({ x: 1, y: 0 })).toEqual({ trees: 135, wood: 531 });
        // The mirrors moved with the stands
        expect(world.cellAt(0, 0)?.resources.tree).toBe(135);
        expect(world.cellAt(-2, 0)?.resources.tree).toBe(95);
        expect(world.cellAt(1, 0)?.resources.tree).toBe(135);
    });

    it('the zoom mirrors the stand exactly — 383 treed subtiles at persistent positions', () => {
        const { world, terrain, ecology, inventory } = buildEcology(undefined, 25, 17);
        const sub = terrain.canvasFor([{ x: 2, y: 0 }]);
        // (2,0) is a boulder-spilled wood: T2's densified 0.9 coverage →
        // 383 fine cells carry a tree; the 9-spot boulder band + the bare
        // remainder (42 fine cells) hold none
        expect(sub?.cells.filter((cell) => (cell.resources.tree ?? 0) === 1).length).toBe(383);
        expect(sub?.cells.filter((cell) => cell.resources.tree === undefined).length).toBe(42);
        // Every treed subtile carries ONE tree + the ground supply (the
        // zoom reveals the woods' interior without reshuffling anything);
        // R4: the ground supply is dirt/grass only — the (2,0) wood is no
        // longer a stone-bearing site (stone lives on the highland peaks)
        const treed = sub?.cells.find((cell) => (cell.resources.tree ?? 0) === 1);
        expect(treed?.resources).toEqual({ tree: 1, dirt: 1, grass: 1 });
        // PERSISTENCE — cut one wood off the stand (the harvest path) and
        // re-zoom: the cut tree STANDS (the tree at Ael's fine spot (10,−2)
        // holds 6 woods), so the stand's size and every treed position hold
        // — only the wood mirror moved
        const before = sub!.cells.map((cell) => cell.resources.tree ?? 0);
        const ael = world.spawn({
            id: 'a', name: 'Ael', kind: 'sentient', type: 'human',
            position: position3(2, 0), marker: 'A', condition: 'well',
            profile: { sex: 'male' },
        });
        // The chop cuts ONE wood — the tree stands
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(true);
        const after = terrain.canvasFor([{ x: 2, y: 0 }])!.cells.map((cell) => cell.resources.tree ?? 0);
        expect(after.filter((count) => count === 1).length).toBe(383);
        after.forEach((count, index) => {
            expect(count).toBe(before[index]);
        });
        // Read-only caches: re-zooming serves the SAME cached grid and the
        // stands are untouched by any zoom (the mirror held — the deposit
        // didn't move, so the fingerprint still matches the cached grid)
        expect(terrain.canvasFor([{ x: 2, y: 0 }])).toBe(terrain.canvasFor([{ x: 2, y: 0 }]));
        // T2's densified 383-tree stand with its mixed seeded ages (the
        // captured wood sum)
        expect(ecology.standOf({ x: 2, y: 0 })).toEqual({ trees: 383, wood: 1458 });
    });
});

describe('forestPlugin — the chop (wood off the pool)', () => {
    it('cuts ONE wood off the exact fine spot\u2019s tree, folding its growth first', () => {
        const { terrain, ecology, world, inventory } = buildEcology(undefined, 15, 9);
        const stand = terrain.forestOf(-1, 0)!;
        // T2's densified 15×9 stand now TREES the old (0,−3) bare spot —
        // the first row-major bare fine cell moved to (−3,−4)
        const bare = { x: -3, y: -4 };
        expect(stand.trees.has('-3,-4')).toBe(false);
        // A planted pool-5 tree (born −100 — past the virgin marker)
        terrain.forestPlant(-1, 0, bare, { born: -100, base: 5, baseMinute: -100, carry: 0 });
        const size = stand.trees.size;
        expect(ecology.chop({ x: -1, y: 0 }, bare)).toEqual({ felled: false, taken: 1 });
        // The tree STANDS: one wood off the pool, the record alive
        const record = stand.trees.get('-3,-4')!;
        expect(record.base).toBe(4);
        expect(stand.trees.size).toBe(size);
        // Three more chops leave ONE wood standing; the fifth fells it
        ecology.chop({ x: -1, y: 0 }, bare);
        ecology.chop({ x: -1, y: 0 }, bare);
        ecology.chop({ x: -1, y: 0 }, bare);
        expect(stand.trees.get('-3,-4')?.base).toBe(1);
        expect(ecology.chop({ x: -1, y: 0 }, bare)).toEqual({ felled: true, taken: 1 });
        // FELLED COMPLETE — the record leaves the stand and the mirrors
        // drop with it (deposit + gatherable stock read the stand size)
        expect(stand.trees.has('-3,-4')).toBe(false);
        expect(stand.trees.size).toBe(size - 1);
        expect(world.cellAt(-1, 0)?.resources.tree).toBe(size - 1);
        expect(inventory.cellStock(-1, 0).tree).toBe(size - 1);
    });

    it('R2 — a multiunit chop cuts UP TO `units` off ONE tree and pays exactly what stood', () => {
        const { terrain, ecology } = buildEcology(undefined, 15, 9);
        const stand = terrain.forestOf(-1, 0)!;
        const bare = { x: -3, y: -4 };
        // A planted pool-5 tree — a 3-unit chop takes 3 and the tree STANDS
        terrain.forestPlant(-1, 0, bare, { born: -100, base: 5, baseMinute: -100, carry: 0 });
        expect(ecology.chop({ x: -1, y: 0 }, bare, 3)).toEqual({ felled: false, taken: 3 });
        expect(stand.trees.get('-3,-4')?.base).toBe(2);
        // CONSERVATION — a 3-unit chop on the pool-2 stump pays only 2 and
        // fells it (never prints a third log out of thin air)
        expect(ecology.chop({ x: -1, y: 0 }, bare, 3)).toEqual({ felled: true, taken: 2 });
        expect(stand.trees.has('-3,-4')).toBe(false);
        // A pool-1 sapling chopped for 3 pays 1 and dies
        const spot = { x: -3, y: -3 };
        terrain.forestPlant(-1, 0, spot, { born: -100, base: 1, baseMinute: -100, carry: 0 });
        expect(ecology.chop({ x: -1, y: 0 }, spot, 3)).toEqual({ felled: true, taken: 1 });
    });

    it('a bare fine cell cuts the deterministic nearest tree inside the same tile', () => {
        const { terrain, ecology } = buildEcology(undefined, 15, 9);
        const stand = terrain.forestOf(-1, 0)!;
        // Chopping the bare tile heart falls back to the deterministic
        // NEAREST tree in the stand (its pool) — the tree STANDS at a
        // healthy pool, so the stand's size is intact (T2's densified 15×9
        // stand: 122 trees, up from 101)
        expect(ecology.chop({ x: -1, y: 0 })).toEqual({ felled: false, taken: 1 });
        expect(stand.trees.size).toBe(122);
        // A tree-less tile declines the chop entirely (the (−7,4) corner is
        // bare ground on the 15×9 island)
        expect(terrain.forestOf(-7, 4)).toBeUndefined();
        expect(ecology.chop({ x: -7, y: 4 })).toBeNull();
        // A treed membership of this stand held through the cut
        expect(stand.trees.has('1,0')).toBe(true);
    });

    it('an empty stand (clearcut) declines the chop', () => {
        const { terrain, ecology } = buildEcology(undefined, 15, 9);
        const stand = terrain.forestOf(0, 1)!;
        while (stand.trees.size > 0) {
            ecology.chop({ x: 0, y: 1 });
        }
        expect(terrain.forestOf(0, 1)).toBeDefined();
        expect(ecology.chop({ x: 0, y: 1 })).toBeNull();
        // The mirror is gone with the stand — the tile re-skinned bare
        expect(ecology.standOf({ x: 0, y: 1 })).toEqual({ trees: 0, wood: 0 });
    });
});

describe('forestPlugin — the wood growth (lazy, deterministic)', () => {
    it('a sapling grows wood toward the cap: new tree 1 wood, old tree more', () => {
        // Accelerated maturity: 100 world minutes to the full pool of 5
        const { terrain, ecology } = buildEcology({ maturityMinutes: 100, woodCap: 5 }, 15, 9);
        const stand = terrain.forestOf(-1, 0)!;
        // T2's densified 15×9 stand treed the old (−1,−2) bare spot —
        // (0,0) is a bare fine cell of the (−1,0) stand (captured)
        const bare = { x: 0, y: 0 };
        const sapling = { born: 0, base: 1, baseMinute: 0, carry: 0 };
        terrain.forestPlant(-1, 0, bare, sapling);
        expect(ecology.poolOf(sapling)).toBe(1);
        // Minute 50: half grown — 1 + floor(50 × 4 / 100) = 3
        ecology.fastForward(50);
        expect(ecology.poolOf(sapling)).toBe(3);
        // Minute 100: the full pool — 5
        ecology.fastForward(50);
        expect(ecology.poolOf(sapling)).toBe(5);
        expect(ecology.matureOf(sapling)).toBe(true);
        // The age reads the ecology clock (deterministic minutes)
        expect(ecology.ageOf(sapling)).toBe(100);
    });

    it('a mature PARTIALLY harvested tree regrows — never dead-ended at cap-minus-harvest', () => {
        const { terrain, ecology } = buildEcology({ maturityMinutes: 100, woodCap: 5 }, 15, 9);
        const stand = terrain.forestOf(-1, 0)!;
        // T2's densified 15×9 stand treed the old (−1,−2) bare spot —
        // (0,0) is a bare fine cell of the (−1,0) stand (captured)
        const bare = { x: 0, y: 0 };
        const mature = { born: -1000, base: 5, baseMinute: -1000, carry: 0 };
        terrain.forestPlant(-1, 0, bare, mature);
        expect(ecology.poolOf(mature)).toBe(5);
        // Chop the mature tree down to 2 wood standing (three cuts)
        ecology.chop({ x: -1, y: 0 }, bare);
        ecology.chop({ x: -1, y: 0 }, bare);
        ecology.chop({ x: -1, y: 0 }, bare);
        expect(mature.base).toBe(2);
        // The regrowth: the baseline fold re-arms the growth — 50 minutes
        // later the pool is back at the cap (2 + floor(50 × 4 / 100) = 4 →
        // the NEXT fold caps at 5; the lazy read already shows 4)
        ecology.fastForward(50);
        expect(ecology.poolOf(mature)).toBe(4);
        ecology.fastForward(50);
        expect(ecology.poolOf(mature)).toBe(5);
        // …and the tree is still alive — wood can be cut again
        expect(ecology.chop({ x: -1, y: 0 }, bare)).toEqual({ felled: false, taken: 1 });
    });

    it('a felled tree\u2019s record is removed; growth never resurrects it', () => {
        const { terrain, ecology } = buildEcology({ maturityMinutes: 100, woodCap: 5 }, 15, 9);
        const stand = terrain.forestOf(-1, 0)!;
        // T2's densified 15×9 stand treed the old (−1,−2) bare spot —
        // (0,0) is a bare fine cell of the (−1,0) stand (captured)
        const bare = { x: 0, y: 0 };
        const sapling = { born: 0, base: 1, baseMinute: 0, carry: 0 };
        terrain.forestPlant(-1, 0, bare, sapling);
        // The sapling's whole pool is one wood — the first chop fells it
        expect(ecology.chop({ x: -1, y: 0 }, bare)).toEqual({ felled: true, taken: 1 });
        expect(stand.trees.has('0,0')).toBe(false);
        // Growth works on the ecology clock — a year later the spot stays
        // bare (only recruitment replants a felled spot)
        ecology.fastForward(500);
        expect(stand.trees.has('0,0')).toBe(false);
    });
});

describe('forestPlugin — recruitment (the seed bank)', () => {
    it('a forest voxel recruits even clearcut, into a free fine cell', () => {
        const { world, terrain, ecology, inventory } = buildEcology({ recruitMinutes: 10 }, 15, 9);
        const stand = terrain.forestOf(0, 1)!;
        // Clearcut the whole stand (the chop fells tree after tree)
        while (stand.trees.size > 0) {
            ecology.chop({ x: 0, y: 1 });
        }
        expect(world.cellAt(0, 1)?.resources.tree).toBeUndefined();
        expect(inventory.cellStock(0, 1).tree).toBeUndefined();
        // The tile is STILL forest (the voxel stands) — the seed bank
        // recruits: ten minutes later one sapling stands again
        ecology.fastForward(10);
        expect(stand.trees.size).toBe(1);
        // The mirrors came back with the sapling (coherent render/inventory)
        expect(world.cellAt(0, 1)?.resources.tree).toBe(1);
        expect(inventory.cellStock(0, 1).tree).toBe(1);
        // The recruited tree is a sapling: wood 1, born at the due minute
        const [key, record] = Array.from(stand.trees.entries())[0];
        expect(record.base).toBe(1);
        expect(record.born).toBeGreaterThan(0);
        expect(ecology.ageOf(record)).toBeLessThanOrEqual(10);
        expect(key).not.toBe('');
    });

    it('a non-forest tile never recruits — the grass/sand/stone/water substrates stay bare', () => {
        const { world, terrain, ecology } = buildEcology({ recruitMinutes: 10 }, 25, 17);
        // The bare meadow (0,−3) on the 0.8 island: grass substrate, no stand
        expect(terrain.forestOf(0, -3)).toBeUndefined();
        ecology.fastForward(100);
        expect(terrain.forestOf(0, -3)).toBeUndefined();
        expect(world.cellAt(0, -3)?.resources.tree).toBeUndefined();
        // A beach tile: sand substrate — never a stand
        expect(terrain.forestOf(-4, -7)).toBeUndefined();
        expect(world.cellAt(-4, -7)?.resources.tree).toBeUndefined();
    });

    it('recruitment fills toward the FULL stand (the 100% uncut cap over the years)', () => {
        const { terrain, ecology } = buildEcology({ recruitMinutes: 10 }, 15, 9);
        const stand = terrain.forestOf(0, 1)!;
        // Clearcut, then let ten recruitment cycles run — each cycle adds
        // ONE sapling (bounded, deterministic)
        while (stand.trees.size > 0) {
            ecology.chop({ x: 0, y: 1 });
        }
        ecology.fastForward(100);
        expect(stand.trees.size).toBe(10);
    });

    it('recruitment fills the LAST percent: the bounded fallback lands the final bare spot', () => {
        const { world, terrain, ecology } = buildEcology(
            { recruitMinutes: 10, spreadMinutes: 1000000000 },
            25,
            17,
        );
        // (2,0) is a boulder-spilled wood: the west highland column carves a
        // 6-spot wavy band (R1's seam meander), so its capacity is the
        // boulder-penalty cap 419 (425 − 6), NOT the full 425
        const stand = terrain.forestOf(2, 0)!;
        // T2's densified 0.9-coverage stand: 383 trees (up from 319), leaving
        // 42 bare fine cells (425 − 383)
        expect(stand.trees.size).toBe(383);
        // Fill all but ONE of the 42 bare fine cells (row-major probe)
        const bare: Array<{ x: number; y: number }> = [];
        for (let row = 0; row < 17 && bare.length < 42; row++) {
            for (let col = 0; col < 25; col++) {
                const spot = { x: col - 12, y: row - 8 };
                if (!stand.trees.has(`${spot.x},${spot.y}`)) {
                    bare.push(spot);
                }
            }
        }
        expect(bare.length).toBe(42);
        bare.slice(0, 41).forEach((spot) => {
            terrain.forestPlant(2, 0, spot, { born: 1, base: 1, baseMinute: 1, carry: 0 });
        });
        // One recruit cycle: the random probe OR the bounded row-major
        // fallback lands saplings — the stand trims back to the boulder cap
        // of 419, with the LAST bare non-rock spot standing
        ecology.fastForward(10);
        expect(stand.trees.size).toBe(419);
        expect(stand.trees.has('12,8')).toBe(true);
        // The mirrors read the capped stand (the rock penalty already priced
        // the band out — the deposit IS the stand)
        expect(world.cellAt(2, 0)?.resources.tree).toBe(419);
        expect(ecology.standOf({ x: 2, y: 0 })).toEqual({ trees: 419, wood: 1495 });
    });

    // ── THE BOULDER BOUNDARY (the T5 fix's regression pins) ────────────────
    // A rock-spilled forest tile's band (plugins/terrain islandTerrain.ts
    // rockSpillSpots, stamped into cell.carving.rock) holds boulders: the
    // recruitment capacity prices the band out (w·h − rocks.size), the
    // random probe AND the bounded fallback both exclude the band's keys,
    // and the terrain plugin's forestPlant refuses a carved spot outright —
    // so no tree EVER stands on a boulder, however long the world runs.
    // The reference tile is the seed-7 island's (2,0): the west highland
    // column carves a 6-spot wavy seam band ('−12,−3' … '−12,2'),
    // capacity 425 − 6 = 419.

    it('recruitment never stands a tree on a boulder: the band stays treeless to the neighborhood cap', () => {
        const { world, terrain, ecology } = buildEcology(
            { recruitMinutes: 10, spreadMinutes: 1000000000 },
            25,
            17,
        );
        const band = world.cellAt(2, 0)!.carving!.rock;
        expect(band.length).toBe(6);
        const stand = terrain.forestOf(2, 0)!;
        // T2's densified 383-tree stand (the seeded size is irrelevant to
        // the boundary — the clearcut below starts the refill from zero)
        expect(stand.trees.size).toBe(383);
        // Clearcut the whole stand — the mirrors drop with it (the boulders
        // stay; the forest voxel keeps its seed-bank recruitment alive)
        while (stand.trees.size > 0) {
            ecology.chop({ x: 2, y: 0 });
        }
        expect(stand.trees.size).toBe(0);
        expect(world.cellAt(2, 0)?.resources.tree).toBeUndefined();
        // One recruit cycle: ONE sapling stands, and it is OFF the band —
        // the captured probe pick (deterministic stream, rock spots excluded
        // from every roll)
        ecology.fastForward(10);
        expect(stand.trees.size).toBe(1);
        expect(Array.from(stand.trees.keys())).toEqual(['-12,4']);
        // Full refill: 419 recruitment cycles (every 10 minutes) land the
        // stand exactly at its neighborhood cap — every fine cell BUT the
        // band — with not one tree on a boulder
        ecology.fastForward(4180);
        const onRock = band.filter((spot) => stand.trees.has(spot));
        expect(onRock).toEqual([]);
        expect(stand.trees.size).toBe(419);
        // The mirror reads the capped stand (the rock penalty already priced
        // the band out — the deposit IS the stand)
        expect(world.cellAt(2, 0)?.resources.tree).toBe(419);
        // The cap HOLDS: further cycles add nothing (419 = 425 − 6 — the
        // capacity gate, not a probe miss)
        ecology.fastForward(100);
        expect(stand.trees.size).toBe(419);
        expect(band.filter((spot) => stand.trees.has(spot))).toEqual([]);
        // The zoomed interior agrees: 419 treed subtiles, the 6 boulders
        // crowned and treeless — the invariant holds at every scale
        const sub = terrain.canvasFor([{ x: 2, y: 0 }])!;
        const treed = sub.cells.filter((cell) => (cell.resources.tree ?? 0) > 0);
        expect(treed.length).toBe(419);
        const bouldered = sub.cells.filter(
            (cell) =>
                cell.voxels.length === (world.cellAt(2, 0)?.voxels.length ?? 0) + 1 &&
                cell.voxels[cell.voxels.length - 1] === 'gravel',
        );
        expect(bouldered.length).toBe(6);
        expect(bouldered.filter((cell) => (cell.resources.tree ?? 0) > 0)).toEqual([]);
    });

    it('the bounded fallback lands the last non-rock spot: a near-full stand fills to its cap off the band', () => {
        const { world, terrain, ecology } = buildEcology(
            { recruitMinutes: 10, spreadMinutes: 1000000000 },
            25,
            17,
        );
        const band = world.cellAt(2, 0)!.carving!.rock;
        const stand = terrain.forestOf(2, 0)!;
        // Clearcut, then plant every non-rock fine cell except the LAST one
        // in row-major order ('12,8' — 415 plants, one bare spot among the
        // 425-cell board): the near-full shape that can evade the random
        // probe's per-cycle hit rate
        while (stand.trees.size > 0) {
            ecology.chop({ x: 2, y: 0 });
        }
        const nonRock: Array<{ x: number; y: number }> = [];
        for (let row = 0; row < 17; row++) {
            for (let col = 0; col < 25; col++) {
                const spot = { x: col - 12, y: row - 8 };
                if (!band.includes(`${spot.x},${spot.y}`)) {
                    nonRock.push(spot);
                }
            }
        }
        expect(nonRock.length).toBe(419);
        nonRock.slice(0, 418).forEach((spot) => {
            terrain.forestPlant(2, 0, spot, { born: 1, base: 1, baseMinute: 1, carry: 0 });
        });
        expect(stand.trees.size).toBe(418);
        // One recruit cycle: exactly ONE sapling lands at the only bare
        // non-rock spot (the probe's 1/425 rolls OR the bounded row-major
        // fallback — either path fills THE spot), and the band gains
        // nothing
        ecology.fastForward(10);
        expect(stand.trees.size).toBe(419);
        expect(stand.trees.has('12,8')).toBe(true);
        expect(band.filter((spot) => stand.trees.has(spot))).toEqual([]);
        // The mirrors read the capped stand
        expect(world.cellAt(2, 0)?.resources.tree).toBe(419);
    });
});

describe('forestPlugin — the spread (grass substrate only)', () => {
    it('mature woods convert adjacent MEADOW tiles; sand/stone/water never convert', () => {
        const { world, terrain, ecology, inventory } = buildEcology(
            { maturityMinutes: 1, spreadMinutes: 10 },
            25,
            17,
        );
        // Every tree matures instantly (maturity 1 minute); the first
        // spread slot of each forest tile falls within the first 10 minutes
        const meadowSet = world.canvas.cells
            .filter((cell) => cell.biome === 'meadow')
            .map((cell) => `${cell.x},${cell.y}`);
        // R4-INTEGRATION — the river generation carved five of the old 63
        // meadows into water (the ford at (−1,−2) sits where a converting
        // wood once stood): the meadow census is 58 and the spread can
        // never claim a river cell (water substrate — the rule this test
        // already enforces for sand/stone/water)
        expect(meadowSet.length).toBe(58);
        ecology.fastForward(10);
        // Captured conversions: 34 meadow tiles turned into woods — each
        // carries the forest voxel, the forest biome, and a stand of
        // INGRESS + ONE sapling (the ingressed meadows already held their
        // localized edge fringe — the spread's sapling JOINS that stand;
        // the bare meadows seed a one-sapling stand). R1's EDGE WEAVE
        // prices the fringe off the shared forest seam's meander
        const converted = world.canvas.cells.filter(
            (cell) =>
                cell.biome === 'forest' &&
                meadowSet.includes(`${cell.x},${cell.y}`),
        );
        expect(converted.map((cell) => `${cell.x},${cell.y}:${cell.resources.tree}`)).toEqual([
            '-7,-3:1', '-6,-3:1', '-5,-3:1', '-2,-3:8', '1,-3:15', '-7,-2:17', '-6,-2:1', '-5,-2:1',
            '0,-2:1', '1,-2:12', '-6,-1:7', '-5,-1:10', '-4,-1:22', '-2,-1:25',
            '1,-1:13', '-3,0:29', '-3,1:7', '-2,1:1', '6,1:29', '7,1:29', '-4,2:10', '-3,2:4',
            '1,2:7', '-5,3:1', '-4,3:1', '0,3:9', '1,3:4', '2,3:18', '3,3:30', '-1,4:23',
            '1,4:30', '2,4:1', '3,4:8', '3,5:1',
        ]);
        // The meadow census dropped to 24 (58 before, 34 converted — the
        // river-era capture; the re-skin fringe the old 63-meadow board
        // showed does not fire on this generation)
        expect(world.canvas.cells.filter((cell) => cell.biome === 'meadow').length).toBe(24);
        // A WOOD's sand neighbour never converts: (−8,1) is the beach west
        // of the (−7,1) wood — the spread never touches sand (or stone or
        // water), regardless of the soil underlayer
        expect(world.cellAt(-8, 1)?.biome).toBe('beach');
        expect(terrain.forestOf(-8, 1)).toBeUndefined();
        // The converted tile's inventory is coherent: the fringe-plus-sapling
        // stock mirror stands (the meadow's berries persist beside it)
        const first = converted[0];
        expect(inventory.cellStock(first.x, first.y).tree).toBe(1);
        // The converted wood's zoom paints the joined stand over the grass
        const sub = terrain.canvasFor([{ x: first.x, y: first.y }]);
        expect(sub?.cells.filter((cell) => (cell.resources.tree ?? 0) === 1).length).toBe(1);
    });
});

describe('forestPlugin — independent ticking and invalid config', () => {
    it('the staggered first slots: a tile whose slot lands inside the horizon recruits once', () => {
        const { world, ecology } = buildEcology(undefined, 25, 17);
        const treesBefore = treeSnapshot(world, ecology);
        const woodBefore = woodTotal(world, ecology);
        // Two thousand world minutes at the REAL pace: the recruit rhythm
        // runs in years, but each tile's staggered slot (offset < the
        // rhythm) is its FIRST due minute — the captured run has exactly
        // one tile whose slot lands inside the horizon: (4,−5) (the T2
        // 383-edge) recruits once; every other wood keeps its neighborhood
        // count
        ecology.fastForward(2000);
        expect(treeSnapshot(world, ecology)).toBe(treesBefore.replace('4,-5:383#383', '4,-5:384#384'));
        // The wood moved by the captured crossings: the recruit's 1 sapling
        // wood plus the lazy floor boundaries the seeded ages crossed (the
        // densified stands cross different age boundaries now)
        expect(woodTotal(world, ecology)).toBe(woodBefore + 87);
    });

    it('two full years of default ecology recruit each wood whose slot lands in that year', () => {
        const { world, ecology } = buildEcology(undefined, 15, 9);
        // One year = 525,600 minutes: the 2-year recruitment rhythm fires
        // for the tiles whose staggered slot lands inside the year. The
        // 15×9 layout staggers 5 of the 14 woods into year one and the
        // remaining slots into year two (the 3-year spread rhythm fires
        // nowhere — no meadows on the 15×9 island); T2's densified counts
        // re-capture the whole board
        const treesBefore = treeSnapshot(world, ecology);
        expect(treesBefore).toBe(
            '0,-1:121#121|1,-1:135#135|2,-1:135#135|3,-1:128#128|4,-1:101#101|-2,0:95#95|' +
            '-1,0:122#122|0,0:135#135|1,0:135#135|2,0:135#135|3,0:128#128|0,1:121#121|1,1:135#135|2,1:121#121',
        );
        ecology.fastForward(525600);
        const yearOne = treeSnapshot(world, ecology);
        // Year one: 5 saplings stand (3,−1 / −2,0 / −1,0 / 3,0 / 0,1 each +1)
        expect(yearOne).toBe(
            '0,-1:121#121|1,-1:135#135|2,-1:135#135|3,-1:129#129|4,-1:101#101|-2,0:96#96|' +
            '-1,0:123#123|0,0:135#135|1,0:135#135|2,0:135#135|3,0:129#129|0,1:122#122|1,1:135#135|2,1:121#121',
        );
        // The SECOND year recruits the remaining staggered slots (0,−1 /
        // 4,−1 / 2,1 each +1) — the 2-yearly rhythm straddles both years
        // for this layout; the mirrors move with the stands
        ecology.fastForward(525600);
        world.canvas.cells
            .filter((cell) => cell.biome === 'forest')
            .forEach((cell) => {
                expect(ecology.standOf(cell)?.trees).toBe(cell.resources.tree);
            });
        expect(treeSnapshot(world, ecology)).toBe(
            '0,-1:122#122|1,-1:135#135|2,-1:135#135|3,-1:129#129|4,-1:102#102|-2,0:96#96|' +
            '-1,0:123#123|0,0:135#135|1,0:135#135|2,0:135#135|3,0:129#129|0,1:122#122|1,1:135#135|2,1:122#122',
        );
    });

    it('zero and invalid configuration falls back to the documented defaults', () => {
        const { ecology } = buildEcology({
            growthRateMultiplier: 0,
            maturityYears: -5,
            recruitMinutes: 0,
            spreadMinutes: Number.NaN,
            woodCap: -3,
        });
        // Every invalid value fell back: the REAL pace (multiplier 1) with
        // the research-backed year defaults; the cap clamps at 2 minimum
        expect(ecology.pacing()).toEqual({
            maturityMinutes: 4204800,
            recruitMinutes: 1051200,
            spreadMinutes: 1576800,
            woodCap: 8,
        });
        // Invalid fast-forward spans are no-ops (never NaN the clock)
        ecology.fastForward(-5);
        ecology.fastForward(Number.NaN);
        const { terrain } = buildEcology(undefined, 15, 9);
        const record = Array.from(terrain.forestOf(0, 0)!.trees.values())[0];
        expect(Number.isFinite(ecology.poolOf(record))).toBe(true);
        expect(Number.isFinite(ecology.ageOf(record))).toBe(true);
    });

    it('invalid YEAR overrides retain their biological defaults (the review fix)', () => {
        // 0 / negative / NaN / Infinity YEARS used to collapse their rhythm
        // to a 1-minute pulse (finitePositive → 0 → Math.max(1, 0)); each
        // year field now validates against ITS OWN documented constant
        const zeroed = buildEcology({ recruitYears: 0, spreadYears: 0 });
        expect(zeroed.ecology.pacing()).toEqual({
            maturityMinutes: 4204800,
            recruitMinutes: 1051200,
            spreadMinutes: 1576800,
            woodCap: 8,
        });
        const broken = buildEcology({
            maturityYears: Number.NaN,
            recruitYears: -7,
            spreadYears: Number.POSITIVE_INFINITY,
        });
        expect(broken.ecology.pacing()).toEqual({
            maturityMinutes: 4204800,
            recruitMinutes: 1051200,
            spreadMinutes: 1576800,
            woodCap: 8,
        });
    });

    it('valid overrides keep their precedence — minutes over years, years over defaults', () => {
        // Direct minutes win over years; valid years win over the constants
        const tuned = buildEcology({ recruitYears: 5, spreadMinutes: 100 });
        expect(tuned.ecology.pacing()).toEqual({
            maturityMinutes: 4204800,
            recruitMinutes: 2628000,
            spreadMinutes: 100,
            woodCap: 8,
        });
        // A valid year override next to an invalid one: each field resolves
        // independently
        const mixed = buildEcology({ recruitYears: 1, spreadYears: Number.NaN });
        expect(mixed.ecology.pacing()).toEqual({
            maturityMinutes: 4204800,
            recruitMinutes: 525600,
            spreadMinutes: 1576800,
            woodCap: 8,
        });
    });

    it('the multiplier speeds the BIOLOGY only — the clock keeps its own pace', () => {
        // 1000× biology: a stand matures in ~70 world hours; the wood pools
        // climb on the SAME world-minute clock the rest of the world runs
        const { terrain, ecology } = buildEcology({ growthRateMultiplier: 1000, woodCap: 5 });
        expect(ecology.pacing()).toEqual({
            maturityMinutes: 4205,
            recruitMinutes: 1051,
            spreadMinutes: 1577,
            woodCap: 5,
        });
        const stand = terrain.forestOf(-1, 0)!;
        // T2's densified 15×9 stand treed the old (−1,−2) bare spot —
        // (0,0) is a bare fine cell of the (−1,0) stand (captured)
        const bare = { x: 0, y: 0 };
        const sapling = { born: 0, base: 1, baseMinute: 0, carry: 0 };
        terrain.forestPlant(-1, 0, bare, sapling);
        // Minute 1000: 1 + floor(1000 × 4 / 4205) = 1 — the pool grows
        // gradually, every step exact integer math
        ecology.fastForward(1000);
        expect(ecology.poolOf(sapling)).toBe(1);
        ecology.fastForward(4205 - 1000);
        expect(ecology.poolOf(sapling)).toBe(5);
    });

    it('fastForward replays exactly what per-minute stepping would apply', () => {
        const pacing: ForestPacingOptions = {
            maturityMinutes: 1,
            recruitMinutes: 10,
            spreadMinutes: 20,
        };
        const stepped = buildEcology(pacing, 25, 17);
        const forwarded = buildEcology(pacing, 25, 17);
        for (let index = 0; index < 55; index++) {
            stepped.world.step();
        }
        forwarded.ecology.fastForward(55);
        // The same stands, mirrors and wood — the compact replay applies
        // the exact due schedule minutes with the same seeded streams
        expect(treeSnapshot(forwarded.world, forwarded.ecology)).toBe(
            treeSnapshot(stepped.world, stepped.ecology),
        );
        expect(woodTotal(forwarded.world, forwarded.ecology)).toBe(
            woodTotal(stepped.world, stepped.ecology),
        );
        // …down to the converted tiles' biome map
        expect(
            forwarded.world.canvas.cells.map((cell) => cell.biome).join(''),
        ).toBe(stepped.world.canvas.cells.map((cell) => cell.biome).join(''));
    });
});

describe('forestPlugin — the harvest integration (inventory flow)', () => {
    /** The full wiring with entity profiles — the capacity gate lives.
     *  The 15×9 island (14 forests, no wetlands) hosts the multi-wood
     *  harvest flows the 0.8 tiny-board collapse retired 7×5 for. */
    const buildWired = (pacing: ForestPacingOptions = {}) => {
        const terrain = islandTerrainPlugin({ width: 15, height: 9 });
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ rainChancePerMinute: 0, profiles });
        const ecology = forestPlugin({ terrain, inventory }, pacing);
        const world = createWorld({ seed: 7, plugins: [terrain, profiles, inventory, ecology] });
        return { world, terrain, inventory, ecology, profiles };
    };

    const actor = (id: string, name: string, x: number, y: number): Actor => ({
        id,
        name,
        kind: 'sentient',
        type: 'human',
        position: position3(x, y),
        marker: name.slice(0, 1),
        condition: 'well',
        profile: { sex: 'male' },
    });

    it('harvest takes one wood atomically: capacity first, then the pool, then the bag', () => {
        const { world, inventory, ecology } = buildWired();
        const ael = world.spawn(actor('a', 'Ael', 0, 0));
        // Ael's fine spot (4,4) holds a mature pool-7 tree (captured card)
        // — the first chop cuts ITS pool and the tree STANDS
        const fine = world.subOf('a')!;
        expect(fine).toEqual({ x: 4, y: 4 });
        expect(ecology.treeAt({ x: 0, y: 0 }, fine)).toEqual({
            wood: 7,
            ageMinutes: 3952446,
            mature: false,
        });
        const before = ecology.standOf({ x: 0, y: 0 })!;
        // T2's densified 15×9 base: (0,0) now clamps at the FULL 135 (up
        // from 128) with its mixed seeded ages
        expect(before).toEqual({ trees: 135, wood: 488 });
        // THE CAPACITY GATE — a full bag never fells (the pool untouched).
        // R5 — five 40-weight stones fill the 200-weight budget exactly.
        inventory.spawnKit('a', { stone: 5 });
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(ecology.standOf({ x: 0, y: 0 })).toEqual(before);
        expect(inventory.of('a')).toEqual({ stone: 5 });
        // One stone of room freed (160 carried): the chop moves exactly ONE
        // wood (20) — the tree stands
        inventory.consume(ael, 'stone');
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(inventory.of('a')).toEqual({ stone: 4, wood: 1 });
        expect(ecology.standOf({ x: 0, y: 0 })).toEqual({ trees: 135, wood: 487 });
        // The gatherable stock mirrors the stand exactly (no ghosts)
        expect(inventory.cellStock(0, 0).tree).toBe(135);
    });

    it('R5 — a PARTIAL-capacity chop pays only the logs that fit and conserves the tree', () => {
        const { world, inventory, ecology } = buildWired();
        const ael = world.spawn(actor('a', 'Ael', 0, 0));
        // The fine (4,4) tree holds a pool of 7. Four stones (160) + one berry
        // (5) = 165 carried: the 35-weight room fits exactly ONE 20-weight log,
        // so a 3-wood request clamps to 1 — the tree keeps the rest standing.
        inventory.spawnKit('a', { stone: 4, berry: 1 });
        expect(inventoryWeight(inventory.of('a'))).toBe(165);
        const before = ecology.standOf({ x: 0, y: 0 })!;
        expect(before).toEqual({ trees: 135, wood: 488 });
        expect(inventory.harvest(ael, 'tree', 'wood', 3)).toBe(true);
        // Exactly ONE log entered the bag (not three) — the bag nets 185
        expect(inventory.of('a')).toEqual({ stone: 4, berry: 1, wood: 1 });
        expect(inventoryWeight(inventory.of('a'))).toBe(185);
        // Conservation: the stand paid for exactly what was cut (488 → 487)
        // and the pool-7 tree STANDS (no over-fell, no phantom wood)
        expect(ecology.standOf({ x: 0, y: 0 })).toEqual({ trees: 135, wood: 487 });
        expect(inventory.cellStock(0, 0).tree).toBe(135);
    });

    it('detaching seals the biological woods — the legacy whole-tree path cannot farm them', () => {
        // THE CONSERVATION BOUNDARY: a living tree harvests ONLY through
        // its owner. With the forest provider unmounted, the inventory
        // refuses whole-tree harvests on stand-bearing terrain BEFORE any
        // mutation — the legacy cut would draw the mirrors down without
        // reaching the records, and a remount would restore the count:
        // the same wood reharvestable forever. No drift is created, so
        // the remount's reconciliation has nothing to heal.
        const { world, terrain, inventory, ecology } = buildWired();
        const ael = world.spawn(actor('a', 'Ael', 0, 0));
        const before = ecology.standOf({ x: 0, y: 0 })!;
        world.plugins.remove('forest');
        // The provider is gone — the cut is REFUSED (the biological woods
        // are uncuttable without their owner; nothing mutates)
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(inventory.of('a')).toEqual({});
        expect(ecology.standOf({ x: 0, y: 0 })).toEqual(before);
        expect(inventory.cellStock(0, 0).tree).toBe(before.trees);
        expect(world.cellAt(0, 0)?.resources.tree).toBe(before.trees);
        void terrain;
    });

    it('detach leaves the biological woods UNCUTTABLE — no legacy cut, no remount farm', () => {
        // THE CONSERVATION BOUNDARY: a living tree harvests ONLY through
        // its owner. With the forest provider unmounted, the inventory
        // refuses whole-tree harvests on stand-bearing terrain BEFORE any
        // mutation — the legacy cut would draw the mirrors down without
        // reaching the records, and a remount would restore the count:
        // the same wood reharvestable forever. No drift is created, so
        // the remount's reconciliation has nothing to heal.
        const { world, terrain, inventory, ecology } = buildWired({
            recruitMinutes: 10,
            spreadMinutes: 1000000000,
        });
        const ael = world.spawn(actor('a', 'Ael', 0, 0));
        // A clock-sensitive recruited sapling joins the stand — T2's
        // densified base fills (0,0) to the FULL 135 cap, so the recruit
        // slot has no room (the stand stands at 135 with no added sapling)
        ecology.fastForward(10);
        const before = ecology.standOf({ x: 0, y: 0 })!;
        expect(before).toEqual({ trees: 135, wood: 488 }); // 135 seeded, full cap
        expect(inventory.cellStock(0, 0).tree).toBe(135);
        // DETACH — the provider unmounts, the boundary stands guard
        world.plugins.remove('forest');
        // The cut is REFUSED — the persistent tree keeps its pool (the
        // original wood total stands) and the bag gains nothing
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(inventory.of('a')).toEqual({});
        expect(ecology.standOf({ x: 0, y: 0 })).toEqual(before);
        expect(inventory.cellStock(0, 0).tree).toBe(135);
        expect(world.cellAt(0, 0)?.resources.tree).toBe(135);
        // REMOUNT — the setup sweep re-aligns (nothing drifted — the
        // mirrors already read the stand), the clock stays monotonic
        world.plugins.add(ecology);
        expect(ecology.standOf({ x: 0, y: 0 })).toEqual(before);
        expect(inventory.cellStock(0, 0).tree).toBe(135);
        expect(world.cellAt(0, 0)?.resources.tree).toBe(135);
        expect(inventory.of('a')).toEqual({});
        // The remounted chop is the REAL cut: one wood off Ael's seeded
        // pool-7 tree at the fine spot (4,4), the tree STANDS — conservation
        // held throughout
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(ecology.treeAt({ x: 0, y: 0 }, { x: 4, y: 4 })!.wood).toBe(6);
        expect(ecology.standOf({ x: 0, y: 0 })).toEqual({ trees: 135, wood: 487 });
        expect(inventory.cellStock(0, 0).tree).toBe(135);
    });

    it('the legacy whole-tree path survives on stand-less terrain only (old fixtures)', () => {
        // A LEGACY TERRAIN SHAPE — the harvest boundary reads the
        // persistent stands through the inventory plugin's terrain handle;
        // a fixture world with NO terrain plugin carries no stands, so the
        // legacy path serves whole-tree cuts (nothing can resurrect them
        // — no stand exists to restore from)
        const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
        const world = createWorld({ seed: 7, plugins: [inventory] });
        const ael = world.spawn({
            id: 'a', name: 'Ael', kind: 'sentient', type: 'human',
            position: position3(0, 0), marker: 'A', condition: 'well',
            profile: { sex: 'male' },
        });
        // A bare stand-less cell with a hand-seeded tree mirror
        inventory.cellStock(0, 0).tree = 2;
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(inventory.cellStock(0, 0).tree).toBe(1);
    });
});
