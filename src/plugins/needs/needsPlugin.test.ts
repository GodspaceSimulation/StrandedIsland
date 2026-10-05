// Tests for the needs environment plugin (plugins/needs/needsPlugin.ts).

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { needsPlugin } from './needsPlugin';
import type { Actor } from '../../engine/types';

const spawnActor = (world: ReturnType<typeof createWorld>, id = 'a', name = 'Ael') => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(0, 0), marker: name.slice(0, 1), condition: 'well' };
    world.spawn(actor);
    return actor;
};

describe('needsPlugin', () => {
    it('decays needs per minute — three 1-minute steps drift 3 minutes worth', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 7, plugins: [needs] });
        spawnActor(world);
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        // 3 steps × 1 world-minute of per-minute decay (0.1/min hunger,
        // 0.15/min thirst, −0.06/min energy) — floats pinned from reference
        expect(needs.of('a')).toEqual({
            hunger: 20.300000000000004,
            thirst: 20.449999999999996,
            energy: 99.82,
        });
    });

    it('decay scales with tick size — an hour tick moves needs 6× a 10-min tick', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 7, tickSize: 60, plugins: [needs] });
        spawnActor(world);
        world.step();
        // 60 world-minutes of the same per-minute rates
        expect(needs.of('a')).toEqual({
            hunger: 26.000000000000085,
            thirst: 28.999999999999915,
            energy: 96.39999999999986,
        });
    });

    it('one hour-long step equals sixty 1-minute steps — the smallest-scale rule', () => {
        // The step size is only a batch: the logic inside always runs one
        // world-minute at a time, so both worlds end in the same state
        const stepped = needsPlugin();
        const hourly = needsPlugin();
        const minuteWorld = createWorld({ seed: 7, tickSize: 1, plugins: [stepped] });
        const hourWorld = createWorld({ seed: 7, tickSize: 60, plugins: [hourly] });
        spawnActor(minuteWorld, 'm');
        spawnActor(hourWorld, 'h');
        for (let index = 0; index < 60; index++) {
            minuteWorld.step();
        }
        hourWorld.step();
        expect(stepped.of('m')).toEqual(hourly.of('h'));
        expect(stepped.of('m')).toEqual({
            hunger: 26.000000000000085,
            thirst: 28.999999999999915,
            energy: 96.39999999999986,
        });
    });

    it('starting state is a little hungry, not starving', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 7, plugins: [needs] });
        spawnActor(world);
        expect(needs.of('a')).toEqual({ hunger: 20, thirst: 20, energy: 100 });
    });

    it('satisfy applies clamped deltas', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 7, plugins: [needs] });
        spawnActor(world);
        // Eating drops hunger — but never below 0
        needs.satisfy('a', { hunger: -50 });
        expect(needs.of('a').hunger).toBe(0);
        // Resting tops energy — never above 100
        needs.satisfy('a', { energy: 50 });
        expect(needs.of('a').energy).toBe(100);
        // Mid-range values apply exactly
        needs.satisfy('a', { hunger: 20, thirst: 10, energy: -40 });
        expect(needs.of('a')).toEqual({ hunger: 20, thirst: 30, energy: 60 });
    });

    it('moved charges one extra energy point per cell', () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
        const world = createWorld({ seed: 7, tickSize: 10, plugins: [needs] });
        spawnActor(world);
        needs.moved('a');
        needs.moved('a');
        needs.moved('a');
        expect(needs.of('a').energy).toBe(97);
    });

    it('fires threshold events once on upward crossings', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 1, tickSize: 10, plugins: [needs] });
        spawnActor(world);
        needs.satisfy('a', { hunger: 48.5 }); // 68.5 — just below the 70 threshold
        world.step(); // 69.49999999999994 — no event
        expect(world.events.log().filter((event) => event.kind === 'needs').length).toBe(0);
        world.step(); // 70.49999999999989 — pangs fire
        expect(world.events.log().filter((event) => event.kind === 'needs').map((event) => event.message)).toEqual([
            'Ael feels hunger pangs.',
        ]);
        // Staying above the threshold does not re-fire
        world.step();
        expect(world.events.log().filter((event) => event.kind === 'needs').length).toBe(1);
    });

    it('energy crossing fires on the way down', () => {
        // 0.05/min × 10 min = −0.5 energy per tick
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0.05 });
        const world = createWorld({ seed: 1, tickSize: 10, plugins: [needs] });
        spawnActor(world);
        needs.satisfy('a', { energy: -89 }); // 11 — above the 10 collapse line
        world.step(); // 10.5 — still above
        expect(world.events.log().filter((event) => event.kind === 'needs').length).toBe(0);
        needs.satisfy('a', { energy: -0.4 }); // 10.1 — just above the line
        world.step(); // crossing: decays to 9.6 ≤ 10 during the tick
        expect(world.events.log().filter((event) => event.kind === 'needs').map((event) => event.message)).toEqual([
            'Ael is collapsing from exhaustion.',
        ]);
        // Below the threshold it does not re-fire
        world.step(); // 9.1
        expect(world.events.log().filter((event) => event.kind === 'needs').length).toBe(1);
    });

    it('derives the actor condition ladder and mirrors it into the coordinate record', () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
        const world = createWorld({ seed: 1, tickSize: 10, plugins: [needs] });
        const actor = spawnActor(world);
        world.step();
        expect(actor.condition).toBe('well');
        needs.satisfy('a', { hunger: 50 }); // 70 → weak
        world.step();
        expect(actor.condition).toBe('weak');
        // The ascii canvas reads its glyph color from the coordinate record
        expect(world.coordinates.entryOf('a')?.state).toBe('weak');
        needs.satisfy('a', { hunger: 20 }); // 90 → critical
        world.step();
        expect(actor.condition).toBe('critical');
        expect(world.coordinates.entryOf('a')?.state).toBe('critical');
    });

    it('starvation kills after the doom window and despawns the actor', () => {
        const needs = needsPlugin({ hungerPerMinute: 2, thirstPerMinute: 0, energyPerMinute: 0, doomMinutes: 20 });
        const world = createWorld({ seed: 1, tickSize: 10, plugins: [needs] });
        spawnActor(world);
        for (let index = 0; index < 8; index++) {
            world.step();
        }
        // Hunger hits 100 during step 4 (+2/min × 40 min), the 20-minute
        // doom window runs out during step 6
        expect(world.actors.size).toBe(0);
        const messages = world.events.log().map((event) => event.message);
        expect(messages).toEqual([
            'Ael washes ashore.',
            'Ael feels hunger pangs.',
            'Ael is starving.',
            'Ael is no more.',
            'Ael has died.',
        ]);
    });
});
