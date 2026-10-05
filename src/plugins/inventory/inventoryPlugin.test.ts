// Tests for the inventory environment plugin (plugins/inventory/inventoryPlugin.ts).
// Uses the default seed-7 island (37×25, centered coordinates) as fixture;
// the exact stock layouts below were captured from a reference run and must
// never drift.
//
// Tile DEPOSITS (TerrainCell.resources) seed the gatherable stocks: forests
// carry wood ×2, highlands stone ×1 (+ iron ×1 on vein lodes), and the
// UNLIMITED deposits — sand ×1 on beaches, dirt ×1 on meadows — never
// deplete when gathered. Cell stocks list deposits first, then biome food,
// then the shell/flint chance draws.

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
    kind: 'sentient',
    type: 'human',
    position: position3(x, y),
    marker: name.slice(0, 1),
    condition: 'well',
});

// Default island (37×25, seed 7) — has meadow, forest, beach and sea.
// Reference cells (captured, row-major order from the survey; deposits
// seed first, then the biome's food, then the chance draws):
//   (0,−6)    meadow  stock {dirt:1, berry:2}            (dirt unlimited)
//   (−3,−6)   forest  stock {wood:2, berry:1}
//   (−10,−11) beach   stock {sand:1, coconut:1, shell:1} (sand unlimited, 50% shell draw hit)
//   (−11,−11) beach   stock {sand:1, coconut:1}          (shell draw missed)
//   (−18,−12) shallows stock {fish:1}
//   (−7,0)    highland stock {stone:1}
//   (−5,3)    highland stock {stone:1, iron:1, flint:1} (iron lode + 30% flint draw hit)
//   (−7,1)    highland stock {iron:1, stone:1}     (iron lode, flint draw missed)
const buildWorld = () => {
    const island = inventoryPlugin({ rainChancePerMinute: 0 });
    const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
    return { world, island };
};

