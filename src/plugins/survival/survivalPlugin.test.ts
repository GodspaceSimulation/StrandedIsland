// Tests for the survival plugin (plugins/survival/survivalPlugin.ts).
// Every scenario assembles the full plugin stack exactly like the scenario
// factory does (scenario/island.ts), then drives it with controlled needs
// rates. Threats are placed straight into the coordinate space (the single
// position registry the plugin scans) — the predators plugin's own tests
// cover the beasts themselves. All outcomes were captured from reference
// runs — the task loop is fully deterministic.
//
// The survival model: the priority-60 'survival' ledger behaviour is the
// HIGHEST rung — a wild animal (a creature of a threat type: boar, shark)
// within one tile (Chebyshev) is a meeting that can hurt, and the flee
// task pre-empts every other queue (the ledger's strictly-higher-priority
// rule). The flee is one fine step away from the threat; a threat sharing
// the actor's tile triggers the COMMITTED EXIT — the flee marches the
// nearest dry tile edge and crosses out (a directionless random step was
// the old fatal-chase bug: the tile-level threat scan never cleared, so
// the actor random-walked its own tile while the beast mauled it — see
// survivalFleeRegression.test.ts). While the threat stands the ladder
// re-plans the flee every minute; the tick it clears, the interrupted
// find-food / find-water queue resumes.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from '../tasks/tasksPlugin';
import { behaviorPlugin } from '../behavior/behaviorPlugin';
import { survivalPlugin } from './survivalPlugin';
import type { Actor } from '../../engine/types';

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(x, y), marker: name.slice(0, 1), condition: 'well', profile: { sex: 'male' } };
    return world.spawn(actor);
};

// A threat straight into the coordinate space — kind 'creature', one of
// the THREAT types, grounded (z 0)
const placeThreat = (
    world: ReturnType<typeof createWorld>,
    id: string,
    name: string,
    x: number,
    y: number,
) => {
    world.coordinates.place({
        id,
        position: position3(x, y),
        kind: 'creature',
        type: 'boar',
        name,
        marker: name.slice(0, 1),
        state: 'roaming',
    });
};

// Full stack with rain disabled and needs frozen
const buildStack = () => {
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const survival = survivalPlugin({ tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, survival],
    });
    return { world, inventory, needs, tasks, survival };
};

