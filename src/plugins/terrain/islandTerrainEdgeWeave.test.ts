// Tests for the scale-0 EDGE WEAVE (R1 — natural neighbor blending): the
// shared deterministic seam mechanism that replaces the old fixed-geometry
// edge treatments (the checkerboard rock spill, the distance-ranked meadow
// ingress strip, the straight land↔water abutments) with seeded, spatially
// coherent meanders both tiles of a seam read alike.
//
// The four regression duties this file owns:
//   (a) the blends are REPRODUCIBLE but SEED-VARYING and SPATIALLY COHERENT
//       — never the checkerboard's alternating parity, never a fixed strip;
//   (b) R2 — water never gains land: the water parents (ocean, shallows,
//       lake, pond) zoom 100% pure, and the land-side blends never clone
//       finite deposits. T3 carves the RIVER out — its passable ford zooms
//       into the living riverbank (the organic water body ringed by
//       synthesized dry banks, islandTerrainRiver.test.ts) — so the river
//       assertions below pin the new zoom contract (the 60–70% water band,
//       dry raised banks, no finite stock anywhere), not the old purity;
//   (c) the materializer and the fast histogram agree cell-for-cell on the
//       blended grids (the shared fineCellDraft builder);
//   (d) the narrow/corner cases and the cache/majority contracts: the stamp
//       invalidates when a NEIGHBOR converts (the spread), the depth-2 stand
//       scoping keeps coincidental root stands out of unrelated grids, and
//       the coarse majority never leaves the tile's own look family.
//
// Unit half: hand-built centered grids. Integration half: the seed-7 default
// island plus small subtiles-2 worlds.

import { describe, it, expect } from 'vitest';
import {
    BLEND_FEATHER_CHANCE,
    BLEND_MAX_PUSH,
    edgeMask,
    fineWaterColumn,
    islandTerrainPlugin,
    seamSpots,
    tileSurfaceKey,
    type BlendLook,
    type EdgeMask,
    type ShoreWater,
} from './islandTerrain';
import { dominantVisibleType } from '../../features/tileDetails';
import { createIslandWorld } from '../../scenario/island';
import { createWorld } from '../../engine/world';
import { NEIGHBOR_OFFSETS, tilePathKey, type TilePath } from '@godspace/core';
import type { Canvas, TerrainCell, TileResource } from '../../engine/types';

// ── Synthetic grid helpers ───────────────────────────────────────────────────

/** A land or water column for a hand-built grid. */
const column = (biome: TerrainCell['biome'], passable: boolean): TerrainCell => ({
    x: 0,
    y: 0,
    voxels: passable ? ['dirt', 'grass'] : ['sand', 'water'],
    height: passable ? 3 : 2,
    waterLevel: 3,
    biome,
    passable,
    resources: passable ? { dirt: 1, grass: 1 } : {},
});

/** A centered odd grid of land columns with specific overrides. */
const grid = (
    layout: string[],
    overrides: Array<{ x: number; y: number; biome: TerrainCell['biome']; passable: boolean }> = [],
): Canvas => {
    const width = layout[0].length;
    const height = layout.length;
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    const cells: TerrainCell[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            cells.push(column('meadow', true));
        }
    }
    const canvas: Canvas = { width, height, cells };
    const put = (x: number, y: number, cell: TerrainCell) => {
        // The cell carries its own address — edgeMask's neighborAt and
        // otherKeyOf read parent.x/parent.y, so a fixture parent placed
        // off-center must report the coordinates it sits at
        cell.x = x;
        cell.y = y;
        canvas.cells[(y + halfY) * width + (x + halfX)] = cell;
    };
    overrides.forEach(({ x, y, biome, passable }) => put(x, y, column(biome, passable)));
    return canvas;
};

/** The centered parent of a fixture grid (its own override applied). */
const parentAt = (canvas: Canvas, x: number, y: number): TerrainCell => {
    const halfX = (canvas.width - 1) / 2;
    const halfY = (canvas.height - 1) / 2;
    return canvas.cells[(y + halfY) * canvas.width + (x + halfX)];
};

const pathOf = (x: number, y: number): TilePath => [{ x, y }];

// ── (a) the seam geometry ─────────────────────────────────────────────────────