describe('inventoryPlugin', () => {
    it('seeds resources from tile deposits and biome food on setup', () => {
        const { island } = buildWorld();
        // Meadow (0,−6) → unlimited dirt + 2 berries
        expect(island.cellStock(0, -6)).toEqual({ dirt: 1, berry: 2 });
        // Forest (−3,−6) → 2 wood (the timber deposit) + 1 berry
        expect(island.cellStock(-3, -6)).toEqual({ wood: 2, berry: 1 });
        // Beach (−10,−11) → unlimited sand, coconut 1, shell (50% draw hit)
        expect(island.cellStock(-10, -11)).toEqual({ sand: 1, coconut: 1, shell: 1 });
        // Sea (−18,−12) → fish (no tile deposits under water)
        expect(island.cellStock(-18, -12)).toEqual({ fish: 1 });
    });

    it('seeds stone, iron lodes (and sometimes flint) on highlands', () => {
        const island = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
        // Reference highlands on the default island: (−7,0) holds plain
        // stone; (−5,3) is an iron lode that hid a flint (30% draw hit)
        expect(island.cellStock(-7, 0)).toEqual({ stone: 1 });
        expect(island.cellStock(-5, 3)).toEqual({ stone: 1, iron: 1, flint: 1 });
        // The other two lodes: (−7,1) and (−5,2) — the lodes carry stone too
        // (deposits seed in TILE_RESOURCES order: stone before iron)
        expect(island.cellStock(-7, 1)).toEqual({ stone: 1, iron: 1 });
        expect(island.cellStock(-5, 2)).toEqual({ stone: 1, iron: 1 });
        // Full reference lists — every highland carries stone (the lodes
        // carry it too, under the ore); the iron list is exactly the vein
        // noise's picks
        expect(island.cellsWithItem('stone').map((cell) => `${cell.x},${cell.y}`)).toEqual([
            '-7,0', '-6,0', '-7,1', '-6,1', '-5,1', '-6,2', '-5,2', '-6,3', '-5,3',
        ]);
        expect(island.cellsWithItem('iron').map((cell) => `${cell.x},${cell.y}`)).toEqual([
            '-7,1', '-5,2', '-5,3',
        ]);
        expect(island.cellsWithItem('flint').map((cell) => `${cell.x},${cell.y}`)).toEqual(['-5,3']);
    });

    it('gather moves the first available FOOD from the cell to the actor bag', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -3, -6));
        // Forest cell: the only food is the berry (wood is a deposit
        // material — gather never picks it)
        expect(island.gather(ael)).toBe('berry');
        expect(island.of('a')).toEqual({ berry: 1 });
        expect(island.cellStock(-3, -6)).toEqual({ wood: 2 });
        // Gathering event landed in the log (index 0 is the spawn event)
        expect(world.events.logFor('a')[1].message).toBe('Ael gathers 1 Berry.');
    });

    it('gather returns null when only materials remain, without side effects', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -3, -6));
        // The forest cell's only food is 1 berry — after that, wood stays
        expect(island.gather(ael)).toBe('berry');
        expect(island.gather(ael)).toBe(null);
        // No wood entered the bag and no wood left the tile: materials are
        // NOT gathered by the hunger loop (agents must walk to real food
        // instead of farming a tile's dirt/sand/stone forever)
        expect(island.of('a')).toEqual({ berry: 1 });
        expect(island.cellStock(-3, -6)).toEqual({ wood: 2 });
        // Materials are fetched explicitly with takeFromCell
        expect(island.takeFromCell(ael, 'wood')).toBe(true);
        expect(island.of('a')).toEqual({ berry: 1, wood: 1 });
    });

    it('gathering a finite deposit draws the tile down; the last unit re-skins it', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -3, -6));
        // Forest (−3,−6) starts with wood ×2 standing on it
        expect(world.cellAt(-3, -6)?.resources).toEqual({ wood: 2 });
        // Chopping one unit: the stock AND the tile deposit drop together
        expect(island.takeFromCell(ael, 'wood')).toBe(true);
        expect(island.cellStock(-3, -6)).toEqual({ wood: 1, berry: 1 });
        expect(world.cellAt(-3, -6)?.resources).toEqual({ wood: 1 });
        // Chopping the last unit empties the deposit — the tile re-skins to
        // its plain biome through tileSurfaceKey (scenario surfaceOf)
        expect(island.takeFromCell(ael, 'wood')).toBe(true);
        expect(island.cellStock(-3, -6)).toEqual({ berry: 1 });
        expect(world.cellAt(-3, -6)?.resources).toEqual({});
        // Nothing left to chop
        expect(island.takeFromCell(ael, 'wood')).toBe(false);
    });

    it('gathering an iron lode draws the ore before the stone around it', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -5, 3));
        // Lode (−5,3): stone ×1 + iron ×1 (+ a flint) — the cell also hides
        // a flint, which has no deposit
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 1, iron: 1 });
        expect(island.takeFromCell(ael, 'iron')).toBe(true);
        expect(island.of('a')).toEqual({ iron: 1 });
        // The ore is gone, the tile still shows its stone deposit
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 1 });
        expect(island.takeFromCell(ael, 'stone')).toBe(true);
        expect(world.cellAt(-5, 3)?.resources).toEqual({});
        // The mined-out highland falls back to its plain biome surface
        expect(world.cellAt(-5, 3)?.biome).toBe('highland');
    });

    it('unlimited deposits (sand, dirt) never deplete', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -10, -11));
        // Scooping sand: the bag grows with every take…
        for (let index = 0; index < 5; index++) {
            expect(island.takeFromCell(ael, 'sand')).toBe(true);
        }
        expect(island.of('a')).toEqual({ sand: 5 });
        // …but the pile and the deposit stay intact forever
        expect(island.cellStock(-10, -11)).toEqual({ sand: 1, coconut: 1, shell: 1 });
        expect(world.cellAt(-10, -11)?.resources).toEqual({ sand: 1 });
        // Dirt works the same on meadows
        const bram = world.spawn(actor('b', 'Bram', 0, -6));
        expect(island.takeFromCell(bram, 'dirt')).toBe(true);
        expect(island.of('b')).toEqual({ dirt: 1 });
        expect(island.cellStock(0, -6)).toEqual({ dirt: 1, berry: 2 });
        expect(world.cellAt(0, -6)?.resources).toEqual({ dirt: 1 });
    });

    it('taking from an empty stock fails without side effects', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 0, -6));
        // No water on the cell yet
        expect(island.takeFromCell(ael, 'water')).toBe(false);
        expect(island.of('a')).toEqual({});
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
        // The unlimited deposits blanket their biomes: 438 beaches carry
        // sand, 138 meadows carry dirt
        expect(island.cellsWithItem('sand').length).toBe(438);
        expect(island.cellsWithItem('dirt').length).toBe(138);
    });

    it('regrowth restores stocks on the staggered rhythm', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 0, -6));
        void ael;
        // Meadow cell (0,−6): cap 3, rhythm every 30 minutes at offset 20 —
        // a 10-minute step sweeps minutes 1-10 (silent), the next one
        // crosses minute 20 and regrows
        island.cellStock(0, -6).berry = 0;
        world.step(); // minutes 1-10 → no minute hits the offset
        expect(island.cellStock(0, -6).berry ?? 0).toBe(0);
        world.step(); // minutes 11-20 → minute 20 regrows one berry
        expect(island.cellStock(0, -6).berry).toBe(1);
        // Cap respected: parked at cap, regrowth does not exceed 3
        island.cellStock(0, -6).berry = 3;
        world.step();
        world.step();
        expect(island.cellStock(0, -6).berry).toBe(3);
    });

    it('wood regrowth grows the tile deposit back with the stock', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -3, -6));
        // Chop ONE timber unit off the forest (−3,−6): the pile keeps its
        // last unit (the key a regrowth sweep needs — a fully deleted pile
        // never regrows, matching the stock behavior)
        island.takeFromCell(ael, 'wood');
        expect(island.cellStock(-3, -6)).toEqual({ wood: 1, berry: 1 });
        expect(world.cellAt(-3, -6)?.resources).toEqual({ wood: 1 });
        // Wood rhythm: every 60 minutes at offset 40 — steps 1-3 (minutes
        // 1-30) pass silently…
        world.step();
        world.step();
        world.step();
        expect(island.cellStock(-3, -6).wood).toBe(1);
        // …step 4 (minute 40) regrows one unit into the stock AND the tile
        // deposit
        world.step();
        expect(island.cellStock(-3, -6).wood).toBe(2);
        expect(world.cellAt(-3, -6)?.resources).toEqual({ wood: 2 });
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
        expect(island.cellStock(-3, -5)).toEqual({ sand: 1, coconut: 1, shell: 1 });
        expect(island.cellStock(-2, -4)).toEqual({ wood: 2, berry: 1 });
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
        // Reference run: the per-minute rain roll (0.0127/min ≈ 0.12 per
        // 10-minute step) fired on steps 19, 22, 23, 41, 43, 51, 57
        expect(rains).toEqual([19, 22, 23, 41, 43, 51, 57]);
        // Beach (−11,−11): coconut regrew to cap 2; two rains pooled water;
        // the unlimited sand pile never moved
        expect(island.cellStock(-11, -11)).toEqual({ sand: 1, coconut: 2, water: 2 });
    });
});