describe('survivalPlugin', () => {
    it('registers the priority-60 behaviour above the whole survival ladder', () => {
        const { tasks } = buildStack();
        expect(tasks.ledger.behaviours().map((module) => ({ id: module.id, priority: module.priority }))).toEqual([
            { id: 'survival', priority: 60 },
            { id: 'thirst', priority: 50 },
            { id: 'hunger', priority: 40 },
            { id: 'roost', priority: 33 },
            { id: 'rest', priority: 25 },
            { id: 'social', priority: 20 },
            { id: 'wander', priority: 0 },
        ]);
    });

    it('a threatened actor flees a full tile away — the running stride', () => {
        const { world, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        // The boar closes in from the east — adjacent tile, within the
        // threat range
        placeThreat(world, 'boar-x', 'Tusk', 9, 2);
        world.step();
        // The flee outranks everything: the RUNNING STRIDE west, away from
        // the beast — a full Scale-0 tile in one minute (the profile's run
        // row; a fine step could never outpace the boar's two-minute gait).
        // A 'move' task — the behavior plugin's move effect applies it; the
        // tag reads in the payload)
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'survival',
            kind: 'move',
            label: 'flees',
            minutes: 1,
            payload: { tx: 7, ty: 2, flee: true },
            total: 1,
            remaining: 1,
        });
        world.step();
        // The stride landed: Ael stands a full tile west — a TWO-tile gap
        // from the beast, beyond the threat range. The scan clears and the
        // wider ladder takes the minute back (the old fine-step flee never
        // opened a gap and re-planned forever).
        expect(world.actors.get('a')!.position).toEqual(position3(7, 2));
        expect(tasks.taskOf('a')?.behaviour).not.toBe('survival');
        // The fleeing is silent — movement is simulation plumbing
        expect(world.events.log().map((event) => event.kind)).toEqual(['spawn']);
        void needs;
    });

    it('the flee pre-empts a busy queue: the interrupted task is abandoned mid-work', () => {
        const { world, inventory, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 3, -4); // the berry+mushroom meadow stocks food
        needs.satisfy('a', { hunger: 40 }); // hunger 60
        // The busy queue is queued DIRECTLY on the ledger (a synthetic
        // 10-minute gather under the hunger rung): survival's pre-emption
        // contract must not hinge on the behavior plugin's plan-time
        // gather economics (shared tile jobs / beats) — its own tests pin
        // those. Equal priorities never churn a running queue, so the
        // hunger rung leaves this one alone.
        tasks.ledger.queue('a', 'hunger', [{ kind: 'gather', label: 'gathers', minutes: 10 }]);
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        // Three minutes into the gather (remaining 7), THEN the boar
        // closes in (from the east)
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'gather', remaining: 7 });
        placeThreat(world, 'boar-x', 'Tusk', 4, -4);
        world.step();
        // The flee took the head — the half-done gather is abandoned (the
        // bag stays empty; not every task completes)
        expect(tasks.taskOf('a')).toEqual({
            id: 't-2',
            actorId: 'a',
            behaviour: 'survival',
            kind: 'move',
            label: 'flees',
            minutes: 1,
            // (the west neighbor is wet and the beast's own tile is never
            // an exit — the committed exit runs NORTH to the nearest dry
            // neighbor instead)
            payload: { tx: 3, ty: -3, flee: true },
            total: 1,
            remaining: 1,
        });
        expect(inventory.of('a')).toEqual({});
        // The abandoned gather never completed — no food, no log
        expect(needs.of('a').hunger).toBe(60);
        expect(world.events.log().map((event) => event.kind)).toEqual(['spawn']);
    });

    it('the tick the threat clears, the interrupted queue resumes', () => {
        const { world, inventory, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 3, -4); // the berry+mushroom meadow stocks food
        needs.satisfy('a', { hunger: 40 });
        // Synthetic busy queue (see the pre-emption test — the resume
        // contract belongs to survival; the gather's minutes economics
        // belong to the behavior plugin's own tests and are NOT pinned
        // here)
        tasks.ledger.queue('a', 'hunger', [{ kind: 'gather', label: 'gathers', minutes: 10 }]);
        placeThreat(world, 'boar-x', 'Tusk', 4, -4);
        // Minute 1: the gather is pre-empted by the flee…
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'flees', remaining: 1 });
        // …and the beast wanders off (the threat is gone)
        world.coordinates.move('boar-x', position3(12, 8));
        world.step();
        // The flee completed; with the coast clear the hunger rung takes
        // the actor back (whatever shape its gather plan has this build)
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'hunger', kind: 'gather' });
        expect(inventory.of('a')).toEqual({});
    });

    it('a beast sharing the actor\u2019s tile triggers the committed exit — the stride runs to the nearest dry neighbor tile', () => {
        const { world, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        // The boar stands ON Ael's tile — no away direction exists
        placeThreat(world, 'boar-x', 'Tusk', 8, 2);
        world.step();
        // The committed exit (no random draw): the +y neighbor is the
        // nearest dry edge from Ael's derived fine spot — the stride
        // commits SOUTH. The old blind flight drew ANY step at random; a
        // directionless walk never left the tile while the (tile-level)
        // threat scan kept re-planning the flee every minute.
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'survival',
            kind: 'move',
            label: 'flees',
            minutes: 1,
            payload: { tx: 8, ty: 3, flee: true },
            total: 1,
            remaining: 1,
        });
        world.step();
        // The stride lands Ael a full tile off the threatened tile
        expect(world.actors.get('a')!.position).toEqual(position3(8, 3));
        world.step();
        // Minute 3 — the away rung's second stride put Ael TWO tiles from
        // the beast: beyond the threat range the scan clears and the wider
        // ladder takes the minute back (the running stride outpaces the
        // lumbering gait — the gap never closes)
        expect(world.actors.get('a')!.position).toEqual(position3(8, 4));
        expect(tasks.taskOf('a')?.behaviour).not.toBe('survival');
    });

    it('removing the survival plugin strands the threat: the wider ladder takes over', () => {
        const { world, inventory, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        placeThreat(world, 'boar-x', 'Tusk', 7, 2);
        world.step();
        expect(tasks.taskOf('a')?.behaviour).toBe('survival');
        world.plugins.remove('survival');
        // The update-on-remove rule: the behaviour is gone AND its queued
        // flee tasks are cancelled. The wider ladder still runs — and it
        // plans the BOAR too (the behavior plugin plans every grounded
        // creature): the beast carries its own wander task
        expect(tasks.ledger.behaviours().map((module) => module.id)).toEqual(['thirst', 'hunger', 'roost', 'rest', 'social', 'wander']);
        expect(tasks.tasks().map((task) => ({ actorId: task.actorId, behaviour: task.behaviour, kind: task.kind, label: task.label, minutes: task.minutes }))).toEqual([
            { actorId: 'boar-x', behaviour: 'wander', kind: 'move', label: 'wanders', minutes: 1 },
        ]);
        // The threat stands, but nothing flees anymore — the actor
        // fine-wanders into the boar's range (needs frozen, no triggers)
        // while the boar fine-wanders its own tile
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders' });
        void inventory; void needs;
    });
});
