// Tests for the tasks environment plugin's lifecycle glue
// (plugins/tasks/tasksPlugin.ts). The ledger's pure logic — queueing,
// prioritization, the world-minute heartbeat — is covered by
// taskLedger.test.ts; this file pins the NO STALE TASKS wiring: the
// setup-subscribed cancellation that fires when the body behind a queue
// leaves the world (a health-zero death, a bird glided past the world's
// edge, a shark swept back out to sea — every removal lands in the log as
// a 'despawn' or 'death' event carrying the actorId).

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from './tasksPlugin';
import { behaviorPlugin } from '../behavior/behaviorPlugin';
import type { Actor } from '../../engine/types';

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(x, y), marker: name.slice(0, 1), condition: 'well', profile: { sex: 'male' } };
    return world.spawn(actor);
};

// Full stack with rain disabled and needs frozen — the behavior ladder
// queues the tasks whose cleanup this file verifies
const buildStack = () => {
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const needs = needsPlugin({ thirstPerMinute: 0, energyPerMinute: 0, hungerPerMinute: 0 });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior],
    });
    return { world, inventory, needs, tasks };
};

describe('tasksPlugin — no stale tasks for departed bodies', () => {
    it('a despawned actor\u2019s queued tasks are cancelled on the despawn event', () => {
        const { world, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 6, 2);
        world.step(); // the idle wander queues
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        world.despawn('a');
        // The despawn event carried the actorId — the queue is gone at once
        expect(tasks.taskOf('a')).toBeUndefined();
        expect(tasks.tasks()).toEqual([]);
    });

    it('a health-zero death cancels the in-progress task mid-count', () => {
        const { world, inventory, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 6, 2);
        needs.satisfy('a', { hunger: 45 }); // hunger 65 ≥ 60 — the gather queues
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'gather', remaining: 10 });
        world.step(); // one minute of gathering
        expect(tasks.taskOf('a')?.remaining).toBe(9);
        // The reservoir runs dry mid-task: the needs sweep kills the body
        // (the despawn + death events) and the queue cancels with it
        needs.satisfy('a', { health: -100 });
        world.step();
        expect(world.actors.has('a')).toBe(false);
        expect(tasks.taskOf('a')).toBeUndefined();
        expect(tasks.tasks()).toEqual([]);
        // The interrupted gather never completed — no food ever landed
        expect(inventory.of('a')).toEqual({});
    });

    it('the cancel passthrough wipes a queue directly (the god-side hook)', () => {
        const { world, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 6, 2);
        world.step();
        expect(tasks.taskOf('a')).toBeDefined();
        expect(tasks.cancel('a').map((task) => task.kind)).toEqual(['move']);
        expect(tasks.tasks()).toEqual([]);
        // An unknown actor cancels nothing
        expect(tasks.cancel('ghost')).toEqual([]);
    });
});