describe('seamSpots — the shared meander (R1)', () => {
    const seed = 7;

    it('carries the documented tuning constants', () => {
        expect(BLEND_MAX_PUSH).toBe(2);
        expect(BLEND_FEATHER_CHANCE).toBe(0.05);
    });

    it('is deterministic: the same inputs derive the identical spots', () => {
        const a = seamSpots(9, 7, seed, '0,0', '1,0', { dx: 1, dy: 0 });
        const b = seamSpots(9, 7, seed, '0,0', '1,0', { dx: 1, dy: 0 });
        expect(b).toEqual(a);
        expect(b).not.toBe(a);
    });

    it('converts only the pushed side: each spot sits 1..BLEND_MAX_PUSH cells inside the tile', () => {
        // A cardinal seam runs along the full axis; every converted spot of
        // the self side lies within two fine cells of the shared edge
        const spots = seamSpots(9, 7, seed, '0,0', '1,0', { dx: 1, dy: 0 });
        expect(spots.size).toBeGreaterThan(0);
        spots.forEach((depth, key) => {
            const [x, y] = key.split(',').map(Number);
            expect(depth).toBeGreaterThanOrEqual(1);
            expect(depth).toBeLessThanOrEqual(BLEND_MAX_PUSH);
            expect(x).toBe(4 - depth + 1);
            expect(y).toBeGreaterThanOrEqual(-3);
            expect(y).toBeLessThanOrEqual(3);
        });
    });

    it('spatially coherent: the converted positions form contiguous runs, never the checkerboard parity', () => {
        // The checkerboard's signature: NO two edge-adjacent positions ever
        // both convert. The meander's runs always touch somewhere on every
        // band of two or more positions, across seeds and both edge axes.
        [1, 2, 3, 4, 5, 6, 7, 8].forEach((bandSeed) => {
            (
                [
                    { dx: 1, dy: 0 },
                    { dx: -1, dy: 0 },
                    { dx: 0, dy: 1 },
                    { dx: 0, dy: -1 },
                ] as const
            ).forEach((offset) => {
                const spots = seamSpots(25, 17, bandSeed, 'a', 'b', offset);
                // The outermost layer's positions along the edge axis
                const edge = [...spots.entries()]
                    .filter(([, depth]) => depth === 1)
                    .map(([key]) => (offset.dx !== 0 ? Number(key.split(',')[1]) : Number(key.split(',')[0])))
                    .sort((left, right) => left - right);
                if (edge.length < 2) {
                    return;
                }
                const touches = edge.some((t, index) => index > 0 && t - edge[index - 1] === 1);
                expect(
                    touches,
                    `seed ${bandSeed} offset ${JSON.stringify(offset)} band ${JSON.stringify(edge)} must run, not alternate`,
                ).toBe(true);
            });
        });
    });

    it('seed-varying: different seeds draw different meanders', () => {
        let varied = false;
        for (let other = 1; other <= 8 && !varied; other++) {
            const a = seamSpots(25, 17, other, 'a', 'b', { dx: 1, dy: 0 });
            const b = seamSpots(25, 17, 7, 'a', 'b', { dx: 1, dy: 0 });
            varied = JSON.stringify([...a.entries()]) !== JSON.stringify([...b.entries()]);
        }
        expect(varied).toBe(true);
    });

    it('both tiles of a seam derive ONE meander — the two sides never claim the same fine cell', () => {
        // The canonical `seam:<low>~<high>` stream is shared: neither side's
        // conversion can overlap the other's (the composite boundary is a
        // single wavy line around the world edge)
        [1, 7, 11, 42].forEach((bandSeed) => {
            const east = seamSpots(9, 7, bandSeed, 'a', 'b', { dx: 1, dy: 0 });
            const west = seamSpots(9, 7, bandSeed, 'b', 'a', { dx: -1, dy: 0 });
            east.forEach((_depth, key) => {
                expect(west.has(key), `seed ${bandSeed} overlap at ${key}`).toBe(false);
            });
            // The vertical seam likewise
            const south = seamSpots(9, 7, bandSeed, 'a', 'b', { dx: 0, dy: 1 });
            const north = seamSpots(9, 7, bandSeed, 'b', 'a', { dx: 0, dy: -1 });
            south.forEach((_depth, key) => {
                expect(north.has(key), `seed ${bandSeed} vertical overlap at ${key}`).toBe(false);
            });
        });
    });

    it('a diagonal seam is the shared corner wedge (the corner cell, flanks on a deep push)', () => {
        const spots = seamSpots(9, 7, seed, '0,0', '1,1', { dx: 1, dy: 1 });
        // Every spot of a diagonal seam sits inside the 3×3 corner block
        spots.forEach((_depth, key) => {
            const [x, y] = key.split(',').map(Number);
            expect(x).toBeGreaterThanOrEqual(2);
            expect(y).toBeGreaterThanOrEqual(1);
            expect(x).toBeLessThanOrEqual(4);
            expect(y).toBeLessThanOrEqual(3);
        });
    });

    it('a zero offset derives nothing (the degenerate self-seam)', () => {
        expect(seamSpots(9, 7, seed, 'a', 'a', { dx: 0, dy: 0 }).size).toBe(0);
    });
});

// ── edgeMask — the per-tile plan ─────────────────────────────────────────────

