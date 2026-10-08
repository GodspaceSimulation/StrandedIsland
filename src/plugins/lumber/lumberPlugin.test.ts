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
        // Forest (−7,0) mirrors its full 425-tree stand (the 0.8 interior
        // clamp)
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
        // the bag. The SOURCE tree was the tree on Ael's fine spot — a
        // pool-1 sapling, so the cut FELS it (the mirror drops 425 → 424).
        // The wetland shore's water stands beside the grove (water:2)
        expect(inventory.of('a')).toEqual({ wood: 1 });
        // R4: the (−7,0) column is a meadow shore — the finite stone is gone
        // (stone stands only on the highland rock sites); the tree mirror
        // keeps its felled 424 band
        expect(inventory.cellStock(-7, 0)).toEqual({ dirt: 1, grass: 1, tree: 424, berry: 1, mushroom: 2, water: 2 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ dirt: 1, grass: 1, tree: 424 });
        // The felling is silent — a solo beat, not a story between entities
        expect(world.events.log().map((event) => event.kind)).toEqual(['spawn']);
        // Wooded up, the lumber gate fails — the actor fine-wanders on
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
    });

    it('the wood rack re-arms when the wood is spent: chops pool the same tree down', () => {
        const { world, inventory, tasks, forest } = buildStack();
        spawn(world, 'a', 'Ael', -7, 0);
        // The seeded stand's standing wood at minute 0 (captured reference)
        expect(forest.standOf({ x: -7, y: 0 })).toEqual({ trees: 425, wood: 1688 });
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
        // The second chop cut the stand's next wood — the first cut felled a
        // pool-1 sapling (425 → 424), the second stands; the standing wood
        // dropped by exactly the two cut units (1688 → 1686) and the
        // default biology adds nothing in 31 world minutes (real-year pace)
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(inventory.cellStock(-7, 0).tree).toBe(424);
        expect(forest.standOf({ x: -7, y: 0 })).toEqual({ trees: 424, wood: 1686 });
    });

    it('a woodless actor with no tree underfoot travels toward the nearest treed tile', () => {
        const { world, inventory, tasks } = buildStack();
        // Ael stands on the (2,5) meadow with its 6-tree ingress fringe
        // FELLED away (the stock mirror only — the tile deposit regrows
        // through the ecology's recruitment, not a stock rhythm): the
        // nearest treed tile is the (1,5) grove — 361 trees, ONE west step
        spawn(world, 'a', 'Ael', 2, 5);
        delete inventory.cellStock(2, 5).tree;
        world.step();
        // One fine step toward the grove — a 1-minute task (the first leg
        // runs west into (1,5))
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
        // The step west onto the treed (1,5) short-circuits the trek (a tree
        // underfoot chops): by minute 40 the wood is in the bag and the
        // grove's tree mirror holds 425 (T2's densified pure stand; the chop
        // cut a pool wood — the 425-tree stand stands; the berry/mushroom
        // regrow on their rhythms; R4: the meadow is no stone-bearing)
        for (let index = 0; index < 40; index++) {
            world.step();
        }
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(inventory.cellStock(1, 5)).toEqual({ dirt: 1, grass: 1, tree: 425, berry: 2, mushroom: 2 });
        expect(world.cellAt(1, 5)?.biome).toBe('forest');
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

    it('R4: a castaway carrying the crafted axe chops half-speed (the tool earns its input)', () => {
        // Without the axe: the base 15-minute chop is planned on the treed tile
        const plain = buildStack();
        spawn(plain.world, 'a', 'Ael', -7, 0);
        plain.world.step();
        expect(plain.tasks.taskOf('a')).toMatchObject({ behaviour: 'lumber', kind: 'chop', minutes: 15 });
        // With the crafted axe in the bag: the chop's world-minute cost HALVES
        // (ceil(15 / 2) = 8) — the axe (R4's early tool, plugins/construction)
        // is not cosmetic, it speeds the lumber work it feeds
        const tool = buildStack();
        spawn(tool.world, 'a', 'Ael', -7, 0);
        tool.inventory.spawnKit('a', { axe: 1 });
        tool.world.step();
        expect(tool.tasks.taskOf('a')).toMatchObject({ behaviour: 'lumber', kind: 'chop', minutes: 8 });
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
