// Regression tests for the scale-0 SHORE (R1 — the realistic mixed
// water/sand shore): the shore mask (the deterministic waterline a beach
// tile's zoomed interior carries toward its water neighbors), the fine
// water column (the real sea-shaped column a masked spot materializes as),
// and the plugin-level agreement — the materialized sub-grid, the pure mask
// and the surfaceKeyCounts histogram must all agree cell-for-cell.
//
// The unit half runs on HAND-BUILT 7×5 canvases (the mask reads the parent's
// in-grid neighbors off parentCanvas; the sub-grid dims equal the parent
// canvas dims), so every expected value is derived from the mask's own rule
// block, not from a captured run. The integration half runs on the seed-7
// default island and asserts the three readers agree on EVERY beach tile.

import { describe, it, expect } from 'vitest';
import {
    SHORE_DEEP_LAYERS,
    SHORE_WATER_CAP,
    fineWaterColumn,
    islandTerrainPlugin,
    shoreMask,
    tileSurfaceKey,
    type ShoreWater,
} from './islandTerrain';
import { createWorld } from '../../engine/world';
import { NEIGHBOR_OFFSETS, randomKeyed, tilePathKey, type TilePath } from '@godspace/core';
import type { Biome, Canvas, TerrainCell } from '../../engine/types';

// ── Hand-built fixture helpers ───────────────────────────────────────────────

/** A column for a hand-built canvas: a dry land tile or an impassable water tile. */
const column = (biome: Biome, passable: boolean, waterLevel = 3): TerrainCell => ({
    x: 0,
    y: 0,
    voxels: passable ? ['dirt', 'sand'] : ['sand', 'water'],
    height: passable ? 3 : 2,
    waterLevel,
    biome,
    passable,
    resources: {},
});

/** A 7×5 (default) or sized canvas of land columns with specific overrides. */
const grid = (
    overrides: Array<{ x: number; y: number; cell: TerrainCell }>,
    width = 7,
    height = 5,
    base: TerrainCell = column('meadow', true),
): Canvas => {
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    const cells: TerrainCell[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            cells.push({ ...base });
        }
    }
    const canvas: Canvas = { width, height, cells };
    overrides.forEach(({ x, y, cell }) => {
        canvas.cells[(y + halfY) * width + (x + halfX)] = cell;
    });
    return canvas;
};

/** The centered beach parent of a fixture grid. */
const beachParent = (waterLevel = 3): TerrainCell => column('beach', true, waterLevel);