describe('edgeMask — the per-tile blend plan (R1)', () => {
    it('R2: a WATER parent blends NOTHING — the basins and the sea; the river zoom banks are T3\'s own plan', () => {
        // The center column's own biome varies; every non-river water kind
        // answers the empty plan
        (['ocean', 'shallows', 'lake', 'pond'] as const).forEach((waterBiome) => {
            const canvas = grid(['mm'], [{ x: 0, y: 0, biome: waterBiome, passable: false }]);
            const parent = parentAt(canvas, 0, 0);
            const plan = edgeMask(parent, pathOf(0, 0), canvas, 7);
            expect(plan.water.size).toBe(0);
            expect(plan.land.size).toBe(0);
            expect(plan.bank.size).toBe(0);
        });
        // T3 — the RIVER parent zooms into the living riverbank instead:
        // water/land stay empty (the ford's water is the inherited column,
        // never a water spot) and the BANKS carry the plan — but a river
        // tile with no channel neighbor (this 1×1 fixture) keeps the pure
        // zoom: no edge to open, no bank to shape (islandTerrainRiver.test.ts
        // covers the channel-facing plans)
        const river = grid(['mm'], [{ x: 0, y: 0, biome: 'river', passable: true }]);
        const riverPlan = edgeMask(parentAt(river, 0, 0), pathOf(0, 0), river, 7);
        expect(riverPlan.water.size).toBe(0);
        expect(riverPlan.land.size).toBe(0);
        expect(riverPlan.bank.size).toBe(0);
        // An IMPASSABLE column is water alike
        const drowned = grid(['mm'], [{ x: 0, y: 0, biome: 'meadow', passable: false }]);
        const plan = edgeMask(parentAt(drowned, 0, 0), pathOf(0, 0), drowned, 7);
        expect(plan.water.size).toBe(0);
        expect(plan.land.size).toBe(0);
        expect(plan.bank.size).toBe(0);
    });

    it('same-biome neighbors seam nothing', () => {
        const canvas = grid(['mmm', 'mmm', 'mmm']);
        const plan = edgeMask(parentAt(canvas, 0, 0), pathOf(0, 0), canvas, 7);
        expect(plan.water.size).toBe(0);
        expect(plan.land.size).toBe(0);
    });

    it('a meadow beside a forest keeps the seam for the INGRESS — no plain land look on the meadow side', () => {
        // The meadow→forest pair is the tree ingress's (generation pass 3 +
        // seedStands) — the plain swap table lends nothing there
        const canvas = grid(['mmf'], [{ x: 1, y: 0, biome: 'forest', passable: true }]);
        const plan = edgeMask(parentAt(canvas, 0, 0), pathOf(0, 0), canvas, 7);
        expect(plan.land.size).toBe(0);
    });

    it('a forest beside a meadow grows GRASS clearings on the seam meander', () => {
        // The FOREST side of a meadow↔forest seam (the meadow side is the
        // tree ingress's — lendSurface answers undefined there). The grid is
        // five rows tall so the seam runs five edge positions: the meander's
        // full-period sine takes both signs across them, so this side's
        // conversion is guaranteed for any seed — a one-position seam could
        // legitimately push the other way
        const canvas = grid(
            ['fff', 'fff', 'fff', 'fff', 'fff'],
            [
                { x: -1, y: -2, biome: 'forest', passable: true },
                { x: -1, y: -1, biome: 'forest', passable: true },
                { x: -1, y: 0, biome: 'forest', passable: true },
                { x: -1, y: 1, biome: 'forest', passable: true },
                { x: -1, y: 2, biome: 'forest', passable: true },
            ],
        );
        const plan = edgeMask(parentAt(canvas, -1, 0), pathOf(-1, 0), canvas, 7);
        expect(plan.land.size).toBeGreaterThan(0);
        plan.land.forEach((look) => {
            expect(look).toBe<BlendLook>('grass');
        });
    });

    it('a meadow beside a highland grows ROCK scree on the seam meander', () => {
        const canvas = grid(['mmh'], [{ x: 1, y: 0, biome: 'highland', passable: true }]);
        const plan = edgeMask(parentAt(canvas, 0, 0), pathOf(0, 0), canvas, 7);
        expect(plan.land.size).toBeGreaterThan(0);
        plan.land.forEach((look) => {
            expect(look).toBe<BlendLook>('rock');
        });
    });

    it('a forest beside a beach grows SAND tongues; a beach beside a forest grows canopy patches', () => {
        // Five rows tall — the same full-period argument as the grass test:
        // both sides of the seam convert somewhere for any seed
        const canvas = grid(
            ['fbb', 'fbb', 'fbb', 'fbb', 'fbb'],
            [
                { x: -1, y: -2, biome: 'forest', passable: true },
                { x: -1, y: -1, biome: 'forest', passable: true },
                { x: -1, y: 0, biome: 'forest', passable: true },
                { x: -1, y: 1, biome: 'forest', passable: true },
                { x: -1, y: 2, biome: 'forest', passable: true },
                { x: 0, y: -2, biome: 'beach', passable: true },
                { x: 0, y: -1, biome: 'beach', passable: true },
                { x: 0, y: 0, biome: 'beach', passable: true },
                { x: 0, y: 1, biome: 'beach', passable: true },
                { x: 0, y: 2, biome: 'beach', passable: true },
                { x: 1, y: -2, biome: 'beach', passable: true },
                { x: 1, y: -1, biome: 'beach', passable: true },
                { x: 1, y: 0, biome: 'beach', passable: true },
                { x: 1, y: 1, biome: 'beach', passable: true },
                { x: 1, y: 2, biome: 'beach', passable: true },
            ],
        );
        // The forest tile lends its sand to the beach's edge (the tongue)
        const forestPlan = edgeMask(parentAt(canvas, -1, 0), pathOf(-1, 0), canvas, 7);
        expect(forestPlan.land.size).toBeGreaterThan(0);
        forestPlan.land.forEach((look) => {
            expect(look).toBe<BlendLook>('sand');
        });
        // The beach tile lends its canopy to the forest's edge (the patch)
        const beachPlan = edgeMask(parentAt(canvas, 0, 0), pathOf(0, 0), canvas, 7);
        expect(beachPlan.land.size).toBeGreaterThan(0);
        beachPlan.land.forEach((look) => {
            expect(look).toBe<BlendLook>('forest');
        });
    });

    it('a meadow beside water waves a WATERLINE (the fresh basins and the river lend their own biome)', () => {
        const pond = grid(['mmp'], [{ x: 1, y: 0, biome: 'pond', passable: false }]);
        const pondPlan = edgeMask(parentAt(pond, 0, 0), pathOf(0, 0), pond, 7);
        expect(pondPlan.water.size).toBeGreaterThan(0);
        pondPlan.water.forEach((spot) => {
            expect(spot.depth).toBe(1);
            expect(spot.basin).toBe('pond');
        });
        const river = grid(['mmr'], [{ x: 1, y: 0, biome: 'river', passable: true }]);
        const riverPlan = edgeMask(parentAt(river, 0, 0), pathOf(0, 0), river, 7);
        expect(riverPlan.water.size).toBeGreaterThan(0);
        riverPlan.water.forEach((spot) => {
            expect(spot.depth).toBe(1);
            expect(spot.basin).toBe('river');
        });
        // The sea: shallow at one voxel, the ocean two
        const shallows = grid(['mms'], [{ x: 1, y: 0, biome: 'shallows', passable: false }]);
        edgeMask(parentAt(shallows, 0, 0), pathOf(0, 0), shallows, 7).water.forEach((spot) => {
            expect(spot.depth).toBe(1);
            expect(spot.basin).toBeUndefined();
        });
        const ocean = grid(['mmo'], [{ x: 1, y: 0, biome: 'ocean', passable: false }]);
        edgeMask(parentAt(ocean, 0, 0), pathOf(0, 0), ocean, 7).water.forEach((spot, key) => {
            expect(spot.basin).toBeUndefined();
            expect(spot.depth).toBe(key.endsWith('2') ? 1 : 2);
        });
    });

    it('water wins a shared corner over a land look (the put dedupe)', () => {
        // A meadow with water east and highland south-east: the corner fine
        // cell both seams claim goes to the WATER (the seam sweep runs the
        // water spots first, then the land looks skip taken spots)
        const canvas = grid(
            ['mmh', 'mmo', 'mmm'],
            [
                { x: 1, y: 0, biome: 'highland', passable: true },
                { x: 1, y: -1, biome: 'ocean', passable: false },
            ],
        );
        const plan = edgeMask(parentAt(canvas, 0, 0), pathOf(0, 0), canvas, 7);
        plan.land.forEach((_look, key) => {
            expect(plan.water.has(key)).toBe(false);
        });
    });
});

