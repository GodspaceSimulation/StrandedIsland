// Tests for the forest ecology plugin (plugins/forest/forestPlugin.ts).
//
// THE LIVING WOODS: the terrain plugin seeds every forested tile with a
// persistent fine-scale stand (plugins/terrain ForestStand — 90% of the
// tile's fine cells, mixed seeded ages); this plugin grows the trees' wood
// pools, recruits saplings (even clearcut — the seed bank), and spreads
// mature woods over adjacent GRASS tiles only. Every outcome below was
// captured from reference runs — the ecology is fully deterministic.
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

describe('forestPlugin — the seeded stands (exact density)', () => {
    it('seeds 90% of every forest tile\u2019s fine cells: 383 trees on the default island', () => {
        const { world, ecology } = buildEcology(undefined, 25, 17);
        // The pinned rounding choice: Math.round(0.9 × 425) = 383
        expect(forestTreeCount(25, 17)).toBe(383);
        // The reference wood (−7,0) — captured stand (383 trees, 1518 wood)
        expect(ecology.standOf({ x: -7, y: 0 })).toEqual({ trees: 383, wood: 1518 });
        // Every one of the island's 75 forests seeds the same 383-tree stand
        const forests = world.canvas.cells.filter((cell) => cell.biome === 'forest');
        expect(forests.length).toBe(75);
        expect(forests.every((cell) => ecology.standOf(cell)?.trees === 383)).toBe(true);
        // The mixed seeded ages read as standing wood immediately (the
        // seeded woods hold mature trees and saplings side by side)
        expect(ecology.standOf({ x: -7, y: 0 })?.wood).toBe(1518);
    });

    it('seeds the 7×5 island\u2019s woods at 32 trees each (90% of 35 fine cells)', () => {
        const { world, ecology } = buildEcology();
        expect(forestTreeCount(7, 5)).toBe(32);
        // Captured stand sums per tile (the seeded age mix)
        expect(ecology.standOf({ x: -1, y: 0 })).toEqual({ trees: 32, wood: 120 });
        expect(ecology.standOf({ x: 0, y: 0 })).toEqual({ trees: 32, wood: 130 });
        expect(ecology.standOf({ x: 0, y: 1 })).toEqual({ trees: 32, wood: 110 });
    });

    it('the zoom mirrors the stand exactly — 383 treed subtiles at persistent positions', () => {
        const { world, terrain, ecology, inventory } = buildEcology(undefined, 25, 17);
        const sub = terrain.canvasFor([{ x: -7, y: 0 }]);
        expect(sub?.cells.filter((cell) => (cell.resources.tree ?? 0) === 1).length).toBe(383);
        // The bare remainder: 425 − 383 = 42 fine cells hold no tree
        expect(sub?.cells.filter((cell) => cell.resources.tree === undefined).length).toBe(42);
        // Every treed subtile carries ONE tree + the ground supply (the
        // zoom reveals the woods' interior without reshuffling anything)
        const treed = sub?.cells.find((cell) => (cell.resources.tree ?? 0) === 1);
        expect(treed?.resources).toEqual({ tree: 1, stone: 1, dirt: 1, grass: 1 });
        // PERSISTENCE — cut one tree (the harvest path) and re-zoom: exactly
        // the cut spot went bare, every other position byte-identical
        const before = sub!.cells.map((cell) => cell.resources.tree ?? 0);
        const ael = world.spawn({
            id: 'a', name: 'Ael', kind: 'sentient', type: 'human',
            position: position3(-7, 0), marker: 'A', condition: 'well',
            profile: { sex: 'male' },
        });
        // Chop the same tree to its end (its pool — captured: the fine
        // spot's sapling pool 1, one cut fells it)
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(true);
        const after = terrain.canvasFor([{ x: -7, y: 0 }])!.cells.map((cell) => cell.resources.tree ?? 0);
        expect(after.filter((count) => count === 1).length).toBe(382);
        after.forEach((count, index) => {
            if (before[index] === 0) {
                expect(count).toBe(0);
            }
        });
        // Read-only caches: re-zooming serves the SAME cached grid and the
        // stands/wood are untouched by any zoom (zooming never grows or
        // fells anything)
        expect(terrain.canvasFor([{ x: -7, y: 0 }])).toBe(terrain.canvasFor([{ x: -7, y: 0 }]));
        expect(ecology.standOf({ x: -7, y: 0 })).toEqual({ trees: 382, wood: 1517 });
    });
});

