// Tests for the scale-0 RIVER FINE MASK (T3 — the living riverbank).
//
// The user's rule: land creeps onto rivers. A river tile's zoomed interior is
// no longer a solid ford block — the coarse channel widens into an organic
// fresh-water body (about 60–70% water) ringed by synthesized DRY banks, with
// seeded islands in the flood. This file owns the exact T3 contracts:
//
//   (a) the tuning constants and the mask's determinism/seed-variation;
//   (b) the 60–70% water band across fresh seeds on the default grid (the
//       exact midpoint count 276/425 — the growth lands every normal river
//       tile on the target) and the tiny-grid rounding tolerance;
//   (c) cardinal water connectivity WITHIN each river fine grid (one
//       connected body) and ACROSS its edges (the shared neighbor exits:
//       river↔river borders meet water on water, the sea mouth fans onto the
//       sea's inherited water, the basins alike);
//   (d) LAND AT THE BOUNDARIES: every dry neighbor holds a bank row (the two
//       corner cells may go to a perpendicular water edge — deeper water
//       wins), and the SEEDED ISLANDS (dry cells the flood surrounded);
//   (e) the synthesized bank columns: raised dry ground, NO water voxel, the
//       bank's own ground supply, NO finite stock and no tree;
//   (f) the fine fords: every water fine cell is the parent's passable
//       column (terrain.cellFor reads biome 'river' — the other plugins'
//       contract), deposits/tree never clone;
//   (g) the materializer/histogram parity on river tiles (the shared
//       fineCellDraft/riverBankColumn builders) and the majority still river.
//
// Unit half: riverBankColumn. Integration half: full worlds across seeds
// (the plugin is the same terrain+engine stack the other terrain tests use —
// no changing dependencies).

import { describe, it, expect } from 'vitest';
import {
    islandTerrainPlugin,
    riverBankColumn,
    riverFineMask,
    RIVER_FINE_NOISE_SCALE,
    RIVER_FINE_WATER_TARGET,
    tileSurfaceKey,
    type RiverBank,
} from './islandTerrain';
import { createWorld } from '../../engine/world';
import { NEIGHBOR_OFFSETS, tilePathKey, type TilePath } from '@godspace/core';
import type { Canvas, TerrainCell } from '../../engine/types';

// ── helpers ──────────────────────────────────────────────────────────────────

/** The four cardinal steps — the only neighbors that share an edge. */
const CARDINALS: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** The centered cell read on an arbitrary canvas (the plugin's cellOn twin). */
const cellOn = (canvas: Canvas, x: number, y: number): TerrainCell | undefined => {
    const halfX = (canvas.width - 1) / 2;
    const halfY = (canvas.height - 1) / 2;
    if (y < -halfY || y > halfY || x < -halfX || x > halfX) {
        return undefined;
    }
    return canvas.cells[(y + halfY) * canvas.width + (x + halfX)];
};

/** Whether a coarse biome is water the channel can flow across. */
const isChannelWater = (biome: string): boolean =>
    biome === 'river' || biome === 'ocean' || biome === 'shallows' || biome === 'lake' || biome === 'pond';

/** One river tile's zoom plan plus the derived predicates the tests assert with. */
type RiverZoom = {
    parent: TerrainCell;
    mask: Map<string, RiverBank>;
    total: number;
    halfX: number;
    halfY: number;
    isWater: (x: number, y: number) => boolean;
    waterCount: number;
};

const zoomOf = (canvas: Canvas, parent: TerrainCell, seed: number): RiverZoom => {
    const width = canvas.width;
    const height = canvas.height;
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    const total = width * height;
    const mask = riverFineMask(parent, tilePathKey([{ x: parent.x, y: parent.y }]), canvas, seed);
    const isWater = (x: number, y: number): boolean => {
        if (y < -halfY || y > halfY || x < -halfX || x > halfX) {
            return false;
        }
        return !mask.has(`${x},${y}`);
    };
    return { parent, mask, total, halfX, halfY, isWater, waterCount: total - mask.size };
};

/** Floods the fine water over cardinal steps from one water cell. */
const floodWater = (zoom: RiverZoom): number => {
    let start: string | undefined;
    for (let y = -zoom.halfY; y <= zoom.halfY && !start; y++) {
        for (let x = -zoom.halfX; x <= zoom.halfX; x++) {
            if (zoom.isWater(x, y)) {
                start = `${x},${y}`;
                break;
            }
        }
    }
    if (!start) {
        return 0;
    }
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
        const current = queue.shift()!;
        const [cx, cy] = current.split(',').map(Number);
        CARDINALS.forEach(([dx, dy]) => {
            const key = `${cx + dx},${cy + dy}`;
            if (zoom.isWater(cx + dx, cy + dy) && !seen.has(key)) {
                seen.add(key);
                queue.push(key);
            }
        });
    }
    return seen.size;
};