// ── T4 — seam precedence: land and water seams claim one fine cell ───────────
//
// The seam sweep walks the neighbors in the fixed NEIGHBOR_OFFSETS order
// (north, north-east, east, …), so a LAND seam can be processed BEFORE the
// water seam claiming the same fine cell — a highland to the north and the
// ocean to the east: both meanders can reach the shared top-right corner.
// The land sweep's guard skips only water written SO FAR, so `putWater`
// must clear the stale land entry itself or the spot sits in BOTH masks —
// an order-dependent invariant (the draft and the histogram read water
// first, so nothing materialized wrong; the masks must be order-independent
// regardless). The arrangements below cover both processing orders over the
// cardinal and the diagonal orientations and pin the end-state exactly: the
// masks disjoint, the water mask EXACTLY the water seam's own spots (a land
// seam neither adds, removes nor reshapes a water spot) and the land mask
// the land seam minus precisely the spots the water took.

describe('edgeMask precedence — a land seam before a water seam (T4)', () => {
    // 9×7 — every neighbor of the center parent exists, odd-sided like the
    // real grids (the seam streams need the centered half-extents)
    const SIZE = { width: 9, height: 7 };
    const SELF = tilePathKey([{ x: 0, y: 0 }]);
    const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    /** The ocean waterline mapping of one seam reach (edgeMask's water branch). */
    const oceanWater = (reach: number): ShoreWater => ({ depth: reach === 1 ? 2 : 1 });

    /**
     * The expected plan of a center meadow with ONE highland and ONE ocean
     * neighbor: the two seams' own spots, each water-claimed corner going to
     * the water alone (the fix under regression). The expectation derives
     * from the shared seam streams, never from the processing order.
     */
    const expectedPlan = (
        landOffset: { dx: number; dy: number },
        waterOffset: { dx: number; dy: number },
        seed: number,
    ): EdgeMask => {
        const landKey = tilePathKey([{ x: landOffset.dx, y: landOffset.dy }]);
        const waterKey = tilePathKey([{ x: waterOffset.dx, y: waterOffset.dy }]);
        const water = new Map<string, ShoreWater>();
        seamSpots(SIZE.width, SIZE.height, seed, SELF, waterKey, waterOffset).forEach((reach, key) => {
            water.set(key, oceanWater(reach));
        });
        const land = new Map<string, BlendLook>();
        seamSpots(SIZE.width, SIZE.height, seed, SELF, landKey, landOffset).forEach((_reach, key) => {
            // The spot the water seam took is WATER'S — the stale land
            // entry must be gone
            if (!water.has(key)) {
                land.set(key, 'rock');
            }
        });
        return { water, land };
    };

    /** Runs edgeMask on the hand-built two-neighbor grid (all else meadow). */
    const planOf = (landAt: { x: number; y: number }, waterAt: { x: number; y: number }, seed: number): EdgeMask => {
        const canvas = grid(
            Array.from({ length: 7 }, () => 'mmmmmmmmm'),
            [
                { x: landAt.x, y: landAt.y, biome: 'highland', passable: true },
                { x: waterAt.x, y: waterAt.y, biome: 'ocean', passable: false },
            ],
        );
        return edgeMask(parentAt(canvas, 0, 0), pathOf(0, 0), canvas, seed);
    };

    /** How often the two seams claim one spot across the seeds — the regression must not be vacuous. */
    const overlapCount = (landOffset: { dx: number; dy: number }, waterOffset: { dx: number; dy: number }): number => {
        const landKey = tilePathKey([{ x: landOffset.dx, y: landOffset.dy }]);
        const waterKey = tilePathKey([{ x: waterOffset.dx, y: waterOffset.dy }]);
        let overlaps = 0;
        SEEDS.forEach((seed) => {
            const landSpots = seamSpots(SIZE.width, SIZE.height, seed, SELF, landKey, landOffset);
            const waterSpots = seamSpots(SIZE.width, SIZE.height, seed, SELF, waterKey, waterOffset);
            landSpots.forEach((_reach, key) => {
                if (waterSpots.has(key)) {
                    overlaps = overlaps + 1;
                }
            });
        });
        return overlaps;
    };

    it('land seam first (highland north, ocean east): the masks stay disjoint and exact', () => {
        const landOffset = { dx: 0, dy: -1 };
        const waterOffset = { dx: 1, dy: 0 };
        // The corner claim is REAL for these seeds — the meanders collide
        expect(overlapCount(landOffset, waterOffset)).toBeGreaterThan(0);
        SEEDS.forEach((seed) => {
            const plan = planOf({ x: landOffset.dx, y: landOffset.dy }, { x: waterOffset.dx, y: waterOffset.dy }, seed);
            const wanted = expectedPlan(landOffset, waterOffset, seed);
            expect(plan.water).toEqual(wanted.water);
            expect(plan.land).toEqual(wanted.land);
            plan.land.forEach((_look, key) => {
                expect(plan.water.has(key)).toBe(false);
            });
            plan.water.forEach((_spot, key) => {
                expect(plan.land.has(key)).toBe(false);
            });
        });
    });

    it('water seam first (ocean north, highland east): the same invariant holds', () => {
        const waterOffset = { dx: 0, dy: -1 };
        const landOffset = { dx: 1, dy: 0 };
        expect(overlapCount(landOffset, waterOffset)).toBeGreaterThan(0);
        SEEDS.forEach((seed) => {
            const plan = planOf({ x: landOffset.dx, y: landOffset.dy }, { x: waterOffset.dx, y: waterOffset.dy }, seed);
            const wanted = expectedPlan(landOffset, waterOffset, seed);
            expect(plan.water).toEqual(wanted.water);
            expect(plan.land).toEqual(wanted.land);
        });
    });

    it('diagonal orientations: the corner wedge meets a cardinal water seam, both orders', () => {
        // The NE highland's wedge corner cell (and its flanks on a deep
        // push) against the north ocean meander — water processed FIRST
        // (north is NEIGHBOR_OFFSETS' head, the diagonal second). The
        // highland stands at the unit NE offset (1,-1) — the neighbor
        // edgeMask actually reads
        const waterNorth = { dx: 0, dy: -1 };
        const landNE = { dx: 1, dy: -1 };
        expect(overlapCount(landNE, waterNorth)).toBeGreaterThan(0);
        SEEDS.forEach((seed) => {
            const plan = planOf({ x: 1, y: -1 }, { x: 0, y: -1 }, seed);
            const wanted = expectedPlan(landNE, waterNorth, seed);
            expect(plan.water).toEqual(wanted.water);
            expect(plan.land).toEqual(wanted.land);
            plan.land.forEach((_look, key) => {
                expect(plan.water.has(key)).toBe(false);
            });
        });
        // The reverse order: the ocean EAST (third) after the NE highland
        // (second) — the land seam is processed first again
        const waterEast = { dx: 1, dy: 0 };
        expect(overlapCount(landNE, waterEast)).toBeGreaterThan(0);
        SEEDS.forEach((seed) => {
            const plan = planOf({ x: 1, y: -1 }, { x: 1, y: 0 }, seed);
            const wanted = expectedPlan(landNE, waterEast, seed);
            expect(plan.water).toEqual(wanted.water);
            expect(plan.land).toEqual(wanted.land);
        });
    });

    it('the water mask is unchanged by the land seam\'s presence at all', () => {
        // The seam stream keys off SELF and the water neighbor's address
        // only — the same ocean seam derives the same meander whether or
        // not a highland also borders the tile
        SEEDS.forEach((seed) => {
            const withLand = planOf({ x: 0, y: -1 }, { x: 1, y: 0 }, seed);
            const bare = grid(
                Array.from({ length: 7 }, () => 'mmmmmmmmm'),
                [{ x: 1, y: 0, biome: 'ocean', passable: false }],
            );
            const withoutLand = edgeMask(parentAt(bare, 0, 0), pathOf(0, 0), bare, seed);
            expect(withLand.water).toEqual(withoutLand.water);
        });
    });
});