describe('forestPlugin — the chop (wood off the pool)', () => {
    it('cuts ONE wood off the exact fine spot\u2019s tree, folding its growth first', () => {
        const { terrain, ecology, world, inventory } = buildEcology();
        const stand = terrain.forestOf(-1, 0)!;
        const bare = { x: -1, y: -2 };
        expect(stand.trees.has('-1,-2')).toBe(false);
        // A planted pool-5 tree (born −100 — past the virgin marker)
        terrain.forestPlant(-1, 0, bare, { born: -100, base: 5, baseMinute: -100, carry: 0 });
        const size = stand.trees.size;
        expect(ecology.chop({ x: -1, y: 0 }, bare)).toEqual({ felled: false });
        // The tree STANDS: one wood off the pool, the record alive
        const record = stand.trees.get('-1,-2')!;
        expect(record.base).toBe(4);
        expect(stand.trees.size).toBe(size);
        // Three more chops leave ONE wood standing; the fifth fells it
        ecology.chop({ x: -1, y: 0 }, bare);
        ecology.chop({ x: -1, y: 0 }, bare);
        ecology.chop({ x: -1, y: 0 }, bare);
        expect(stand.trees.get('-1,-2')?.base).toBe(1);
        expect(ecology.chop({ x: -1, y: 0 }, bare)).toEqual({ felled: true });
        // FELLED COMPLETE — the record leaves the stand and the mirrors
        // drop with it (deposit + gatherable stock read the stand size)
        expect(stand.trees.has('-1,-2')).toBe(false);
        expect(stand.trees.size).toBe(size - 1);
        expect(world.cellAt(-1, 0)?.resources.tree).toBe(size - 1);
        expect(inventory.cellStock(-1, 0).tree).toBe(size - 1);
    });

    it('a bare fine cell cuts the deterministic nearest tree inside the same tile', () => {
        const { terrain, ecology } = buildEcology();
        const stand = terrain.forestOf(-1, 0)!;
        // The tile heart's nearest (captured): (1,1) at distance 1, pool 2
        expect(ecology.chop({ x: -1, y: 0 })).toEqual({ felled: false });
        // The NEAREST tree took the cut — its pool dropped (2 → 1); the
        // captured card (the seeded age's pool at this point)
        expect(ecology.treeAt({ x: -1, y: 0 }, { x: 1, y: 1 })).toEqual({
            wood: 1,
            ageMinutes: 1035561,
            mature: false,
        });
        // A tree-less tile declines the chop entirely
        expect(terrain.forestOf(1, -1)).toBeUndefined();
        expect(ecology.chop({ x: 1, y: -1 })).toBeNull();
        expect(stand.trees.has('1,1')).toBe(true);
    });

    it('an empty stand (clearcut) declines the chop', () => {
        const { terrain, ecology } = buildEcology();
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
        const { terrain, ecology } = buildEcology({ maturityMinutes: 100, woodCap: 5 });
        const stand = terrain.forestOf(-1, 0)!;
        const bare = { x: -1, y: -2 };
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
        const { terrain, ecology } = buildEcology({ maturityMinutes: 100, woodCap: 5 });
        const stand = terrain.forestOf(-1, 0)!;
        const bare = { x: -1, y: -2 };
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
        expect(ecology.chop({ x: -1, y: 0 }, bare)).toEqual({ felled: false });
    });

    it('a felled tree\u2019s record is removed; growth never resurrects it', () => {
        const { terrain, ecology } = buildEcology({ maturityMinutes: 100, woodCap: 5 });
        const stand = terrain.forestOf(-1, 0)!;
        const bare = { x: -1, y: -2 };
        const sapling = { born: 0, base: 1, baseMinute: 0, carry: 0 };
        terrain.forestPlant(-1, 0, bare, sapling);
        // The sapling's whole pool is one wood — the first chop fells it
        expect(ecology.chop({ x: -1, y: 0 }, bare)).toEqual({ felled: true });
        expect(stand.trees.has('-1,-2')).toBe(false);
        // Growth works on the ecology clock — a year later the spot stays
        // bare (only recruitment replants a felled spot)
        ecology.fastForward(500);
        expect(stand.trees.has('-1,-2')).toBe(false);
    });
});

