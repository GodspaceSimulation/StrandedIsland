// Tests for the lumber plugin (plugins/lumber/lumberPlugin.ts).
// Every scenario assembles the full plugin stack exactly like the scenario
// factory does (scenario/island.ts), then drives it with controlled needs
// rates. All outcomes were captured from reference runs — the task loop is
// fully deterministic.
//
// The lumber model (R6): wood is NOT a natural resource — the standing
// deposit is the TREE, and wood exists only as the product of cutting a
// tree's wood pool. The priority-10 'lumber' ledger behaviour sends a
// woodless, SKILLED (the species 'chop' ability) actor to the woods: the
// felling is a PERSISTENT SHARED TILE JOB in the tasks plugin's tile-work
// ledger (@godspace/core src/work), keyed `tileWorkKey(x, y, 'chop')` —
// the job demands `chopMinutes` (15) WORK-minutes; every contributor adds
// one work-minute per 1-minute beat task, the job survives every actor's
// death/abort, and ANY skilled contributor may finish it (the payout is
// claimed atomically — one wood per finished job, never duplicated). A
// tree underfoot with no standing job OPENS it (the axe halves the demand
// at open, R4); no tree means one fine step toward the nearest treed tile.
// The forest ecology (plugins/forest) grows the pools back between chops.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { toolState } from '../inventory/toolDurability';
import { forestPlugin } from '../forest/forestPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { entityPlugin } from '../entity/entityPlugin';
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
// scenario's default) — the chop cuts wood off the tree pools. `withEntity`
// mounts the species registry so the 'chop' ability gate is live.
const buildStack = (withEntity = false) => {
    const terrain = islandTerrainPlugin();
    const entity = withEntity ? entityPlugin() : undefined;
    const inventory = inventoryPlugin({ rainChancePerMinute: 0, ...(entity ? { profiles: entity } : {}) });
    const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({
        inventory,
        needs,
        relationship,
        tasks,
        ...(entity ? { profiles: entity } : {}),
    });
    const forest = forestPlugin({ terrain, inventory });
    const lumber = lumberPlugin({
        inventory,
        tasks,
        ...(entity ? { profiles: entity } : {}),
    });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [terrain, ...(entity ? [entity] : []), inventory, forest, needs, relationship, tasks, behavior, lumber],
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

    it('a woodless actor on a treed tile opens the shared job and beats it: the wood lands on completion', () => {
        const { world, inventory, tasks } = buildStack();
        // Forest (−7,0) mirrors its full 425-tree stand (the 0.8 interior
        // clamp)
        spawn(world, 'a', 'Ael', -7, 0);
        world.step();
        // Minute 1: the tile's chop JOB opens at 15 work-minutes and the
        // actor's first 1-minute beat queues — the tree is NOT consumed at
        // plan time (the harvest lands on the atomic claim)
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'lumber',
            kind: 'chop',
            label: 'chops a tree',
            minutes: 1,
            total: 1,
            remaining: 1,
        });
        expect(tasks.tileWork.get('tile:-7,0:chop')).toEqual({
            key: 'tile:-7,0:chop',
            kind: 'chop',
            units: 15,
            progress: 0,
            skill: 'chop',
        });
        expect(inventory.of('a')).toEqual({});
        // Minute 2: the first beat completes — one work-minute into the job
        world.step();
        expect(tasks.tileWork.get('tile:-7,0:chop')?.progress).toBe(1);
        for (let index = 0; index < 14; index++) {
            world.step();
        }
        // The chop completed at minute 16 (fifteen beats): one wood off a
        // tree's POOL into the bag and the job is GONE (claimed). The SOURCE
        // tree was the tree on Ael's fine spot — a pool-1 sapling, so the
        // cut FELS it (the mirror drops 425 → 424). The wetland shore's
        // water stands beside the grove (water:2)
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(tasks.tileWork.get('tile:-7,0:chop')).toBeUndefined();
        // R4/R7: the (−7,0) column is a meadow shore — the finite stone is
        // gone (stone stands only on the highland rock sites); the tree
        // mirror keeps its felled 424 band. The enriched abundance seeds
        // berry 4 + mushroom 3 + the standing bush + a vine from the 0.6
        // forest draw; the minute-15 mushroom pulse adds the fourth mushroom
        // (the berry pulse at 20 has not fired yet at minute 16)
        expect(inventory.cellStock(-7, 0)).toEqual({ dirt: 1, grass: 1, tree: 424, berry: 4, mushroom: 4, bush: 1, water: 2, vine: 1 });
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
        // re-opens on the next planning round and a FRESH job opens (the
        // old one was claimed away)
        delete inventory.of('a').wood;
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'chop', minutes: 1, remaining: 1 });
        expect(tasks.tileWork.get('tile:-7,0:chop')?.units).toBe(15);
        for (let index = 0; index < 15; index++) {
            world.step();
        }
        // The second chop cut the stand's next tree — the first cut felled a
        // pool-1 sapling (425 → 424, one wood), the second stands; R2's
        // 3-wood payout took three units off the standing tree, so the
        // standing wood dropped by exactly the four cut units (1688 → 1684)
        // and the default biology adds nothing in 31 world minutes (real-year
        // pace)
        expect(inventory.of('a')).toEqual({ wood: 3 });
        expect(inventory.cellStock(-7, 0).tree).toBe(424);
        expect(forest.standOf({ x: -7, y: 0 })).toEqual({ trees: 424, wood: 1684 });
    });

    it('R6: the job PERSISTS across actors — a dead chopper leaves its minutes standing', () => {
        const { world, inventory, tasks } = buildStack();
        spawn(world, 'a', 'Ael', -7, 0);
        // Five beats complete (minutes 2–6): five work-minutes stand in the
        // tile's job
        for (let index = 0; index < 6; index++) {
            world.step();
        }
        expect(tasks.tileWork.get('tile:-7,0:chop')?.progress).toBe(5);
        // Ael dies mid-felling — the queue cancels, the JOB stays
        world.despawn('a');
        expect(tasks.taskOf('a')).toBeUndefined();
        expect(tasks.tileWork.get('tile:-7,0:chop')).toEqual({
            key: 'tile:-7,0:chop',
            kind: 'chop',
            units: 15,
            progress: 5,
            skill: 'chop',
        });
        // Bram picks the standing work up — he never restarts it
        spawn(world, 'b', 'Bram', -7, 0);
        world.step(); // minute 7: Bram joins the job (no re-open)
        expect(tasks.taskOf('b')).toMatchObject({ kind: 'chop', minutes: 1 });
        expect(tasks.tileWork.get('tile:-7,0:chop')?.progress).toBe(5);
        // Ten more beats finish it: the claim pays Bram up to three wood
        // (R2 — the standing tree's pool covers all three)
        for (let index = 0; index < 11; index++) {
            world.step();
        }
        expect(inventory.of('b')).toEqual({ wood: 3 });
        expect(tasks.tileWork.get('tile:-7,0:chop')).toBeUndefined();
    });

    it('R6: two contributors share one job — the claim pays ONE wood, not two', () => {
        const { world, inventory, tasks } = buildStack();
        // BOTH castaways stand on the treed tile from the start — every
        // minute each beats the ONE shared job, so the 15-unit job lands in
        // half the world time (the ledger counts LABOR-minutes, the ticker
        // counts world minutes)
        spawn(world, 'a', 'Ael', -7, 0);
        spawn(world, 'b', 'Bram', -7, 0);
        world.step(); // minute 1: Ael opens the job; Bram joins the same unit
        expect(tasks.tileWork.get('tile:-7,0:chop')?.units).toBe(15);
        // Minutes 2–8: both beats complete every minute → 7 × 2 = 14 work-
        // minutes stand; minute 9: Ael's beat reaches 15 and claims
        for (let index = 0; index < 7; index++) {
            world.step();
        }
        expect(tasks.tileWork.get('tile:-7,0:chop')?.progress).toBe(14);
        world.step();
        // Exactly ONE wood exists across both bags — the atomic claim pays
        // the finisher only. The claimed job is gone; the job that stands
        // now is Bram's FRESH open (progress 0, the same 15-unit demand) —
        // the finished work was never double-paid
        const wood = (inventory.of('a').wood ?? 0) + (inventory.of('b').wood ?? 0);
        expect(wood).toBe(1);
        expect(tasks.tileWork.get('tile:-7,0:chop')).toEqual({
            key: 'tile:-7,0:chop',
            kind: 'chop',
            units: 15,
            progress: 0,
            skill: 'chop',
        });
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
        // underfoot opens the job): by minute 40 the wood is in the bag and
        // the grove's tree mirror drops to 424 (T2's densified pure stand;
        // the chop cut the last TWO pool wood off a pool-2 tree — R2's payout
        // is up to three, but this tree only held two, and emptying the pool
        // FELL it: 425 → 424; the enriched R7 stocks (seeded berry 4 +
        // mushroom 3) regrow on their rhythms — the minute-15 mushroom and
        // minute-20 berry pulses add a unit each; this grove cell missed the
        // vine draw; R4: the meadow is no stone-bearing)
        for (let index = 0; index < 40; index++) {
            world.step();
        }
        expect(inventory.of('a')).toEqual({ wood: 2 });
        expect(inventory.cellStock(1, 5)).toEqual({ dirt: 1, grass: 1, tree: 424, berry: 5, mushroom: 4 });
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

    it('R6 skill gate: without the species chop ability the woods stay unworked', () => {
        // The entity profiles mounted — 'human' carries 'chop', 'boar' does
        // not. A boar-shaped sentient (kind forced sentient, type boar) must
        // never open or join the job
        const { world, tasks } = buildStack(true);
        const boar: Actor = {
            id: 'tusk',
            name: 'Tusk',
            kind: 'sentient',
            type: 'boar',
            position: position3(-7, 0),
            marker: 'T',
            condition: 'well',
            // The engine's facet reader demands a profile on every spawned
            // body (world.ts facetOf reads profile.sex) — the boar-shaped
            // sentient carries the stock beast profile shape
            profile: { sex: 'male' },
        };
        world.spawn(boar);
        world.step();
        // The chop gate declines — the wander filler takes the minute and
        // NO tile job opens on the treed tile
        expect(tasks.taskOf('tusk')?.kind).not.toBe('chop');
        expect(tasks.tileWork.get('tile:-7,0:chop')).toBeUndefined();
    });

    it('R4: a castaway carrying the crafted axe opens the job at half the work-minutes', () => {
        // Without the axe: the base 15-work-minute job opens on the treed tile
        const plain = buildStack();
        spawn(plain.world, 'a', 'Ael', -7, 0);
        plain.world.step();
        expect(plain.tasks.taskOf('a')).toMatchObject({ behaviour: 'lumber', kind: 'chop', minutes: 1 });
        expect(plain.tasks.tileWork.get('tile:-7,0:chop')?.units).toBe(15);
        // With the crafted axe in the bag: the job's WORK demand halves
        // (ceil(15 / 2) = 8) — the axe (R4's early tool, plugins/
        // construction) is not cosmetic, it speeds the lumber work it feeds
        const tool = buildStack();
        spawn(tool.world, 'a', 'Ael', -7, 0);
        tool.inventory.spawnKit('a', { axe: 1 });
        tool.world.step();
        expect(tool.tasks.taskOf('a')).toMatchObject({ behaviour: 'lumber', kind: 'chop', minutes: 1 });
        expect(tool.tasks.tileWork.get('tile:-7,0:chop')?.units).toBe(8);
        // Eight beats land the wood: beats complete minutes 2–9
        for (let index = 0; index < 8; index++) {
            tool.world.step();
        }
        // The axe stays in the bag (it is a tool, not a harvest) — the bag
        // holds the axe AND the claimed wood
        expect(tool.inventory.of('a')).toEqual({ axe: 1, wood: 1 });
        expect(tool.tasks.tileWork.get('tile:-7,0:chop')).toBeUndefined();
    });

    it('removing the lumber plugin mid-chop cancels the task but keeps the standing job', () => {
        const { world, tasks } = buildStack();
        spawn(world, 'a', 'Ael', -7, 0);
        world.step();
        world.step(); // one beat lands
        expect(tasks.taskOf('a')?.kind).toBe('chop');
        expect(tasks.tileWork.get('tile:-7,0:chop')?.progress).toBe(1);
        world.plugins.remove('lumber');
        // The update-on-remove rule: the behaviour is gone AND its queued
        // tasks are cancelled — but the tile WORK belongs to the tasks
        // environment, so the standing job survives the behaviour swap
        expect(tasks.ledger.behaviours().map((module) => module.id)).toEqual(['thirst', 'hunger', 'roost', 'rest', 'social', 'wander']);
        expect(tasks.tileWork.get('tile:-7,0:chop')?.progress).toBe(1);
        // The idle filler takes over — the actor fine-wanders again
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        // A second drop of the same id reports false
        expect(tasks.dropBehaviour('lumber')).toBe(false);
    });
});

