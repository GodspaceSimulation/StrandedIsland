// Tests for the inventory environment plugin (plugins/inventory/inventoryPlugin.ts).
// Uses the default seed-7 island (37×25, centered coordinates) as fixture;
// the exact stock layouts below were captured from a reference run and must
// never drift.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import type { Actor } from '../../engine/types';
import { inventoryPlugin } from './inventoryPlugin';

// A standard actor fixture placed on a specific cell (ground plane, z = 0)
const actor = (id: string, name: string, x: number, y: number): Actor => ({
    id,
    name,
    position: position3(x, y),
    marker: name.slice(0, 1),
    condition: 'well',
});

// Default island (37×25, seed 7) — has meadow, forest, beach and sea.
// Reference cells (captured, row-major order from the survey):
//   (0,−6)    meadow  stock {berry:2}
//   (−3,−6)   forest  stock {berry:1, wood:2}
//   (−10,−11) beach   stock {coconut:1, shell:1} (50% shell draw hit)
//   (−11,−11) beach   stock {coconut:1}          (shell draw missed)
//   (−18,−12) shallows stock {fish:1}
//   (−7,0)    highland stock {stone:1}
//   (−5,3)    highland stock {stone:1, flint:1}
const buildWorld = () => {
    const island = inventoryPlugin({ rainChance: 0 });
    const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
    return { world, island };
};

