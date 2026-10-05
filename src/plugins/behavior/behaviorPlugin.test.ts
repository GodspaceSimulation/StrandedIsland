// Tests for the task-driven behavior plugin (plugins/behavior/behaviorPlugin.ts).
// Every scenario assembles the full plugin stack exactly like the scenario
// factory does (scenario/island.ts), then drives it with controlled needs
// rates. All outcomes were captured from reference runs — the task loop is
// fully deterministic.
//
// The one-minute steps keep the scenarios compact: one step is one
// world-minute, so a 10-minute travel task spans 10 steps. Sub-step rhythm
// (engine/world.ts): a task planned during minute M's behavior tick first
// decrements at minute M+1's ledger tick — planned at minute 1, a 10-minute
// task completes at minute 11.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from '../tasks/tasksPlugin';
import { behaviorPlugin } from './behaviorPlugin';
import type { Actor } from '../../engine/types';

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(x, y), marker: name.slice(0, 1), condition: 'well' };
    return world.spawn(actor);
};

// Full stack with rain disabled so injected water is the only source
const buildStack = (needsOptions: Parameters<typeof needsPlugin>[0] = {}) => {
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const needs = needsPlugin({ thirstPerMinute: 0, energyPerMinute: 0, ...needsOptions });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior],
    });
    return { world, inventory, needs, relationship, tasks, behavior };
};