/** The count of bank cells the flood fully surrounded (off-boundary islands). */
const islandCount = (zoom: RiverZoom): number => {
    let islands = 0;
    zoom.mask.forEach((_spot, key) => {
        const [x, y] = key.split(',').map(Number);
        if (Math.abs(x) === zoom.halfX || Math.abs(y) === zoom.halfY) {
            return;
        }
        if (NEIGHBOR_OFFSETS.every((offset) => zoom.isWater(x + offset.dx, y + offset.dy))) {
            islands = islands + 1;
        }
    });
    return islands;
};

/** The exact fine-grid census of a materialized sub-grid (the parity reference). */
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
            return;
        }
        counts.set(key, { key, count: 1, first: index, last: index });
    });
    return [...counts.values()];
};

// ── (a) the tuning + determinism ─────────────────────────────────────────────

describe('riverFineMask — the tuning constants and determinism (T3)', () => {
    it('carries the documented tuning constants', () => {
        // The 60–70% band's midpoint and the organic blob scale
        expect(RIVER_FINE_WATER_TARGET).toBe(0.65);
        expect(RIVER_FINE_NOISE_SCALE).toBe(3);
    });

    it('is deterministic: the same seed derives the identical plan; another seed differs', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        const parent = canvas.cells.find((cell) => cell.biome === 'river')!;
        const key = tilePathKey([{ x: parent.x, y: parent.y }]);
        const serialize = (mask: Map<string, RiverBank>): string =>
            [...mask.entries()]
                .sort((left, right) => (left[0] > right[0] ? 1 : left[0] < right[0] ? -1 : 0))
                .map(([spot, bank]) => `${spot}:${bank.surface}`)
                .join(';');
        expect(serialize(riverFineMask(parent, key, canvas, 7))).toBe(
            serialize(riverFineMask(parent, key, canvas, 7)),
        );
        // The fresh seed re-rolls the flood (the plan is seed-varying)
        expect(serialize(riverFineMask(parent, key, canvas, 8))).not.toBe(serialize(riverFineMask(parent, key, canvas, 7)));
    });
});

// ── (b) the water band ───────────────────────────────────────────────────────

describe('riverFineMask — the 60–70% water band (T3)', () => {
    it('lands every river tile of the default grid exactly on the target count, across fresh seeds', () => {
        // Math.round(RIVER_FINE_WATER_TARGET × 425) = 276 — the growth
        // admits to the target on every edge plan (the frontier cannot dry
        // before it: the free interior always outnumbers the remaining
        // admissions), so the band holds with the exact midpoint count
        const target = Math.round(RIVER_FINE_WATER_TARGET * 25 * 17);
        expect(target).toBe(276);
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const plugin = islandTerrainPlugin();
            const world = createWorld({ seed, plugins: [plugin] });
            const canvas = world.canvas as Canvas;
            const rivers = canvas.cells.filter((cell) => cell.biome === 'river' && cell.passable);
            expect(rivers.length).toBeGreaterThan(0);
            rivers.forEach((parent) => {
                const zoom = zoomOf(canvas, parent, seed);
                expect(zoom.waterCount).toBe(276);
            });
        }
    });

    it('the zoomed river keeps the RIVER the majority key (the coarse fold still reads river)', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        canvas.cells
            .filter((cell) => cell.biome === 'river' && cell.passable)
            .forEach((parent) => {
                const path: TilePath = [{ x: parent.x, y: parent.y }];
                const counts = plugin.surfaceKeyCounts(path)!;
                const river = counts.find((entry) => entry.key === 'river')!;
                counts.forEach((entry) => {
                    if (entry.key !== 'river') {
                        expect(river.count).toBeGreaterThan(entry.count);
                    }
                });
            });
    });

    it('tiny grids keep the water the majority (the rounding tolerance)', () => {
        // The 7×5 board's river tiles: 23/35 and 22/35 — rounding + the
        // forced edge plans keep the flood above half even at 35 cells
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        const rivers = canvas.cells.filter((cell) => cell.biome === 'river' && cell.passable);
        expect(rivers.map((cell) => [cell.x, cell.y])).toEqual([
            [-1, -1],
            [-1, 0],
        ]);
        const counts = rivers.map((parent) => zoomOf(canvas, parent, 7).waterCount);
        expect(counts).toEqual([23, 22]);
        counts.forEach((count) => {
            expect(count * 2).toBeGreaterThan(7 * 5);
        });
    });
});