describe('islandTerrain — the scale-0 shore mask (R1)', () => {
    it('carries the documented cap and deep-layer constants', () => {
        // The land-majority cap: a shore never drowns more than 40% of its
        // interior; a deep waterline reaches two layers (the waterline plus
        // the wave-gated shallows tongue)
        expect(SHORE_WATER_CAP).toBe(0.4);
        expect(SHORE_DEEP_LAYERS).toBe(2);
    });

    it('opens a FULL one-voxel waterline row toward a cardinal shallows neighbor', () => {
        const parent = beachParent();
        const canvas = grid([{ x: 0, y: -1, cell: column('shallows', false) }], 7, 5, parent);
        const mask = shoreMask(parent, 'p', canvas, 7);
        // The exact mask: every fine cell of the shared north edge, one
        // voxel deep, no basin, nothing else
        const expected = new Map<string, ShoreWater>();
        for (let x = -3; x <= 3; x++) {
            expected.set(`${x},-2`, { depth: 1 });
        }
        expect(mask).toEqual(expected);
    });

    it('opens a FULL two-voxel waterline column toward a cardinal ocean neighbor, plus its wave-gated inland tongue', () => {
        const parent = beachParent();
        const canvas = grid([{ x: 1, y: 0, cell: column('ocean', false) }], 7, 5, parent);
        const mask = shoreMask(parent, 'p', canvas, 7);
        // THE WATERLINE — the shared east edge, FULL, two voxels deep
        for (let y = -2; y <= 2; y++) {
            expect(mask.get(`3,${y}`)).toEqual({ depth: 2 });
        }
        // THE TONGUE — the wave-gated extension lives only on the single
        // inland column (x = +2), one voxel deep, exactly where the edge's
        // own keyed wave runs positive. The wave is re-derived here from the
        // documented stream (the SAME stream read shoreMask consumes) — the
        // sine's positive ARCS are contiguous runs (a bay of runs, never
        // single-cell speckle), so the expected set is the arcs' spots.
        const expectedTongue: number[] = [];
        {
            const stream = randomKeyed(7, 'shore:p:E');
            const phase = stream() * Math.PI * 2;
            const cycles = 1 + Math.floor(stream() * 2);
            for (let y = -2; y <= 2; y++) {
                const wave = Math.sin(phase + (2 * Math.PI * cycles * (y + 2)) / 5);
                if (wave > 0) {
                    expectedTongue.push(y);
                }
            }
        }
        const tongue: number[] = [];
        for (let y = -2; y <= 2; y++) {
            const spot = mask.get(`2,${y}`);
            if (spot) {
                expect(spot).toEqual({ depth: 1 });
                tongue.push(y);
            }
        }
        expect(tongue).toEqual(expectedTongue);
        expect(tongue.length).toBeGreaterThan(0);
        // The land-majority cap holds: waterline 5 + tongue ≤ 14
        expect(mask.size).toBeLessThanOrEqual(Math.floor(SHORE_WATER_CAP * 7 * 5));
        // DETERMINISM — the wave stream is keyed, the same inputs give the
        // exact same mask
        expect(shoreMask(parent, 'p', canvas, 7)).toEqual(mask);
    });

    it('carves the corner wedge toward a diagonal water neighbor — corner plus two flanks', () => {
        const parent = beachParent();
        // NE ocean: the corner cell keeps the deep depth, its two flanks run
        // one voxel along each edge sharing the corner
        const ne = grid([{ x: 1, y: -1, cell: column('ocean', false) }], 7, 5, parent);
        expect(shoreMask(beachParent(), 'p', ne, 7)).toEqual(
            new Map<string, ShoreWater>([
                ['3,-2', { depth: 2 }],
                ['2,-2', { depth: 1 }],
                ['3,-1', { depth: 1 }],
            ]),
        );
        // SW lake: the fresh basin lends its own biome to every wedge spot
        const sw = grid([{ x: -1, y: 1, cell: column('lake', false) }], 7, 5, beachParent());
        expect(shoreMask(beachParent(), 'p', sw, 7)).toEqual(
            new Map<string, ShoreWater>([
                ['-3,2', { depth: 1, basin: 'lake' }],
                ['-2,2', { depth: 1, basin: 'lake' }],
                ['-3,1', { depth: 1, basin: 'lake' }],
            ]),
        );
    });

    it('shapes an inland sand flat nothing — no water neighbor, no shore', () => {
        const parent = beachParent();
        const canvas = grid([], 7, 5, parent);
        expect(shoreMask(parent, 'p', canvas, 7)).toEqual(new Map());
    });

    it('only DRY SAND shores shape — an impassable or non-beach parent masks nothing', () => {
        const canvas = grid([{ x: 0, y: -1, cell: column('ocean', false) }], 7, 5, column('beach', true));
        // A drowned (impassable) beach-shaped column is sea, not shore
        const drowned = column('beach', false);
        expect(shoreMask(drowned, 'p', canvas, 7)).toEqual(new Map());
        // A meadow beside the sea is not a beach — no waterline
        const meadow = column('meadow', true);
        expect(shoreMask(meadow, 'p', canvas, 7)).toEqual(new Map());
    });

    it('keeps the shore land-majority: the cap truncates whole edges, land always wins', () => {
        const parent = beachParent();
        // ALL FOUR cardinals shallow: the waterlines total 7+5+7+5 = 24
        // against the 14-spot cap (floor(0.4 × 35)) — the fixed
        // NEIGHBOR_OFFSETS fill order keeps the first two (north row 7,
        // east column 5 = 12 ≤ 14) and drops south and west whole
        const canvas = grid(
            [
                { x: 0, y: -1, cell: column('shallows', false) },
                { x: 1, y: 0, cell: column('shallows', false) },
                { x: 0, y: 1, cell: column('shallows', false) },
                { x: -1, y: 0, cell: column('shallows', false) },
            ],
            7,
            5,
            parent,
        );
        const mask = shoreMask(parent, 'p', canvas, 7);
        const expected = new Map<string, ShoreWater>();
        for (let x = -3; x <= 3; x++) {
            expected.set(`${x},-2`, { depth: 1 });
        }
        for (let y = -2; y <= 2; y++) {
            expected.set(`3,${y}`, { depth: 1 });
        }
        expect(mask).toEqual(expected);
        // LAND REMAINS — 24 of 35 fine cells stay dry land (the north row's
        // east corner (3,-2) and the east column's north end are the SAME
        // spot — the deeper-water-wins put dedupes the shared corner, so
        // the two kept waterlines hold 7 + 5 − 1 = 11 unique water spots)
        expect(mask.size).toBe(11);
        expect(35 - mask.size).toBe(24);
    });

    it('lends a cardinal basin neighbor its own fresh biome at one voxel', () => {
        const parent = beachParent();
        const canvas = grid([{ x: 0, y: 1, cell: column('pond', false) }], 7, 5, parent);
        const mask = shoreMask(parent, 'p', canvas, 7);
        const expected = new Map<string, ShoreWater>();
        for (let x = -3; x <= 3; x++) {
            expected.set(`${x},2`, { depth: 1, basin: 'pond' });
        }
        expect(mask).toEqual(expected);
    });
});

