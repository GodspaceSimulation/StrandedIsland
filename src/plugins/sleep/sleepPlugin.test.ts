// Tests for the sleep plugin (plugins/sleep/sleepPlugin.ts).
// Every scenario assembles the full plugin stack exactly like the scenario
// factory does, then drives it with one-minute steps (tickSize 1 — engine
// sub-stepping). All outcomes were captured from reference runs.
//
// The sleep model: a priority-30 'sleep' ledger behaviour shadows the
// behavior plugin's priority-25 'rest' fallback; the 45-minute sleep task
// restores 1.2 energy per world-minute WHILE it runs (this plugin's tick —
// one tick hook call covers exactly one world-minute), and the sleep/wake
// transitions are logged once per slumber.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from '../tasks/tasksPlugin';
import { behaviorPlugin } from '../behavior/behaviorPlugin';
import { sleepPlugin } from './sleepPlugin';
import type { Actor } from '../../engine/types';

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(x, y), marker: name.slice(0, 1), condition: 'well', profile: { sex: 'male' } };
    return world.spawn(actor);
};

// Full stack WITH the sleep plugin mounted (the scenario order: terrain,
// inventory, needs, relationship, tasks, behavior, sleep)
const buildStack = () => {
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0 });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const sleep = sleepPlugin({ needs, tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, sleep],
    });
    return { world, inventory, needs, relationship, tasks, behavior, sleep };
};

describe('sleepPlugin', () => {
    it('registers the priority-30 behaviour that shadows the rest fallback', () => {
        const { tasks } = buildStack();
        // Planning order: the roost rung (33) routes the tired bird to the
        // trees before the sleep rung (30) slumbers it — sleep sits between
        // the roost and the behavior plugin's rest fallback (25)
        expect(tasks.ledger.behaviours().map((module) => ({ id: module.id, priority: module.priority }))).toEqual([
            { id: 'thirst', priority: 50 },
            { id: 'hunger', priority: 40 },
            { id: 'roost', priority: 33 },
            { id: 'sleep', priority: 30 },
            { id: 'rest', priority: 25 },
            { id: 'social', priority: 20 },
            { id: 'wander', priority: 0 },
        ]);
    });

    it('a drained actor sleeps: +1.2 energy per minute, silently', () => {
        const { world, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        needs.satisfy('a', { energy: -80 }); // energy 20 ≤ 22 → sleep shadows rest
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        // The 45-minute sleep task was planned at minute 1 and restores
        // 1.2/min while it counts down (net +1.14/min with the 0.06 decay)
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'sleep',
            kind: 'sleep',
            label: 'sleeps',
            minutes: 45,
            total: 45,
            remaining: 41,
        });
        expect(needs.of('a').energy).toBe(25.700000000000003);
        for (let index = 0; index < 40; index++) {
            world.step();
        }
        // Minute 45: the task still holds with one minute left
        expect(needs.of('a').energy).toBe(71.30000000000003);
        expect(tasks.taskOf('a')?.remaining).toBe(1);
        world.step();
        // Minute 46: the sleep task completed, the actor re-planned a wander
        // (no restore on the completing minute)
        expect(needs.of('a').energy).toBe(71.24000000000002);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        // The whole slumber stays out of the log — dozing off is a solo
        // beat, not a story between entities
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
        ]);
        expect(world.events.log().filter((event) => event.kind === 'sleep')).toEqual([]);
    });

    it('a drained actor keeps sleeping minute after minute until the slumber ends', () => {
        const { world, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        needs.satisfy('a', { energy: -80 });
        world.step();
        // One minute of sleep: −0.06 decay + 1.2 restore
        expect(needs.of('a').energy).toBe(21.14);
        expect(tasks.taskOf('a')?.kind).toBe('sleep');
        for (let index = 0; index < 4; index++) {
            world.step();
        }
        // Minute 5: four more +1.14 net minutes (energy per step rises 1.14)
        expect(needs.of('a').energy).toBe(25.700000000000003);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'sleep', remaining: 41 });
        // Nothing logged across the whole slumber
        expect(world.events.log().filter((event) => event.kind === 'sleep').length).toBe(0);
    });

    it('removing the sleep plugin falls back to the instant-rest ladder', () => {
        const { world, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        needs.satisfy('a', { energy: -80 }); // energy 20 ≤ 22
        world.plugins.remove('sleep');
        // The update-on-remove rule: the behaviour is gone AND its queued
        // tasks are cancelled — the actor is idle before any step ran
        expect(tasks.ledger.behaviours().map((module) => module.id)).toEqual(['thirst', 'hunger', 'roost', 'rest', 'social', 'wander']);
        expect(tasks.tasks()).toEqual([]);
        for (let index = 0; index < 11; index++) {
            world.step();
        }
        // The old rest ladder: a 10-minute rest task (no per-minute restore —
        // the +12 recovery lands once, on completion at minute 11)
        expect(needs.of('a').energy).toBe(31.340000000000014);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        // The instant rest is silent too
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
        ]);
    });

    it('removing sleep mid-slumber cancels the task silently', () => {
        const { world, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        needs.satisfy('a', { energy: -80 });
        world.step();
        // One minute slept: the restore applied, the task queued
        expect(needs.of('a').energy).toBe(21.14);
        expect(tasks.taskOf('a')?.kind).toBe('sleep');
        world.plugins.remove('sleep');
        // The sleep task vanished with the behaviour
        expect(tasks.tasks()).toEqual([]);
        for (let index = 0; index < 11; index++) {
            world.step();
        }
        // The tired actor re-plans the rest fallback and recovers the old way
        expect(needs.of('a').energy).toBe(32.48000000000002);
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
        ]);
        // Nothing about the cancelled slumber or the fallback rest logged
        expect(world.events.log().filter((event) => event.kind === 'sleep' || event.kind === 'rest').length).toBe(0);
    });
});