// ── (c) the connectivity + shared exits ──────────────────────────────────────

describe('riverFineMask — cardinal connectivity and the shared neighbor exits (T3)', () => {
    it('the fine water is ONE cardinally connected body in every river tile (multi-seed)', () => {
        for (const seed of [7, 11]) {
            const plugin = islandTerrainPlugin();
            const world = createWorld({ seed, plugins: [plugin] });
            const canvas = world.canvas as Canvas;
            canvas.cells
                .filter((cell) => cell.biome === 'river' && cell.passable)
                .forEach((parent) => {
                    const zoom = zoomOf(canvas, parent, seed);
                    expect(floodWater(zoom)).toBe(zoom.waterCount);
                });
        }
    });

    it('the channel edges open full rows and meet the neighbor\'s water across the border', () => {
        // River↔river borders: every fine position of the shared edge is
        // water on BOTH tiles (the full-row rule — the shared exits need no
        // shared stream). River↔sea/basin borders: our row is water and the
        // neighbor's zoom is 100% water (the pure zoom the basins/sea keep).
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        const subCache = new Map<string, Canvas>();
        const subOf = (x: number, y: number): Canvas => {
            const key = `${x},${y}`;
            let sub = subCache.get(key);
            if (!sub) {
                sub = plugin.canvasFor([{ x, y }])!;
                subCache.set(key, sub);
            }
            return sub;
        };
        const subWet = (sub: Canvas, x: number, y: number): boolean => {
            const halfX = (sub.width - 1) / 2;
            const halfY = (sub.height - 1) / 2;
            const cell = sub.cells[(y + halfY) * sub.width + (x + halfX)];
            return cell.voxels[cell.voxels.length - 1] === 'water';
        };
        let borders = 0;
        canvas.cells
            .filter((cell) => cell.biome === 'river' && cell.passable)
            .forEach((parent) => {
                const zoom = zoomOf(canvas, parent, 7);
                CARDINALS.forEach(([dx, dy]) => {
                    const neighbor = cellOn(canvas, parent.x + dx, parent.y + dy);
                    if (!neighbor || !isChannelWater(neighbor.biome)) {
                        return;
                    }
                    borders = borders + 1;
                    const neighborSub = subOf(neighbor.x, neighbor.y);
                    for (let step = 0; step < (dx === 0 ? canvas.width : canvas.height); step++) {
                        const x = dx === 0 ? -zoom.halfX + step : dx < 0 ? -zoom.halfX : zoom.halfX;
                        const y = dx === 0 ? (dy < 0 ? -zoom.halfY : zoom.halfY) : -zoom.halfY + step;
                        // Our side: the full edge row is water
                        expect(zoom.isWater(x, y)).toBe(true);
                        // The neighbor's mirrored fine cell: water alike (a
                        // river neighbor zooms into its own full row; a sea
                        // or basin neighbor zooms pure)
                        const nx = dx === 0 ? x : dx < 0 ? zoom.halfX : -zoom.halfX;
                        const ny = dx === 0 ? (dy < 0 ? zoom.halfY : -zoom.halfY) : y;
                        expect(subWet(neighborSub, nx, ny)).toBe(true);
                    }
                });
            });
        // The regression is not vacuous: the seed-7 board's channel borders
        expect(borders).toBeGreaterThan(0);
    });

    it('the sea mouth fans onto the sea: the mouth row is water and the sea zoom is pure', () => {
        // The seed-7 eastern course mouths at (9,-4) into the (10,-4)
        // shallows (the captured coarse courses) — the mouth tile's east
        // edge row is water end to end
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        const mouth = canvas.cells.find((cell) => cell.x === 9 && cell.y === -4)!;
        expect(mouth.biome).toBe('river');
        const zoom = zoomOf(canvas, mouth, 7);
        for (let y = -zoom.halfY; y <= zoom.halfY; y++) {
            expect(zoom.isWater(zoom.halfX, y)).toBe(true);
        }
        const sea = cellOn(canvas, 10, -4)!;
        expect(['ocean', 'shallows']).toContain(sea.biome);
        const seaSub = plugin.canvasFor([{ x: 10, y: -4 }])!;
        seaSub.cells.forEach((fine) => {
            expect(fine.biome).toBe(sea.biome);
            expect(fine.passable).toBe(false);
        });
    });
});