describe('behaviorPlugin', () => {
    it('a hungry actor with a berry eats AFTER the eat task completes', () => {
        const { world, inventory, needs, tasks } = buildStack({ hungerPerMinute: 6 });
        spawn(world, 'a', 'Ael', 6, 2);
        inventory.spawnKit('a', { berry: 2, flint: 1 });
        needs.satisfy('a', { hunger: 40 }); // hunger 60 ≥ the trigger — the eat task is planned first
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        // The 2-minute eat task was planned at minute 1 and completed at
        // minute 3: hunger 60 + 6 × 3 = 78, one berry eaten (−14 nutrition)
        expect(needs.of('a')).toEqual({ hunger: 64, thirst: 20, energy: 100 });
        expect(inventory.of('a')).toEqual({ berry: 1, flint: 1 });
        // The consume event carries the exact stamp of the completing minute
        // (a 'needs' threshold event interleaves at tick 2 — hunger crossed 70)
        const consume = world.events.log().find((event) => event.kind === 'consume');
        expect(consume).toEqual({
            id: 3,
            tick: 3,
            time: 3,
            kind: 'consume',
            message: 'Ael eats 1 Berry.',
            actorId: 'a',
        });
        // Still hungry (64 ≥ 60) — the actor re-plans eating immediately
        expect(tasks.taskOf('a')).toEqual({
            id: 't-2',
            actorId: 'a',
            behaviour: 'hunger',
            kind: 'eat',
            label: 'eats',
            minutes: 2,
            payload: { itemId: 'berry' },
            total: 2,
            remaining: 2,
        });
    });

    it('a thirsty actor travels to water: one tile takes exactly 10 world minutes', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        inventory.cellStock(4, 2).water = 1; // the pool is two tiles west
        needs.satisfy('a', { thirst: 60 }); // thirst 80 ≥ 65
        world.step();
        // The thirst behaviour plans ONE greedy step west — a 10-minute task
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'thirst',
            kind: 'move',
            label: 'travels to water',
            minutes: 10,
            payload: { dx: -1, dy: 0 },
            total: 10,
            remaining: 10,
        });
        for (let index = 0; index < 4; index++) {
            world.step();
        }
        // Mid-task at minute 5: position unchanged, 6 minutes left
        expect(world.ticker.elapsed()).toBe(5);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 2, z: 0 } });
        expect(tasks.taskOf('a')?.remaining).toBe(6);
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        // Elapsed 10 — still mid-task (the last ledger decrement lands next minute)
        expect(world.ticker.elapsed()).toBe(10);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 2, z: 0 } });
        expect(tasks.taskOf('a')?.remaining).toBe(1);
        world.step();
        // The completing step: the move lands, the event fires, energy charged
        expect(world.ticker.elapsed()).toBe(11);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 5, y: 2, z: 0 } });
        expect(needs.of('a').energy).toBe(99);
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
            { kind: 'move', message: 'Ael walks west.', time: 11 },
        ]);
        // The actor re-plans the next tile the same minute — still travelling
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'travels to water', remaining: 10 });
        expect(needs.of('a').thirst).toBe(80);
    });

    it('a mid-travel actor keeps its origin position; a blocked move is silently re-planned', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        inventory.cellStock(4, 2).water = 1;
        needs.satisfy('a', { thirst: 60 });
        world.step(); // the travel task (west) is queued
        // Bram materialises ON the target cell mid-task
        spawn(world, 'b', 'Bram', 5, 2);
        for (let index = 0; index < 10; index++) {
            world.step();
        }
        // The occupancy rule: Ael never left his origin through the task
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 2, z: 0 } });
        world.step(); // the task completes — the target is occupied
        // A blocked move logs NOTHING; the actor re-plans the same minute and
        // takes the neighbour fallback (north) instead
        expect(world.events.log().filter((event) => event.actorId === 'a' && event.kind === 'move')).toEqual([]);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 2, z: 0 } });
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', payload: { dx: 0, dy: -1 } });
        // The energy charge is bound to the move effect — no move, no charge
        expect(needs.of('a').energy).toBe(100);
    });

    it('a fed actor exchanges food for a hungry neighbour’s material AT PLAN TIME', () => {
        const { world, inventory, needs, relationship, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 8, 2);
        spawn(world, 'b', 'Bram', 8, 3);
        inventory.spawnKit('a', { berry: 3, flint: 1 });
        inventory.spawnKit('b', { shell: 1 });
        needs.satisfy('b', { hunger: 50 }); // Bram at hunger 70
        world.step();
        // Ael's plan tick applied the exchange IMMEDIATELY (minute 1) and
        // queued the 10-minute social task as the encounter's time cost
        expect(inventory.of('a')).toEqual({ berry: 2, flint: 1, shell: 1 });
        expect(inventory.of('b')).toEqual({ berry: 1 });
        expect(relationship.relation('a', 'b')).toBe(6);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'social', label: 'trades', remaining: 10 });
        // Bram plans eating the traded berry in his own plan tick
        expect(tasks.taskOf('b')).toMatchObject({ kind: 'eat', remaining: 2 });
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        // Bram's 2-minute eat completed at minute 3
        expect(inventory.of('b')).toEqual({});
        // Drift moved the bond 0.02 per minute after the trade (minutes 2–4)
        expect(relationship.relation('a', 'b')).toBe(5.940000000000001);
        // Ael stays busy the whole encounter — socialMinutes 10
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'social', remaining: 7 });
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
            { kind: 'spawn', message: 'Bram washes ashore.', time: 0 },
            { kind: 'exchange', message: 'Ael and Bram trade: 1 Berry for 1 Shell.', time: 1 },
            { kind: 'relationship', message: 'Ael and Bram grow closer (trading).', time: 1 },
            { kind: 'consume', message: 'Bram eats 1 Berry.', time: 3 },
        ]);
    });

    it('a fed actor gifts food when the neighbour has nothing to trade; the cooldown holds', () => {
        const { world, inventory, needs, relationship, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 8, 2);
        spawn(world, 'b', 'Bram', 8, 3);
        // Only 3 berries: one gift, then the bag is below the gift line
        inventory.spawnKit('a', { berry: 3 });
        needs.satisfy('b', { hunger: 50 });
        // Keep Bram permanently hungry so every cooldown window re-triggers
        for (let index = 0; index < 8; index++) {
            world.step();
            needs.satisfy('b', { hunger: 10 });
        }
        // The gift landed at plan time on minute 1 (+10); drift alone moves
        // the value after that — Ael is busy with the 10-minute social task
        // through minute 11, so the 60-minute cooldown blocks any second gift
        expect(relationship.relation('a', 'b')).toBe(9.860000000000003);
        expect(inventory.of('a')).toEqual({ berry: 2 });
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'social', label: 'gives', remaining: 3 });
        const socialEvents = world.events.log().filter((event) => event.kind === 'exchange' || event.kind === 'relationship');
        expect(socialEvents.map((event) => ({ message: event.message, time: event.time }))).toEqual([
            { message: 'Ael gives Bram 1 Berry.', time: 1 },
            { message: 'Ael and Bram grow closer (gifting).', time: 1 },
        ]);
    });

    it('wander moves to a random free neighbour after the 10-minute task', () => {
        const { world, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        for (let index = 0; index < 11; index++) {
            world.step();
        }
        // The idle filler planned a 10-minute wander at minute 1; the move
        // effect landed at minute 11 — one tile north (the seeded pick)
        expect(world.events.log().filter((event) => event.kind === 'move').map((event) => ({ message: event.message, time: event.time }))).toEqual([
            { message: 'Ael wanders north.', time: 11 },
        ]);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 1, z: 0 } });
        // needs.moved charged the move energy on the completing step (the
        // 0.1/min hunger decay ran through all eleven minutes)
        expect(needs.of('a')).toEqual({ hunger: 21.100000000000016, thirst: 20, energy: 99 });
        // The wanderer re-plans immediately — a fresh 10-minute wander
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 10 });
    });

    it('a hungry actor with no food gathers from the cell it stands on', () => {
        const { world, inventory, needs } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        inventory.spawnKit('a', { flint: 1 });
        needs.satisfy('a', { hunger: 40 }); // hunger 60 ≥ the trigger
        for (let index = 0; index < 13; index++) {
            world.step();
        }
        // The 10-minute gather completed at minute 11, then the fresh berry
        // was eaten at minute 13
        expect(inventory.of('a')).toEqual({ flint: 1 });
        // Hunger: 60 at plan time + 0.1/min decay through minute 13, −14 on the eat
        expect(needs.of('a').hunger).toBe(47.30000000000002);
        // The start cell: the gathered berry is gone; berry regrowth runs on
        // a 30-minute rhythm (offset 20) — thirteen minutes never reach it
        expect(inventory.cellStock(6, 2)).toEqual({ wood: 2 });
        expect(world.events.log().filter((event) => event.kind === 'gather' || event.kind === 'consume').map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'gather', message: 'Ael gathers 1 Berry.', time: 11 },
            { kind: 'consume', message: 'Ael eats 1 Berry.', time: 13 },
        ]);
    });

    it('a thirsty actor drinks the rainwater pool on its own cell', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 1, -4);
        inventory.cellStock(1, -4).water = 1;
        needs.satisfy('a', { thirst: 50 }); // thirst 70 ≥ 65 → the 2-minute drink task
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'drink', remaining: 2 });
        world.step();
        world.step();
        // −35 thirst relief on the completing minute, the pool is emptied,
        // nothing enters the bag (hunger 20.3: the 0.1/min decay ran 3 minutes)
        expect(needs.of('a')).toEqual({ hunger: 20.300000000000004, thirst: 35, energy: 100 });
        expect(inventory.cellStock(1, -4)).toEqual({ dirt: 1, berry: 2 });
        expect(inventory.of('a')).toEqual({});
        expect(world.events.log()[1]).toEqual({
            id: 2,
            tick: 3,
            time: 3,
            kind: 'consume',
            message: 'Ael drinks 1 Water.',
            actorId: 'a',
        });
    });

    it('a starving actor travels toward the nearest stocked cell, tile by tile', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        // Drain EVERY stock (sea fish included), leave a single stocked
        // forest at (8,2) — the only food-bearing cell on the island
        world.canvas.cells.forEach((cell) => {
            const stock = inventory.cellStock(cell.x, cell.y);
            Object.keys(stock).forEach((item) => {
                delete stock[item];
            });
        });
        inventory.cellStock(8, 2).berry = 3;
        spawn(world, 'a', 'Ael', 10, 3);
        inventory.spawnKit('a', { flint: 1 });
        needs.satisfy('a', { hunger: 40 }); // hunger 60 ≥ the trigger
        for (let index = 0; index < 43; index++) {
            world.step();
        }
        // Three 10-minute greedy moves: west, west, north onto the stocked
        // cell — then the 10-minute gather, then the berry is eaten
        expect(world.events.log().filter((event) => event.kind === 'move' || event.kind === 'gather' || event.kind === 'consume').map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'move', message: 'Ael walks west.', time: 11 },
            { kind: 'move', message: 'Ael walks west.', time: 21 },
            { kind: 'move', message: 'Ael walks north.', time: 31 },
            { kind: 'gather', message: 'Ael gathers 1 Berry.', time: 41 },
            { kind: 'consume', message: 'Ael eats 1 Berry.', time: 43 },
        ]);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 8, y: 2, z: 0 } });
        // Three move charges (one per completed tile); hunger 60 at plan
        // time + 0.1/min decay through minute 43, −14 on the eat
        expect(needs.of('a').energy).toBe(97);
        expect(inventory.of('a')).toEqual({ flint: 1 });
        expect(needs.of('a').hunger).toBe(50.30000000000004);
        // Sated (50.3 < 60) — the actor re-plans a wander
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 10 });
    });

    it('an exhausted actor rests: the recovery applies once, on completion', () => {
        const { world, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        needs.satisfy('a', { energy: -80 }); // energy 20 ≤ 22 → the 10-minute rest task
        for (let index = 0; index < 12; index++) {
            world.step();
        }
        // The +12 recovery landed on the completing minute (11)
        expect(needs.of('a').energy).toBe(32);
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
            { kind: 'rest', message: 'Ael rests for a while.', time: 11 },
        ]);
        // Rested past the trigger (32 > 22) — the actor wanders on; the
        // twelfth step already counted one minute off the fresh wander task
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 9 });
    });

    it('dropping the wander behaviour mid-run strands idle actors (task list empties)', () => {
        const { world, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        spawn(world, 'b', 'Bram', 8, 2);
        world.step();
        // Both castaways queued 10-minute wander tasks
        expect(tasks.tasks().map((task) => task.actorId)).toEqual(['a', 'b']);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 10 });
        // Drop the wander module: its queued tasks cancel, actors go idle
        expect(tasks.dropBehaviour('wander')).toBe(true);
        expect(tasks.tasks()).toEqual([]);
        expect(tasks.ledger.behaviours().map((module) => module.id)).toEqual(['thirst', 'hunger', 'rest', 'social']);
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        // No survival trigger fires and the remaining modules decline —
        // the actors stand still with empty task lists
        expect(tasks.tasks()).toEqual([]);
        expect(world.events.log().filter((event) => event.kind === 'move')).toEqual([]);
        // A second drop of the same id reports false
        expect(tasks.dropBehaviour('wander')).toBe(false);
    });
});
