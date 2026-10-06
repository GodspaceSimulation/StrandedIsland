// Tests for the sharks environment plugin (plugins/sharks/sharksPlugin.ts).
// Sharks are the water creatures of the "things can come in too" mechanic:
// they swim in past the world's edge, stay bound to the water (never
// beaching themselves) and sweep back out past the edge again.
//
// Everything below is captured from deterministic reference runs (seeded
// plugin stream) and pinned exactly. One-minute steps keep the reference
// paths short — one step is one world-minute of swimming.

import { describe, it, expect } from 'vitest';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { needsPlugin } from '../needs/needsPlugin';
import { entityPlugin } from '../entity/entityPlugin';
import { sharksPlugin, SHARK_TYPE_GLYPH } from './sharksPlugin';

const buildStack = (
    options: Parameters<typeof sharksPlugin>[0] = {},
    seed = 7,
) => {
    const sharks = sharksPlugin(options);
    const world = createWorld({ seed, tickSize: 1, plugins: [islandTerrainPlugin(), sharks] });
    return { world, sharks };
};

describe('sharksPlugin', () => {
    it('releases a shark onto a rim water cell', () => {
        const { world, sharks } = buildStack();
        const finn = sharks.release();
        // Reference rim pick (seed 7): the x-rim cell (12, −3) — open sea
        expect(finn).toEqual({
            id: 'shark-1',
            name: 'Finn',
            marker: 'F',
            position: { x: 12, y: -3, z: 0 },
        });
        // A water column — sharks spawn on the sea, never on land
        expect(world.cellAt(12, -3)?.passable).toBe(false);
        // The shark lives in the 3D spatial record — a creature of type
        // shark, state 'swimming'; the actor registry never sees sharks
        expect(world.coordinates.entryOf('shark-1')).toEqual({
            id: 'shark-1',
            position: { x: 12, y: -3, z: 0 },
            kind: 'creature',
            type: 'shark',
            name: 'Finn',
            marker: 'F',
            state: 'swimming',
        });
        expect(world.actors.size).toBe(0);
        expect(world.events.log()[0]).toEqual({
            id: 1,
            tick: 0,
            time: 0,
            kind: 'spawn',
            message: 'Finn fins in from the open sea.',
            actorId: 'shark-1',
        });
    });

    it('swims from water cell to water cell, never beaching — silently', () => {
        const { world, sharks } = buildStack({ arriveChancePerMinute: 0, leaveChancePerMinute: 0 });
        sharks.release();
        // Reference run (seed 7): eight minutes of pure swimming
        for (let index = 0; index < 8; index++) {
            world.step();
        }
        // No swim telemetry in the log — the shark gliding north or south is
        // simulation, not story (only arrivals and departures speak)
        expect(
            world.events
                .log()
                .filter((event) => event.actorId === 'shark-1')
                .map((event) => event.message),
        ).toEqual(['Finn fins in from the open sea.']);
        // Reference end position and the water-bound invariant: every step
        // lands on an impassable (water) column
        expect(sharks.sharkOf('shark-1')?.position).toEqual({ x: 11, y: -3, z: 0 });
        expect(world.cellAt(11, -3)?.passable).toBe(false);
    });

    it('a shark sweeps past the edge of the world and vanishes', () => {
        // Forced leave roll on the first minute
        const { world, sharks } = buildStack({ arriveChancePerMinute: 0, leaveChancePerMinute: 1 });
        sharks.release();
        world.step();
        // Gone from the record AND the coordinate space
        expect(sharks.sharks()).toEqual([]);
        expect(sharks.sharkOf('shark-1')).toBeUndefined();
        expect(world.coordinates.all()).toEqual([]);
        expect(world.events.log()[1]).toEqual({
            id: 2,
            tick: 1,
            time: 1,
            kind: 'despawn',
            message: 'Finn sweeps past the edge of the world and vanishes.',
            actorId: 'shark-1',
        });
    });

    it('sharks arrive past the edge until the population cap holds', () => {
        // Forced arrival roll every minute (reference run, seed 7): minute 1
        // spawns Finn, minute 2 Mako — the cap (2) holds from then on, only
        // the two sharks' swims continue
        const { world, sharks } = buildStack({ arriveChancePerMinute: 1, leaveChancePerMinute: 0 });
        for (let index = 0; index < 4; index++) {
            world.step();
        }
        expect(sharks.sharks()).toEqual([
            { id: 'shark-1', name: 'Finn', marker: 'F', position: { x: 6, y: -8, z: 0 } },
            { id: 'shark-2', name: 'Mako', marker: 'M', position: { x: -10, y: -4, z: 0 } },
        ]);
        // Both still bound to the water
        expect(sharks.sharks().map((shark) => world.cellAt(shark.position.x, shark.position.y)?.passable)).toEqual([
            false,
            false,
        ]);
        // The spawn log — exactly two arrivals, no more after the cap
        expect(
            world.events
                .log()
                .filter((event) => event.kind === 'spawn')
                .map((event) => `${event.actorId}:${event.message}`),
        ).toEqual([
            'shark-1:Finn fins in from the open sea.',
            'shark-2:Mako fins in from the open sea.',
        ]);
    });

    it('exposes the shark type glyph for the canvas palettes', () => {
        // The scenario merges this into the unicode/svg type maps so shark
        // entries draw the fin emoji
        expect(SHARK_TYPE_GLYPH).toEqual({ shark: '🦈' });
    });

    it('dispose clears the shoal and drops the world binding', () => {
        const { world, sharks } = buildStack();
        sharks.release();
        world.plugins.remove('sharks');
        expect(sharks.sharks()).toEqual([]);
        // Releasing before setup is a hard error
        const stray = sharksPlugin();
        expect(() => stray.release()).toThrow('sharks plugin released before setup');
    });
});