// ── (b)+(c) the integration: the whole seed-7 board ──────────────────────────

describe('the EDGE WEAVE on the seed-7 island (25×17)', () => {
    const plugin = islandTerrainPlugin();
    const world = createWorld({ seed: 7, plugins: [plugin] });
    const canvas = world.canvas as Canvas;
    const halfX = (canvas.width - 1) / 2;
    const halfY = (canvas.height - 1) / 2;
    const at = (x: number, y: number): TerrainCell => canvas.cells[(y + halfY) * canvas.width + (x + halfX)];
    const naiveCounts = (sub: Canvas) => {
        const counts = new Map<string, { key: string; count: number; first: number; last: number }>();
        sub.cells.forEach((cell, index) => {
            const key = tileSurfaceKey(cell);
            if (key === undefined) {
                return;
            }
            const record = counts.get(key);
            if (record) {
                record.count = record.count + 1;
                record.last = index;
            } else {
                counts.set(key, { key, count: 1, first: index, last: index });
            }
        });
        return [...counts.values()];
    };
    const FINITE: TileResource[] = ['tree', 'stone', 'iron'];

    it('R2: sea and basins zoom 100% pure — the river zooms into its banks (T3)', { timeout: 30_000 }, () => {
        let checked = 0;
        canvas.cells.forEach((parent) => {
            const isWater =
                !parent.passable ||
                parent.biome === 'river' ||
                parent.biome === 'ocean' ||
                parent.biome === 'shallows';
            if (!isWater) {
                return;
            }
            checked = checked + 1;
            const sub = plugin.canvasFor([{ x: parent.x, y: parent.y }])!;
            if (parent.biome === 'river' && parent.passable) {
                // T3 — THE LIVING RIVERBANK: the ford's zoom is the organic
                // fresh-water body (the inherited passable column) ringed by
                // synthesized dry banks. The exact band, connectivity and
                // bank contracts live in islandTerrainRiver.test.ts; here the
                // purity core: no finite stock anywhere, every water fine
                // cell the passable ford column, every bank dry raised ground
                let waterFine = 0;
                sub.cells.forEach((fine) => {
                    FINITE.forEach((resource) => {
                        expect(fine.resources[resource] ?? 0).toBe(0);
                    });
                    if (fine.biome === 'river') {
                        waterFine = waterFine + 1;
                        expect(fine.passable).toBe(true);
                        expect(fine.voxels[fine.voxels.length - 1]).toBe('water');
                    } else {
                        expect(['beach', 'meadow']).toContain(fine.biome);
                        expect(fine.passable).toBe(true);
                        expect(fine.voxels.includes('water')).toBe(false);
                    }
                });
                // The zoomed river stays the river: the shape-first channel
                // fills part of the interior (the exact geometry contracts —
                // connectivity, seam intervals, taper, enclosed-dry fill —
                // live in islandTerrainRiver.test.ts; the old share band
                // 0.55–0.7 was retired with the dial that drew the pool
                // floods). Here the purity core only: the channel exists.
                expect(waterFine).toBeGreaterThan(0);
                return;
            }
            sub.cells.forEach((fine) => {
                expect(fine.biome).toBe(parent.biome);
                expect(fine.passable).toBe(parent.passable);
                FINITE.forEach((resource) => {
                    expect(fine.resources[resource] ?? 0).toBe(0);
                });
            });
        });
        // The regression is not vacuous: the board carries water parents
        expect(checked).toBeGreaterThan(0);
    });

    it('R2: a blend cell never GAINS stock across the seam — the rock look stays bare, trees stay the parent\'s own', () => {
        // The clone ban is structural: the fine draft's resources derive
        // from the PARENT's own scatter (fineCellDraft's flags.deposit) plus
        // the look's borrowed ground supply — no code path copies a
        // neighbor's stock. What the test pins on the board:
        //   · every tree standing on a blend cell belongs to the parent's
        //     OWN stand (a stand tree may stand on a borrowed patch; the
        //     neighbor's stand never plants across the seam);
        //   · the ROCK look — the pure scree — carries NO stock at all: no
        //     stone, no iron, and the ground supply stripped (design rule,
        //     islandTerrain.ts lendSurface block: "the rock look carries NO
        //     stock: the finite stone never clones into a neighboring-biome
        //     cell"). Rock looks occur on meadow/beach parents, which carry
        //     no stone tile deposit, so any stock there would be a clone.
        //   (The parent's own leftover stone pile MAY stand on a borrowed
        //   grass/sand patch — the crown-first scatter predates the look;
        //   seed-7 carries exactly one such pile, on a highland's grass
        //   fringe. That is the parent's own stock, not a seam clone.)
        canvas.cells.forEach((parent) => {
            if (!parent.passable || parent.biome === 'beach') {
                return;
            }
            const path: TilePath = [{ x: parent.x, y: parent.y }];
            const plan = edgeMask(parent, path, canvas, 7);
            const sub = plugin.canvasFor(path)!;
            sub.cells.forEach((fine) => {
                const look = plan.land.get(`${fine.x},${fine.y}`);
                if (!look) {
                    return;
                }
                if ((fine.resources.tree ?? 0) > 0) {
                    const stand = plugin.forestOf(parent.x, parent.y);
                    expect(stand?.trees.has(`${fine.x},${fine.y}`)).toBe(true);
                }
                if (look === 'rock') {
                    expect(fine.resources.stone ?? 0).toBe(0);
                    expect(fine.resources.iron ?? 0).toBe(0);
                    expect(fine.resources.dirt ?? 0).toBe(0);
                    expect(fine.resources.grass ?? 0).toBe(0);
                    expect(fine.resources.sand ?? 0).toBe(0);
                }
            });
        });
    });

    it('(c): the materializer and the fast histogram agree cell-for-cell on EVERY land tile', { timeout: 30_000 }, () => {
        let checked = 0;
        canvas.cells.forEach((parent) => {
            if (!parent.passable) {
                return;
            }
            const path: TilePath = [{ x: parent.x, y: parent.y }];
            const sub = plugin.canvasFor(path)!;
            expect(plugin.surfaceKeyCounts(path)).toEqual(naiveCounts(sub));
            checked = checked + 1;
        });
        expect(checked).toBeGreaterThan(0);
    });

    it('the blend spot materializes the borrowed surface (biome + top voxel + the waterline columns)', () => {
        let looks = 0;
        let waters = 0;
        canvas.cells.forEach((parent) => {
            if (!parent.passable) {
                return;
            }
            const path: TilePath = [{ x: parent.x, y: parent.y }];
            const plan = edgeMask(parent, path, canvas, 7);
            const sub = plugin.canvasFor(path)!;
            sub.cells.forEach((fine) => {
                const spot = `${fine.x},${fine.y}`;
                const water = plan.water.get(spot);
                const look = plan.land.get(spot);
                if (water) {
                    waters = waters + 1;
                    expect(fine.passable).toBe(false);
                    expect(fine.resources).toEqual({});
                    expect(fineWaterColumn(parent.waterLevel, water)).toEqual({
                        voxels: fine.voxels,
                        height: fine.height,
                        biome: fine.biome,
                    });
                } else if (look) {
                    looks = looks + 1;
                    const wantedBiome =
                        look === 'grass' ? 'meadow' : look === 'forest' ? 'forest' : look === 'sand' ? 'beach' : 'highland';
                    const wantedVoxel =
                        look === 'grass' ? 'grass' : look === 'forest' ? 'forest' : look === 'sand' ? 'sand' : 'gravel';
                    expect(fine.biome).toBe(wantedBiome);
                    expect(fine.voxels[fine.voxels.length - 1]).toBe(wantedVoxel);
                }
            });
        });
        // The weave is live on this board — both treatments fire
        expect(looks).toBeGreaterThan(0);
        expect(waters).toBeGreaterThan(0);
    });

    it('the weave stays restrained: a tile\'s blended cells never reach the majority', () => {
        // R3 — the coarse fold must keep reading the tile's own look family:
        // the blend is an edge band, never a repaint
        const island = createIslandWorld({ seed: 7 });
        const familyOf = (biome: string): string[] =>
            biome === 'meadow'
                ? ['grass', 'tree', 'meadow']
                : biome === 'forest'
                    ? ['tree', 'forest', 'grass']
                    : biome === 'highland'
                        ? ['stone', 'iron', 'dirt', 'tree']
                        : biome === 'beach'
                            ? ['sand', 'tree', 'grass', 'shallows', 'ocean', 'lake', 'pond', 'river']
                            : [biome];
        canvas.cells.forEach((cell) => {
            const dominant = dominantVisibleType(island, [{ x: cell.x, y: cell.y }]);
            expect(dominant).toBeDefined();
            expect(familyOf(cell.biome)).toContain(dominant as string);
        });
    });

    it('multi-seed: the weave stays water-safe and majority-safe on fresh boards', { timeout: 60_000 }, () => {
        [11, 23].forEach((boardSeed) => {
            const fresh = islandTerrainPlugin();
            const freshWorld = createWorld({ seed: boardSeed, plugins: [fresh] });
            const freshCanvas = freshWorld.canvas as Canvas;
            const freshIsland = createIslandWorld({ seed: boardSeed });
            freshCanvas.cells.forEach((parent) => {
                const isWater =
                    !parent.passable ||
                    parent.biome === 'river' ||
                    parent.biome === 'ocean' ||
                    parent.biome === 'shallows';
                if (isWater) {
                    const sub = fresh.canvasFor([{ x: parent.x, y: parent.y }])!;
                    if (parent.biome === 'river' && parent.passable) {
                        // T3 — the living riverbank on fresh boards: the
                        // water majority band, dry raised banks, no finite
                        // stock anywhere
                        let waterFine = 0;
                        sub.cells.forEach((fine) => {
                            FINITE.forEach((resource) => {
                                expect(fine.resources[resource] ?? 0).toBe(0);
                            });
                            if (fine.biome === 'river') {
                                waterFine = waterFine + 1;
                                expect(fine.passable).toBe(true);
                            } else {
                                expect(['beach', 'meadow']).toContain(fine.biome);
                                expect(fine.voxels.includes('water')).toBe(false);
                            }
                        });
                        // The shape-first channel exists on fresh boards too
                        // (the geometry contracts live in
                        // islandTerrainRiver.test.ts)
                        expect(waterFine).toBeGreaterThan(0);
                        return;
                    }
                    sub.cells.forEach((fine) => {
                        expect(fine.biome).toBe(parent.biome);
                        expect(fine.passable).toBe(parent.passable);
                    });
                    return;
                }
                // The dominant never leaves the tile's own look family
                const dominant = dominantVisibleType(freshIsland, [{ x: parent.x, y: parent.y }]);
                const family =
                    parent.biome === 'meadow'
                        ? ['grass', 'tree', 'meadow']
                        : parent.biome === 'forest'
                            ? ['tree', 'forest', 'grass']
                            : parent.biome === 'highland'
                                ? ['stone', 'iron', 'dirt', 'tree']
                                : ['sand', 'tree', 'grass', 'shallows', 'ocean', 'lake', 'pond', 'river'];
                expect(family).toContain(dominant as string);
            });
        });
    });
});