// ── (d) the banks: boundaries and islands ────────────────────────────────────

describe('riverFineMask — land at the boundaries and the seeded islands (T3)', () => {
    it('every dry neighbor holds a bank row (the corners may go to a perpendicular water edge)', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        let landEdges = 0;
        canvas.cells
            .filter((cell) => cell.biome === 'river' && cell.passable)
            .forEach((parent) => {
                const zoom = zoomOf(canvas, parent, 7);
                CARDINALS.forEach(([dx, dy]) => {
                    const neighbor = cellOn(canvas, parent.x + dx, parent.y + dy);
                    if (!neighbor || isChannelWater(neighbor.biome)) {
                        return;
                    }
                    landEdges = landEdges + 1;
                    for (let step = 0; step < (dx === 0 ? canvas.width : canvas.height); step++) {
                        const x = dx === 0 ? -zoom.halfX + step : dx < 0 ? -zoom.halfX : zoom.halfX;
                        const y = dx === 0 ? (dy < 0 ? -zoom.halfY : zoom.halfY) : -zoom.halfY + step;
                        // The two corner cells belong to the perpendicular
                        // edge too — water wins there by design
                        if (dx !== 0 && Math.abs(y) === zoom.halfY) {
                            continue;
                        }
                        if (dy !== 0 && Math.abs(x) === zoom.halfX) {
                            continue;
                        }
                        expect(zoom.isWater(x, y)).toBe(false);
                    }
                });
            });
        expect(landEdges).toBeGreaterThan(0);
    });

    it('the flood surrounds dry islands (seed-7 example: tile (1,-7) carries 4)', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        const tile = canvas.cells.find((cell) => cell.x === 1 && cell.y === -7)!;
        expect(tile.biome).toBe('river');
        const zoom = zoomOf(canvas, tile, 7);
        // The exact captured count — the flood's noise order surrounds dry
        // blobs; the zoom banks the flood could not reach in time
        expect(islandCount(zoom)).toBe(4);
    });
});

// ── (e)+(f) the synthesized banks and the fine fords ─────────────────────────