describe('sharksPlugin — the entity profiles: the stat-driven swim', () => {
    /** The stack with the needs plugin + entity profiles — sharks live by stats. */
    const buildStatStack = (options: Parameters<typeof sharksPlugin>[0] = {}, seed = 7) => {
        const profiles = entityPlugin();
        const needs = needsPlugin({ profiles });
        const sharks = sharksPlugin({ needs, profiles, ...options });
        const world = createWorld({ seed, tickSize: 1, plugins: [islandTerrainPlugin(), needs, sharks] });
        return { world, sharks, needs };
    };

    it('swimming burns the swim row per tile — a Speed-14 shark crosses a tile in one minute', () => {
        const { world, sharks, needs } = buildStatStack({ arriveChancePerMinute: 0, leaveChancePerMinute: 0 });
        sharks.release();
        // Eight minutes of swimming (the free-swim reference run): every
        // minute one water tile crossed — the charges consume no rolls, so
        // the path repeats exactly
        for (let index = 0; index < 8; index++) {
            world.step();
        }
        expect(sharks.sharkOf('shark-1')?.position).toEqual({ x: 11, y: -3, z: 0 });
        // The swim economics: eight tiles × 1.67 (the swim row) + the
        // species decay 0.04 × 8 minutes — float drift pinned from the run
        expect(needs.of('shark-1').energy).toBe(86.31999999999994);
    });

    it('a spent shark holds still in the current and recovers instead of sweeping on', () => {
        const { world, sharks, needs } = buildStatStack({ arriveChancePerMinute: 0, leaveChancePerMinute: 0 });
        sharks.release();
        // Drain the shark under the spent line
        needs.satisfy('shark-1', { energy: -81 }); // 19
        const spentAt = sharks.sharkOf('shark-1')?.position;
        world.step(); // the spent rest: the pick ran, the shark held still
        expect(sharks.sharkOf('shark-1')?.position).toEqual(spentAt);
        // The drift recovery (+2) outpaces the decay (−0.04)
        expect(needs.of('shark-1').energy).toBe(20.96);
        // Over the line again: the very next minute sweeps on
        world.step();
        expect(sharks.sharkOf('shark-1')?.position).not.toEqual(spentAt);
        expect(needs.of('shark-1').energy).toBe(19.25);
    });
});
