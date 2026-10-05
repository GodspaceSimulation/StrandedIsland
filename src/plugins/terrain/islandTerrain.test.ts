// Tests for procedural island generation (plugins/terrain/islandTerrain.ts).
// Determinism is the contract — the exact biome maps below were captured from
// a reference run and must never drift.
//
// The world coordinate system is CENTERED: (0, 0) is the dead center of the
// canvas, so grid sizes must be ODD (even input is nudged up one cell). The
// canvas edge is always open sea — the island never touches the border.

import { describe, it, expect } from 'vitest';
import { generateIsland, islandTerrainPlugin, oddSize } from './islandTerrain';
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
        expect(island.stats).toEqual({ land: 13, water: 22, forest: 3 });
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
        expect(island.stats).toEqual({ land: 675, water: 250, forest: 90 });
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
        // surface, forest on top
        expect(island.cells[2 * 7 + 3]).toEqual({
            x: 0,
            y: 0,
            voxels: ['stone', 'stone', 'stone', 'soil', 'grass', 'forest'],
            height: 5,
            waterLevel: 3,
            biome: 'forest',
            passable: true,
        });
        // Top-left corner (−3,−2): shallow seabed sand + water stacked to
        // the sea level
        expect(island.cells[0]).toEqual({
            x: -3,
            y: -2,
            voxels: ['soil', 'sand', 'water'],
            height: 2,
            waterLevel: 3,
            biome: 'shallows',
            passable: false,
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
        expect(plugin.stats()).toEqual({ land: 13, water: 22, forest: 3 });
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
        expect(plugin.stats()).toEqual({ land: 162, water: 111, forest: 36 });
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