describe('riverFineMask — the synthesized bank columns and the fine fords (T3)', () => {
    it('riverBankColumn synthesizes the raised dry ground (no water voxel, its own ground supply)', () => {
        // The default water line 3: gravel bedrock, dirt, the bank surface —
        // height AT the water line (dry), the dry-column ground supply, no
        // finite stock, no tree
        expect(riverBankColumn(3, { surface: 'sand' })).toEqual({
            voxels: ['gravel', 'dirt', 'sand'],
            height: 3,
            biome: 'beach',
            resources: { dirt: 1, sand: 1 },
        });
        expect(riverBankColumn(3, { surface: 'grass' })).toEqual({
            voxels: ['gravel', 'dirt', 'grass'],
            height: 3,
            biome: 'meadow',
            resources: { dirt: 1, grass: 1 },
        });
        // A lowered water line shortens the stack, never wets it
        expect(riverBankColumn(2, { surface: 'sand' })).toEqual({
            voxels: ['dirt', 'sand'],
            height: 2,
            biome: 'beach',
            resources: { dirt: 1, sand: 1 },
        });
    });

    it('every bank fine cell materializes the raised dry column; no water voxel under it', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        let banks = 0;
        canvas.cells
            .filter((cell) => cell.biome === 'river' && cell.passable)
            .forEach((parent) => {
                const zoom = zoomOf(canvas, parent, 7);
                const sub = plugin.canvasFor([{ x: parent.x, y: parent.y }])!;
                const halfX = (sub.width - 1) / 2;
                const halfY = (sub.height - 1) / 2;
                zoom.mask.forEach((spot, key) => {
                    banks = banks + 1;
                    const [x, y] = key.split(',').map(Number);
                    const fine = sub.cells[(y + halfY) * sub.width + (x + halfX)];
                    // The EXACT synthesized column (the shared builder)
                    expect(fine).toEqual({
                        x,
                        y,
                        ...riverBankColumn(parent.waterLevel, spot),
                        waterLevel: parent.waterLevel,
                        passable: true,
                    });
                    // The synthetic ground carries no water voxel, stands at
                    // the water line, and clones no finite stock or tree
                    expect(fine.voxels.includes('water')).toBe(false);
                    expect(fine.height).toBeGreaterThanOrEqual(parent.waterLevel);
                    expect(fine.passable).toBe(true);
                    expect(fine.resources.tree ?? 0).toBe(0);
                    expect(fine.resources.stone ?? 0).toBe(0);
                    expect(fine.resources.iron ?? 0).toBe(0);
                });
            });
        // The regression is not vacuous: the zooms carry banks
        expect(banks).toBeGreaterThan(0);
    });

    it('every water fine cell is the passable ford column, and cellFor reads river for it', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        let waterFines = 0;
        canvas.cells
            .filter((cell) => cell.biome === 'river' && cell.passable)
            .forEach((parent) => {
                const zoom = zoomOf(canvas, parent, 7);
                const sub = plugin.canvasFor([{ x: parent.x, y: parent.y }])!;
                const halfX = (sub.width - 1) / 2;
                const halfY = (sub.height - 1) / 2;
                for (let y = -zoom.halfY; y <= zoom.halfY; y++) {
                    for (let x = -zoom.halfX; x <= zoom.halfX; x++) {
                        if (!zoom.isWater(x, y)) {
                            continue;
                        }
                        waterFines = waterFines + 1;
                        const fine = sub.cells[(y + halfY) * sub.width + (x + halfX)];
                        // The INHERITED ford column: the parent's own shape,
                        // passable (the ford survives the zoom), the water
                        // top, no deposits (the channel carries nothing)
                        expect(fine.biome).toBe('river');
                        expect(fine.passable).toBe(true);
                        expect(fine.voxels).toEqual(parent.voxels);
                        expect(fine.height).toBe(parent.height);
                        expect(fine.resources).toEqual({});
                    }
                }
                // THE OTHER PLUGINS' CONTRACT: terrain.cellFor(path).biome
                // classifies the exact fine water — the center (the spine's
                // cell, always water) reads 'river'
                const center = plugin.cellFor([{ x: parent.x, y: parent.y }, { x: 0, y: 0 }])!;
                expect(center.biome).toBe('river');
                expect(center.passable).toBe(true);
            });
        expect(waterFines).toBeGreaterThan(0);
    });

    it('the materializer and the fast histogram agree exactly on every river tile (multi-seed)', () => {
        for (const seed of [7, 11]) {
            const plugin = islandTerrainPlugin();
            const world = createWorld({ seed, plugins: [plugin] });
            const canvas = world.canvas as Canvas;
            canvas.cells
                .filter((cell) => cell.biome === 'river' && cell.passable)
                .forEach((parent) => {
                    const path: TilePath = [{ x: parent.x, y: parent.y }];
                    const sub = plugin.canvasFor(path)!;
                    expect(plugin.surfaceKeyCounts(path)).toEqual(naiveCounts(sub));
                });
        }
    });
});
