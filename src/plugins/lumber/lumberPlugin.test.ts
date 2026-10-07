// Tests for the lumber plugin (plugins/lumber/lumberPlugin.ts).
// Every scenario assembles the full plugin stack exactly like the scenario
// factory does (scenario/island.ts), then drives it with controlled needs
// rates. All outcomes were captured from reference runs — the task loop is
// fully deterministic.
//
// The lumber model: wood is NOT a natural resource — the standing deposit
// is the TREE, and wood exists only as the product of cutting a tree's wood
// pool. The priority-10 'lumber' ledger behaviour sends a woodless actor to
// the woods: a tree underfoot is chopped (15 minutes — the harvest converts
// one pool wood into one wood item in the bag; the tree STANDS while wood
// remains, and only a pool of 0 fells it); no tree underfoot means one fine
// step toward the nearest treed tile (1 minute). The chop completion effect
// lives in this plugin (the behaviour governs its own tasks); the move
// tasks flow through the behavior plugin's move effect. The forest ecology
// (plugins/forest) grows the pools back between chops.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { forestPlugin } from '../forest/forestPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from '../tasks/tasksPlugin';
import { behaviorPlugin } from '../behavior/behaviorPlugin';
import { lumberPlugin } from './lumberPlugin';
import type { Actor } from '../../engine/types';

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(x, y), marker: name.slice(0, 1), condition: 'well', profile: { sex: 'male' } };
    return world.spawn(actor);
};

// Full stack with rain disabled and needs frozen — the lumber behaviour is
// the only thing that moves the actor. The FOREST ECOLOGY mounts (the
// scenario's default) — the chop cuts wood off the tree pools.
const buildStack = () => {
    const terrain = islandTerrainPlugin();
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const forest = forestPlugin({ terrain, inventory });
    const lumber = lumberPlugin({ inventory, tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [terrain, inventory, forest, needs, relationship, tasks, behavior, lumber],
    });
    return { world, inventory, needs, tasks, lumber, forest };
};