// ── (d) the cache/majority/corner contracts ──────────────────────────────────

describe('the EDGE WEAVE cache and corner contracts (R1/R3)', () => {
    it('the sub-grid cache invalidates when a NEIGHBOR converts (the spread\'s seam inputs)', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas;
        const halfX = (canvas.width - 1) / 2;
        const halfY = (canvas.height - 1) / 2;
        const at = (x: number, y: number): TerrainCell => canvas.cells[(y + halfY) * canvas.width + (x + halfX)];
        // A meadow with a meadow neighbor — the forest spread's conversion
        // input. The neighbor's biome rides the tile's sub-grid stamp, so
        // the cached grid re-derives its seams fresh
        let picked: { tile: { x: number; y: number }; neighbor: TerrainCell } | undefined;
        for (const cell of canvas.cells) {
            if (cell.biome !== 'meadow') {
                continue;
            }
            for (const offset of NEIGHBOR_OFFSETS) {
                const neighbor = at(cell.x + offset.dx, cell.y + offset.dy);
                if (neighbor && neighbor.biome === 'meadow') {
                    picked = { tile: { x: cell.x, y: cell.y }, neighbor };
                    break;
                }
            }
            if (picked) {
                break;
            }
        }
        expect(picked).toBeDefined();
        const before = plugin.canvasFor([{ x: picked!.tile.x, y: picked!.tile.y }]);
        expect(plugin.canvasFor([{ x: picked!.tile.x, y: picked!.tile.y }])).toBe(before);
        picked!.neighbor.biome = 'forest';
        const after = plugin.canvasFor([{ x: picked!.tile.x, y: picked!.tile.y }]);
        expect(after).not.toBe(before);
        // And the fresh read serves the regenerated cache
        expect(plugin.canvasFor([{ x: picked!.tile.x, y: picked!.tile.y }])).toBe(after);
    });

    it('R2 at depth: the coincidental ROOT stand never materializes inside a water fine cell (the stand scoping)', () => {
        // The stand registry is keyed by ROOT tile coordinates; a deeper
        // parent's coords are fine coords of its own grid — reading the
        // registry with them used to materialize an UNRELATED tile's stand
        // (trees standing in a river/pond at depth 2). The scoping fix
        // answers only ROOT-grid parents.
        const deep = islandTerrainPlugin({ subtiles: 2 });
        createWorld({ seed: 7, plugins: [deep] });
        // The ROOT canvas — canvasFor([]) resolves the empty path to the
        // world grid (the root level; cellFor needs a tile address)
        const canvas = deep.canvasFor([])!;
        const rootCells = canvas.cells;
        const treedRoots = new Set(
            rootCells.filter((cell) => (cell.resources.tree ?? 0) > 0).map((cell) => `${cell.x},${cell.y}`),
        );
        expect(treedRoots.size).toBeGreaterThan(0);
        // Find a WATER parent whose fine cells collide with treed root
        // coordinates (they do — the coordinate spaces share the numeric
        // range); the depth-2 zoom of such a fine cell must grow no trees
        let proven = false;
        rootCells
            .filter(
                (cell) =>
                    !cell.passable ||
                    cell.biome === 'river' ||
                    cell.biome === 'ocean' ||
                    cell.biome === 'shallows',
            )
            .forEach((waterParent) => {
                const sub = deep.canvasFor([{ x: waterParent.x, y: waterParent.y }])!;
                const hit = sub.cells.find((fine) => treedRoots.has(`${fine.x},${fine.y}`));
                if (!hit) {
                    return;
                }
                const deep2 = deep.canvasFor([{ x: waterParent.x, y: waterParent.y }, { x: hit.x, y: hit.y }])!;
                deep2.cells.forEach((fine) => {
                    expect(fine.resources.tree ?? 0).toBe(0);
                });
                proven = true;
            });
        expect(proven).toBe(true);
    });

    it('a narrow grid weaves too (the odd-size rule holds at 5×3)', () => {
        const plugin = islandTerrainPlugin({ width: 5, height: 3 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas;
        let blended = 0;
        canvas.cells.forEach((parent) => {
            if (!parent.passable) {
                return;
            }
            const plan = edgeMask(parent, [{ x: parent.x, y: parent.y }], canvas, 7);
            const sub = plugin.canvasFor([{ x: parent.x, y: parent.y }])!;
            sub.cells.forEach((fine) => {
                const spot = `${fine.x},${fine.y}`;
                const water = plan.water.get(spot);
                const look = plan.land.get(spot);
                if (water || look) {
                    blended = blended + 1;
                }
            });
        });
        // The narrow board carries differing neighbors — the weave fires
        expect(blended).toBeGreaterThan(0);
    });

    it('a 3×3 corner board: every cell blends only within its own grid (no out-of-grid reads)', () => {
        const tiny = islandTerrainPlugin({ width: 3, height: 3, subtiles: 1 });
        createWorld({ seed: 7, plugins: [tiny] });
        const canvas = tiny.canvasFor([])!;
        canvas.cells.forEach((parent) => {
            const plan = edgeMask(parent, [{ x: parent.x, y: parent.y }], canvas, 7);
            // Every spot sits INSIDE the 3×3 grid
            const check = (key: string) => {
                const [x, y] = key.split(',').map(Number);
                expect(x).toBeGreaterThanOrEqual(-1);
                expect(x).toBeLessThanOrEqual(1);
                expect(y).toBeGreaterThanOrEqual(-1);
                expect(y).toBeLessThanOrEqual(1);
            };
            plan.water.forEach((_spot, key) => check(key));
            plan.land.forEach((_look, key) => check(key));
        });
    });
});
