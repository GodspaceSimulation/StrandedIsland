// Tests for the World Size settlement helpers (features/worldSize.ts).
//
// settleAfterResize() runs after a terrain regeneration: every coordinate
// resident is clamped back inside the new centered bounds, and castaways
// left standing on water (or out of bounds) walk to the nearest dry cell.
// A synthetic 5×5 canvas (cells −2…+2) makes every outcome hand-computable.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../engine/world';
import { settleAfterResize } from './worldSize';
import type { TerrainCell } from '../engine/types';

/** Synthetic odd canvas builder — dry at the listed cells, water elsewhere. */
const canvas5x5 = (dryCells: Array<[number, number]>): {
    width: number;
    height: number;
    cells: TerrainCell[];
} => {
    const dry = new Set(dryCells.map(([x, y]) => `${x},${y}`));
    const cells: TerrainCell[] = [];
    for (let row = -2; row <= 2; row++) {
        for (let col = -2; col <= 2; col++) {
            const passable = dry.has(`${col},${row}`);
            cells.push({
                x: col,
                y: row,
                voxels: passable ? ['sand'] : ['sand', 'water'],
                height: passable ? 3 : 2,
                waterLevel: 3,
                biome: passable ? 'beach' : 'shallows',
                passable,
            });
        }
    }
    return { width: 5, height: 5, cells };
};

describe('settleAfterResize', () => {
    it('clamps out-of-bounds residents and walks castaways off the water', () => {
        const world = createWorld({ seed: 1 });
        // Dry land: the center (0,0) and (−1,−1). Row-major land order:
        // (−1,−1) first (index 11), (0,0) second (index 12)
        world.canvas = canvas5x5([[0, 0], [-1, -1]]);

        // 'a' — out of bounds AND its clamp lands on water: (3,1) → clamp
        // (2,1), which is sea → nearest dry cell is (0,0) (Chebyshev 2 vs 3)
        world.spawn({
            id: 'a', name: 'Ael', position: position3(3, 1), marker: 'A', condition: 'well',
        });
        // 'b' — in bounds but standing on water: (0,1) → nearest dry (0,0)
        world.spawn({
            id: 'b', name: 'Bram', position: position3(0, 1), marker: 'B', condition: 'well',
        });
        // 'c' — dry and in bounds: untouched
        world.spawn({
            id: 'c', name: 'Cove', position: position3(-1, -1), marker: 'C', condition: 'well',
        });
        // A flyer out of bounds — clamped in the spatial record, z kept
        world.coordinates.place({
            id: 'bird-1',
            position: position3(5, 0, 2),
            kind: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
        });

        const report = settleAfterResize(world);

        // Clamped: 'a' (into the canvas) and the bird — 'b'/'c' stayed inside
        expect(report).toEqual({
            clamped: ['a', 'bird-1'],
            relocated: ['a', 'b'],
        });
        // 'a' clamped to (2,1), then walked to the nearest dry cell (0,0)
        expect(world.actors.get('a')?.position).toEqual({ x: 0, y: 0, z: 0 });
        // 'b' walked to (0,0) too — distance 1 beats (−1,−1) at distance 2
        expect(world.actors.get('b')?.position).toEqual({ x: 0, y: 0, z: 0 });
        // 'c' never moved
        expect(world.actors.get('c')?.position).toEqual({ x: -1, y: -1, z: 0 });
        // The bird kept its altitude, just pulled back inside the bounds
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: 2, y: 0, z: 2 });
    });

    it('leaves a fully settled world untouched', () => {
        const world = createWorld({ seed: 1 });
        world.canvas = canvas5x5([[0, 0], [1, 1]]);
        world.spawn({
            id: 'a', name: 'Ael', position: position3(1, 1), marker: 'A', condition: 'well',
        });
        world.coordinates.place({
            id: 'bird-1',
            position: position3(0, 0, 2),
            kind: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
        });
        expect(settleAfterResize(world)).toEqual({ clamped: [], relocated: [] });
        expect(world.actors.get('a')?.position).toEqual({ x: 1, y: 1, z: 0 });
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: 0, y: 0, z: 2 });
    });
});
