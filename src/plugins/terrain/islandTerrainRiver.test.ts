// Tests for the scale-0 RIVER FINE MASK (T5 — the shape-first channel).
//
// The user's rule: the river must READ as a river — one continuous
// spatially coherent channel, bigger at the sea mouth and smaller and
// uniform as it travels inland, meandering smoothly turn by turn, with
// sands on both banks and dry grass beyond — no scattered sand/shore
// blocks, no seeded islands, no full-width water endpoints at the seams,
// no abrupt neck/pool jumps behind a seam. The shape-first revision
// retires the T4 share dial entirely (the water IS the channel band; the
// dial's pool-flood drew the necks and re-seeded enclosed dry patches)
// and carries the coarse river identity by the SEMANTIC rule
// (tileDetails dominantVisibleType reads a ford tile as 'river'), so no
// fine census has to fake a majority. This file owns the contracts:
//
//   (a) the tuning constants and the mask's determinism/seed-variation;
//   (b) the channel geometry: the mouth floods wider than every inland
//       tile of its course, the seam depth profiles run the border width
//       into the interior with no jumps, the cross-sections hold the dial
//       width, and the 7×5 board carries the exact channel pins;
//   (c) cardinal water connectivity WITHIN each river fine grid (one
//       connected body) and ACROSS its edges: river↔river borders meet at
//       the shared crossing interval — exact on both sides, contiguous,
//       never a full edge — while sea/basin borders open the full row onto
//       the pure-zoom water;
//   (d) the banks: every dry neighbor holds a bank row, NO enclosed dry
//       component anywhere (the reviewer's own border-connection metric,
//       across the review seeds), and the sand stays on the strips hugging
//       the water (no detached sand specks);
//   (e) the synthesized bank columns: raised dry ground, NO water voxel, the
//       bank's own ground supply, NO finite stock and no tree;
//   (f) the fine fords: every water fine cell is the parent's passable
//       column (terrain.cellFor reads biome 'river' — the other plugins'
//       classification contract), deposits/tree never clone;
//   (g) the materializer/histogram parity on river tiles (the shared
//       fineCellDraft/riverBankColumn builders);
//   (h) the longitudinal channel progression: the sea fan opens the full
//       row, the river↔river crossing intervals taper monotonically
//       upstream, and the source stub tapers to its spring.
//
// Unit half: riverBankColumn. Integration half: full worlds across seeds
// (the plugin is the same terrain+engine stack the other terrain tests use —
// no changing dependencies).

