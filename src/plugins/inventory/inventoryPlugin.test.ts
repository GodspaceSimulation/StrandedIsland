// Tests for the inventory environment plugin (plugins/inventory/inventoryPlugin.ts).
// Uses the default seed-7 island as fixture; the exact stock layouts below
// were captured from a reference run and must never drift.

import { describe, it, expect } from 'vitest';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import type { Actor } from '../../engine/types';
import { inventoryPlugin } from './inventoryPlugin';

// A standard actor fixture placed on a specific cell
const actor = (id: string, name: string, x: number, y: number): Actor => ({
    id,
    name,
    x,
    y,
    marker: name.slice(0, 1),
    condition: 'well',
});

// Default island (12×10, seed 7) — has meadow, forest, beach and sea
const buildWorld = () => {
    const island = inventoryPlugin({ rainChance: 0 });
    const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
    return { world, island };
};

describe('inventoryPlugin', () => {
    it('seeds resources by biome on setup', () => {
        const { island } = buildWorld();
        // Meadow (8,2) → 2 berries
        expect(island.cellStock(8, 2)).toEqual({ berry: 2 });
        // Forest (6,2) → 1 berry + 2 wood
        expect(island.cellStock(6, 2)).toEqual({ berry: 1, wood: 2 });
        // Beach (3,2) → coconut 1, shell (50% draw hit for this cell)
        expect(island.cellStock(3, 2)).toEqual({ coconut: 1, shell: 1 });
        // Sea (0,0) → fish
        expect(island.cellStock(0, 0)).toEqual({ fish: 1 });
    });

    it('seeds stone (and sometimes flint) on highlands', () => {
        const island = inventoryPlugin();
        // Roughness 0.62 / maxHeight 9 produces one highland at (6,4)
        createWorld({
            seed: 7,
            plugins: [islandTerrainPlugin({ roughness: 0.62, maxHeight: 9 }), island],
        });
        expect(island.cellStock(6, 4)).toEqual({ stone: 1 });
        // Flint draw missed for this cell/seed — flint list empty
        expect(island.cellsWithItem('flint')).toEqual([]);
        expect(island.cellsWithItem('stone').map((cell) => `${cell.x},${cell.y}`)).toEqual(['6,4']);
    });

    it('gather moves the first available item from the cell to the actor bag', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 6, 2));
        // Forest cell: insertion order berry → wood
        expect(island.gather(ael)).toBe('berry');
        expect(island.of('a')).toEqual({ berry: 1 });
        expect(island.cellStock(6, 2)).toEqual({ wood: 2 });
        // Gathering event landed in the log (index 0 is the spawn event)
        expect(world.events.logFor('a')[1].message).toBe('Ael gathers 1 Berry.');
    });

    it('gather returns null on an empty stock without side effects', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 6, 2));
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
        const ael = world.spawn(actor('a', 'Ael', 8, 2));
        // No water on the cell yet
        expect(island.takeFromCell(ael, 'water')).toBe(false);
        // Inject rain water manually (rain chance is disabled in the fixture)
        island.cellStock(8, 2).water = 1;
        expect(island.takeFromCell(ael, 'water')).toBe(true);
        expect(island.of('a')).toEqual({ water: 1 });
        expect(island.cellStock(8, 2).water).toBeUndefined();
    });

    it('exchange trades between actor bags atomically', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 6, 2));
        const bram = world.spawn(actor('b', 'Bram', 6, 1));
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
        const ael = world.spawn(actor('a', 'Ael', 6, 2));
        const bram = world.spawn(actor('b', 'Bram', 6, 1));
        island.spawnKit('a', { berry: 1 });
        island.spawnKit('b', { shell: 1 });
        // Bram has no fish to give
        expect(island.exchange(ael, bram, { berry: 1 }, { fish: 1 })).toBe(false);
        expect(island.of('a')).toEqual({ berry: 1 });
        expect(island.of('b')).toEqual({ shell: 1 });
    });

    it('give transfers one-way and logs a gift', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 6, 2));
        const bram = world.spawn(actor('b', 'Bram', 6, 1));
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
        // Only sea cells hold fish initially (47 water cells on the default island)
        const fishCells = island.cellsWithItem('fish');
        expect(fishCells.length).toBe(47);
        expect(fishCells.every((cell) => !cell.passable)).toBe(true);
    });

    it('regrowth restores stocks on the staggered rhythm', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 8, 2));
        void ael;
        // Meadow cell (8,2): cap 3, rhythm every 3 ticks at offset 2
        island.cellStock(8, 2).berry = 0;
        world.step(); // tick 1 → 1 % 3 = 1, no regrow
        expect(island.cellStock(8, 2).berry ?? 0).toBe(0);
        world.step(); // tick 2 → 2 % 3 = 2, +1
        expect(island.cellStock(8, 2).berry).toBe(1);
        // Cap respected: parked at cap, regrowth does not exceed 3
        island.cellStock(8, 2).berry = 3;
        world.step();
        world.step();
        expect(island.cellStock(8, 2).berry).toBe(3);
    });

    it('dispose wipes all bags and stocks', () => {
        const { world, island } = buildWorld();
        world.spawn(actor('a', 'Ael', 6, 2));
        island.spawnKit('a', { berry: 1 });
        world.plugins.remove('inventory');
        // Re-touching creates a fresh empty bag
        expect(island.of('a')).toEqual({});
        expect(island.cellStock(6, 2)).toEqual({});
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
        for (let index = 0; index < 12; index++) {
            world.step();
        }
        unsubscribe();
        // Reference run: exactly one rain in the first 12 ticks, on tick 7
        expect(rains).toEqual([7]);
        // Beach (3,2) picked up 1 rain water; its coconut regrew to cap 2
        expect(island.cellStock(3, 2)).toEqual({ coconut: 2, shell: 1, water: 1 });
    });
});
