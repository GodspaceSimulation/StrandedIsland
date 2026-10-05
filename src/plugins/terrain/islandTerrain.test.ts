// Tests for procedural island generation (plugins/terrain/islandTerrain.ts).
// Determinism is the contract — the exact biome maps below were captured from
// a reference run and must never drift.
//
// The world coordinate system is CENTERED: (0, 0) is the dead center of the
// canvas, so grid sizes must be ODD (even input is nudged up one cell). The
// canvas edge is always open sea — the island never touches the border.
//
// Every column also carries RESOURCE DEPOSITS (TileResources): wood ×2 on
// forests, stone ×1 on highlands, iron lodes where the vein noise exceeds
// IRON_LODE_THRESHOLD, and the UNLIMITED sand ×1 / dirt ×1 on beaches and
// meadows. Deposits drive the canvas surface (tileSurfaceKey) and seed the
// inventory plugin's cell stocks.

import { describe, it, expect } from 'vitest';
import {
    generateIsland,
    islandTerrainPlugin,
    oddSize,
    tileDepositSummary,
    tileSurfaceKey,
    IRON_LODE_THRESHOLD,
} from './islandTerrain';
import { createWorld } from '../../engine/world';

describe('oddSize', () => {
    it('nudges even sizes up to the next odd size, odd sizes pass through', () => {
        // (0, 0) must be the exact canvas center — even widths have no middle
        expect(oddSize(36)).toBe(37);
        expect(oddSize(24)).toBe(25);
        expect(oddSize(37)).toBe(37);
        expect(oddSize(13)).toBe(13);
        expect(oddSize(85)).toBe(85);
        expect(oddSize(53)).toBe(53);
    });
});