import { describe, it, expect } from 'vitest';
import {
    islandTerrainPlugin,
    riverBankColumn,
    riverFineMask,
    RIVER_BANK_WOBBLE,
    RIVER_CHANNEL_MIN,
    RIVER_CHANNEL_MOUTH,
    RIVER_CHANNEL_SOURCE,
    RIVER_CHANNEL_TAPER,
    RIVER_FINE_NOISE_SCALE,
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

/** The design's channel width at one course distance (the mask's own dial). */
const channelAt = (distance: number): number =>
    Math.max(RIVER_CHANNEL_MIN, RIVER_CHANNEL_MOUTH - distance * RIVER_CHANNEL_TAPER);

/**
 * The perpendicular THICKNESS of the water at one fine cell: the shortest
 * water run through it over the four run directions (both axes and both
 * diagonals). Orientation-robust — a lengthwise row of a turning channel
 * runs long but stays only dial-thick along its perpendicular, and a
 * 45°-diagonal channel reads its true width on the diagonal runs (axis
 * runs alone would inflate it by 1/0.707) — while a pool is thick in EVERY
 * direction. The metric that separates the channel's cross-section from
 * the old share-dial floodplain.
 */
const runThickness = (zoom: RiverZoom, x: number, y: number): number => {
    const runLength = (dx: number, dy: number): number => {
        let run = 1;
        for (let step = 1; step <= Math.max(zoom.halfX, zoom.halfY); step++) {
            if (!zoom.isWater(x - dx * step, y - dy * step)) {
                break;
            }
            run = run + 1;
        }
        for (let step = 1; step <= Math.max(zoom.halfX, zoom.halfY); step++) {
            if (!zoom.isWater(x + dx * step, y + dy * step)) {
                break;
            }
            run = run + 1;
        }
        return run;
    };
    return Math.min(
        runLength(0, 1),
        runLength(1, 0),
        runLength(1, 1),
        runLength(1, -1),
    );
};

/**
 * The course longitude of every river cell on a canvas — the test-side twin
 * of the mask's mouth BFS (the design spec: mouths are the river cells
 * cardinally touching sea/basin water; distances spread in cardinal river
 * steps). "x,y" keyed.
 */
const courseDistances = (canvas: Canvas): Map<string, number> => {
    const distances = new Map<string, number>();
    const queue: Array<{ x: number; y: number }> = [];
    canvas.cells.forEach((cell) => {
        if (cell.biome !== 'river') {
            return;
        }
        const mouth = CARDINALS.some(([dx, dy]) => {
            const neighbor = cellOn(canvas, cell.x + dx, cell.y + dy);
            return !!neighbor && isChannelWater(neighbor.biome) && neighbor.biome !== 'river';
        });
        if (mouth) {
            distances.set(`${cell.x},${cell.y}`, 0);
            queue.push({ x: cell.x, y: cell.y });
        }
    });
    for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        const level = distances.get(`${current.x},${current.y}`) ?? 0;
        CARDINALS.forEach(([dx, dy]) => {
            const neighbor = cellOn(canvas, current.x + dx, current.y + dy);
            const key = `${current.x + dx},${current.y + dy}`;
            if (neighbor && neighbor.biome === 'river' && !distances.has(key)) {
                distances.set(key, level + 1);
                queue.push({ x: current.x + dx, y: current.y + dy });
            }
        });
    }
    return distances;
};

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