describe('islandTerrain — fineWaterColumn, the sea-shaped fine column', () => {
    it('builds the exact shallows rim column (one voxel of water over the lowered seabed)', () => {
        expect(fineWaterColumn(3, { depth: 1 })).toEqual({
            voxels: ['dirt', 'sand', 'water'],
            height: 2,
            biome: 'shallows',
        });
    });

    it('builds the exact ocean-deep column (two voxels of water)', () => {
        expect(fineWaterColumn(3, { depth: 2 })).toEqual({
            voxels: ['sand', 'water', 'water'],
            height: 1,
            biome: 'ocean',
        });
    });

    it('keeps ONE water voxel on a fresh-basin spot and lends the basin biome', () => {
        expect(fineWaterColumn(3, { depth: 2, basin: 'lake' })).toEqual({
            voxels: ['sand', 'water', 'water'],
            height: 1,
            biome: 'lake',
        });
        expect(fineWaterColumn(3, { depth: 1, basin: 'pond' })).toEqual({
            voxels: ['dirt', 'sand', 'water'],
            height: 2,
            biome: 'pond',
        });
    });

    it('lays the gravel bedrock + dirt underlayer on a deeper shore', () => {
        // waterLevel 5, one voxel of water: ground 4 — gravel ×(4−2), dirt,
        // sand, then the water
        expect(fineWaterColumn(5, { depth: 1 })).toEqual({
            voxels: ['gravel', 'gravel', 'dirt', 'sand', 'water'],
            height: 4,
            biome: 'shallows',
        });
    });
});

// ── Plugin integration: the three readers agree on the seed-7 island ────────

