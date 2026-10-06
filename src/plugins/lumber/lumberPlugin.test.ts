// Tests for the lumber plugin (plugins/lumber/lumberPlugin.ts).
// Every scenario assembles the full plugin stack exactly like the scenario
// factory does (scenario/island.ts), then drives it with controlled needs
// rates. All outcomes were captured from reference runs — the task loop is
// fully deterministic.
//
// The lumber model: wood is NOT a natural resource — the standing deposit
// is the TREE, and wood exists only as the product of felling one. The
// priority-10 'lumber' ledger behaviour sends a woodless actor to the
// woods: a tree underfoot is chopped (15 minutes — the harvest converts
// one tree deposit into one wood item in the bag); no tree underfoot means
// one fine step toward the nearest treed tile (1 minute). The chop
// completion effect lives in this plugin (the behaviour governs its own
// tasks); the move tasks flow through the behavior plugin's move effect.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
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
// the only thing that moves the actor
const buildStack = () => {
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const lumber = lumberPlugin({ inventory, tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, lumber],
    });
    return { world, inventory, needs, tasks, lumber };
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
        // Forest (−7,0) carries tree ×2 standing on it
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
        // The chop completed at minute 16: one tree off the tile, one wood
        // into the bag — wood never stood on the tile. The woods' own
        // stocks stand beside the grove (berry; the mushroom regrew a
        // second one on its minute-15 rhythm)
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(inventory.cellStock(-7, 0)).toEqual({ tree: 1, berry: 1, mushroom: 2 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ tree: 1 });
        // The felling is silent — a solo beat, not a story between entities
        expect(world.events.log().map((event) => event.kind)).toEqual(['spawn']);
        // Wooded up, the lumber gate fails — the actor fine-wanders on
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
    });

    it('the wood rack re-arms when the wood is spent: the last tree re-skins the tile', () => {
        const { world, inventory, tasks } = buildStack();
        spawn(world, 'a', 'Ael', -7, 0);
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
        // The second chop felled the LAST tree: the deposit is empty and
        // the tile re-skins to its plain biome through tileSurfaceKey (the
        // berry regrowth topped the stock back up to its cap, and the
        // mushroom regrowth did the same for the woods' snack, meanwhile)
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(inventory.cellStock(-7, 0)).toEqual({ berry: 2, mushroom: 2 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({});
        expect(world.cellAt(-7, 0)?.biome).toBe('forest');
    });

    it('a woodless actor with no tree underfoot travels toward the nearest treed tile', () => {
        const { world, inventory, tasks } = buildStack();
        // Ael stands on the forest (6,2) with its own grove FELLED away
        // (the stock only — the tile deposit regrows on its own rhythm):
        // the nearest treed tile is (5,2), one tile west (the row-major
        // survey order wins the distance tie with (7,2))
        spawn(world, 'a', 'Ael', 6, 2);
        delete inventory.cellStock(6, 2).tree;
        world.step();
        // One fine step toward the grove — a 1-minute task
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
        // minute 25) then the chop: by minute 40 the wood is in the bag.
        // The grove reads tree ×2 — the tile's regrowth rhythm (every 60
        // at offset 40) grew one tree back on the very minute the chop
        // landed (the inventory tick runs before the ledger's)
        for (let index = 0; index < 40; index++) {
            world.step();
        }
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(inventory.cellStock(5, 2)).toEqual({ tree: 2, berry: 2, mushroom: 2, vine: 1 });
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
