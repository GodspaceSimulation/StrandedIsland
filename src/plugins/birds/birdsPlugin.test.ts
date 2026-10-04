// Tests for the seabirds environment plugin (plugins/birds/birdsPlugin.ts).
// The bird is the engine's Z-axis traveler: everything below is captured
// from deterministic reference runs (seeded plugin stream) and pinned exactly.

import { describe, it, expect } from 'vitest';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { birdsPlugin } from './birdsPlugin';

const buildStack = (options: Parameters<typeof birdsPlugin>[0] = {}) => {
    const birds = birdsPlugin(options);
    const world = createWorld({ seed: 7, tickSize: 10, plugins: [islandTerrainPlugin(), birds] });
    return { world, birds };
};

describe('birdsPlugin', () => {
    it('releases a bird above the island center at cruise altitude', () => {
        const { world, birds } = buildStack();
        const kiki = birds.release();
        expect(kiki).toEqual({
            id: 'bird-1',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
            // 12×10 island → center column (6,5); cruise altitude z = 2
            position: { x: 6, y: 5, z: 2 },
        });
        // The bird lives in the 3D spatial record with kind 'bird'
        expect(world.coordinates.entryOf('bird-1')).toEqual({
            id: 'bird-1',
            position: { x: 6, y: 5, z: 2 },
            kind: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
        });
        // Not a castaway — the actor registry never sees birds
        expect(world.actors.size).toBe(0);
        expect(world.events.log()[0]).toEqual({
            id: 1,
            tick: 0,
            time: 0,
            kind: 'spawn',
            message: 'Kiki wheels above the island.',
            actorId: 'bird-1',
        });
    });

    it('release rolls through the default name roster', () => {
        const { birds } = buildStack();
        expect(birds.release().name).toBe('Kiki');
        expect(birds.release().name).toBe('Jask');
        // An explicit name wins over the roster
        const named = birds.release('Sula');
        expect(named).toEqual({
            id: 'bird-3',
            name: 'Sula',
            marker: 'S',
            state: 'flying',
            position: { x: 6, y: 5, z: 2 },
        });
        expect(birds.birds().map((bird) => bird.name)).toEqual(['Kiki', 'Jask', 'Sula']);
    });

    it('flies through 3D space: glides, drifts altitude, lands, takes off', () => {
        const { world, birds } = buildStack();
        birds.release();
        // Reference run (seed 7): the exact flight path below — glide,
        // land, hop, take off, glide again… the full Z-axis cycle
        for (let index = 0; index < 10; index++) {
            world.step();
        }
        const path = world.events
            .log()
            .filter((event) => event.actorId === 'bird-1')
            .map((event) => event.message);
        expect(path).toEqual([
            'Kiki wheels above the island.',
            'Kiki glides northwest.',
            'Kiki lands.',
            'Kiki hops south.',
            'Kiki takes off.',
            'Kiki glides north.',
            'Kiki glides northwest.',
            'Kiki lands.',
            'Kiki hops west.',
            'Kiki hops northwest.',
            'Kiki takes off.',
        ]);
        // Reference end position: perched-again cycle left Kiki at (2,2,2)
        expect(birds.birdOf('bird-1')?.position).toEqual({ x: 2, y: 2, z: 2 });
    });

    it('lands onto the ground plane (z = 0) and hops while perched', () => {
        // Force the landing instinct: land on the first roll
        const { world, birds } = buildStack({ landChance: 1 });
        birds.release();
        world.step();
        expect(birds.birdOf('bird-1')).toEqual({
            id: 'bird-1',
            name: 'Kiki',
            marker: 'K',
            state: 'perched',
            position: { x: 6, y: 5, z: 0 },
        });
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: 6, y: 5, z: 0 });
        expect(world.events.log()[1].message).toBe('Kiki lands.');

        // Perched: takeoff disabled → the gull hops one step per tick
        const hopper = birdsPlugin({ landChance: 1, takeoffChance: 0 });
        const hopWorld = createWorld({ seed: 7, tickSize: 10, plugins: [islandTerrainPlugin(), hopper] });
        hopper.release();
        hopWorld.step();
        hopWorld.step();
        expect(hopper.birdOf('bird-1')?.state).toBe('perched');
        const hopPath = hopWorld.events
            .log()
            .filter((event) => event.actorId === 'bird-1')
            .map((event) => event.message);
        expect(hopPath).toEqual(['Kiki wheels above the island.', 'Kiki lands.', 'Kiki hops north.']);
        expect(hopper.birdOf('bird-1')?.position).toEqual({ x: 6, y: 4, z: 0 });
    });

    it('a perched bird takes off to an altitude within the ceiling', () => {
        // Land on the first tick, then take off on the next
        const { world, birds } = buildStack({ landChance: 1, takeoffChance: 1 });
        birds.release();
        world.step(); // lands
        world.step(); // takes off
        const bird = birds.birdOf('bird-1');
        expect(bird?.state).toBe('flying');
        // Reference takeoff altitude (seeded draw): 1 + floor(draw × 3) = 1
        expect(bird?.position).toEqual({ x: 6, y: 5, z: 1 });
        expect(world.events.log().at(-1)?.message).toBe('Kiki takes off.');
    });

    it('birds never block castaways — occupancy checks scan actors only', () => {
        const { world, birds } = buildStack({ landChance: 0, takeoffChance: 0 });
        birds.release();
        // A castaway walks onto the bird's column without resistance
        const actor = world.spawn({
            id: 'a',
            name: 'Ael',
            position: { x: 5, y: 5, z: 0 },
            marker: 'A',
            condition: 'well',
        });
        expect(world.actorAt(5, 5)?.id).toBe('a');
        // The bird hovers directly above the same column (z = 2 ≠ 0)
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: 6, y: 5, z: 2 });
        void actor;
    });

    it('dispose clears the flock and drops the world binding', () => {
        const { world, birds } = buildStack();
        birds.release();
        world.plugins.remove('birds');
        expect(birds.birds()).toEqual([]);
        // Releasing before setup is a hard error
        const stray = birdsPlugin();
        expect(() => stray.release()).toThrow('birds plugin released before setup');
    });
});