// ── R3 — the axe's wear rides the successful chop payout ────────────────────
// The durability ledger (plugins/inventory/toolDurability) is keyed by the
// world object, so the lumber stack's own world is the read key. The charge
// lands ONLY on the atomic claim's successful harvest — a failed payout (a
// full bag) puts the job back and wears nothing.
describe('lumberPlugin — R3 the axe wears, breaks and stays honest through the chop', () => {
    /** The held axe's live durability view (undefined: not held). */
    const axeOf = (world: ReturnType<typeof createWorld>, inventory: ReturnType<typeof inventoryPlugin>) =>
        toolState(world, 'a', 'axe', inventory.of('a').axe ?? 0);

    it('the axe spends 5 health per successful chop payout — exact banked wear', () => {
        const { world, inventory, tasks } = buildStack(true);
        spawn(world, 'a', 'Ael', -7, 0);
        inventory.spawnKit('a', { axe: 1 });
        // The fresh acquisition reads full
        expect(axeOf(world, inventory)).toEqual({ tool: 'axe', health: 100, maxHealth: 100, damage: 0 });
        // The first chop: the job opens at the axe's halved 8 units and the
        // payout lands (the fine-spot tree is a pool-1 sapling — one wood)
        world.step();
        for (let index = 0; index < 8; index++) {
            world.step();
        }
        expect(inventory.of('a').wood ?? 0).toBe(1);
        // THE WEAR — one successful payout = toolWearPerUse('axe','chop') = 5
        expect(axeOf(world, inventory)).toEqual({ tool: 'axe', health: 95, maxHealth: 100, damage: 5 });
        // The rack refills: a second chop (the wood leaves, the gate
        // re-opens, a fresh 8-unit job) banks five more
        delete inventory.of('a').wood;
        world.step();
        for (let index = 0; index < 8; index++) {
            world.step();
        }
        expect(axeOf(world, inventory)).toEqual({ tool: 'axe', health: 90, maxHealth: 100, damage: 10 });
        // And the job is claimed away again — the payout landed exactly once
        expect(tasks.tileWork.get('tile:-7,0:chop')).toBeUndefined();
    });

    it('a failed payout (a full bag) wears nothing — the job stands, the axe stays whole', () => {
        const { world, inventory, tasks } = buildStack(true);
        spawn(world, 'a', 'Ael', -7, 0);
        // The axe plus 160 weight of stone: the 200-weight hand has room
        // for 10 more — one wood (20) can NEVER enter, so the claim's
        // harvest refuses whole and the job returns standing
        inventory.spawnKit('a', { axe: 1, stone: 4 });
        expect(inventory.of('a')).toEqual({ axe: 1, stone: 4 });
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'lumber', kind: 'chop' });
        expect(tasks.tileWork.get('tile:-7,0:chop')?.units).toBe(8);
        // The eight beats complete and claim — but every payout fails
        for (let index = 0; index < 12; index++) {
            world.step();
        }
        // NO wood in the bag, NO wear on the axe (the canonical rule: the
        // tool wears on SUCCESS, never on spent minutes), and the job
        // stands ready for the next claim attempt
        expect(inventory.of('a').wood ?? 0).toBe(0);
        expect(axeOf(world, inventory)).toEqual({ tool: 'axe', health: 100, maxHealth: 100, damage: 0 });
        expect(tasks.tileWork.get('tile:-7,0:chop')).toBeDefined();
    });

    it('the 20th successful payout BREAKS the axe atomically and the next job opens un-halved', () => {
        const { world, inventory, tasks } = buildStack(true);
        spawn(world, 'a', 'Ael', -7, 0);
        inventory.spawnKit('a', { axe: 1 });
        // Nineteen chops: each banks exactly 5 health (the payout's cut
        // size varies with the cut tree's pool — the WEAR does not). The
        // wood leaves the bag between chops so the rack gate re-opens.
        for (let chop = 0; chop < 19; chop++) {
            if (chop > 0) {
                delete inventory.of('a').wood;
            }
            world.step(); // the plan/open minute
            for (let index = 0; index < 8; index++) {
                world.step(); // the eight beats complete the job
            }
            expect(inventory.of('a').wood ?? 0).toBeGreaterThan(0);
        }
        // Nineteen payouts banked: 95 damage — the axe stands at its LAST
        // health point
        expect(axeOf(world, inventory)).toEqual({ tool: 'axe', health: 5, maxHealth: 100, damage: 95 });
        // THE TWENTIETH PAYOUT — the atomic break: the last health point
        // removes the axe from the bag in the same synchronous step
        delete inventory.of('a').wood;
        world.step();
        for (let index = 0; index < 8; index++) {
            world.step();
        }
        expect(inventory.of('a').wood ?? 0).toBeGreaterThan(0); // the cut landed
        expect(inventory.of('a').axe ?? 0).toBe(0); // the axe is GONE
        expect(toolState(world, 'a', 'axe', 0)).toBeUndefined(); // the record died with it
        // The next chop: no axe held — the fresh job opens at the FULL
        // 15 work-minutes (the halving rode the held tool only)
        delete inventory.of('a').wood;
        world.step();
        expect(tasks.tileWork.get('tile:-7,0:chop')?.units).toBe(15);
    });
});