/** The river courses of a canvas: the river cells' cardinal components. */
const coursesOf = (canvas: Canvas): Array<Array<{ x: number; y: number }>> => {
    const courses: Array<Array<{ x: number; y: number }>> = [];
    const seen = new Set<string>();
    canvas.cells.forEach((cell) => {
        if (cell.biome !== 'river' || seen.has(`${cell.x},${cell.y}`)) {
            return;
        }
        const course: Array<{ x: number; y: number }> = [];
        const queue = [{ x: cell.x, y: cell.y }];
        seen.add(`${cell.x},${cell.y}`);
        while (queue.length > 0) {
            const current = queue.shift()!;
            course.push(current);
            CARDINALS.forEach(([dx, dy]) => {
                const neighbor = cellOn(canvas, current.x + dx, current.y + dy);
                const key = `${current.x + dx},${current.y + dy}`;
                if (neighbor && neighbor.biome === 'river' && !seen.has(key)) {
                    seen.add(key);
                    queue.push({ x: current.x + dx, y: current.y + dy });
                }
            });
        }
        courses.push(course);
    });
    return courses;
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

describe('riverFineMask — the tuning constants and determinism (T4)', () => {
    it('carries the documented tuning constants', () => {
        // The channel dial: the mouth fan tapering to the uniform inland
        // width (the shape-first revision — the water IS the channel band,
        // the old share dial retired with its pool-flood artifacts)
        expect(RIVER_CHANNEL_MOUTH).toBe(13);
        expect(RIVER_CHANNEL_TAPER).toBe(2.5);
        expect(RIVER_CHANNEL_MIN).toBe(6.5);
        expect(RIVER_CHANNEL_SOURCE).toBe(3);
        expect(RIVER_BANK_WOBBLE).toBe(1);
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
        // The fresh seed re-rolls the crossings, the bend and the bank noise
        // (the plan is seed-varying)
        expect(serialize(riverFineMask(parent, key, canvas, 8))).not.toBe(serialize(riverFineMask(parent, key, canvas, 7)));
    });
});

// ── (b) the channel geometry — the shape-first dial ──────────────────────────

describe('riverFineMask — the channel geometry (shape-first T5)', () => {
    it('the mouth floods wider than the inland channel (population + per-course)', () => {
        // The geometry IS the water: the mouth's channel runs the widest
        // dial of the course and fans onto the sea. Two structural facts,
        // measured with the orientation-robust perpendicular thickness
        // (runThickness — the shortest water run through a cell):
        //   PER COURSE — the mouth's thickest water ties or beats every
        //     inland tile's (the mouth's exit-side band shares the d1 dial,
        //     and its 13-wide sea-side end is clipped by the tile border, so
        //     strict per-tile domination is not the guarantee — parity is);
        //   POPULATION — across the whole sweep the mouths average
        //     strictly thicker than the inland tiles (the reviewer's own
        //     perpWidth population form; the taper's dial 13 vs 6.5–10.5).
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 103, 104, 201, 202, 203]) {
            const plugin = islandTerrainPlugin();
            const world = createWorld({ seed, plugins: [plugin] });
            const canvas = world.canvas as Canvas;
            const distances = courseDistances(canvas);
            const maxThickness = (parent: TerrainCell): number => {
                const zoom = zoomOf(canvas, parent, seed);
                let thickest = 0;
                for (let y = -zoom.halfY; y <= zoom.halfY; y++) {
                    for (let x = -zoom.halfX; x <= zoom.halfX; x++) {
                        if (zoom.isWater(x, y)) {
                            thickest = Math.max(thickest, runThickness(zoom, x, y));
                        }
                    }
                }
                return thickest;
            };
            let mouthSum = 0;
            let inlandSum = 0;
            let inlandTiles = 0;
            coursesOf(canvas).forEach((course) => {
                const byDistance = course
                    .map((cell) => ({
                        distance: distances.get(`${cell.x},${cell.y}`)!,
                        thick: maxThickness(cell),
                    }))
                    .sort((left, right) => left.distance - right.distance);
                const mouth = byDistance[0];
                mouthSum = mouthSum + mouth.thick;
                byDistance.slice(1).forEach((inland) => {
                    if (inland.distance === mouth.distance) {
                        return;
                    }
                    inlandSum = inlandSum + inland.thick;
                    inlandTiles = inlandTiles + 1;
                    expect(
                        mouth.thick,
                        `seed ${seed} mouth (d${mouth.distance}, thick ${mouth.thick}) must tie or beat the inland tile (d${inland.distance}, thick ${inland.thick})`,
                    ).toBeGreaterThanOrEqual(inland.thick - 1);
                });
            });
            expect(inlandTiles).toBeGreaterThan(0);
            // The population form: the mouths' mean thickness strictly
            // exceeds the inland tiles' (one mouth per course vs its
            // inlands — the means compare like populations)
            const courses = coursesOf(canvas).length;
            expect(mouthSum / courses).toBeGreaterThan(inlandSum / inlandTiles);
        }
    });

    it('the seam expansion is coherent — no pool hides behind a border (multi-seed)', () => {
        // The shape-first core: the water the crossing interval opens at the
        // shared border is the water the interior keeps. The old share
        // top-up flooded from the 7-cell interval to 20+-cell pools one row
        // behind the border (the reviewer's 1-row 2–3× jumps). The metric is
        // the water's perpendicular THICKNESS — for each water cell the
        // shorter of its two axis-aligned runs — which reads the channel's
        // width whatever its orientation (a lengthwise row of a turning
        // channel is long but only dial-thick): every water cell within the
        // four rows behind a river↔river seam stays within the seam's dial
        // width + the bend/wobble allowance, so no expansion past the dial
        // exists at any depth.
        for (const seed of [1, 7, 201, 202, 203]) {
            const plugin = islandTerrainPlugin();
            const world = createWorld({ seed, plugins: [plugin] });
            const canvas = world.canvas as Canvas;
            const distances = courseDistances(canvas);
            let seams = 0;
            canvas.cells
                .filter((cell) => cell.biome === 'river' && cell.passable)
                .forEach((parent) => {
                    const zoom = zoomOf(canvas, parent, seed);
                    CARDINALS.forEach(([dx, dy]) => {
                        const neighbor = cellOn(canvas, parent.x + dx, parent.y + dy);
                        if (!neighbor || neighbor.biome !== 'river' || !neighbor.passable) {
                            return;
                        }
                        // Each seam reports once, from its downstream end
                        if (
                            (distances.get(`${neighbor.x},${neighbor.y}`) ?? 99) >=
                            (distances.get(`${parent.x},${parent.y}`) ?? 99)
                        ) {
                            return;
                        }
                        seams = seams + 1;
                        const length = dx === 0 ? canvas.width : canvas.height;
                        const dial = channelAt(
                            Math.max(
                                distances.get(`${parent.x},${parent.y}`)!,
                                distances.get(`${neighbor.x},${neighbor.y}`)!,
                            ),
                        );
                        for (let depth = 0; depth <= 4; depth++) {
                            const inward = (dx === 0 ? zoom.halfY : zoom.halfX) - depth;
                            for (let step = 0; step < length; step++) {
                                const position = step - (length - 1) / 2;
                                const x = dx === 0 ? position : dx < 0 ? -inward : inward;
                                const y = dx === 0 ? (dy < 0 ? -inward : inward) : position;
                                if (!zoom.isWater(x, y)) {
                                    continue;
                                }
                                expect(
                                    runThickness(zoom, x, y),
                                    `seed ${seed} seam (${parent.x},${parent.y})->(${neighbor.x},${neighbor.y}) depth ${depth} cell ${x},${y} thicker than the dial ${dial} allows`,
                                ).toBeLessThanOrEqual(Math.ceil(dial) + 5);
                            }
                        }
                    });
                });
            expect(seams).toBeGreaterThan(0);
        }
    });

    it('every inland tile holds the dial thickness (uniform cross-sections, no pools)', () => {
        // The perpendicular thickness of every water cell in a NON-MOUTH
        // tile (no sea/basin edge — the mouth fans are their own geometry)
        // stays within the tile's dial window: the widest crossing width the
        // tile's longitudes allow + the pair jitter, the wobble and the
        // 90°-bend's miter allowance (+5). The old share dial flooded the
        // free interior to 15–23-thick pools at longitudes whose dial is
        // 6.5–10.5 — this pins the channel cross-section instead.
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 101, 103, 104, 201, 202, 203, 302, 304, 306, 308]) {
            const plugin = islandTerrainPlugin();
            const world = createWorld({ seed, plugins: [plugin] });
            const canvas = world.canvas as Canvas;
            const distances = courseDistances(canvas);
            canvas.cells
                .filter((cell) => cell.biome === 'river' && cell.passable)
                .forEach((parent) => {
                    const zoom = zoomOf(canvas, parent, seed);
                    const edges = CARDINALS.map(([dx, dy]) => {
                        const neighbor = cellOn(canvas, parent.x + dx, parent.y + dy);
                        if (!neighbor) {
                            return 'rim';
                        }
                        if (neighbor.biome === 'river') {
                            return 'river';
                        }
                        return isChannelWater(neighbor.biome) ? 'sea' : 'land';
                    });
                    const seaEdges = edges.filter((edge) => edge === 'sea').length;
                    const waterEdges = edges.filter((edge) => edge === 'sea' || edge === 'river').length;
                    if (seaEdges > 0 || waterEdges >= 3) {
                        // Mouth fans and hub confluences are their own
                        // geometry (the sea rows and the spoke overlap)
                        return;
                    }
                    // The tile's dial window: the WIDEST crossing any of the
                    // tile's water edges opens — per edge, the dial at
                    // max(own, neighbor) longitude (a lower-longitude
                    // neighbor opens a wider crossing, so the per-edge max is
                    // not the global max longitude's dial)
                    const dial = Math.max(
                        ...CARDINALS.map(([dx, dy]) => {
                            const neighbor = cellOn(canvas, parent.x + dx, parent.y + dy);
                            if (!neighbor || neighbor.biome !== 'river') {
                                return 0;
                            }
                            return channelAt(
                                Math.max(
                                    distances.get(`${parent.x},${parent.y}`)!,
                                    distances.get(`${neighbor.x},${neighbor.y}`)!,
                                ),
                            );
                        }),
                    );
                    for (let y = -zoom.halfY; y <= zoom.halfY; y++) {
                        for (let x = -zoom.halfX; x <= zoom.halfX; x++) {
                            if (!zoom.isWater(x, y)) {
                                continue;
                            }
                            expect(
                                runThickness(zoom, x, y),
                                `seed ${seed} tile (${parent.x},${parent.y}) d=${distances.get(`${parent.x},${parent.y}`)} cell ${x},${y} thicker than the dial ${dial} allows`,
                            ).toBeLessThanOrEqual(Math.ceil(dial) + 5);
                        }
                    }
                });
        }
    });

    it('tiny grids: the channel crosses both tiles of the 7×5 board (exact pins)', () => {
        // The 7×5 board's river tiles (the coarse carve's exact tiles — the
        // carve is untouched). The channel-only mask runs the dial's
        // board-scaled width across both; the exact counts pin the seed-7
        // determinism (the old majority expectation retired with the share
        // dial — a 35-cell board holds a 2-fine-cell channel, not a flood).
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        const rivers = canvas.cells.filter((cell) => cell.biome === 'river' && cell.passable);
        expect(rivers.map((cell) => [cell.x, cell.y])).toEqual([
            [-1, -1],
            [-1, 0],
        ]);
        const counts = rivers.map((parent) => zoomOf(canvas, parent, 7).waterCount);
        // (−1,−1) is the mouth: its sea edge opens the full row (7) plus the
        // board-scaled band; (−1,0) is the inland channel only — the dial
        // 13 × scale 5/17 ≈ 3.8 wide across the tiny board
        expect(counts).toEqual([26, 10]);
        counts.forEach((count) => {
            expect(count).toBeGreaterThan(0);
        });
    });
});

