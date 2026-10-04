// Tests for the behavior environment plugin (plugins/behavior/behaviorPlugin.ts).
// Every scenario assembles the full plugin stack exactly like the scenario
// factory does, then drives it with controlled needs rates. All outcomes were
// captured from reference runs — the agent loop is fully deterministic.

import { describe, it, expect } from 'vitest';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { behaviorPlugin } from './behaviorPlugin';
import type { Actor } from '../../engine/types';

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, x, y, marker: name.slice(0, 1), condition: 'well' };
    return world.spawn(actor);
};

// Full stack with rain disabled so injected water is the only source
const buildStack = (needsOptions: Parameters<typeof needsPlugin>[0] = {}) => {
    const inventory = inventoryPlugin({ rainChance: 0 });
    const needs = needsPlugin({ thirstPerMinute: 0, energyPerMinute: 0, ...needsOptions });
    const relationship = relationshipPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship });
    const world = createWorld({
        seed: 7,
        tickSize: 10,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, behavior],
    });
    return { world, inventory, needs, relationship };
};

describe('behaviorPlugin', () => {
    it('a hungry actor eats the first food in its bag (berry priority)', () => {
        const { world, inventory, needs } = buildStack({ hungerPerMinute: 0.6 });
        spawn(world, 'a', 'Ael', 6, 2);
        inventory.spawnKit('a', { berry: 2, flint: 1 });
        for (let index = 0; index < 7; index++) {
            world.step();
        }
        // Hunger 20+6×7 = 62 ≥ 60 on tick 7 → eats one berry (−14 nutrition)
        expect(needs.of('a')).toEqual({ hunger: 48, thirst: 20, energy: 94 });
        expect(inventory.of('a')).toEqual({ berry: 1, flint: 1 });
        // Six hungry-wander ticks happened before the eating tick
        expect(world.events.log().map((event) => event.kind)).toEqual([
            'spawn', 'move', 'move', 'move', 'move', 'move', 'move', 'consume',
        ]);
        expect(world.events.log()[7].message).toBe('Ael eats 1 Berry.');
    });

    it('a hungry actor with no food gathers from the cell it stands on', () => {
        const { world, inventory, needs } = buildStack({ hungerPerMinute: 0.6 });
        spawn(world, 'a', 'Ael', 6, 2);
        inventory.spawnKit('a', { flint: 1 });
        for (let index = 0; index < 7; index++) {
            world.step();
        }
        // Wandering carried the actor to a beach — gathering picked a coconut
        expect(inventory.of('a')).toEqual({ flint: 1, coconut: 1 });
        expect(needs.of('a').hunger).toBe(62);
        // Meanwhile the forest cell regrew: berry rhythm hit ticks 2 & 5,
        // wood rhythm tick 4
        expect(inventory.cellStock(6, 2)).toEqual({ berry: 3, wood: 3 });
    });

    it('a thirsty actor drinks the rainwater pool on its own cell', () => {
        const { world, inventory, needs } = buildStack({});
        spawn(world, 'a', 'Ael', 8, 2);
        inventory.cellStock(8, 2).water = 1;
        needs.satisfy('a', { thirst: 50 }); // thirst 70 ≥ 65 → drink this tick
        world.step();
        // −35 thirst relief, the pool is emptied, nothing enters the bag
        // (hunger 21: the default 0.1/min decay ran one tick)
        expect(needs.of('a')).toEqual({ hunger: 21, thirst: 35, energy: 100 });
        expect(inventory.cellStock(8, 2)).toEqual({ berry: 2 });
        expect(inventory.of('a')).toEqual({});
        expect(world.events.log()[1]).toEqual({
            id: 2,
            tick: 1,
            time: 10,
            kind: 'consume',
            message: 'Ael drinks 1 Water.',
            actorId: 'a',
        });
    });

    it('an exhausted actor rests and recovers energy', () => {
        const { world, needs } = buildStack({ energyPerMinute: 0.8 });
        spawn(world, 'a', 'Ael', 8, 2);
        for (let index = 0; index < 10; index++) {
            world.step();
        }
        // 100 − 8/tick × 9 ticks − 8 move charges = 20 at tick 9 → rest +12,
        // then one more wander tick: 32 − 8 − 1 = 23
        expect(needs.of('a').energy).toBe(23);
        // The rest happened on tick 9, after 8 wandering moves
        expect(world.events.log().map((event) => event.kind)).toEqual([
            'spawn', 'move', 'move', 'move', 'move', 'move', 'move', 'move', 'move', 'rest', 'move',
        ]);
        expect(world.events.log()[9].message).toBe('Ael rests for a while.');
    });

    it('a fed actor exchanges food for a hungry neighbour’s material', () => {
        const { world, inventory, relationship } = buildStack({});
        spawn(world, 'a', 'Ael', 8, 2);
        spawn(world, 'b', 'Bram', 8, 3);
        inventory.spawnKit('a', { berry: 3, flint: 1 });
        inventory.spawnKit('b', { shell: 1 });
        needs_satisfy(world, 'b', 50); // Bram at hunger 70
        world.step();
        // Ael: no survival triggers → social: trades 1 berry for Bram's shell
        expect(inventory.of('a')).toEqual({ berry: 2, flint: 1, shell: 1 });
        // Bram: hunger 70 → eats the traded berry in his own tick
        expect(inventory.of('b')).toEqual({});
        expect(relationship.relation('a', 'b')).toBe(6);
        expect(world.events.log().map((event) => event.message)).toEqual([
            'Ael washes ashore.',
            'Bram washes ashore.',
            'Ael and Bram trade: 1 Berry for 1 Shell.',
            'Ael and Bram grow closer (trading).',
            'Bram eats 1 Berry.',
        ]);
    });

    it('a fed actor gifts food when the neighbour has nothing to trade', () => {
        const { world, inventory, relationship } = buildStack({});
        spawn(world, 'a', 'Ael', 8, 2);
        spawn(world, 'b', 'Bram', 8, 3);
        inventory.spawnKit('a', { berry: 3, flint: 1 });
        needs_satisfy(world, 'b', 50);
        world.step();
        // Exchange impossible (Bram holds nothing) → gift from a 3-berry bag
        expect(inventory.of('a')).toEqual({ berry: 2, flint: 1 });
        expect(inventory.of('b')).toEqual({});
        expect(relationship.relation('a', 'b')).toBe(10);
        expect(world.events.log().map((event) => event.message)).toEqual([
            'Ael washes ashore.',
            'Bram washes ashore.',
            'Ael gives Bram 1 Berry.',
            'Ael and Bram grow closer (gifting).',
            'Bram eats 1 Berry.',
        ]);
    });

    it('a starving actor walks toward the nearest stocked cell', () => {
        const { world, inventory, needs } = buildStack({ hungerPerMinute: 0.6 });
        // Drain every cell, leave a single stocked meadow at (8,2)
        world.landCells().forEach((cell) => {
            const stock = inventory.cellStock(cell.x, cell.y);
            Object.keys(stock).forEach((item) => {
                delete stock[item];
            });
        });
        inventory.cellStock(8, 2).berry = 3;
        spawn(world, 'a', 'Ael', 11, 0);
        inventory.spawnKit('a', { flint: 1 });
        for (let index = 0; index < 9; index++) {
            world.step();
        }
        // Six hungry wanders, then the walk path toward (8,2), arriving and
        // gathering a berry on tick 9
        expect(world.events.log().filter((event) => event.kind === 'move').map((event) => event.message)).toEqual([
            'Ael wanders south.',
            'Ael wanders west.',
            'Ael wanders southwest.',
            'Ael wanders southeast.',
            'Ael wanders south.',
            'Ael wanders northwest.',
            'Ael moves west.',
            'Ael moves north.',
        ]);
        expect(world.actors.get('a')).toMatchObject({ x: 8, y: 2 });
        expect(inventory.of('a')).toEqual({ flint: 1, berry: 1 });
        expect(needs.of('a')).toEqual({ hunger: 74, thirst: 20, energy: 92 });
    });

    it('social attempts respect the cooldown (bag too small to repeat)', () => {
        const { world, inventory, relationship } = buildStack({});
        spawn(world, 'a', 'Ael', 8, 2);
        spawn(world, 'b', 'Bram', 8, 3);
        // Only 3 berries: one gift, then the bag is below the gift line
        inventory.spawnKit('a', { berry: 3 });
        needs_satisfy(world, 'b', 50);
        // Keep Bram permanently hungry so every cooldown window re-triggers
        for (let index = 0; index < 8; index++) {
            world.step();
            needs_satisfy(world, 'b', 10);
        }
        // Gift lands on tick 1 (+10); afterwards Ael holds 2 berries — below
        // the 3-berry gift threshold and Bram never holds a material, so no
        // further social action fires. Drift −0.2 × 7 ticks → 8.6.
        expect(relationship.relation('a', 'b')).toBe(8.600000000000005);
        expect(inventory.of('a')).toEqual({ berry: 2 });
        const socialEvents = world.events.log().filter((event) => event.kind === 'exchange' || event.kind === 'relationship');
        expect(socialEvents.map((event) => event.message)).toEqual([
            'Ael gives Bram 1 Berry.',
            'Ael and Bram grow closer (gifting).',
        ]);
    });
});

// Small helper: push an actor's hunger up through the plugin API
function needs_satisfy(world: ReturnType<typeof createWorld>, actorId: string, amount: number) {
    // The needs plugin instance is reached through the registry
    const needs = world.plugins.get('needs') as ReturnType<typeof needsPlugin>;
    needs.satisfy(actorId, { hunger: amount });
}