describe('forestPlugin — recruitment (the seed bank)', () => {
    it('a forest voxel recruits even clearcut, into a free fine cell', () => {
        const { world, terrain, ecology, inventory } = buildEcology({ recruitMinutes: 10 });
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
        const { world, terrain, ecology } = buildEcology({ recruitMinutes: 10 });
        // The meadow (1,−4) on the default island: grass substrate, no stand
        expect(terrain.forestOf(1, -4)).toBeUndefined();
        ecology.fastForward(100);
        expect(terrain.forestOf(1, -4)).toBeUndefined();
        expect(world.cellAt(1, -4)?.resources.tree).toBeUndefined();
        // A beach tile: sand substrate — never a stand
        expect(terrain.forestOf(-4, -7)).toBeUndefined();
        expect(world.cellAt(-4, -7)?.resources.tree).toBeUndefined();
    });

    it('recruitment fills toward the FULL stand (the 100% uncut cap over the years)', () => {
        const { terrain, ecology } = buildEcology({ recruitMinutes: 10 });
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
        const stand = terrain.forestOf(-7, 0)!;
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
            terrain.forestPlant(-7, 0, spot, { born: 1, base: 1, baseMinute: 1, carry: 0 });
        });
        expect(stand.trees.size).toBe(424);
        // One recruit cycle: the random probe (a 63% hit rate for one bare
        // spot among 425) OR the bounded row-major fallback — either way
        // exactly ONE sapling lands at the only bare fine cell
        ecology.fastForward(10);
        expect(stand.trees.size).toBe(425);
        expect(stand.trees.has(`${bare[41].x},${bare[41].y}`)).toBe(true);
        // The mirrors read the FULL stand (the documented 100% cap reached)
        expect(world.cellAt(-7, 0)?.resources.tree).toBe(425);
        expect(ecology.standOf({ x: -7, y: 0 })).toEqual({ trees: 425, wood: 1560 });
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
        const meadowsBefore = world.canvas.cells.filter((cell) => cell.biome === 'meadow').length;
        expect(meadowsBefore).toBe(38);
        ecology.fastForward(10);
        // Captured conversions: 31 meadow tiles turned into woods — each
        // carries the forest voxel, the forest biome, a ONE-SAPLING stand
        // and the coherent mirrors
        const converted = world.canvas.cells.filter(
            (cell) =>
                cell.biome === 'forest' &&
                cell.voxels[cell.voxels.length - 1] === 'forest' &&
                (cell.resources.tree ?? 0) === 1 &&
                (terrain.forestOf(cell.x, cell.y)?.trees.size ?? 0) === 1,
        );
        expect(converted.map((cell) => `${cell.x},${cell.y}`)).toEqual([
            '1,-4', '-3,-3', '-2,-3', '-1,-3', '0,-3', '1,-3', '-4,-2',
            '-1,-2', '0,-2', '1,-2', '-6,-1', '-5,-1', '-4,-1', '-2,-1',
            '1,-1', '-3,0', '-3,1', '-2,1', '6,1', '7,1', '-4,2', '-3,2',
            '1,2', '-5,3', '-4,3', '0,3', '1,3', '2,3', '-1,4', '1,4', '-2,5',
        ]);
        // The meadow census dropped by exactly the conversions
        expect(world.canvas.cells.filter((cell) => cell.biome === 'meadow').length).toBe(7);
        // A WOOD WITHOUT MEADOW NEIGHBOURS spread nothing: (−7,0) is fenced
        // by beach and woods — every neighbour kept its substrate (never
        // sand, never stone, never water — regardless of the soil underlayer)
        expect(terrain.forestOf(-7, -1)).toBeUndefined();
        expect(world.cellAt(-7, -1)?.biome).toBe('beach');
        expect(world.cellAt(-7, -1)?.voxels.includes('forest')).toBe(false);
        expect(world.cellAt(-8, 1)?.biome).toBe('beach');
        expect(world.cellAt(-8, 0)?.biome).toBe('beach');
        // The converted tile's inventory is coherent: the sapling's stock
        // mirror stands (the meadow's berries persist beside it)
        const first = converted[0];
        expect(inventory.cellStock(first.x, first.y).tree).toBe(1);
        // The converted wood's zoom paints the canopy over the grass
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
        // one tile whose slot lands inside the horizon: (4,−5) recruits
        // once; every other wood keeps its 383
        ecology.fastForward(2000);
        expect(treeSnapshot(world, ecology)).toBe(treesBefore.replace('4,-5:383#383', '4,-5:384#384'));
        // The wood moved by the captured crossings: the recruit's 1 sapling
        // wood plus the lazy floor boundaries the seeded ages crossed
        expect(woodTotal(world, ecology)).toBe(woodBefore + 98);
    });

    it('two full years of default ecology recruit exactly once per forest tile', () => {
        const { world, ecology } = buildEcology(undefined, 7, 5);
        const treesBefore = treeSnapshot(world, ecology);
        // One year = 525,600 minutes: the 2-year recruitment rhythm fires
        // for the tiles whose staggered slot lands inside the year, the
        // 3-year spread rhythm nowhere (no meadows on the 7×5 island)
        ecology.fastForward(525600);
        const yearOne = treeSnapshot(world, ecology);
        expect(yearOne).not.toBe(treesBefore);
        // The second year completes every tile's first recruitment: each
        // of the three woods stands 33 trees (32 seeded + 1 recruited),
        // the mirrors moved with them
        ecology.fastForward(525600);
        world.canvas.cells
            .filter((cell) => cell.biome === 'forest')
            .forEach((cell) => {
                expect(ecology.standOf(cell)?.trees).toBe(33);
                expect(cell.resources.tree).toBe(33);
            });
        expect(treeSnapshot(world, ecology)).toBe('-1,0:33#33|0,0:33#33|0,1:33#33');
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
        const { terrain } = buildEcology(undefined, 7, 5);
        const record = Array.from(terrain.forestOf(-1, 0)!.trees.values())[0];
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
        const bare = { x: -1, y: -2 };
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
    /** The full wiring with entity profiles — the capacity gate lives. */
    const buildWired = (pacing: ForestPacingOptions = {}) => {
        const terrain = islandTerrainPlugin({ width: 7, height: 5 });
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
        const ael = world.spawn(actor('a', 'Ael', -1, 0));
        // Ael's fine spot (−1,0) holds a pool-7 tree (captured card) — the
        // first chop cuts ITS pool and the tree STANDS
        const fine = world.subOf('a')!;
        expect(fine).toEqual({ x: -1, y: 0 });
        expect(ecology.treeAt({ x: -1, y: 0 }, fine)).toEqual({
            wood: 7,
            ageMinutes: 3867279,
            mature: false,
        });
        const before = ecology.standOf({ x: -1, y: 0 })!;
        expect(before).toEqual({ trees: 32, wood: 120 });
        // THE CAPACITY GATE — a full bag never fells (the pool untouched)
        inventory.spawnKit('a', { sand: 8 });
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(ecology.standOf({ x: -1, y: 0 })).toEqual(before);
        expect(inventory.of('a')).toEqual({ sand: 8 });
        // One unit freed: the chop moves exactly ONE wood — the tree stands
        inventory.consume(ael, 'sand');
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(inventory.of('a')).toEqual({ sand: 7, wood: 1 });
        expect(ecology.standOf({ x: -1, y: 0 })).toEqual({ trees: 32, wood: 119 });
        // The gatherable stock mirrors the stand exactly (no ghosts)
        expect(inventory.cellStock(-1, 0).tree).toBe(32);
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
        const ael = world.spawn(actor('a', 'Ael', -1, 0));
        const before = ecology.standOf({ x: -1, y: 0 })!;
        world.plugins.remove('forest');
        // The provider is gone — the cut is REFUSED (the biological woods
        // are uncuttable without their owner; nothing mutates)
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(inventory.of('a')).toEqual({});
        expect(ecology.standOf({ x: -1, y: 0 })).toEqual(before);
        expect(inventory.cellStock(-1, 0).tree).toBe(before.trees);
        expect(world.cellAt(-1, 0)?.resources.tree).toBe(before.trees);
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
        const ael = world.spawn(actor('a', 'Ael', -1, 0));
        // A clock-sensitive recruited sapling joins the stand
        ecology.fastForward(10);
        const before = ecology.standOf({ x: -1, y: 0 })!;
        expect(before).toEqual({ trees: 33, wood: 121 }); // 32 seeded + 1 recruited
        expect(inventory.cellStock(-1, 0).tree).toBe(33);
        // DETACH — the provider unmounts, the boundary stands guard
        world.plugins.remove('forest');
        // The cut is REFUSED — the persistent tree keeps its pool (the
        // original wood total stands) and the bag gains nothing
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(inventory.of('a')).toEqual({});
        expect(ecology.standOf({ x: -1, y: 0 })).toEqual(before);
        expect(inventory.cellStock(-1, 0).tree).toBe(33);
        expect(world.cellAt(-1, 0)?.resources.tree).toBe(33);
        // REMOUNT — the setup sweep re-aligns (nothing drifted — the
        // mirrors already read the stand), the clock stays monotonic: the
        // recruited sapling's absolute birth minute keeps its meaning
        world.plugins.add(ecology);
        expect(ecology.standOf({ x: -1, y: 0 })).toEqual(before);
        expect(inventory.cellStock(-1, 0).tree).toBe(33);
        expect(world.cellAt(-1, 0)?.resources.tree).toBe(33);
        expect(inventory.of('a')).toEqual({});
        // The remounted chop is the REAL cut: one wood off Ael's seeded
        // pool-7 tree, the tree STANDS — conservation held throughout
        expect(inventory.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(ecology.treeAt({ x: -1, y: 0 }, { x: -1, y: 0 })!.wood).toBe(6);
        expect(ecology.standOf({ x: -1, y: 0 })).toEqual({ trees: 33, wood: 120 });
        expect(inventory.cellStock(-1, 0).tree).toBe(33);
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
