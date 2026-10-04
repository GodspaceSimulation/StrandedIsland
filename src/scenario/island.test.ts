// Tests for the scenario composition root (scenario/island.ts).

import { describe, it, expect } from 'vitest';
import { createIslandWorld } from './island';

describe('createIslandWorld', () => {
    it('assembles all stock plugins in tick order (packages + environment)', () => {
        const handle = createIslandWorld({ seed: 7 });
        expect(handle.world.plugins.list().map((plugin) => plugin.id)).toEqual([
            'island-terrain',
            'inventory',
            'needs',
            'relationship',
            'behavior',
            'birds',
            // The @godspace/canvas representation plugin, loaded by the engine
            'ascii-canvas',
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
            position: actor.position,
        }))).toEqual([
            { id: 'actor-1', name: 'Ael', position: { x: 6, y: 0, z: 0 } },
            { id: 'actor-2', name: 'Bram', position: { x: 8, y: 2, z: 0 } },
            { id: 'actor-3', name: 'Cove', position: { x: 7, y: 4, z: 0 } },
            { id: 'actor-4', name: 'Dune', position: { x: 5, y: 6, z: 0 } },
        ]);
        // Every castaway sits on the ground plane (z = 0) in the coordinate
        // record — the 3D spatial record holds the whole world
        expect(
            Array.from(handle.world.actors.keys()).map((id) => handle.world.coordinates.positionOf(id)?.z),
        ).toEqual([0, 0, 0, 0]);
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 2, flint: 1 });
        expect(handle.inventory.of('actor-4')).toEqual({ berry: 2, flint: 1 });
    });

    it('releases a seabird wheeling above the island center at cruise altitude', () => {
        const handle = createIslandWorld({ seed: 7 });
        const bird = handle.birds.birdOf('bird-1');
        expect(bird).toEqual({
            id: 'bird-1',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
            // 12×10 island → center column (6, 5), cruise altitude z = 2
            position: { x: 6, y: 5, z: 2 },
        });
        // The bird lives in the 3D spatial record with kind 'bird'
        expect(handle.world.coordinates.entryOf('bird-1')).toEqual({
            id: 'bird-1',
            position: { x: 6, y: 5, z: 2 },
            kind: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
        });
        // Birds are not castaways — they stay out of the actor registry
        expect(handle.world.actors.has('bird-1')).toBe(false);
        // Release log line lands after the four castaway spawns
        expect(handle.world.events.log().map((event) => event.message)).toEqual([
            'Ael washes ashore.',
            'Bram washes ashore.',
            'Cove washes ashore.',
            'Dune washes ashore.',
            'Kiki wheels above the island.',
        ]);
    });

    it('actorCount caps the cast', () => {
        const handle = createIslandWorld({ seed: 7, actorCount: 2 });
        expect(Array.from(handle.world.actors.keys())).toEqual(['actor-1', 'actor-2']);
    });

    it('runs: actors wander once the ticker advances', () => {
        const handle = createIslandWorld({ seed: 7 });
        handle.world.step();
        expect(handle.world.ticker.ticks()).toBe(1);
        // Every castaway moved (wander path) + Kiki's first glide
        expect(handle.world.events.log().filter((event) => event.kind === 'move').length).toBe(5);
    });

    it('plugin toggles swap environment behaviour out entirely', () => {
        // No behavior plugin → actors stand still forever
        const still = createIslandWorld({ seed: 7, plugins: { behavior: false } });
        const before = Array.from(still.world.actors.values()).map((actor) => ({ ...actor.position }));
        for (let index = 0; index < 5; index++) {
            still.world.step();
        }
        const after = Array.from(still.world.actors.values()).map((actor) => ({ ...actor.position }));
        expect(after).toEqual(before);
        expect(still.world.plugins.has('behavior')).toBe(false);

        // Only terrain → a bare canvas world with no actors at all
        const bare = createIslandWorld({
            seed: 7,
            plugins: {
                inventory: false,
                needs: false,
                relationship: false,
                behavior: false,
                birds: false,
                ascii: false,
            },
            actorCount: 0,
        });
        expect(bare.world.plugins.list().map((plugin) => plugin.id)).toEqual(['island-terrain']);
        expect(bare.world.canvas.width).toBe(12);


        // Birds off → no bird in the spatial record, no birds plugin
        const grounded = createIslandWorld({ seed: 7, plugins: { birds: false } });
        expect(grounded.world.plugins.has('birds')).toBe(false);
        expect(grounded.world.coordinates.count()).toBe(4);
        expect(grounded.birds.birds()).toEqual([]);

        // ASCII canvas off → no representation plugin on the roster
        const unseen = createIslandWorld({ seed: 7, plugins: { ascii: false } });
        expect(unseen.world.plugins.has('ascii-canvas')).toBe(false);
        expect(unseen.ascii.frame()).toEqual({ columns: 0, rows: 0, tiles: [] });
    });

    it('the ascii canvas frame mirrors the world: tiles, glyphs and altitude', () => {
        const handle = createIslandWorld({ seed: 7 });
        const frame = handle.ascii.frame();
        // One tile per island cell, row-major
        expect(frame.columns).toBe(12);
        expect(frame.rows).toBe(10);
        expect(frame.tiles.length).toBe(120);
        // Ael stands on (6,0): tile 0×12+6 = 6 carries his grounded glyph
        expect(frame.tiles[6].glyphs).toEqual([
            { id: 'actor-1', glyph: 'A', color: '#5cb85c', elevation: 0, kind: 'castaway', state: 'well' },
        ]);
        // Kiki wheels at (6,5): tile 5×12+6 = 66 carries the flying glyph
        expect(frame.tiles[66].glyphs).toEqual([
            { id: 'bird-1', glyph: 'K', color: '#7ec8e3', elevation: 2, kind: 'bird', state: 'flying' },
        ]);
        // Hover titles: ground column + entity facets
        expect(frame.tiles[66].title).toContain('Kiki · flying · z 2');
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