describe('lumberPlugin', () => {
    it('registers the priority-10 behaviour between social and wander', () => {
        const { tasks } = buildStack();
        // Planning order: the survival needs outrank the wood rack; the
        // wood rack outranks the idle wander (the roost rung sits between
        // hunger and sleep — the tired bird's safe-sleep routing)
        expect(tasks.ledger.behaviours().map((module) => ({ id: module.id, priority: module.priority }))).toEqual([
            { id: 'thirst', priority: 50 },
            { id: 'hunger', priority: 40 },
            { id: 'roost', priority: 33 },
            { id: 'rest', priority: 25 },
            { id: 'social', priority: 20 },
            { id: 'lumber', priority: 10 },
            { id: 'wander', priority: 0 },
        ]);
    });

    it('a woodless actor on a treed tile chops: the wood lands in the bag on completion', () => {
        const { world, inventory, tasks } = buildStack();
        // Forest (−7,0) mirrors its neighborhood-counted 298-tree stand
        spawn(world, 'a', 'Ael', -7, 0);
        world.step();
        // The 15-minute chop was planned at minute 1 — the tree is NOT
        // consumed at plan time (the harvest lands on completion)
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'lumber',
            kind: 'chop',
            label: 'chops a tree',
            minutes: 15,
            total: 15,
            remaining: 15,
        });
        expect(inventory.of('a')).toEqual({});
        for (let index = 0; index < 16; index++) {
            world.step();
        }
        // The chop completed at minute 16: one wood off a tree's POOL into
        // the bag — wood never stood on the tile. The SOURCE tree was the
        // tree standing exactly on Ael's fine spot: the cut takes ONE wood
        // and the tree STANDS (its pool holds more wood — captured) — the
        // mirror stays at 298. The woods' own stocks stand beside the grove
        // (berry; the mushroom regrew a second one on its minute-15 rhythm)
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(inventory.cellStock(-7, 0)).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 298, berry: 1, mushroom: 2 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 298 });
        // The felling is silent — a solo beat, not a story between entities
        expect(world.events.log().map((event) => event.kind)).toEqual(['spawn']);
        // Wooded up, the lumber gate fails — the actor fine-wanders on
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
    });

    it('the wood rack re-arms when the wood is spent: chops pool the same tree down', () => {
        const { world, inventory, tasks, forest } = buildStack();
        spawn(world, 'a', 'Ael', -7, 0);
        // The seeded stand's standing wood at minute 0 (captured reference)
        expect(forest.standOf({ x: -7, y: 0 })).toEqual({ trees: 298, wood: 1176 });
        for (let index = 0; index < 16; index++) {
            world.step();
        }
        expect(inventory.of('a')).toEqual({ wood: 1 });
        // The wood leaves the bag (a trade or build spent it) — the gate
        // re-opens on the next planning round
        delete inventory.of('a').wood;
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'chop', remaining: 15 });
        for (let index = 0; index < 15; index++) {
            world.step();
        }
        // The second chop cut the stand's next wood — both cuts came off
        // standing trees (no fell: the stand still counts 298) and the
        // standing wood dropped by exactly the two cut units — the default
        // biology adds nothing in 31 world minutes (real-year pace)
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(inventory.cellStock(-7, 0).tree).toBe(298);
        expect(forest.standOf({ x: -7, y: 0 })).toEqual({ trees: 298, wood: 1174 });
    });

    it('a woodless actor with no tree underfoot travels toward the nearest treed tile', () => {
        const { world, inventory, tasks } = buildStack();
        // Ael stands on the forest (6,2) with its own grove FELLED away
        // (the stock mirror only — the tile deposit regrows through the
        // ecology's recruitment, not a stock rhythm): the nearest treed
        // tiles are all ONE Chebyshev step away — (5,1) west-north,
        // (6,1) north, (7,1) north-east, (5,2) west, (7,2) east — and the
        // row-major survey order wins the distance tie: (5,1) ranks first
        spawn(world, 'a', 'Ael', 6, 2);
        delete inventory.cellStock(6, 2).tree;
        world.step();
        // One fine step toward the grove — a 1-minute task (the first leg
        // runs west either way)
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'lumber',
            kind: 'move',
            label: 'travels to trees',
            minutes: 1,
            payload: { dx: -1, dy: 0 },
            total: 1,
            remaining: 1,
        });
        // The trek west (24 fine steps, the wrap into (5,2) landing at
        // minute 25) then the chop: by minute 40 the wood is in the bag —
        // the wrap onto the treed (5,2) short-circuits the trek (a tree
        // underfoot chops). The grove reads tree ×361 (the tile's tree
        // mirror holds — no stock regrow rhythm any more; the chop cut a
        // pool wood)
        for (let index = 0; index < 40; index++) {
            world.step();
        }
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(inventory.cellStock(5, 2)).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 361, berry: 2, mushroom: 2, vine: 1 });
        expect(world.actors.get('a')).toMatchObject({ position: { x: 5, y: 2, z: 0 } });
    });

    it('an actor holding wood never plans lumber — the wider ladder takes over', () => {
        const { world, inventory, tasks } = buildStack();
        spawn(world, 'a', 'Ael', -7, 0);
        inventory.spawnKit('a', { wood: 1 });
        world.step();
        // The gate reads the wood rack: stocked, the behaviour declines and
        // the idle filler wanders
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        expect(inventory.of('a')).toEqual({ wood: 1 });
    });

    it('removing the lumber plugin mid-chop cancels the task (the ledger update rule)', () => {
        const { world, tasks } = buildStack();
        spawn(world, 'a', 'Ael', -7, 0);
        world.step();
        expect(tasks.taskOf('a')?.kind).toBe('chop');
        world.plugins.remove('lumber');
        // The update-on-remove rule: the behaviour is gone AND its queued
        // tasks are cancelled — the actor is idle before any step ran
        expect(tasks.ledger.behaviours().map((module) => module.id)).toEqual(['thirst', 'hunger', 'roost', 'rest', 'social', 'wander']);
        // The idle filler takes over — the actor fine-wanders again
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        // A second drop of the same id reports false
        expect(tasks.dropBehaviour('lumber')).toBe(false);
    });
});
