// Tests for the scenario composition root (scenario/island.ts).

import { describe, it, expect } from 'vitest';
import { createIslandWorld } from './island';

describe('createIslandWorld', () => {
    it('assembles all stock plugins in tick order', () => {
        const handle = createIslandWorld({ seed: 7 });
        expect(handle.world.plugins.list().map((plugin) => plugin.id)).toEqual([
            'island-terrain',
            'inventory',
            'needs',
            'relationship',
            'behavior',
        ]);
        expect(handle.world.ticker.tickSize()).toBe(10);
        // The canvas exists after terrain setup
        expect(handle.world.canvas).toEqual({
            width: 12,
            height: 10,
            cells: expect.any(Array),
        });
    });

    it('spawns the cast spread across dry land with a starting kit', () => {
        const handle = createIslandWorld({ seed: 7 });
        expect(Array.from(handle.world.actors.values()).map((actor) => ({
            id: actor.id,
            name: actor.name,
            x: actor.x,
            y: actor.y,
        }))).toEqual([
            { id: 'actor-1', name: 'Ael', x: 6, y: 0 },
            { id: 'actor-2', name: 'Bram', x: 8, y: 2 },
            { id: 'actor-3', name: 'Cove', x: 7, y: 4 },
            { id: 'actor-4', name: 'Dune', x: 5, y: 6 },
        ]);
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 2, flint: 1 });
        expect(handle.inventory.of('actor-4')).toEqual({ berry: 2, flint: 1 });
    });

    it('actorCount caps the cast', () => {
        const handle = createIslandWorld({ seed: 7, actorCount: 2 });
        expect(Array.from(handle.world.actors.keys())).toEqual(['actor-1', 'actor-2']);
    });

    it('runs: actors wander once the ticker advances', () => {
        const handle = createIslandWorld({ seed: 7 });
        handle.world.step();
        expect(handle.world.ticker.ticks()).toBe(1);
        // Every actor moved at least once on the first tick (wander path)
        expect(handle.world.events.log().filter((event) => event.kind === 'move').length).toBe(4);
    });

    it('plugin toggles swap environment behaviour out entirely', () => {
        // No behavior plugin → actors stand still forever
        const still = createIslandWorld({ seed: 7, plugins: { behavior: false } });
        const before = Array.from(still.world.actors.values()).map((actor) => [actor.x, actor.y]);
        for (let index = 0; index < 5; index++) {
            still.world.step();
        }
        const after = Array.from(still.world.actors.values()).map((actor) => [actor.x, actor.y]);
        expect(after).toEqual(before);
        expect(still.world.plugins.has('behavior')).toBe(false);

        // Only terrain → a bare canvas world with no actors at all
        const bare = createIslandWorld({
            seed: 7,
            plugins: { inventory: false, needs: false, relationship: false, behavior: false },
            actorCount: 0,
        });
        expect(bare.world.plugins.list().map((plugin) => plugin.id)).toEqual(['island-terrain']);
        expect(bare.world.canvas.width).toBe(12);
    });

    it('exposes the plugin handles for god-side control', () => {
        const handle = createIslandWorld({ seed: 7, actorCount: 2 });
        // The god can force an exchange between the two castaways
        const ael = handle.world.actors.get('actor-1');
        const bram = handle.world.actors.get('actor-2');
        const forced = handle.inventory.exchange(ael, bram, { flint: 1 }, { berry: 1 });
        expect(forced).toBe(true);
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 3 });
        expect(handle.inventory.of('actor-2')).toEqual({ berry: 1, flint: 2 });
        expect(handle.relationship.relation('actor-1', 'actor-2')).toBe(0);
        // …and inspect needs directly
        expect(handle.needs.of('actor-1')).toEqual({ hunger: 20, thirst: 20, energy: 100 });
    });
});
