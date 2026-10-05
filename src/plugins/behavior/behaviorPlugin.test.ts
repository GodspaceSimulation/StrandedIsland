// Tests for the task-driven behavior plugin (plugins/behavior/behaviorPlugin.ts).
// Every scenario assembles the full plugin stack exactly like the scenario
// factory does (scenario/island.ts), then drives it with controlled needs
// rates. All outcomes were captured from reference runs — the task loop is
// fully deterministic.
//
// The simulation runs at SCALE 0: every move task walks the actor ONE
// SUBTILE CELL inside its tile's sub-grid (world.relocateFine) — one
// world-minute per task (the distribution's distance rule: one Scale-0 tile
// move per tick). Crossing a tile boundary takes as many steps as the
// actor's fine spot is from the edge, plus the wrapping step itself (25 on
// the 25-wide default island); the energy charge lands on a tile crossing.
//
// Sub-step rhythm (engine/world.ts): a task planned during minute M's
// behavior tick first decrements at minute M+1's ledger tick — planned at
// minute 1, a 1-minute task completes at minute 2.

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

/** The one-minute move task the Scale-0 rules produce. */
const moveTask = (behaviour: string, label: string, dx: number, dy: number, extra: Record<string, unknown> = {}) => ({
    id: expect.any(String),
    actorId: 'a',
    behaviour,
    kind: 'move',
    label,
    minutes: 1,
    payload: { dx, dy, ...extra },
    total: 1,
    remaining: 1,
    ...extra,
});

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

    it('a thirsty actor travels to water: Scale-0 fine steps, a tile crossing every wrap', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        inventory.cellStock(8, 2).water = 1; // the pool is two tiles east
        needs.satisfy('a', { thirst: 60 }); // thirst 80 ≥ 65
        world.step();
        // The thirst behaviour plans ONE fine step east — a 1-minute task
        // (the Scale-0 distance rule: one tile move per tick)
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'thirst',
            kind: 'move',
            label: 'travels to water',
            minutes: 1,
            payload: { dx: 1, dy: 0 },
            total: 1,
            remaining: 1,
        });
        // Minute 2: the completing fine step stays INSIDE the tile (the
        // derived spot {11,−3} is one cell from the east edge) — the island
        // view's coarse position does not move yet
        world.step();
        expect(world.ticker.elapsed()).toBe(2);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 2, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: 12, y: -3 });
        expect(needs.of('a').energy).toBe(100);
        world.step();
        // Minute 3: the NEXT east step steps off the tile edge and WRAPS —
        // the actor flows into the neighbor tile (7,2), and the tile
        // crossing charges the move energy
        expect(world.ticker.elapsed()).toBe(3);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 7, y: 2, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: -12, y: -3 });
        expect(needs.of('a').energy).toBe(99);
        expect(world.events.log().filter((event) => event.kind === 'move').map((event) => ({ message: event.message, time: event.time }))).toEqual([
            { message: 'Ael walks east.', time: 2 },
            { message: 'Ael walks east.', time: 3 },
        ]);
        // The walk across tile (7,2): 25 more east fine steps, the last one
        // wrapping onto the pool tile (8,2) at minute 28 (a second crossing,
        // a second charge)
        for (let index = 0; index < 25; index++) {
            world.step();
        }
        expect(world.ticker.elapsed()).toBe(28);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 8, y: 2, z: 0 } });
        expect(needs.of('a').energy).toBe(98);
        // On the pool tile the thirst behaviour pivots to the 2-minute drink,
        // completing at minute 30 (−35 thirst relief)
        for (let index = 0; index < 2; index++) {
            world.step();
        }
        expect(world.ticker.elapsed()).toBe(30);
        expect(needs.of('a').thirst).toBe(45);
        expect(inventory.cellStock(8, 2)).toEqual({ wood: 2, berry: 2 });
        // 27 east fine steps + the drink's consume stamp
        expect(world.events.log().filter((event) => event.kind === 'move').length).toBe(27);
        expect(world.events.log().filter((event) => event.kind === 'move').slice(-1)).toEqual([
            { id: expect.any(Number), tick: 28, time: 28, kind: 'move', message: 'Ael walks east.', actorId: 'a' },
        ]);
        expect(world.events.log().filter((event) => event.kind === 'consume')).toEqual([
            { id: 29, tick: 30, time: 30, kind: 'consume', message: 'Ael drinks 1 Water.', actorId: 'a' },
        ]);
        // Sated (45 < 65) — the actor re-plans a wander
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
    });

    it('a blocked wrap is silently re-planned: the fallback walks, the next attempt crosses', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        inventory.cellStock(8, 2).water = 1;
        needs.satisfy('a', { thirst: 60 });
        world.step(); // the east travel task is queued
        // A coordinates-only resident (no actor registry entry, no behaviour —
        // it never moves) materializes on tile (7,2) EXACTLY on Ael's landing
        // fine spot: the east edge of the neighbor tile, {−12,−3}. The
        // Scale-0 occupancy rule sees it (the coordinate space is the
        // single position registry).
        world.coordinates.place({
            id: 'b',
            position: position3(7, 2),
            kind: 'creature',
            type: 'dog',
            name: 'Bram',
            marker: 'B',
            state: 'well',
        });
        const bramSub = world.subOf('b');
        expect(bramSub).toEqual({ x: -9, y: 7 });
        world.relocateFine('b', -12 - bramSub.x, -3 - bramSub.y);
        expect(world.subOf('b')).toEqual({ x: -12, y: -3 });
        // Minute 2: the east task completes with an INTERIOR step ({11,−3} →
        // {12,−3}) — no wrap, no block yet. The same minute's re-plan sees
        // the wrap onto the taken spot and plans the FALLBACK (the first
        // valid fine direction: north) instead of a second east step
        world.step();
        expect(world.ticker.elapsed()).toBe(2);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 2, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: 12, y: -3 });
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', payload: { dx: 0, dy: -1 } });
        // Minute 3: the fallback walks — a north fine step inside the tile
        // (no crossing, no charge). The wrap was never attempted, so no move
        // was blocked: the walk event is the fallback's.
        world.step();
        expect(world.ticker.elapsed()).toBe(3);
        // The actor still stands on (6,2) — the island view never saw the
        // blocked wrap as a tile change
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 2, z: 0 } });
        expect(needs.of('a').energy).toBe(100);
        expect(world.events.log().filter((event) => event.kind === 'move').map((event) => ({ message: event.message, time: event.time }))).toEqual([
            { message: 'Ael walks east.', time: 2 },
            { message: 'Ael walks north.', time: 3 },
        ]);
        // Minute 4: the east attempt repeats — the wrap now lands one spot
        // north of the resident ({−12,−4}, free) and the actor flows into
        // (7,2) with the crossing charge
        world.step();
        expect(world.ticker.elapsed()).toBe(4);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 7, y: 2, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: -12, y: -4 });
        expect(needs.of('a').energy).toBe(99);
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
            // Bram, fed and idle, fine-wanders his tile (the Scale-0 filler)
            { kind: 'move', message: 'Bram wanders north.', time: 4 },
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

    it('the idle filler fine-wanders: one Scale-0 tile per completed task', () => {
        const { world, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        for (let index = 0; index < 4; index++) {
            world.step();
        }
        // Three wander tasks completed (minutes 2-4): the seeded picks step
        // north, then south, then south — all INTERIOR fine steps, so the
        // island view's coarse position never moves and no energy is charged
        expect(world.events.log().filter((event) => event.kind === 'move').map((event) => ({ message: event.message, time: event.time }))).toEqual([
            { message: 'Ael wanders north.', time: 2 },
            { message: 'Ael wanders south.', time: 3 },
            { message: 'Ael wanders south.', time: 4 },
        ]);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 2, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: 11, y: -2 });
        // The 0.1/min hunger decay ran through all four minutes; no move
        // charge (no tile crossing)
        expect(needs.of('a')).toEqual({ hunger: 20.400000000000006, thirst: 20, energy: 100 });
        // The wanderer re-plans immediately — a fresh 1-minute wander
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', payload: { dx: 1, dy: 0 }, remaining: 1 });
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
        for (let index = 0; index < 56; index++) {
            world.step();
        }
        // The Scale-0 journey: fine steps west across tile (10,3) — 24
        // interior steps from the derived spot {−4,0} then the wrapping step
        // onto (9,3) at minute 10 — then the same walk across (9,3) (wrap at
        // minute 35 onto (8,3)), then north across (8,3) (wrap at minute 44
        // onto (8,2)), the 10-minute gather, and the berry eaten at minute 56
        const moves = world.events.log().filter((event) => event.kind === 'move');
        expect(moves.length).toBe(43);
        expect(moves.filter((event) => event.message === 'Ael walks west.').length).toBe(34);
        expect(moves[0]).toMatchObject({ message: 'Ael walks west.', time: 2 });
        expect(moves[33]).toMatchObject({ message: 'Ael walks west.', time: 35 });
        expect(moves[34]).toMatchObject({ message: 'Ael walks north.', time: 36 });
        expect(moves[42]).toMatchObject({ message: 'Ael walks north.', time: 44 });
        expect(world.events.log().filter((event) => event.kind === 'gather' || event.kind === 'consume').map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'gather', message: 'Ael gathers 1 Berry.', time: 54 },
            { kind: 'consume', message: 'Ael eats 1 Berry.', time: 56 },
        ]);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 8, y: 2, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: 12, y: 8 });
        // Three tile crossings (one per walked tile); hunger 60 at plan
        // time + 0.1/min decay through minute 56, −14 on the eat
        expect(needs.of('a').energy).toBe(97);
        expect(inventory.of('a')).toEqual({ flint: 1 });
        expect(needs.of('a').hunger).toBe(51.599999999999966);
        // Sated (51.6 < 60) — the actor re-plans a wander
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
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
            // Rested past the trigger (32 > 22) — the actor fine-wanders on
            { kind: 'move', message: 'Ael wanders north.', time: 12 },
        ]);
        // The twelfth minute already completed one 1-minute wander task and
        // re-planned the next
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', payload: { dx: 0, dy: 1 }, remaining: 1 });
    });

    it('dropping the wander behaviour mid-run strands idle actors (task list empties)', () => {
        const { world, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 6, 2);
        spawn(world, 'b', 'Bram', 8, 2);
        world.step();
        // Both castaways queued 1-minute wander tasks
        expect(tasks.tasks().map((task) => task.actorId)).toEqual(['a', 'b']);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
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