// ── (c) the connectivity + shared exits ──────────────────────────────────────

describe('riverFineMask — cardinal connectivity and the shared neighbor exits (T4)', () => {
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

    it('river↔river borders meet at the shared crossing interval (exact, contiguous, never a full edge)', () => {
        // The canonical pair stream both tiles read: our water positions on
        // the shared edge are EXACTLY the neighbor's mirrored positions — a
        // contiguous interval narrower than the full edge (the T3 full-width
        // endpoint rows are gone)
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        const edgeLength = (dx: number, dy: number): number => (dx === 0 ? canvas.width : canvas.height);
        let borders = 0;
        canvas.cells
            .filter((cell) => cell.biome === 'river' && cell.passable)
            .forEach((parent) => {
                const zoom = zoomOf(canvas, parent, 7);
                CARDINALS.forEach(([dx, dy]) => {
                    const neighbor = cellOn(canvas, parent.x + dx, parent.y + dy);
                    if (!neighbor || neighbor.biome !== 'river' || !neighbor.passable) {
                        return;
                    }
                    borders = borders + 1;
                    const length = edgeLength(dx, dy);
                    const neighborZoom = zoomOf(canvas, neighbor, 7);
                    const own: number[] = [];
                    const mirrored: number[] = [];
                    for (let step = 0; step < length; step++) {
                        const position = step - (length - 1) / 2;
                        // The two corner positions belong to the perpendicular
                        // edges as well — a mouth's perpendicular SEA row wets
                        // its corner on one side only (the shore contract's
                        // own corner allowance, T3 behavior preserved)
                        if (Math.abs(position) === length / 2 - 0.5) {
                            continue;
                        }
                        const x = dx === 0 ? position : dx < 0 ? -zoom.halfX : zoom.halfX;
                        const y = dx === 0 ? (dy < 0 ? -zoom.halfY : zoom.halfY) : position;
                        if (zoom.isWater(x, y)) {
                            own.push(position);
                        }
                        const nx = dx === 0 ? position : dx < 0 ? zoom.halfX : -zoom.halfX;
                        const ny = dx === 0 ? (dy < 0 ? zoom.halfY : -zoom.halfY) : position;
                        if (neighborZoom.isWater(nx, ny)) {
                            mirrored.push(position);
                        }
                    }
                    // EXACT seam agreement — the same interval on both sides
                    expect(own).toEqual(mirrored);
                    // Contiguous and strictly narrower than the border
                    expect(own.length).toBeGreaterThan(0);
                    expect(own.length).toBeLessThan(length);
                    for (let index = 1; index < own.length; index++) {
                        expect(own[index] - own[index - 1]).toBe(1);
                    }
                });
            });
        // The regression is not vacuous: the seed-7 board's channel borders
        expect(borders).toBeGreaterThan(0);
    });

    it('river↔sea/basin borders open the full row onto the pure-zoom water', () => {
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
        let mouths = 0;
        canvas.cells
            .filter((cell) => cell.biome === 'river' && cell.passable)
            .forEach((parent) => {
                const zoom = zoomOf(canvas, parent, 7);
                CARDINALS.forEach(([dx, dy]) => {
                    const neighbor = cellOn(canvas, parent.x + dx, parent.y + dy);
                    if (!neighbor || neighbor.biome === 'river' || !isChannelWater(neighbor.biome)) {
                        return;
                    }
                    mouths = mouths + 1;
                    for (let step = 0; step < (dx === 0 ? canvas.width : canvas.height); step++) {
                        const x = dx === 0 ? -zoom.halfX + step : dx < 0 ? -zoom.halfX : zoom.halfX;
                        const y = dx === 0 ? (dy < 0 ? -zoom.halfY : zoom.halfY) : -zoom.halfY + step;
                        // Our side: the full edge row is water (the fan)
                        expect(zoom.isWater(x, y)).toBe(true);
                        // The sea/basin zoom is 100% pure water
                        const nx = dx === 0 ? x : dx < 0 ? zoom.halfX : -zoom.halfX;
                        const ny = dx === 0 ? (dy < 0 ? zoom.halfY : -zoom.halfY) : y;
                        expect(subWet(subOf(neighbor.x, neighbor.y), nx, ny)).toBe(true);
                    }
                });
            });
        expect(mouths).toBeGreaterThan(0);
    });

    it('the sea mouth fans onto the sea: the mouth row is water and the sea zoom is pure', () => {
        // The seed-7 eastern course mouths at (9,-4) into the (10,-4)
        // shallows (the captured coarse courses — the carve is untouched)
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

// ── (d) the banks: boundaries, islands and sand strips ───────────────────────

describe('riverFineMask — the banks: boundaries, islands and sand strips (T4)', () => {
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

    it('no enclosed dry component anywhere — every dry patch connects to the border (multi-seed)', () => {
        // The no-islands guarantee, at the reviewer's own metric: the DRY
        // 4-connected components that touch NO rim cell of the fine grid —
        // the diagonal dry pairs and the enclosed sand pockets the old
        // lone-cell sweep missed — must number ZERO. The mask fills every
        // such component into the channel structurally (the enclosed-fill
        // pass), so this reads the mask's own invariant back.
        const enclosedDryComponents = (zoom: RiverZoom): number => {
            const seen = new Set<string>();
            let count = 0;
            for (let y = -zoom.halfY; y <= zoom.halfY; y++) {
                for (let x = -zoom.halfX; x <= zoom.halfX; x++) {
                    const key = `${x},${y}`;
                    if (seen.has(key) || zoom.isWater(x, y)) {
                        continue;
                    }
                    const component: string[] = [];
                    let rim = false;
                    const queue = [key];
                    seen.add(key);
                    while (queue.length > 0) {
                        const current = queue.shift()!;
                        const [cx, cy] = current.split(',').map(Number);
                        component.push(current);
                        if (Math.abs(cx) === zoom.halfX || Math.abs(cy) === zoom.halfY) {
                            rim = true;
                        }
                        CARDINALS.forEach(([dx, dy]) => {
                            const nx = cx + dx;
                            const ny = cy + dy;
                            // Out-of-grid neighbors are not fine cells at all
                            // (the rim check above already claimed the rim
                            // cells) — skipping them keeps the flood bounded
                            if (nx < -zoom.halfX || nx > zoom.halfX || ny < -zoom.halfY || ny > zoom.halfY) {
                                return;
                            }
                            const nkey = `${nx},${ny}`;
                            if (zoom.isWater(nx, ny)) {
                                return;
                            }
                            if (!seen.has(nkey)) {
                                seen.add(nkey);
                                queue.push(nkey);
                            }
                        });
                    }
                    if (!rim) {
                        count = count + 1;
                    }
                }
            }
            return count;
        };
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 101, 103, 104, 201, 202, 203, 302, 304, 306, 308]) {
            const plugin = islandTerrainPlugin();
            const world = createWorld({ seed, plugins: [plugin] });
            const canvas = world.canvas as Canvas;
            canvas.cells
                .filter((cell) => cell.biome === 'river' && cell.passable)
                .forEach((parent) => {
                    expect(
                        enclosedDryComponents(zoomOf(canvas, parent, seed)),
                        `seed ${seed} tile ${parent.x},${parent.y} carries an enclosed dry patch`,
                    ).toBe(0);
                });
        }
    });

    it('the sand stays on the bank strips hugging the water (no scattered sand specks)', () => {
        // The bank rule is exact: a dry fine cell reads sand if and only if
        // it is 8-adjacent to the channel's water — the contiguous narrow
        // strips on both banks, dry grass beyond, nothing detached
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        let sand = 0;
        canvas.cells
            .filter((cell) => cell.biome === 'river' && cell.passable)
            .forEach((parent) => {
                const zoom = zoomOf(canvas, parent, 7);
                zoom.mask.forEach((spot, key) => {
                    const [x, y] = key.split(',').map(Number);
                    const touches = NEIGHBOR_OFFSETS.some((offset) =>
                        zoom.isWater(x + offset.dx, y + offset.dy),
                    );
                    if (spot.surface === 'sand') {
                        sand = sand + 1;
                        expect(touches).toBe(true);
                    } else {
                        expect(touches).toBe(false);
                    }
                });
            });
        // The regression is not vacuous: the zooms carry sand banks
        expect(sand).toBeGreaterThan(0);
    });
});

// ── (e)+(f) the synthesized banks and the fine fords ─────────────────────────

describe('riverFineMask — the synthesized bank columns and the fine fords (T4)', () => {
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
                        // THE OTHER PLUGINS' CONTRACT: terrain.cellFor
                        // classifies the exact fine water as 'river' —
                        // asserted over the mask's actual water cells (the
                        // T3 spine's center pin retired: the channel runs
                        // where the crossings put it)
                        const resolved = plugin.cellFor([{ x: parent.x, y: parent.y }, { x, y }])!;
                        expect(resolved.biome).toBe('river');
                        expect(resolved.passable).toBe(true);
                    }
                }
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

// ── (h) the longitudinal channel progression ─────────────────────────────────

describe('riverFineMask — the longitudinal channel progression (T4)', () => {
    it('the sea fan opens the full row and the crossing intervals taper monotonically upstream', () => {
        // The seam widths ARE the design's dial: the interval on a river
        // border is the crossing disc's reach — channelAt(max(dA, dB)) with
        // the pair's keyed ±1 jitter. The windows below are the jitter's
        // exact envelope (the interval cell count of W−1 .. W+1); the
        // progression asserts each border no narrower than the next one
        // upstream minus the jitter allowance.
        const intervalCount = (width: number, edge: number): number => {
            const reach = Math.sqrt(Math.max(0, (width * width) / 4 - 0.25));
            let count = 0;
            for (let position = 0; position < edge; position++) {
                const centered = position - (edge - 1) / 2;
                if (Math.abs(centered) <= reach) {
                    count = count + 1;
                }
            }
            return count;
        };
        for (const seed of [1, 7]) {
            const plugin = islandTerrainPlugin();
            const world = createWorld({ seed, plugins: [plugin] });
            const canvas = world.canvas as Canvas;
            const distances = courseDistances(canvas);
            coursesOf(canvas).forEach((course) => {
                // The course's river↔river borders, ordered upstream
                const borders: Array<{ upstream: number; interval: number; edge: number }> = [];
                course.forEach((cell) => {
                    const ownDistance = distances.get(`${cell.x},${cell.y}`)!;
                    CARDINALS.forEach(([dx, dy]) => {
                        const neighbor = cellOn(canvas, cell.x + dx, cell.y + dy);
                        if (!neighbor || neighbor.biome !== 'river' || !neighbor.passable) {
                            return;
                        }
                        const neighborDistance = distances.get(`${neighbor.x},${neighbor.y}`)!;
                        // Each border reports once (from its downstream end)
                        if (neighborDistance >= ownDistance) {
                            return;
                        }
                        const zoom = zoomOf(canvas, cell, seed);
                        const edge = dx === 0 ? canvas.width : canvas.height;
                        let count = 0;
                        for (let step = 0; step < edge; step++) {
                            const x = dx === 0 ? -zoom.halfX + step : dx < 0 ? -zoom.halfX : zoom.halfX;
                            const y = dx === 0 ? (dy < 0 ? -zoom.halfY : zoom.halfY) : -zoom.halfY + step;
                            if (zoom.isWater(x, y)) {
                                count = count + 1;
                            }
                        }
                        borders.push({
                            upstream: Math.max(ownDistance, neighborDistance),
                            interval: count,
                            edge,
                        });
                    });
                });
                expect(borders.length).toBeGreaterThan(0);
                borders.sort((left, right) => left.upstream - right.upstream);
                borders.forEach((border) => {
                    // The design width ± the pair jitter's envelope
                    const low = intervalCount(channelAt(border.upstream) - 1, border.edge);
                    const high = intervalCount(channelAt(border.upstream) + 1, border.edge);
                    expect(border.interval).toBeGreaterThanOrEqual(low);
                    expect(border.interval).toBeLessThanOrEqual(high);
                });
                for (let index = 1; index < borders.length; index++) {
                    // Monotone upstream within the ±1 jitter (±2 interval
                    // cells at the quantization boundaries)
                    expect(borders[index - 1].interval).toBeGreaterThanOrEqual(
                        borders[index].interval - 2,
                    );
                }
            });
        }
    });

    it('the source stub tapers to the spring width (the one-edge tile)', () => {
        // The seed-7 northern course's source tile (-1,-1) has a single
        // river neighbor: its channel narrows from the border crossing to
        // the keyed spring end — the far interior stays dry land
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const canvas = world.canvas as Canvas;
        const source = canvas.cells.find((cell) => cell.x === -1 && cell.y === -1)!;
        expect(source.biome).toBe('river');
        const zoom = zoomOf(canvas, source, 7);
        // The source tile's inland half carries dry ground: the spring
        // channel (≤ the source width + wobble around its line) cannot fill
        // the tile — the dry majority reads
        let dryInland = 0;
        for (let y = 0; y <= zoom.halfY; y++) {
            for (let x = -zoom.halfX; x <= zoom.halfX; x++) {
                if (!zoom.isWater(x, y)) {
                    dryInland = dryInland + 1;
                }
            }
        }
        expect(dryInland).toBeGreaterThan(0);
    });
});