describe('inventoryPlugin', () => {
    it('seeds resources by biome on setup', () => {
        const { island } = buildWorld();
        // Meadow (0,−6) → 2 berries
        expect(island.cellStock(0, -6)).toEqual({ berry: 2 });
        // Forest (−3,−6) → 1 berry + 2 wood
        expect(island.cellStock(-3, -6)).toEqual({ berry: 1, wood: 2 });
        // Beach (−10,−11) → coconut 1, shell (50% draw hit for this cell)
        expect(island.cellStock(-10, -11)).toEqual({ coconut: 1, shell: 1 });
        // Sea (−18,−12) → fish
        expect(island.cellStock(-18, -12)).toEqual({ fish: 1 });
    });

    it('seeds stone (and sometimes flint) on highlands', () => {
        const island = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
        // Reference highlands on the default island: (−7,0) holds a stone,
        // (−5,3) hid a flint (30% draw hit)
        expect(island.cellStock(-7, 0)).toEqual({ stone: 1 });
        expect(island.cellStock(-5, 3)).toEqual({ stone: 1, flint: 1 });
        // Full reference lists
        expect(island.cellsWithItem('stone').map((cell) => `${cell.x},${cell.y}`)).toEqual([
            '-7,0', '-6,0', '-7,1', '-6,1', '-5,1', '-6,2', '-5,2', '-6,3', '-5,3',
        ]);
        expect(island.cellsWithItem('flint').map((cell) => `${cell.x},${cell.y}`)).toEqual(['-5,3']);
    });

    it('gather moves the first available item from the cell to the actor bag', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -3, -6));
        // Forest cell: insertion order berry → wood
        expect(island.gather(ael)).toBe('berry');
        expect(island.of('a')).toEqual({ berry: 1 });
        expect(island.cellStock(-3, -6)).toEqual({ wood: 2 });
        // Gathering event landed in the log (index 0 is the spawn event)
        expect(world.events.logFor('a')[1].message).toBe('Ael gathers 1 Berry.');
    });

    it('gather returns null on an empty stock without side effects', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -3, -6));
        // Drain the forest cell (1 berry + 2 wood = 3 items)
        island.gather(ael);
        island.gather(ael);
        island.gather(ael);
        island.gather(ael);
        expect(island.gather(ael)).toBe(null);
        expect(island.of('a')).toEqual({ berry: 1, wood: 2 });
    });

    it('takeFromCell fetches an explicit item (drinking rainwater)', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 0, -6));
        // No water on the cell yet
        expect(island.takeFromCell(ael, 'water')).toBe(false);
        // Inject rain water manually (rain chance is disabled in the fixture)
        island.cellStock(0, -6).water = 1;
        expect(island.takeFromCell(ael, 'water')).toBe(true);
        expect(island.of('a')).toEqual({ water: 1 });
        expect(island.cellStock(0, -6).water).toBeUndefined();
    });

    it('exchange trades between actor bags atomically', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -3, -6));
        const bram = world.spawn(actor('b', 'Bram', -3, -5));
        island.spawnKit('a', { berry: 2 });
        island.spawnKit('b', { shell: 1 });
        // A trades 1 berry for 1 shell
        expect(island.exchange(ael, bram, { berry: 1 }, { shell: 1 })).toBe(true);
        expect(island.of('a')).toEqual({ berry: 1, shell: 1 });
        expect(island.of('b')).toEqual({ berry: 1 });
        // Trade event is logged (index 0 is the spawn event)
        const exchanges = world.events.log().filter((event) => event.kind === 'exchange');
        expect(exchanges[0].message).toBe('Ael and Bram trade: 1 Berry for 1 Shell.');
    });

    it('exchange refuses when either side cannot pay', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -3, -6));
        const bram = world.spawn(actor('b', 'Bram', -3, -5));
        island.spawnKit('a', { berry: 1 });
        island.spawnKit('b', { shell: 1 });
        // Bram has no fish to give
        expect(island.exchange(ael, bram, { berry: 1 }, { fish: 1 })).toBe(false);
        expect(island.of('a')).toEqual({ berry: 1 });
        expect(island.of('b')).toEqual({ shell: 1 });
    });

    it('give transfers one-way and logs a gift', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -3, -6));
        const bram = world.spawn(actor('b', 'Bram', -3, -5));
        island.spawnKit('a', { fish: 1 });
        expect(island.give(ael, bram, 'fish', 1)).toBe(true);
        expect(island.of('a')).toEqual({});
        expect(island.of('b')).toEqual({ fish: 1 });
        const gifts = world.events.log().filter((event) => event.kind === 'exchange');
        expect(gifts[0].message).toBe('Ael gives Bram 1 Fish.');
        // Cannot give what is not held
        expect(island.give(ael, bram, 'fish', 1)).toBe(false);
    });

    it('cellsWithItem lists cells holding an item', () => {
        const { island } = buildWorld();
        // Only sea cells hold fish initially (250 water cells on the default island)
        const fishCells = island.cellsWithItem('fish');
        expect(fishCells.length).toBe(250);
        expect(fishCells.every((cell) => !cell.passable)).toBe(true);
    });

    it('regrowth restores stocks on the staggered rhythm', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 0, -6));
        void ael;
        // Meadow cell (0,−6): cap 3, rhythm every 3 ticks at offset 2
        island.cellStock(0, -6).berry = 0;
        world.step(); // tick 1 → 1 % 3 = 1, no regrow
        expect(island.cellStock(0, -6).berry ?? 0).toBe(0);
        world.step(); // tick 2 → 2 % 3 = 2, +1
        expect(island.cellStock(0, -6).berry).toBe(1);
        // Cap respected: parked at cap, regrowth does not exceed 3
        island.cellStock(0, -6).berry = 3;
        world.step();
        world.step();
        expect(island.cellStock(0, -6).berry).toBe(3);
    });

    it('dispose wipes all bags and stocks', () => {
        const { world, island } = buildWorld();
        world.spawn(actor('a', 'Ael', -3, -6));
        island.spawnKit('a', { berry: 1 });
        world.plugins.remove('inventory');
        // Re-touching creates a fresh empty bag
        expect(island.of('a')).toEqual({});
        expect(island.cellStock(-3, -6)).toEqual({});
    });

    it('resurvey wipes and re-seeds cell stocks after a terrain regeneration', () => {
        const plugin = islandTerrainPlugin();
        const island = inventoryPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin, island] });
        // Shrink the island and re-survey the new canvas
        plugin.resize(21, 13);
        island.resurvey();
        // Reference cells on the 21×13 island (row-major survey order):
        // first beach (−3,−5) hit the shell draw, first forest (−2,−4)
        expect(island.cellStock(-3, -5)).toEqual({ coconut: 1, shell: 1 });
        expect(island.cellStock(-2, -4)).toEqual({ berry: 1, wood: 2 });
        // Stocks from the OLD canvas are gone: a cell that only existed on
        // the 37×25 island (−11,−11) now has no stock (out of bounds)
        expect(island.cellStock(-11, -11)).toEqual({});
        // Water cells stock fish again on the new canvas
        expect(island.cellsWithItem('fish').length).toBe(111);
    });

    it('rain pools fresh water on land cells on the seeded rhythm', () => {
        const island = inventoryPlugin();
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
        const rains: number[] = [];
        const unsubscribe = world.events.subscribe((event) => {
            if (event.kind === 'weather') {
                rains.push(event.tick);
            }
        });
        for (let index = 0; index < 60; index++) {
            world.step();
        }
        unsubscribe();
        // Reference run: three rains in the first 60 ticks, on ticks 33, 52, 53
        expect(rains).toEqual([33, 52, 53]);
        // Beach (−11,−11): coconut regrew to cap 2; two rains pooled water
        expect(island.cellStock(-11, -11)).toEqual({ coconut: 2, water: 2 });
    });
});