describe('generateIsland', () => {
    it('produces the exact biome map for seed 7 (7×5)', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Full biome names per cell, row-major
        const map = Array.from({ length: island.height }, (_, row) =>
            Array.from({ length: island.width }, (_, col) => island.cells[row * island.width + col].biome).join(' '),
        );
        expect(map).toEqual([
            'shallows shallows shallows shallows shallows shallows ocean',
            'shallows shallows beach beach beach shallows ocean',
            'shallows beach forest forest beach beach shallows',
            'ocean beach beach forest beach beach shallows',
            'ocean ocean ocean ocean ocean ocean shallows',
        ]);
        expect(island.stats).toEqual({ land: 13, water: 22, forest: 3, iron: 0 });
    });

    it('produces the exact biome map for seed 7 at default size (37×25)', () => {
        const island = generateIsland({ seed: 7 });
        expect(island.width).toBe(37);
        expect(island.height).toBe(25);
        // Two-letter biome codes per cell, row-major
        const map = Array.from({ length: island.height }, (_, row) =>
            Array.from({ length: island.width }, (_, col) => island.cells[row * island.width + col].biome.slice(0, 2)).join(''),
        );
        expect(map).toEqual([
            "shshshshshshococococococococococococshshshshshshshshshshshshshococococococ",
            "shocococococshbebebebebebebebebebebeshbebebebebebeshshshshshshbeshbebebeoc",
            "shocshshshshbebeshbebeshshbebebebebebebebebebebebebebeshshshshbebebebebesh",
            "shocshbebebebeshshbebeshshbebebebebebebebebebebebebebebebeshshbebebebeshsh",
            "shocshbebebebebebebebebebebebebebebebebebebebebebebebebebebeshbebebeshshsh",
            "shocshbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebeshshsh",
            "shococshbebebebebebebebebebebefofofomefofofofobebebebebefobebebebebeshshsh",
            "shococshshbebebebebebebebebememememefofofofofobebebefofofofobebebebebebeoc",
            "shococshshbebebebebemefobefomemememefofomemefofobebememememebebebebebebeoc",
            "shshshshbebebebebebemefofofomemememefofomememefobebemememememebebebebebeoc",
            "ocshshbebebebebemememefofomememebemefofomememefobebebemebemebebebebebebesh",
            "ocbebebebebememefofofomememememememememefofomememememebebebebebebeshshshsh",
            "ocbemebebebememefofofohihimememememememefofomememememebebebebebeshshshocsh",
            "ocbebebebebememefofofohihihimemememememefofomememememefobebebebebeshshshsh",
            "ocbebebebebebemememememehihimememefofofofomemememememememebebebebebeshshsh",
            "shshbebebebebebememememehihimefofofofofomememefofofobebebebebebebebeshshsh",
            "shshbebeshbebebememememememememefofofofofofofofofobebebebebebebebeshshocsh",
            "shshshshshbebebebebemememememememefofofofofofofofobebebebebebebeshshococsh",
            "shocshshshbebebebebemememememememefobefofofofofomefobebebebebebeshshococsh",
            "shocococshshshbebebebebebebebebebebebebefofofofomemebebebebebebebebeshshoc",
            "shshococococshbebebebebebebebebebebebebebebebemememebebebebebebebebebebeoc",
            "shocococococshbebebebebebebebebebebebebebebebebebebebebebebebebebebebebeoc",
            "shocshococshshbebebebebebebebebebebebebemebebebebebebebebebebebebebebebeoc",
            "shocshshshshbebebebebebebebebebebebebebebebebebeshbebebebebebebebebebebeoc",
            "shshshshocococococococococococococococococococococococococococococococococ",
        ]);
        expect(island.stats).toEqual({ land: 675, water: 250, forest: 90, iron: 3 });
    });

    it('carries resource deposits: wood on forests, sand/dirt unlimited, bare sea', () => {
        const island = generateIsland({ seed: 7 });
        // Forest (−3,−6): timber — a finite deposit of 2
        expect(island.cells.find((cell) => cell.x === -3 && cell.y === -6)?.resources).toEqual({ wood: 2 });
        // Beach (−10,−11): unlimited sand — a symbolic count the inventory
        // never depletes (UNLIMITED_TILE_RESOURCES)
        expect(island.cells.find((cell) => cell.x === -10 && cell.y === -11)?.resources).toEqual({ sand: 1 });
        // Meadow (0,−6): unlimited dirt
        expect(island.cells.find((cell) => cell.x === 0 && cell.y === -6)?.resources).toEqual({ dirt: 1 });
        // Sea (−18,−12): no deposits — the sea stocks fish, not tile resources
        expect(island.cells.find((cell) => cell.x === -18 && cell.y === -12)?.resources).toEqual({});
    });

    it('hides iron lodes in the stone highlands (vein noise, seed 7)', () => {
        const island = generateIsland({ seed: 7 });
        // Reference run: exactly 3 of the 9 highland cells lode at
        // IRON_LODE_THRESHOLD = 0.5 (vein samples 0.0756 … 0.5158)
        expect(IRON_LODE_THRESHOLD).toBe(0.5);
        expect(island.stats.iron).toBe(3);
        const lodes = island.cells
            .filter((cell) => (cell.resources.iron ?? 0) > 0)
            .map((cell) => `${cell.x},${cell.y}`);
        expect(lodes).toEqual(['-7,1', '-5,2', '-5,3']);
        // A lode carries stone AND iron — the ore sits in the rock
        expect(island.cells.find((cell) => cell.x === -5 && cell.y === 3)?.resources).toEqual({
            stone: 1,
            iron: 1,
        });
        // …while the plain highland next door keeps only its stone
        expect(island.cells.find((cell) => cell.x === -7 && cell.y === 0)?.resources).toEqual({ stone: 1 });
    });

    it('derives the canvas surface from the tile deposits (tileSurfaceKey)', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Deposits win: the 7×5 island surfaces as wood / sand / dirt
        expect(island.cells.map((cell) => tileSurfaceKey(cell))).toEqual([
            'shallows', 'shallows', 'shallows', 'shallows', 'shallows', 'shallows', 'ocean',
            'shallows', 'shallows', 'sand', 'sand', 'sand', 'shallows', 'ocean',
            'shallows', 'sand', 'wood', 'wood', 'sand', 'sand', 'shallows',
            'ocean', 'sand', 'sand', 'wood', 'sand', 'sand', 'shallows',
            'ocean', 'ocean', 'ocean', 'ocean', 'ocean', 'ocean', 'shallows',
        ]);
        // Deposit priority puts the rarest resource first: a stone tile with
        // an iron lode surfaces as iron (37×25 reference cell (−5,3))
        const full = generateIsland({ seed: 7 });
        expect(tileSurfaceKey(full.cells.find((cell) => cell.x === -5 && cell.y === 3)!)).toBe('iron');
        // A deposit-less tile falls back to its plain biome (sea columns)
        expect(tileSurfaceKey(full.cells.find((cell) => cell.x === -18 && cell.y === -12)!)).toBe('shallows');
        // Gathered-away deposits fall back too — the cell shape only needs
        // biome + resources
        expect(tileSurfaceKey({ biome: 'forest', resources: {} })).toBe('forest');
        expect(tileSurfaceKey({ biome: 'meadow' })).toBe('meadow');
    });

    it('summarizes deposits for hover titles and inspectors (tileDepositSummary)', () => {
        expect(tileDepositSummary({ wood: 2 })).toBe('wood ×2');
        expect(tileDepositSummary({ stone: 1, iron: 1 })).toBe('stone ×1 · iron ×1');
        // Unlimited deposits render the infinity marker, never a bare count
        expect(tileDepositSummary({ sand: 1 })).toBe('sand ×∞');
        expect(tileDepositSummary({ dirt: 1, berry: 2 } as never)).toBe('dirt ×∞');
        expect(tileDepositSummary({})).toBe('');
        expect(tileDepositSummary(undefined)).toBe('');
    });

    it('centers the world: coordinates run −half … +half with (0, 0) the middle', () => {
        const island = generateIsland({ seed: 7 });
        const xs = island.cells.map((cell) => cell.x);
        const ys = island.cells.map((cell) => cell.y);
        expect(Math.min(...xs)).toBe(-18);
        expect(Math.max(...xs)).toBe(18);
        expect(Math.min(...ys)).toBe(-12);
        expect(Math.max(...ys)).toBe(12);
        // The middle cell exists and is exactly (0, 0)
        expect(island.cells[12 * 37 + 18]).toMatchObject({ x: 0, y: 0 });
    });

    it('the canvas edge is always open sea — the island never touches the border', () => {
        const island = generateIsland({ seed: 7 });
        // Every outermost-ring cell is submerged water
        const edge = island.cells.filter(
            (cell) => Math.abs(cell.x) === 18 || Math.abs(cell.y) === 12,
        );
        expect(edge.length).toBe(2 * 37 + 2 * 23);
        expect(edge.every((cell) => !cell.passable)).toBe(true);
        expect(edge.every((cell) => cell.voxels[cell.voxels.length - 1] === 'water')).toBe(true);
        // Reference mix of shallows and ocean on the rim (coarse noise depth)
        expect(edge.filter((cell) => cell.biome === 'ocean').length).toBe(65);
        expect(edge.filter((cell) => cell.biome === 'shallows').length).toBe(55);
    });

    it('builds voxel columns bottom → top with soil under the surface', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Forest cell (0,0) — the canvas middle: stone bedrock, soil, grass
        // surface, forest on top, timber standing on it
        expect(island.cells[2 * 7 + 3]).toEqual({
            x: 0,
            y: 0,
            voxels: ['stone', 'stone', 'stone', 'soil', 'grass', 'forest'],
            height: 5,
            waterLevel: 3,
            biome: 'forest',
            passable: true,
            resources: { wood: 2 },
        });
        // Top-left corner (−3,−2): shallow seabed sand + water stacked to
        // the sea level — no deposits on a sea column
        expect(island.cells[0]).toEqual({
            x: -3,
            y: -2,
            voxels: ['soil', 'sand', 'water'],
            height: 2,
            waterLevel: 3,
            biome: 'shallows',
            passable: false,
            resources: {},
        });
    });

    it('is deterministic: same seed → identical canvases', () => {
        const a = generateIsland({ seed: 42, width: 9, height: 7 });
        const b = generateIsland({ seed: 42, width: 9, height: 7 });
        expect(a.cells).toEqual(b.cells);
    });

    it('different seeds produce different canvases', () => {
        const a = generateIsland({ seed: 1, width: 9, height: 7 });
        const b = generateIsland({ seed: 2, width: 9, height: 7 });
        expect(a.cells).not.toEqual(b.cells);
    });

    it('even size input is nudged up to odd', () => {
        const island = generateIsland({ seed: 7, width: 12, height: 10 });
        expect(island.width).toBe(13);
        expect(island.height).toBe(11);
    });

    it('water columns are impassable with a water surface; sandbars are walkable', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        const waterCells = island.cells.filter((cell) => !cell.passable);
        const landCells = island.cells.filter((cell) => cell.passable);
        expect(waterCells.length).toBe(22);
        expect(landCells.length).toBe(13);
        // Every impassable column's surface voxel is water
        expect(waterCells.every((cell) => cell.voxels[cell.voxels.length - 1] === 'water')).toBe(true);
        // No walkable column's surface is water
        expect(landCells.every((cell) => cell.voxels[cell.voxels.length - 1] !== 'water')).toBe(true);
    });
});