describe('islandTerrain — the R1 shore agreement on the generated island', () => {
    /** The independent reference census of a MATERIALIZED grid's keys. */
    const naiveCounts = (cells: TerrainCell[]) => {
        const counts = new Map<string, { key: string; count: number; first: number; last: number }>();
        cells.forEach((cell, index) => {
            const key = tileSurfaceKey(cell);
            if (key === undefined) {
                return;
            }
            const record = counts.get(key);
            if (record) {
                record.count = record.count + 1;
                record.last = index;
                return;
            }
            counts.set(key, { key, count: 1, first: index, last: index });
        });
        return [...counts.values()];
    };

    it('materializes every masked shore spot as real water and keeps every unmasked cell inherited', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        const cap = Math.floor(SHORE_WATER_CAP * canvas.width * canvas.height);
        let shores = 0;
        canvas.cells.forEach((parent) => {
            if (parent.biome !== 'beach' || !parent.passable) {
                return;
            }
            // Only tiles that actually face water carry a mask
            const facesWater = NEIGHBOR_OFFSETS.some((offset) => {
                const neighbor = world.cellAt(parent.x + offset.dx, parent.y + offset.dy);
                return neighbor !== undefined && !neighbor.passable;
            });
            const path: TilePath = [{ x: parent.x, y: parent.y }];
            const mask = shoreMask(parent, tilePathKey(path), canvas, 7);
            if (!facesWater) {
                // An inland sand flat shapes nothing
                expect(mask.size).toBe(0);
                return;
            }
            shores = shores + 1;
            // THE LAND-MAJORITY CAP — the coarse tile keeps its sand look
            expect(mask.size).toBeLessThanOrEqual(cap);
            const sub = plugin.canvasFor(path);
            if (!sub) {
                throw new Error(`no sub-grid for the beach tile ${parent.x},${parent.y}`);
            }
            const halfX = (sub.width - 1) / 2;
            const halfY = (sub.height - 1) / 2;
            sub.cells.forEach((fine) => {
                const spot = mask.get(`${fine.x},${fine.y}`);
                if (spot) {
                    // The masked spot is REAL water: impassable,
                    // deposit-free, the exact sea-shaped column
                    expect(fine.passable).toBe(false);
                    expect(fine.resources).toEqual({});
                    expect(fineWaterColumn(parent.waterLevel, spot)).toEqual({
                        voxels: fine.voxels,
                        height: fine.height,
                        biome: fine.biome,
                    });
                } else {
                    // The unmasked cell inherits its parent exactly
                    expect(fine.passable).toBe(parent.passable);
                    expect(fine.biome).toBe(parent.biome);
                }
            });
        });
        // The seed-7 island actually carries shaped shores — the regression
        // is not vacuous
        expect(shores).toBeGreaterThan(0);
    });

    it('counts the children EXACTLY — the histogram agrees with the materialized grid on every shore', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        // EVERY beach tile (shaped or not) plus fixed controls: the highland
        // rock site, an interior lake and an ingress meadow
        const addresses: TilePath[] = canvas.cells
            .filter((cell) => cell.biome === 'beach')
            .map((cell) => [{ x: cell.x, y: cell.y }]);
        [
            { x: 0, y: 0 },
            { x: 1, y: -4 },
            { x: -1, y: -1 },
        ].forEach((spot) => addresses.push([spot]));
        addresses.forEach((path) => {
            const sub = plugin.canvasFor(path);
            if (!sub) {
                throw new Error(`no sub-grid at ${tilePathKey(path)}`);
            }
            expect(plugin.surfaceKeyCounts(path)).toEqual(naiveCounts(sub.cells));
        });
    });

    it('never shapes a non-beach parent — woods, meadows and rock zoom pure', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const control = (spot: { x: number; y: number }) => {
            const parent = world.cellAt(spot.x, spot.y);
            if (!parent || !parent.passable) {
                return;
            }
            const sub = plugin.canvasFor([spot]);
            if (!sub) {
                throw new Error('no sub-grid');
            }
            sub.cells.forEach((fine) => {
                expect(fine.passable).toBe(parent.passable);
                expect(fine.biome).toBe(parent.biome);
            });
        };
        // A forest interior, a highland peak, an inland meadow
        control({ x: 0, y: 0 });
        control({ x: 1, y: -2 });
        control({ x: -1, y: -1 });
    });
});
