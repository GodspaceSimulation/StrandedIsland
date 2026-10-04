// Tests for procedural island generation (plugins/terrain/islandTerrain.ts).
// Determinism is the contract — the exact biome maps below were captured from
// a reference run and must never drift.

import { describe, it, expect } from 'vitest';
import { generateIsland, islandTerrainPlugin } from './islandTerrain';
import { createWorld } from '../../engine/world';

describe('generateIsland', () => {
    it('produces the exact biome map for seed 7 (6×5)', () => {
        const island = generateIsland({ seed: 7, width: 6, height: 5 });
        // Full biome names per cell, row-major
        const map = Array.from({ length: island.height }, (_, y) =>
            Array.from({ length: island.width }, (_, x) => island.cells[y * island.width + x].biome).join(' '),
        );
        expect(map).toEqual([
            'ocean ocean ocean ocean ocean ocean',
            'ocean shallows beach beach shallows ocean',
            'shallows beach forest forest beach shallows',
            'beach beach beach forest beach shallows',
            'beach beach shallows beach beach shallows',
        ]);
        expect(island.stats).toEqual({ land: 15, water: 15, forest: 3 });
    });

    it('produces the exact biome map for seed 7 at default size (12×10)', () => {
        const island = generateIsland({ seed: 7 });
        // Two-letter biome codes per cell, row-major
        const map = Array.from({ length: island.height }, (_, y) =>
            Array.from({ length: island.width }, (_, x) => island.cells[y * island.width + x].biome.slice(0, 2)).join(''),
        );
        expect(map).toEqual([
            'ocococococshbebebebebebe',
            'ococococshbebebebebebebe',
            'ococshbebebefofomebeshsh',
            'shbebebefofofofomebebesh',
            'shbebefofofofofomemebesh',
            'shbebefofofofofofobebesh',
            'shbebebefofofobebebeshoc',
            'shshbebefofofobebeshococ',
            'shshshbebebebebeshshshoc',
            'shshshshshbebeshshocococ',
        ]);
        expect(island.stats).toEqual({ land: 73, water: 47, forest: 23 });
    });

    it('builds voxel columns bottom → top with soil under the surface', () => {
        const island = generateIsland({ seed: 7, width: 6, height: 5 });
        // Forest cell (2,2): stone bedrock, soil, grass surface, forest on top
        expect(island.cells[2 * 6 + 2]).toEqual({
            x: 2,
            y: 2,
            voxels: ['stone', 'stone', 'stone', 'soil', 'grass', 'forest'],
            height: 5,
            waterLevel: 3,
            biome: 'forest',
            passable: true,
        });
        // Ocean cell (0,0): seabed sand + water stacked to sea level
        expect(island.cells[0]).toEqual({
            x: 0,
            y: 0,
            voxels: ['sand', 'water', 'water'],
            height: 1,
            waterLevel: 3,
            biome: 'ocean',
            passable: false,
        });
        // Sandbar cell (0,3): exactly at the water line, dry and walkable
        expect(island.cells[3 * 6 + 0]).toEqual({
            x: 0,
            y: 3,
            voxels: ['stone', 'soil', 'sand'],
            height: 3,
            waterLevel: 3,
            biome: 'beach',
            passable: true,
        });
    });

    it('is deterministic: same seed → identical canvases', () => {
        const a = generateIsland({ seed: 42, width: 8, height: 8 });
        const b = generateIsland({ seed: 42, width: 8, height: 8 });
        expect(a.cells).toEqual(b.cells);
    });

    it('different seeds produce different canvases', () => {
        const a = generateIsland({ seed: 1, width: 8, height: 8 });
        const b = generateIsland({ seed: 2, width: 8, height: 8 });
        expect(a.cells).not.toEqual(b.cells);
    });

    it('water columns are impassable with a water surface; sandbars are walkable', () => {
        const island = generateIsland({ seed: 7, width: 6, height: 5 });
        const waterCells = island.cells.filter((cell) => !cell.passable);
        const landCells = island.cells.filter((cell) => cell.passable);
        expect(waterCells.length).toBe(15);
        expect(landCells.length).toBe(15);
        // Every impassable column's surface voxel is water
        expect(waterCells.every((cell) => cell.voxels[cell.voxels.length - 1] === 'water')).toBe(true);
        // No walkable column's surface is water
        expect(landCells.every((cell) => cell.voxels[cell.voxels.length - 1] !== 'water')).toBe(true);
    });
});

describe('islandTerrainPlugin', () => {
    it('builds the world canvas from the world seed in setup', () => {
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 6, height: 5 })] });
        expect(world.canvas.width).toBe(6);
        expect(world.canvas.height).toBe(5);
        expect(world.canvas.cells.length).toBe(30);
        expect(world.cellAt(2, 2)?.biome).toBe('forest');
    });

    it('exposes generation stats', () => {
        const plugin = islandTerrainPlugin({ width: 6, height: 5 });
        createWorld({ seed: 7, plugins: [plugin] });
        expect(plugin.stats()).toEqual({ land: 15, water: 15, forest: 3 });
    });

    it('respects a seed override independent of the world seed', () => {
        const world = createWorld({
            seed: 99,
            plugins: [islandTerrainPlugin({ width: 6, height: 5, seed: 7 })],
        });
        expect(world.canvas.width).toBe(6);
        // Same seed 7 → same interior biome as the canonical 6×5 map
        expect(world.cellAt(2, 2)?.biome).toBe('forest');
    });
});