describe('islandTerrainPlugin', () => {
    it('builds the world canvas from the world seed in setup', () => {
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 7, height: 5 })] });
        expect(world.canvas.width).toBe(7);
        expect(world.canvas.height).toBe(5);
        expect(world.canvas.cells.length).toBe(35);
        expect(world.cellAt(0, 0)?.biome).toBe('forest');
    });

    it('exposes generation stats', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [plugin] });
        expect(plugin.stats()).toEqual({ land: 13, water: 22, forest: 3, iron: 0 });
    });

    it('respects a seed override independent of the world seed', () => {
        const world = createWorld({
            seed: 99,
            plugins: [islandTerrainPlugin({ width: 7, height: 5, seed: 7 })],
        });
        expect(world.canvas.width).toBe(7);
        // Same seed 7 → same interior biome at the canvas middle
        expect(world.cellAt(0, 0)?.biome).toBe('forest');
    });

    it('size reports the configured grid size', () => {
        const plugin = islandTerrainPlugin({ width: 13, height: 9 });
        createWorld({ seed: 7, plugins: [plugin] });
        expect(plugin.size()).toEqual({ width: 13, height: 9 });
    });

    it('resize regenerates the canvas in place and logs the redraw', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const events = world.events.log().length;
        plugin.resize(21, 13);
        expect(world.canvas.width).toBe(21);
        expect(world.canvas.height).toBe(13);
        expect(world.canvas.cells.length).toBe(273);
        expect(plugin.size()).toEqual({ width: 21, height: 13 });
        expect(plugin.stats()).toEqual({ land: 162, water: 111, forest: 36, iron: 0 });
        // The redraw is announced on the world log
        expect(world.events.log()[events]).toEqual({
            id: events + 1,
            tick: 0,
            time: 0,
            kind: 'world',
            message: 'The island is redrawn at 21×13.',
        });
        // The edge rule holds at the new size too
        const edge = world.canvas.cells.filter(
            (cell) => Math.abs(cell.x) === 10 || Math.abs(cell.y) === 6,
        );
        expect(edge.every((cell) => !cell.passable)).toBe(true);
        // The center rises above the water line on any size
        expect(world.cellAt(0, 0)?.passable).toBe(true);
    });

    it('resize keeps the seed: the same island, bigger or smaller', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const small = createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 7, height: 5 })] });
        // The reference 7×5 center column, regenerated at default size
        plugin.resize(37, 25);
        expect(small.cellAt(0, 0)?.biome).toBe('forest');
        expect(small.cellAt(0, 0)?.height).toBe(5);
    });

    it('resize normalizes even input to odd', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        plugin.resize(36, 24);
        expect(world.canvas.width).toBe(37);
        expect(world.canvas.height).toBe(25);
        expect(world.events.log().at(-1)?.message).toBe('The island is redrawn at 37×25.');
    });

    it('resize before setup defers to the next setup', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        plugin.resize(21, 13);
        expect(plugin.size()).toEqual({ width: 21, height: 13 });
        // The first setup regenerates at the deferred size
        const world = createWorld({ seed: 7, plugins: [plugin] });
        expect(world.canvas.width).toBe(21);
        expect(world.canvas.height).toBe(13);
    });
});
