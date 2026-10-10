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
import { survivalPlugin } from '../survival/survivalPlugin';
import { sleepPlugin } from '../sleep/sleepPlugin';
import { entityPlugin } from '../entity/entityPlugin';
import type { Actor } from '../../engine/types';

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(x, y), marker: name.slice(0, 1), condition: 'well', profile: { sex: 'male' } };
    return world.spawn(actor);
};

// Full stack with rain disabled so injected water is the only source
const buildStack = (needsOptions: Parameters<typeof needsPlugin>[0] = {}) => {
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    // R6-INTEGRATION — hunger pinned EXPLICITLY at the 0.1/min the ladder
    // pins were calibrated against: these tests prove the ladder MECHANICS
    // (triggers, plans, effects), not the scenario's belly calibration —
    // the default accumulation horizons are pinned where they live
    // (needsPlugin.test.ts + entityPlugin.test.ts), so a recalibration of
    // the human profile never churns the whole ladder suite
    const needs = needsPlugin({ thirstPerMinute: 0, energyPerMinute: 0, hungerPerMinute: 0.1, ...needsOptions });
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

describe('behaviorPlugin — every living thing plans through the ladder', () => {
    /** The stack the creature tests share: the ledger plans the whole
     * coordinate space, not only the castaway registry. */
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

    /** A coordinate-space creature fixture — the birds/boars/sharks
     * plugins' registry pattern (never world.actors). */
    const place = (
        world: ReturnType<typeof createWorld>,
        id: string,
        name: string,
        type: string,
        x: number,
        y: number,
        z = 0,
        state = z > 0 ? 'flying' : 'perched',
    ) => {
        world.coordinates.place({
            id,
            position: position3(x, y, z),
            kind: 'creature',
            type,
            name,
            marker: name.slice(0, 1),
            state,
        });
    };

    it('a perched gull plans through the ladder: the idle filler fine-wanders its tile', () => {
        const { world, tasks } = buildStack();
        // The gull perches on the dry beach (8,2) — the 0.85-era forest (6,2)
        // is an impassable pond now
        place(world, 'bird-1', 'Kiki', 'bird', 8, 2);
        world.step();
        // The behavior tick planned her: the idle wander queued — the same
        // 1-minute move task a castaway gets, keyed by her creature id
        expect(tasks.taskOf('bird-1')).toEqual({
            id: 't-1',
            actorId: 'bird-1',
            behaviour: 'wander',
            kind: 'move',
            label: 'wanders',
            minutes: 1,
            payload: { dx: 0, dy: -1, wander: true },
            total: 1,
            remaining: 1,
        });
        world.step();
        // The wander completed: the gull fine-stepped north INSIDE the tile
        // (the coarse position holds, the fine spot moved from the derived
        // {-7,8} to {-7,7} — the seeded pick ran north, an interior step)
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: 8, y: 2, z: 0 });
        expect(world.subOf('bird-1')).toEqual({ x: -7, y: 7 });
        // The wander is silent — simulation plumbing, not story
        expect(world.events.log().filter((event) => event.kind === 'move')).toEqual([]);
    });

    it('a hungry gull forages: it gathers the cell\u2019s food into its beak-bag and eats it', () => {
        const { world, inventory, needs, tasks } = buildStack();
        // The gull perches on the dry grassland (0,3) — the forest (6,2) is a
        // pond at the 0.8 wetland threshold
        place(world, 'bird-1', 'Kiki', 'bird', 0, 3);
        needs.satisfy('bird-1', { hunger: 45 }); // 65 ≥ 60 — the hunger rung fires
        world.step();
        // No food in the beak, food underfoot — the forage is the tile's
        // SHARED gather job (R6): 10 WORK-minutes for the 'berry' unit at
        // (0,3); the gull's task is a 1-minute beat feeding it
        expect(tasks.taskOf('bird-1')).toEqual({
            id: 't-1',
            actorId: 'bird-1',
            behaviour: 'hunger',
            kind: 'gather',
            label: 'gathers',
            minutes: 1,
            payload: { itemId: 'berry', source: 'berry', beat: true, x: 0, y: 3 },
            total: 1,
            remaining: 1,
        });
        expect(tasks.tileWork.get('tile:0,3:berry')).toEqual({
            key: 'tile:0,3:berry',
            kind: 'berry',
            units: 10,
            progress: 0,
            skill: 'forage',
        });
        for (let index = 0; index < 10; index++) {
            world.step();
        }
        // The forage completed: one berry stands in the beak-bag (the bird
        // carries 2–3 things — the profiles' size, read through the
        // coordinate facet without a registry entry) and the eat is queued
        expect(inventory.of('bird-1')).toEqual({ berry: 1 });
        expect(tasks.taskOf('bird-1')).toMatchObject({ behaviour: 'hunger', kind: 'eat', payload: { itemId: 'berry' }, remaining: 2 });
        for (let index = 0; index < 2; index++) {
            world.step();
        }
        // The berry is eaten (−14 nutrition): the gull sates itself the
        // same way a castaway does — out of the bag
        expect(inventory.of('bird-1')).toEqual({});
        expect(needs.of('bird-1').hunger).toBe(51);
        // The tile's own food went with the forage (the gather takes the
        // first food in stock order — the berry; the standing berry bush is a
        // material, not food, so the forage leaves it in place). The
        // grassland seeds THREE berries now (the abundance tuning) — one was
        // foraged, two stand
        expect(inventory.cellStock(0, 3)).toEqual({ tree: 8, dirt: 1, grass: 1, berry: 2, bush: 1 });
        // Foraging is a solo beat — silent
        expect(world.events.log().filter((event) => event.kind === 'gather' || event.kind === 'consume')).toEqual([]);
    });

    it('flyers keep their own scripts; the water realm declines an idle ladder', () => {
        const { world, tasks } = buildStack();
        // Kiki glides at z 2 — airborne, the birds plugin owns every minute
        place(world, 'bird-1', 'Kiki', 'bird', 6, 2, 2, 'flying-2');
        // Finn swims the shallows — an impassable cell, the sharks plugin's
        // realm. The water realm IS planned now (the non-travel rungs serve
        // it), but with needs frozen every rung declines: no wander filler
        // on water, no hunger, no rest — the gull's altitude band stays the
        // facet state and the shark stays where its swim script put it
        place(world, 'shark-1', 'Finn', 'shark', -12, -8, 0, 'swimming');
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        // No ledger tasks for either
        expect(tasks.taskOf('bird-1')).toBeUndefined();
        expect(tasks.taskOf('shark-1')).toBeUndefined();
        expect(world.coordinates.entryOf('bird-1')?.state).toBe('flying-2');
    });

    it('a hungry shark hunts the fish underfoot: the water realm\u2019s non-travel rungs serve it', () => {
        const { world, inventory, needs, tasks } = buildStack();
        // Finn swims the shallows (−12,−8) — an impassable cell, the
        // sharks plugin's realm
        place(world, 'shark-1', 'Finn', 'shark', -12, -8, 0, 'swimming');
        world.step();
        // The idle minute belongs to the swim script: the wander filler
        // declines on the water realm, no rung fires
        expect(tasks.taskOf('shark-1')).toBeUndefined();
        needs.satisfy('shark-1', { hunger: 55 }); // 65 ≥ 60 — the hunger rung fires
        world.step();
        // Fish underfoot (every water cell stocks them) — the hunt is the
        // tile's shared gather job (R6): 10 work-minutes on the 'fish' unit
        // at (−12,−8); the shark's task is a 1-minute beat
        expect(tasks.taskOf('shark-1')).toEqual({
            id: 't-1',
            actorId: 'shark-1',
            behaviour: 'hunger',
            kind: 'gather',
            label: 'gathers',
            minutes: 1,
            payload: { itemId: 'fish', source: 'fish', beat: true, x: -12, y: -8 },
            total: 1,
            remaining: 1,
        });
        expect(tasks.tileWork.get('tile:-12,-8:fish')).toEqual({
            key: 'tile:-12,-8:fish',
            kind: 'fish',
            units: 10,
            progress: 0,
            skill: 'forage',
        });
        for (let index = 0; index < 10; index++) {
            world.step();
        }
        // The fish is in the gullet-bag; the eat is queued (the ten beats
        // consumed task ids t-1…t-10)
        expect(inventory.of('shark-1')).toEqual({ fish: 1 });
        expect(tasks.taskOf('shark-1')).toEqual({
            id: 't-11',
            actorId: 'shark-1',
            behaviour: 'hunger',
            kind: 'eat',
            label: 'eats',
            minutes: 2,
            payload: { itemId: 'fish' },
            total: 2,
            remaining: 2,
        });
        for (let index = 0; index < 2; index++) {
            world.step();
        }
        // Eaten: −26 nutrition (75 − 26), the bag empty, the swim resumes
        expect(needs.of('shark-1')).toEqual({ hunger: 49, thirst: 20, energy: 100, health: 100 });
        expect(inventory.of('shark-1')).toEqual({});
        expect(tasks.taskOf('shark-1')).toBeUndefined();
    });

    it('a thirsty bird afloat declines the water trek — no mill pin on the open sea', () => {
        const { world, needs, tasks } = buildStack();
        // Kiki floats on the shallows — a water-realm body
        place(world, 'bird-1', 'Kiki', 'bird', -12, -8);
        needs.satisfy('bird-1', { thirst: 60 }); // 70 ≥ 65 — thirsty, afloat
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        // No bag water, no pool on a sea column, and NO ground travel from
        // the water realm (the wrap needs dry land): the thirst ladder
        // declines entirely. Without the realm guard the travel fallback
        // would mill fine steps inside the water tile every minute — a
        // busy body forever, the birds plugin's takeoff gate never
        // re-opening, the gull pinned afloat to die of thirst.
        expect(tasks.taskOf('bird-1')).toBeUndefined();
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: -12, y: -8, z: 0 });
    });

    it('a floating tired bird sleeps afloat: the roost declines on water, the slumber takes over', () => {
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ rainChancePerMinute: 0, profiles });
        const needs = needsPlugin({ profiles });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const sleep = sleepPlugin({ needs, tasks });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, sleep],
        });
        // Kiki floats on the shallows at the tired line
        world.coordinates.place({
            id: 'bird-1',
            position: position3(-12, -8),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'perched',
        });
        needs.satisfy('bird-1', { energy: -80 }); // energy 20 ≤ 22
        world.step();
        // The roost declines (no ground travel from the water realm) and
        // the sleep rung takes the minute — the gull dozes on the swell
        expect(tasks.taskOf('bird-1')).toEqual({
            id: 't-1',
            actorId: 'bird-1',
            behaviour: 'sleep',
            kind: 'sleep',
            label: 'sleeps',
            minutes: 45,
            total: 45,
            remaining: 45,
        });
        world.step();
        world.step();
        // The sleep restore rides the PROGRESSED minutes, never the plan
        // minute (the sleep contract — planned at minute M, the first
        // decrement is M+1): minute 1 restored nothing, minutes 2-3
        // restored +1.2 each against the bird profile's −0.05 decay
        expect(needs.of('bird-1').energy).toBe(22.249999999999996);
        expect(tasks.taskOf('bird-1')).toMatchObject({ kind: 'sleep', remaining: 43 });
    });

    it('a tired bird within reach of the woods seeks a roost — the safe sleep in the trees', () => {
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ rainChancePerMinute: 0, profiles });
        const needs = needsPlugin({ profiles });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const sleep = sleepPlugin({ needs, tasks });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, sleep],
        });
        // Kiki perches on Ael's bare beach (−11,0); the grove is four tiles
        // east — within the roost range (the 0.8 basins shifted the treed
        // tiles, so the gull now roosts on the (−8,0) stand)
        world.coordinates.place({
            id: 'bird-1',
            position: position3(-11, 0),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'perched',
        });
        needs.satisfy('bird-1', { energy: -80 }); // energy 20 ≤ 22
        world.step();
        // The roost outranks the sleep rung: the tired bird walks to the
        // trees FIRST — one strict fine step east per minute
        expect(tasks.taskOf('bird-1')).toEqual({
            id: 't-1',
            actorId: 'bird-1',
            behaviour: 'roost',
            kind: 'move',
            label: 'seeks a roost',
            minutes: 1,
            payload: { dx: 1, dy: 0 },
            total: 1,
            remaining: 1,
        });
        // The Scale-0 trek: fine steps at the one-cell-per-minute pace
        // until the bird crosses onto the grove, where the roost gate
        // declines and the sleep rung takes over (the sleep task kind
        // carries the sleep plugin's per-minute restore). The pre-step
        // above was minute 1 — the loop counts world minutes from 2.
        let sleptAt = -1;
        for (let minute = 2; minute <= 130 && sleptAt < 0; minute++) {
            world.step();
            if (tasks.taskOf('bird-1')?.kind === 'sleep') {
                sleptAt = minute;
            }
        }
        expect(sleptAt).toBe(69);
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: -8, y: 0, z: 0 });
        // The gull roosts AMONG the trees (the neighborhood-counted 382-tree
        // stand at (−8,0) — T2's densified edge band; no regrowth rhythm
        // moves it any more; the ecology owns the trees)
        expect(world.cellAt(-8, 0)?.resources).toEqual({ dirt: 1, grass: 1, tree: 382 });
    });

    it('a tired bird already among the trees sleeps there — the roost gate declines on a treed tile', () => {
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ rainChancePerMinute: 0, profiles });
        const needs = needsPlugin({ profiles });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const sleep = sleepPlugin({ needs, tasks });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, sleep],
        });
        // Kiki perches on the forest (6,2) — trees underfoot already
        world.coordinates.place({
            id: 'bird-1',
            position: position3(6, 2),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'perched',
        });
        needs.satisfy('bird-1', { energy: -80 }); // energy 20 ≤ 22
        world.step();
        // The roost is HERE — the sleep rung takes the minute directly
        expect(tasks.taskOf('bird-1')).toEqual({
            id: 't-1',
            actorId: 'bird-1',
            behaviour: 'sleep',
            kind: 'sleep',
            label: 'sleeps',
            minutes: 45,
            total: 45,
            remaining: 45,
        });
        world.step();
        world.step();
        // The per-minute restore applies in the trees like anywhere — and
        // rides the PROGRESSED minutes only (the plan minute restored
        // nothing): two restores of +1.2 against the −0.05 decay
        expect(needs.of('bird-1').energy).toBe(22.249999999999996);
        expect(tasks.taskOf('bird-1')).toMatchObject({ kind: 'sleep', remaining: 43 });
    });

    it('a tired bird with no trees in reach sleeps where it stands', () => {
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ rainChancePerMinute: 0, profiles });
        const needs = needsPlugin({ profiles });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const sleep = sleepPlugin({ needs, tasks });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, sleep],
        });
        world.coordinates.place({
            id: 'bird-1',
            position: position3(-11, 0),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'perched',
        });
        // Cull every grove within the ROOST_RANGE (6 tiles) of the bird:
        // the woods are out of reach for an exhausted gull
        world.canvas.cells.forEach((cell) => {
            if (Math.max(Math.abs(cell.x + 11), Math.abs(cell.y)) <= 6) {
                delete inventory.cellStock(cell.x, cell.y).tree;
            }
        });
        needs.satisfy('bird-1', { energy: -80 }); // energy 20 ≤ 22
        world.step();
        // The roost declines (no grove within the range) — the sleep rung
        // takes the minute on the beach rather than a boundless coastal
        // trek at critical energy
        expect(tasks.taskOf('bird-1')).toMatchObject({ behaviour: 'sleep', kind: 'sleep', minutes: 45 });
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: -11, y: 0, z: 0 });
    });

    it('a boar\u2019s maul stays possible while the ledger drives it: the bite rides the needs sweep', () => {
        // The boar carries no tasks in this stack (no behavior rung fires —
        // needs frozen); the point is the free-mix: creatures planned
        // through the ladder keep their own plugin hooks intact
        const { world, needs, tasks } = buildStack();
        place(world, 'boar-1', 'Tusk', 'boar', 8, 2, 0, 'roaming'); // dry beach — (6,2) is a pond now
        world.step();
        // The grounded boar plans like any dry-land creature — the idle
        // wander fills its minute
        expect(tasks.taskOf('boar-1')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        // Energy untouched by planning itself — only movement charges it
        expect(needs.of('boar-1').energy).toBe(100);
        void world;
    });

    it('a profiled perched gull with no pressing need is NOT planned — the birds plugin owns the perch', () => {
        // WITH the entity profiles mounted, the wander filler exempts
        // flyers: a task queued every minute would keep the birds plugin's
        // busy gate closed forever, and no takeoff roll would ever fire
        // again — the gull pinned to the ground. The perch belongs to the
        // birds plugin (takeoff/hop rolls, the roost recovery); the ledger
        // only takes over for real needs (the forage test above)
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ profiles });
        const needs = needsPlugin({ profiles, thirstPerMinute: 0, energyPerMinute: 0, hungerPerMinute: 0 });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, profiles],
        });
         world.coordinates.place({
             id: 'bird-1',
             position: position3(0, 3), // the dry grassland (the 0.85-era forest (6,2) is a pond now)
             kind: 'creature',
             type: 'bird',
             name: 'Kiki',
             marker: 'K',
             state: 'perched',
         });
         for (let index = 0; index < 3; index++) {
             world.step();
         }
        // No ledger tasks — the gull's idle minutes are the birds plugin's
        expect(tasks.taskOf('bird-1')).toBeUndefined();
        // A HUNGRY gull still gets planned (the need outranks the perch) —
        // the bird profile starts hunger at 10, so +55 reaches the trigger
        needs.satisfy('bird-1', { hunger: 55 }); // 65 ≥ 60
        world.step();
        expect(tasks.taskOf('bird-1')).toMatchObject({ behaviour: 'hunger', kind: 'gather' });
    });
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
        // minute 3: hunger 60 + 6 × 3 = 78, one berry eaten (−14 nutrition).
        // Health stays full — nothing hurt the actor
        expect(needs.of('a')).toEqual({ hunger: 64, thirst: 20, energy: 100, health: 100 });
        expect(inventory.of('a')).toEqual({ berry: 1, flint: 1 });
        // The eat itself is silent — a solo beat, not a story between
        // entities (only the spawn has landed in the log so far)
        expect(world.events.log().map((event) => event.kind)).toEqual(['spawn']);
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
        // Ael starts on the dry grassland (0,3) — the driest patch on the
        // island (the nearest natural water is four tiles by Chebyshev). The
        // pool is two tiles east at (2,3), so the injected pool is the
        // UNIQUE nearest water (the 0.85-era pair (6,2)/(8,2) is wet now —
        // (6,2) is a pond)
        spawn(world, 'a', 'Ael', 0, 3);
        inventory.cellStock(2, 3).water = 1; // the pool is two tiles east
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
        // Minute 2: the derived spot {12,−4} sits ON the east edge, so the
        // first east step WRAPS immediately — Ael flows into the neighbor
        // tile (1,3), and the tile crossing charges the move energy
        world.step();
        expect(world.ticker.elapsed()).toBe(2);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 1, y: 3, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: -12, y: -4 });
        expect(needs.of('a').energy).toBe(99);
        world.step();
        // Minute 3: the NEXT east step stays INSIDE tile (1,3)
        expect(world.ticker.elapsed()).toBe(3);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 1, y: 3, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: -11, y: -4 });
        expect(needs.of('a').energy).toBe(99);
        // The walk is silent — the whole journey stays out of the log
        expect(world.events.log().filter((event) => event.kind === 'move')).toEqual([]);
        // The walk across tile (1,3): 24 more east fine steps, the last one
        // wrapping onto the pool tile (2,3) at minute 27 (a second crossing,
        // a second charge)
        for (let index = 0; index < 24; index++) {
            world.step();
        }
        expect(world.ticker.elapsed()).toBe(27);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 2, y: 3, z: 0 } });
        expect(needs.of('a').energy).toBe(98);
        // On the pool tile the thirst behaviour pivots to the 3-minute
        // COLLECTION — the water goes INTO THE BAG first (nothing recovers
        // straight from the ground), completing at minute 30
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        expect(world.ticker.elapsed()).toBe(30);
        // The pooled water is carried now — the bag holds it, the cell is
        // dry. The cell's own stocks ran their rhythms (the seeded three
        // berries grew to four on the minute-20 pulse — the abundance cap
        // of 5 leaves room)
        expect(inventory.of('a')).toEqual({ water: 1 });
        // The standing berry bush refilled to two on the bush rhythm
        // (minute 25) — it is the standing plant, not the gathered food
        expect(inventory.cellStock(2, 3)).toEqual({ tree: 11, dirt: 1, grass: 1, berry: 4, bush: 2 });
        // The same minute re-plans the 2-minute drink from the bag,
        // completing at minute 32 (−35 thirst relief, the bag empties)
        for (let index = 0; index < 2; index++) {
            world.step();
        }
        expect(world.ticker.elapsed()).toBe(32);
        expect(needs.of('a').thirst).toBe(45);
        expect(inventory.of('a')).toEqual({});
        // 25 east fine steps + the collect + the drink — ALL silent, no
        // move/consume events
        expect(world.events.log().filter((event) => event.kind === 'move' || event.kind === 'consume')).toEqual([]);
        // Sated (45 < 65) — the actor re-plans a wander
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
    });

    it('a blocked wrap is silently re-planned: the fallback walks, the next attempt crosses', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        // Ael starts on the dry grassland (0,3); the pool is two tiles east
        // at (2,3) — the 0.85-era pair (6,2)/(8,2) is wet now
        spawn(world, 'a', 'Ael', 0, 3);
        inventory.cellStock(2, 3).water = 1;
        needs.satisfy('a', { thirst: 60 });
        world.step(); // the east travel task is queued
        // A coordinates-only creature (no actor registry entry) materializes
        // on tile (1,3) EXACTLY on Ael's landing fine spot: the west edge of
        // the neighbor tile, {−12,−4}. The Scale-0 occupancy rule sees it
        // (the coordinate space is the single position registry). The dog is
        // a living thing too — the behavior plugin plans it every minute, so
        // it fine-wanders beside the drama (its own random picks, its own
        // minute of work)
        world.coordinates.place({
            id: 'b',
            position: position3(1, 3),
            kind: 'creature',
            type: 'dog',
            name: 'Bram',
            marker: 'B',
            state: 'well',
        });
        const bramSub = world.subOf('b');
        expect(bramSub).toEqual({ x: 12, y: 3 });
        world.relocateFine('b', -12 - bramSub.x, -4 - bramSub.y);
        expect(world.subOf('b')).toEqual({ x: -12, y: -4 });
        // Minute 2: the east task's completing step lands on the TAKEN spot
        // ({−12,−4} is occupied) — Ael falls back north instead of the wrap.
        // The dog plans its own wander
        world.step();
        expect(world.ticker.elapsed()).toBe(2);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 0, y: 3, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: 12, y: -4 });
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', payload: { dx: 0, dy: -1 } });
        expect(tasks.taskOf('b')).toMatchObject({ kind: 'move', label: 'wanders', payload: { dx: 0, dy: -1 } });
        // Minute 3: the fallback walks — a north fine step inside the tile
        // (no crossing, no charge). The dog's wander lands it one spot north
        // — ONTO Ael's next landing ({−12,−5}) — so the re-planned east wrap
        // is blocked AGAIN and Ael falls back north a second time
        world.step();
        expect(world.ticker.elapsed()).toBe(3);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 0, y: 3, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: 12, y: -5 });
        expect(world.subOf('b')).toEqual({ x: -12, y: -5 });
        expect(needs.of('a').energy).toBe(100);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', payload: { dx: 0, dy: -1 } });
        // Minute 4: the second fallback walks ({12,−6}); the dog wanders off
        // ({−11,−4}) — the east wrap is finally clear and Ael plans it
        world.step();
        expect(world.ticker.elapsed()).toBe(4);
        expect(world.subOf('a')).toEqual({ x: 12, y: -6 });
        expect(world.subOf('b')).toEqual({ x: -11, y: -4 });
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', payload: { dx: 1, dy: 0 } });
        // Minute 5: the east attempt crosses — the actor flows into (1,3)
        // at sub {−12,−6} with the crossing charge. Every step stayed out of
        // the log
        world.step();
        expect(world.ticker.elapsed()).toBe(5);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 1, y: 3, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: -12, y: -6 });
        expect(needs.of('a').energy).toBe(99);
        expect(world.events.log().filter((event) => event.kind === 'move')).toEqual([]);
        // The walk across tile (1,3) from {−12,−6}: 24 more east fine steps
        // (minutes 6–29), then the wrapping step itself onto the pool tile
        // (2,3) at minute 30 (a second crossing, a second charge)
        for (let index = 0; index < 25; index++) {
            world.step();
        }
        expect(world.ticker.elapsed()).toBe(30);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 2, y: 3, z: 0 } });
        expect(needs.of('a').energy).toBe(98);
        // On the pool tile the thirst behaviour pivots to the 3-minute
        // COLLECTION — the water goes INTO THE BAG first (nothing recovers
        // straight from the ground), completing at minute 33
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        expect(world.ticker.elapsed()).toBe(33);
        // The pooled water is carried now — the bag holds it, the cell is
        // dry. The cell's own stocks ran their rhythms (the seeded three
        // berries grew to four on the minute-20 pulse by the collect; the
        // standing berry bush stays in place — it is a material plant, not
        // the gathered food)
        expect(inventory.of('a')).toEqual({ water: 1 });
        expect(inventory.cellStock(2, 3)).toEqual({ tree: 11, dirt: 1, grass: 1, berry: 4, bush: 2 });
        // The same minute re-plans the 2-minute drink from the bag,
        // completing at minute 35 (−35 thirst relief, the bag empties)
        for (let index = 0; index < 2; index++) {
            world.step();
        }
        expect(world.ticker.elapsed()).toBe(35);
        expect(needs.of('a').thirst).toBe(45);
        expect(inventory.of('a')).toEqual({});
        // The whole journey — the blocked wrap, the fallbacks, the two
        // crossings, the collect and the drink — ALL silent, no move or
        // consume events
        expect(world.events.log().filter((event) => event.kind === 'move' || event.kind === 'consume')).toEqual([]);
        // Sated (45 < 65) — the actor re-plans a wander
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
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
        // The TRADE is the story — the exchange and the bond move stay in
        // the log; Bram's own eat and wander stay silent
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
            { kind: 'spawn', message: 'Bram washes ashore.', time: 0 },
            { kind: 'exchange', message: 'Ael and Bram trade: 1 Berry for 1 Shell.', time: 1 },
            { kind: 'relationship', message: 'Ael and Bram grow closer (trading).', time: 1 },
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
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        for (let index = 0; index < 4; index++) {
            world.step();
        }
        // Three wander tasks completed (minutes 2-4): the seeded picks land
        // the fine spot on {-4,8} (derived {-4,7} + the net of three picks) —
        // all fine steps inside the tile, so the island view's coarse
        // position never moves and no energy is charged.
        // Wandering is silent — the log never narrates the filler.
        expect(world.events.log().filter((event) => event.kind === 'move')).toEqual([]);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 8, y: 2, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: -4, y: 8 });
        // The 0.1/min hunger decay ran through all four minutes; no move
        // charge (no tile crossing). Health stays full
        expect(needs.of('a')).toEqual({ hunger: 20.400000000000006, thirst: 20, energy: 100, health: 100 });
        // The wanderer re-plans immediately — a fresh 1-minute wander
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', payload: { dx: 1, dy: 0 }, remaining: 1 });
    });

    it('a hungry actor with no food gathers from the cell it stands on', () => {
        const { world, inventory, needs } = buildStack({});
        // Ael stands on the dry grassland (0,3) — the 0.85-era forest (6,2)
        // is a pond at the lowered 0.8 threshold
        spawn(world, 'a', 'Ael', 0, 3);
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
        // The start cell (0,3): the gathered berry is gone (the gather takes
        // the first food in stock order); the grassland seeds three berries
        // now (the abundance tuning) — two stand beside its few trees, and
        // the standing berry bush stays (a material plant, not the food)
        expect(inventory.cellStock(0, 3)).toEqual({ tree: 8, dirt: 1, grass: 1, berry: 2, bush: 1 });
        // The gather + the eat are silent solo beats
        expect(world.events.log().filter((event) => event.kind === 'gather' || event.kind === 'consume')).toEqual([]);
    });

    it('a thirsty actor collects the pool on its own cell, then drinks from the bag', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 1, -2); // the meadow pool (the 0.85-era (1,-4) is a lake now)
        inventory.cellStock(1, -2).water = 1;
        needs.satisfy('a', { thirst: 50 }); // thirst 70 ≥ 65 → the 3-minute collect first
        world.step();
        // Nothing recovers straight from the ground: the water goes INTO
        // THE BAG first — the collection is the tile's shared 3-work-minute
        // gather job (R6), fed by 1-minute beats; the payout lands on the
        // atomic claim at minute 4 exactly like the old single task
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'collect', label: 'collects water', remaining: 1 });
        expect(tasks.tileWork.get('tile:1,-2:water')).toEqual({
            key: 'tile:1,-2:water',
            kind: 'water',
            units: 3,
            progress: 0,
            skill: 'forage',
        });
        world.step();
        world.step();
        world.step();
        // The collect completed at minute 4: the bag holds the pooled
        // water, the cell is dry
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'drink', remaining: 2 });
        expect(inventory.of('a')).toEqual({ water: 1 });
        expect(inventory.cellStock(1, -2)).toEqual({ tree: 14, dirt: 1, grass: 1, berry: 3 });
        world.step();
        world.step();
        // −35 thirst relief on the completing minute 6, drunk OUT OF THE
        // BAG — the bag empties (hunger 20.6: the 0.1/min decay ran 6
        // minutes). Health stays full
        expect(needs.of('a')).toEqual({ hunger: 20.60000000000001, thirst: 35, energy: 100, health: 100 });
        expect(inventory.of('a')).toEqual({});
        // The collect and the drink are silent — only the spawn has landed
        // in the log
        expect(world.events.log().map((event) => event.kind)).toEqual(['spawn']);
    });

    it('R2: a thirsty castaway on a real lake basin collects, drinks, and draws the fresh water down', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        // Stand ON a genuine lake cell — the 0.8 interior basin that stocks
        // a unit of fresh water on the survey (no pool injection; the basin
        // IS the source, unlike the scattered rain pools above).
        // R4-INTEGRATION — the river now runs through the old (1,−5) shore
        // cell (a passable ford whose water is INEXHAUSTIBLE — never drawn
        // down), so the draw-down proof moves to the lake's (2,−5), the
        // basin cell beside the ford that still stocks the spendable unit
        spawn(world, 'a', 'Ael', 2, -5);
        expect(inventory.cellStock(2, -5).water).toBe(1);
        needs.satisfy('a', { thirst: 50 }); // thirst 70 ≥ the 65 trigger
        world.step();
        // The thirst ladder reads the basin as a water source and plans the
        // beat on the tile's shared 3-work-minute water job (R6 — the
        // fresh water goes into the bag on the atomic claim)
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'thirst', kind: 'collect', label: 'collects water', remaining: 1 });
        world.step();
        world.step();
        world.step();
        // The collect completed at minute 4 — the drink is planned and the
        // basin's standing water is drawn down (the 1 unit is spent)
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'thirst', kind: 'drink', remaining: 2 });
        expect(inventory.cellStock(2, -5).water).toBeUndefined();
        world.step();
        world.step();
        // −35 thirst relief on the completing minute: the drink ran out of
        // the basin's fresh water, thirst 70 → 35
        expect(needs.of('a').thirst).toBe(35);
        expect(inventory.of('a')).toEqual({});
    });

    it('a starving actor travels toward the nearest stocked cell — the regrown shore beats the long trek', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        // Drain EVERY stock (sea fish included), leave a forest berry patch
        // at (8,2) — the only food LEFT ON THE SURVEY. THE EXHAUSTED-SOURCE
        // FIX means the drain does NOT sterilize the island: every cell the
        // survey seeded stays REGROW-ELIGIBLE (the registry outlives the
        // deleted stock keys), so the shore under the trek refills on its
        // own rhythm and the hunger ladder re-targets. (The old pin — a
        // permanently barren island — was the bug.)
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
        // Minutes 1-10: the Scale-0 journey fine-steps west across tile
        // (10,3) — 8 interior steps from the derived spot {−4,0} then the
        // wrapping step onto (9,3) at minute 10 (the crossing charge).
        for (let index = 0; index < 10; index++) {
            world.step();
        }
        expect(world.actors.get('a')).toMatchObject({ position: { x: 9, y: 3, z: 0 } });
        // THE FIX IN ACTION: minute 10 is the coconut rhythm's offset — the
        // beach cell (9,3) the survey seeded regrows its coconut even
        // though the drain deleted the stock key. The nearest stocked cell
        // is now the one UNDERFOOT: the trek to (8,2) gives way to the
        // 10-minute gather (planned minute 10, completing at minute 20)…
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'hunger', kind: 'gather', label: 'gathers' });
        // …and the distant berry patch is never touched
        expect(inventory.cellStock(8, 2).berry).toBe(3);
        // …and the 2-minute eat of the coconut (−18 nutrition) at minute 22
        for (let index = 0; index < 12; index++) {
            world.step();
        }
        expect(needs.of('a').hunger).toBe(44.20000000000003);
        expect(inventory.of('a')).toEqual({ flint: 1 });
        // Minute 56: the sated wander drifts the shore — three tile
        // crossings in all (minutes 10, 26 and 48). Hunger 60 + 0.1/min
        // through minute 56, −18 on the eat. The whole story is silent —
        // not a single move/gather/consume log line.
        for (let index = 0; index < 34; index++) {
            world.step();
        }
        expect(world.events.log().filter((event) => event.kind === 'move' || event.kind === 'gather' || event.kind === 'consume')).toEqual([]);
        expect(world.actors.get('a')).toMatchObject({ position: { x: 9, y: 3, z: 0 } });
        expect(world.subOf('a')).toEqual({ x: 10, y: -4 });
        expect(needs.of('a').energy).toBe(97);
        expect(needs.of('a').hunger).toBe(47.60000000000008);
        // Sated (47.6 < 60) — the actor re-plans a wander
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
    });

    it('the hunger targets are PASSABLE: a hungry beachgoer treks to the fishing shore, never onto the sea fish', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        // Ael stands on the southern waterline (6,5) — dry beach sand
        // (the 25×17 seed-7 island's ring: every cell beyond the passable
        // land is open sea). The only fish live in the shallows just SOUTH
        // of her (6,7) — impassable. If the hunger rung targeted the fish
        // CELL, the body would mill at the waterline aiming at water it can
        // never stand on. R5 turns the fish into a reachable source through
        // its FISHING SHORES: the dry tile (6,6) between her and the shoal
        // is now a food target — one tile south, nearer than the meadow
        // berry at (0,3). The greedy step therefore leads SOUTH to the
        // shore, never INTO (6,7).
        spawn(world, 'a', 'Ael', 6, 5);
        expect(world.cellAt(6, 5).passable).toBe(true);
        expect(world.cellAt(6, 7).passable).toBe(false);
        expect(world.cellAt(0, 3).passable).toBe(true);
        // Drain EVERY loose food + berry bush from every cell: the only
        // food left on the island is the injected pair
        world.canvas.cells.forEach((cell) => {
            const stock = inventory.cellStock(cell.x, cell.y);
            ['berry', 'mushroom', 'fish', 'coconut', 'seaweed', 'bush'].forEach((item) => {
                delete stock[item];
            });
        });
        // The trap: fish stocked ONLY in the impassable shallows
        inventory.cellStock(6, 7).fish = 2;
        // The land food, five tiles west and two north
        inventory.cellStock(0, 3).berry = 2;
        needs.satisfy('a', { hunger: 40 }); // hunger 60 ≥ the 60 trigger
        world.step();
        // The hunger rung prunes the impassable fish CELL from its targets
        // and adds its fishing shore (6,6) instead — the nearest reachable
        // food position, one tile south. The greedy fine step from the
        // (6,5) spawn walks SOUTH toward the shore, one world-minute per
        // Scale-0 step. Without the passability filter the same minute
        // would aim at (6,7) itself — the sea the body can never step into.
        expect(tasks.taskOf('a')).toMatchObject({
            behaviour: 'hunger',
            kind: 'move',
            label: 'travels to food',
            minutes: 1,
            payload: { dx: 0, dy: 1 },
            total: 1,
            remaining: 1,
        });
        // The shallows' fish are untouched — the body works the shore, not the water
        expect(inventory.cellStock(6, 7).fish).toBe(2);
        // The meadow still holds its pair (not needed — the shore is nearer)
        expect(inventory.cellStock(0, 3).berry).toBe(2);
    });

    it('the fishing shore: a hungry actor beside the water fishes the shoal at its feet', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        // Ael stands on the dry beach (6,6) — the fishing shore CARDINAL to
        // the impassable shallows (6,7). R5: dry ground + cardinal-adjacent
        // water stocking fish = the fishery; the body never enters the sea.
        spawn(world, 'a', 'Ael', 6, 6);
        expect(world.cellAt(6, 6).passable).toBe(true);
        expect(world.cellAt(6, 7).passable).toBe(false);
        // Drain EVERY loose food + berry bush from every cell
        world.canvas.cells.forEach((cell) => {
            const stock = inventory.cellStock(cell.x, cell.y);
            ['berry', 'mushroom', 'fish', 'coconut', 'seaweed', 'bush'].forEach((item) => {
                delete stock[item];
            });
        });
        // The shoal at her feet
        inventory.cellStock(6, 7).fish = 2;
        needs.satisfy('a', { hunger: 40 }); // hunger 60 ≥ the 60 trigger
        world.step();
        // The fishing rung beats the trek — the water here already feeds
        expect(tasks.taskOf('a')).toMatchObject({
            behaviour: 'hunger',
            kind: 'fish',
            label: 'fishes',
            minutes: 3,
            payload: { x: 6, y: 7 },
            total: 3,
            remaining: 3,
        });
        // The cast lands at minute 3: one fish in the bag, the shoal down to one
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        expect(inventory.of('a')).toEqual({ fish: 1 });
        expect(inventory.cellStock(6, 7).fish).toBe(1);
        // The body never entered the water — still standing on the shore
        expect(world.actors.get('a')).toMatchObject({ position: { x: 6, y: 6, z: 0 } });
    });

    it('the thirst trek never aims at an impassable basin: water behind a wall is no pool (R4)', () => {
        const { world, inventory, needs, tasks } = buildStack({});
        // Ael stands on the dry forest shoulder (7,2) of the drowned pond
        // (6,2) — the pond stocks a drinking pool, but nobody can stand IN
        // the pond to collect it
        spawn(world, 'a', 'Ael', 7, 2);
        // Drain EVERY water stock from every PASSABLE cell; the impassable
        // pond keeps its pool (and the sea's cells hold no drinking water)
        world.canvas.cells.forEach((cell) => {
            if (cell.passable) {
                delete inventory.cellStock(cell.x, cell.y).water;
            }
        });
        inventory.cellStock(6, 2).water = 3;
        needs.satisfy('a', { thirst: 40 }); // thirst 60 ≥ the trigger
        world.step();
        // The pond is pruned from the pool targets: with no reachable pool
        // the thirst rung DECLINES — the idle wander fills the minute rather
        // than a trek aimed at water behind a wall
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'wander', kind: 'move', label: 'wanders', remaining: 1 });
    });

    it('an exhausted actor rests: the recovery applies once, on completion', () => {
        const { world, needs, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        needs.satisfy('a', { energy: -80 }); // energy 20 ≤ 22 → the 10-minute rest task
        for (let index = 0; index < 12; index++) {
            world.step();
        }
        // The +12 recovery landed on the completing minute (11)
        expect(needs.of('a').energy).toBe(32);
        // The rest and the wandering are silent — only the spawn exists
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
        ]);
        // The twelfth minute already completed one 1-minute wander task and
        // re-planned the next
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', payload: { dx: 0, dy: 1 }, remaining: 1 });
    });

    it('dropping the wander behaviour mid-run strands idle actors (task list empties)', () => {
        const { world, tasks } = buildStack({});
        spawn(world, 'a', 'Ael', 2, 3); // dry meadow — (6,2) is an impassable pond now
        spawn(world, 'b', 'Bram', 8, 2);
        world.step();
        // Both castaways queued 1-minute wander tasks
        expect(tasks.tasks().map((task) => task.actorId)).toEqual(['a', 'b']);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        // Drop the wander module: its queued tasks cancel, actors go idle
        expect(tasks.dropBehaviour('wander')).toBe(true);
        expect(tasks.tasks()).toEqual([]);
        expect(tasks.ledger.behaviours().map((module) => module.id)).toEqual(['thirst', 'hunger', 'roost', 'rest', 'social']);
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

describe('behaviorPlugin — the entity profiles: movement energy per kind', () => {
    /**
     * The profiled stack — entity profiles mounted, so every tile crossing
     * charges the entity's species movement row (attributes-derived) instead
     * of the legacy flat point. Survival mounts too: fleeing runs.
     */
    const buildProfiledStack = () => {
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
        const needs = needsPlugin({ profiles, thirstPerMinute: 0, hungerPerMinute: 0, energyPerMinute: 0 });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const survival = survivalPlugin({ tasks, travelMinutesPerTile: 1 });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, survival],
        });
        return { world, inventory, needs, tasks };
    };

    /** A grounded coordinates-only beast (the survival threat). */
    const beast = (id: string, type: string, x: number, y: number) => ({
        id,
        position: position3(x, y),
        kind: 'creature' as const,
        type,
        name: id,
        marker: id.slice(0, 1),
        state: 'roaming',
    });

    it('a plain walk crossing burns the walk row — Speed 10 is the typical point', () => {
        const { world, inventory, needs } = buildProfiledStack();
        // Ael starts on the dry grassland (0,3); the pool is two tiles east
        // at (2,3) — the 0.85-era pair (6,2)/(8,2) is wet now
        spawn(world, 'a', 'Ael', 0, 3);
        // Ael's derived fine spot (seed 7) sits ON the tile's east edge
        // ({12,−4}) — the FIRST east step wraps, and the wrap is where the
        // charge lands. The species' own decay runs (profile stats override
        // the flat options when profiles are mounted).
        inventory.cellStock(2, 3).water = 1;
        needs.satisfy('a', { thirst: 60 }); // thirst 80 ≥ 65 → the trek east
        world.step(); // minute 1: the east travel task queues
        // Minute 2: the east step {12,−4}→{−12,−4} WRAPS onto (1,3) — the
        // crossing charges the walk row (1 energy) alongside the decay
        world.step();
        expect(needs.of('a').energy).toBe(98.88); // 100 − decay (0.06 × 2) − 1 crossing
        expect(world.actors.get('a')).toMatchObject({ position: { x: 1, y: 3 } });
        world.step(); // minute 3: an interior step inside (1,3) — no crossing
        // The species decay (0.06 × 3 = 0.18) and the one walk crossing
        // (1 energy) ran alongside
        expect(world.actors.get('a')).toMatchObject({ position: { x: 1, y: 3 } });
        expect(needs.of('a').energy).toBe(98.82);
    });

    it('a flee crossing burns the RUN row — panic costs threefold', () => {
        const { world, needs, tasks } = buildProfiledStack();
        spawn(world, 'a', 'Ael', 6, 2);
        // A boar one tile west — within the survival threat range (1). The
        // flee RUNS AWAY (east): the stride relocates a full tile in one
        // minute (the profile's run row)
        world.coordinates.place(beast('boar-1', 'boar', 5, 2));
        world.step(); // minute 1: the flee task queues (priority 60)
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'flees', payload: { flee: true, tx: 7, ty: 2 } });
        world.step(); // minute 2: the stride CROSSES a full tile — the RUN row charges
        expect(world.actors.get('a')).toMatchObject({ position: { x: 7, y: 2 } });
        // The run row: 3 energy a crossing (a walk would have burned 1);
        // the species decay (0.06 × 2 = 0.12) ran alongside
        expect(needs.of('a').energy).toBe(96.88);
        // Minute 3: the stride opened a two-tile gap — the threat scan
        // clears and the wider ladder takes the minute back
        world.step();
        expect(tasks.taskOf('a')?.behaviour).not.toBe('survival');
    });

    it('R4-SAFETY: the thirst trek skips a boar-guarded pool for a clear one, and declines when only a guarded pool remains', () => {
        // nearestSafeWater filters the DESTINATION tile (not the whole route —
        // see the helper's doc). These pins prove the destination filter with
        // the priority-60 flee live: a nearer guarded basin is never aimed at,
        // a clear one is, and with only a guarded basin the rung declines
        // rather than grinding the trek against the flee on the spot.
        const { world, inventory, needs, tasks } = buildProfiledStack();
        spawn(world, 'a', 'Ael', 0, 3);
        // Strip every passable cell's drinking water so the only pools are the
        // two we place (the sea holds no drinkable stock)
        world.canvas.cells.forEach((cell) => {
            if (cell.passable) {
                delete inventory.cellStock(cell.x, cell.y).water;
            }
        });
        needs.satisfy('a', { thirst: 60 }); // thirst 80 ≥ 65 → the trek rung
        // A boar camps beside the NEAR pool (1,3) — within the flee radius (1)
        // of that tile, but two tiles from Ael (so Ael itself is not fleeing)
        inventory.cellStock(1, 3).water = 1;
        world.coordinates.place(beast('boar-1', 'boar', 2, 3));
        world.step();
        // Only the guarded pool exists → the trek DECLINES (wander fills the
        // minute; the body keeps its energy instead of oscillating against the
        // flee — the seed-7 march stall)
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'wander', kind: 'move', label: 'wanders', remaining: 1 });
        // A CLEAR pool opens one tile south at (0,4) — same distance, but no
        // beast within its flee ring. The trek now aims at the clear pool.
        inventory.cellStock(0, 4).water = 1;
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'thirst', kind: 'move', label: 'travels to water', remaining: 1 });
        // No oscillation: over the next minutes the trek never drags Ael into
        // the boar's flee ring (it aims at the CLEAR pool, never the guarded
        // (1,3)) — so the priority-60 flee never fires and the body's energy
        // never collapses against a cancelled trek (the seed-7 grind).
        let fled = false;
        for (let index = 0; index < 12; index++) {
            world.step();
            if (tasks.taskOf('a')?.label === 'flees') {
                fled = true;
            }
            expect(world.actors.get('a')?.position).not.toMatchObject({ x: 1, y: 3 });
        }
        expect(fled).toBe(false);
        expect(needs.of('a').energy).toBeGreaterThan(90);
    });

    it('the behavior ladder carries no autonomous mine rung — the ability gates, conduct comes later', () => {
        const { world, tasks } = buildProfiledStack();
        spawn(world, 'a', 'Ael', 6, 2);
        world.step();
        // The profiles are mounted, humans hold 'mine' — but the behavior
        // plugin registers no mining conduct: the ability gates the
        // inventory's ore takes, the ledger module arrives with the mining
        // feature. The registered slices are the stock survival ladder plus
        // the survival flee and the roost rung.
        expect(tasks.ledger.behaviours().map((module) => module.id)).toEqual([
            'survival', 'thirst', 'hunger', 'roost', 'rest', 'social', 'wander',
        ]);
    });

    it('a full-handed body at the desperation line abandons one unit and forages underfoot; below the line it still declines', () => {
        // THIS TEST ASSEMBLES ITS OWN PROFILED STACK — the no-profile
        // buildStack hands out an INFINITE bag (the capacity gate's
        // profiles-missing fallback) and buildProfiledStack mounts profiles
        // on needs/behavior but NOT the inventory (whose `capacityOf` is the
        // gate the rung reads), so a hand is never "full" in either. Here the
        // profiles go on the INVENTORY (bag size) and the behavior (the
        // ladder) — a human's hand is EXACTLY the 200 WEIGHT the long-march
        // bags were clogged at (R5: capacity is weight, not unit count), and
        // zero decay keeps the line value exact.
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ profiles, rainChancePerMinute: 0 });
        const needs = needsPlugin({ profiles, thirstPerMinute: 0, hungerPerMinute: 0, energyPerMinute: 0 });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior],
        });
        expect(inventory.capacityOf('a')).toBe(200);
        // BOTH bodies stand on the meadow grassland (0,3) — the cell stocks
        // a berry bush beside them (an underfoot forage the hunger rung can
        // pluck) — and BOTH carry the same FULL hand: cargo weighing exactly
        // 200 (shell5 + flint×2 30 + sand30 + dirt25 + grass3 + wood20 +
        // vine6 + stone×2 80 + bush1), nothing edible (the bag clogged by
        // over-fetched goods the sites never take, the food underfoot — the
        // long-march stall).
        spawn(world, 'a', 'Ael', 0, 3);
        spawn(world, 'b', 'Bram', 0, 3);
        inventory.spawnKit('a', { shell: 1, flint: 2, sand: 1, dirt: 1, grass: 1, wood: 1, vine: 1, stone: 2, bush: 1 });
        inventory.spawnKit('b', { shell: 1, flint: 2, sand: 1, dirt: 1, grass: 1, wood: 1, vine: 1, stone: 2, bush: 1 });
        expect(inventory.of('a')).toEqual({ shell: 1, flint: 2, sand: 1, dirt: 1, grass: 1, wood: 1, vine: 1, stone: 2, bush: 1 });
        // A KNOWN forage sits underfoot (the survey's own stand on this
        // cell; pinned explicitly so the gather has its target)
        inventory.cellStock(0, 3).bush = 1;
        // Ael is AT the desperation line (twenty base + seventy — the
        // profiled stack's needs decay at zero, so the line holds); Bram is
        // at the plain hunger trigger (twenty + forty), below the line.
        needs.satisfy('a', { hunger: 70 });
        needs.satisfy('b', { hunger: 40 });
        world.step();
        // Ael: the hunger rung's full-hand decline RELEASES at the
        // desperation line — it abandons ONE unit of cargo (LEAST
        // essential first: the shell heads the abandon order, 5 weight) so
        // the hand drops to 195 and holds room for the berry, then falls
        // through to the underfoot forage — the berry bush beside her is
        // gathered (the beat on the tile's shared 10-work-minute gather job).
        expect(inventory.of('a')).toEqual({ flint: 2, sand: 1, dirt: 1, grass: 1, wood: 1, vine: 1, stone: 2, bush: 1 });
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'hunger', kind: 'gather', label: 'gathers', remaining: 1 });
        // Bram: below the line the decline is INTACT — the hand is left as
        // it was (a starvation does not outrank cargo until the doom line)
        // and the rung declines, so the ledger's filler plans a wander.
        expect(inventory.of('b')).toEqual({ shell: 1, flint: 2, sand: 1, dirt: 1, grass: 1, wood: 1, vine: 1, stone: 2, bush: 1 });
        expect(tasks.taskOf('b')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
    });
});

describe('behaviorPlugin — R6 shared tile gathering', () => {
    /** The PROFILED stack — the 'forage' skill gate is live (the scenario's
     * assembly, scenario/island.ts). Needs decay frozen except hunger so the
     * hunger rung stays pinned. */
    const buildProfiled = () => {
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ profiles, rainChancePerMinute: 0 });
        const needs = needsPlugin({ profiles, thirstPerMinute: 0, energyPerMinute: 0, hungerPerMinute: 0 });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), profiles, inventory, needs, relationship, tasks, behavior],
        });
        return { world, inventory, needs, tasks };
    };

    it('a pre-empted forage leaves its minutes standing — another hand finishes the SAME job', () => {
        const { world, inventory, needs, tasks } = buildProfiled();
        // The meadow grassland (0,3) seeds three berries — the shared job
        // for the tile's 'berry' unit demands 10 work-minutes
        spawn(world, 'a', 'Ael', 0, 3);
        needs.satisfy('a', { hunger: 45 });
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        // Beats completed minutes 2–5: four work-minutes stand in the job
        expect(tasks.tileWork.get('tile:0,3:berry')).toMatchObject({ units: 10, progress: 4 });
        // Ael walks away (a despawn — the harshest pre-emption): the queue
        // cancels, the JOB stays
        world.despawn('a');
        expect(tasks.tileWork.get('tile:0,3:berry')).toMatchObject({ units: 10, progress: 4 });
        // Bram picks the standing forage up — he never restarts it
        spawn(world, 'b', 'Bram', 0, 3);
        needs.satisfy('b', { hunger: 45 });
        world.step(); // minute 6: Bram joins the standing unit
        expect(tasks.taskOf('b')).toMatchObject({ behaviour: 'hunger', kind: 'gather', minutes: 1 });
        expect(tasks.tileWork.get('tile:0,3:berry')).toMatchObject({ progress: 4 });
        // His beats complete minutes 7–12: 4 + 6 = 10 — the claim pays him
        // the berry, and the job is gone
        for (let index = 0; index < 6; index++) {
            world.step();
        }
        expect(inventory.of('b').berry ?? 0).toBe(1);
        // The berry sits in the bag (the eat is planned next minute) and the
        // claimed job is gone — Bram is fooded, so no fresh job re-opens
        expect(tasks.tileWork.get('tile:0,3:berry')).toBeUndefined();
    });

    it('two hands on one berry — the claim pays ONE berry, not two', () => {
        const { world, inventory, needs, tasks } = buildProfiled();
        spawn(world, 'a', 'Ael', 0, 3);
        spawn(world, 'b', 'Bram', 0, 3);
        needs.satisfy('a', { hunger: 45 });
        needs.satisfy('b', { hunger: 45 });
        world.step(); // minute 1: both join the ONE 'berry' job on the tile
        expect(tasks.tileWork.get('tile:0,3:berry')).toMatchObject({ units: 10, progress: 0 });
        // Minutes 2–6: both beats complete every minute → 5 × 2 = 10 — the
        // first beat that reaches 10 claims; the co-worker's same-minute
        // beat lands on the gone unit
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        const berries = (inventory.of('a').berry ?? 0) + (inventory.of('b').berry ?? 0);
        expect(berries).toBe(1);
        // The finished job was claimed; a fresh one may stand at progress 0
        // (the loser re-opens — never a second payout from the same labor)
        expect(tasks.tileWork.get('tile:0,3:berry')?.progress).toBe(0);
    });

    it('the skill gate: a species without forage never opens the gather job', () => {
        const { world, needs, tasks } = buildProfiled();
        // A dog-shaped creature — no stock profile, so no 'forage' ability
        // (the entity registry answers false for unknown species)
        world.coordinates.place({
            id: 'rex',
            position: position3(0, 3),
            kind: 'creature',
            type: 'dog',
            name: 'Rex',
            marker: 'R',
            state: 'perched',
        });
        needs.satisfy('rex', { hunger: 45 });
        world.step();
        // The hunger rung's underfoot gather DECLINES on the skill gate —
        // no beat task and NO tile job opens on the berry cell
        expect(tasks.taskOf('rex')?.kind).not.toBe('gather');
        expect(tasks.tileWork.get('tile:0,3:berry')).toBeUndefined();
    });

    it('a beat completing OFF the committed tile never claims or transfers — the qualified on-tile beat finishes the job', () => {
        const { world, inventory, needs, tasks } = buildProfiled();
        // Ael forages the berry cell (0,3) — three berries on the tile
        spawn(world, 'a', 'Ael', 0, 3);
        needs.satisfy('a', { hunger: 45 });
        // Minute 1 opens the shared 'berry' job; minutes 2–10 bank NINE
        // on-tile work-minutes — the claim is one minute away
        for (let index = 0; index < 10; index++) {
            world.step();
        }
        expect(tasks.tileWork.get('tile:0,3:berry')).toMatchObject({ units: 10, progress: 9 });
        // MID-BEAT DRIFT: the body is relocated to ANOTHER berry cell
        // (0,5 — four berries) while its tenth (0,3) beat is in flight (a
        // gull's drift, a flee stride — the gate reads the COARSE tile)
        world.relocate('a', position3(0, 5));
        world.step(); // minute 11: the in-flight beat completes OFF (0,3)
        // THE ON-TILE GATE — the beat lands NOWHERE: no claim fires, so the
        // (0,3) job keeps its stored progress (9, not claimed), the (0,3)
        // stock stands (3), the WRONG tile (0,5) hands nothing over (4),
        // and the bag stays empty (the bug paid the berry off (0,5)'s stock)
        expect(tasks.tileWork.get('tile:0,3:berry')).toMatchObject({ progress: 9 });
        expect(inventory.cellStock(0, 3).berry ?? 0).toBe(3);
        expect(inventory.cellStock(0, 5).berry ?? 0).toBe(4);
        expect(inventory.of('a').berry ?? 0).toBe(0);
        // Back on the committed tile the qualified beats land again: a
        // respawn (clean queue) joins the STANDING job and its on-tile
        // beat banks the tenth minute — the claim pays from (0,3) itself
        world.despawn('a');
        spawn(world, 'a', 'Ael', 0, 3);
        needs.satisfy('a', { hunger: 45 });
        world.step(); // minute 12: the hunger rung JOINS the standing job
        world.step(); // minute 13: the on-tile beat completes the job
        expect(inventory.of('a').berry ?? 0).toBe(1);
        expect(inventory.cellStock(0, 3).berry ?? 0).toBe(2);
        // The claimed job is gone — and none re-opens: the berry in the
        // bag takes the next plan (the eat rung outranks the forage)
        expect(tasks.tileWork.get('tile:0,3:berry')).toBeUndefined();
    });

    it('the water collect beat obeys the same on-tile gate — a drifted body drinks no pool dry', () => {
        const { world, inventory, needs, tasks } = buildProfiled();
        // The shore pool cell (0,-6) stocks one water unit; the neighbour
        // (1,-6) stocks one too — the wrong-tile victim if the gate missed
        spawn(world, 'a', 'Ael', 0, -6);
        needs.satisfy('a', { thirst: 45 });
        // Minute 1 opens the shared 'water' job (3 work-minutes); minutes
        // 2–3 bank TWO on-tile minutes — the claim is one minute away
        world.step();
        world.step();
        world.step();
        expect(tasks.tileWork.get('tile:0,-6:water')).toMatchObject({ units: 3, progress: 2 });
        // Mid-beat drift to the neighbouring pool
        world.relocate('a', position3(1, -6));
        world.step(); // minute 4: the in-flight beat completes OFF (0,-6)
        // The gate refuses: no claim, the job stands at 2, BOTH pools keep
        // their unit, the bag holds no water
        expect(tasks.tileWork.get('tile:0,-6:water')).toMatchObject({ progress: 2 });
        expect(inventory.cellStock(0, -6).water ?? 0).toBe(1);
        expect(inventory.cellStock(1, -6).water ?? 0).toBe(1);
        expect(inventory.of('a').water ?? 0).toBe(0);
    });

    it('a queued beat whose contributor lacks the forage skill is refused at completion', () => {
        const { world, inventory, tasks } = buildProfiled();
        // A standing berry job on (0,3) — the skilled hands opened it
        tasks.tileWork.open({ key: 'tile:0,3:berry', kind: 'berry', units: 10, skill: 'forage' });
        // Rex the dog (no 'forage' ability) carries an in-flight gather
        // beat ON the tile — the location gate would pass; the SKILL
        // REVALIDATION is what refuses the beat (queued directly: the
        // plan-time gate never lets the dog open one)
        world.coordinates.place({
            id: 'rex',
            position: position3(0, 3),
            kind: 'creature',
            type: 'dog',
            name: 'Rex',
            marker: 'R',
            state: 'perched',
        });
        tasks.ledger.queue('rex', 'hunger', {
            kind: 'gather',
            label: 'gathers',
            minutes: 1,
            payload: { itemId: 'berry', source: 'berry', beat: true, x: 0, y: 3 },
        });
        world.step(); // the pre-queued beat completes — refused by the gate
        expect(tasks.tileWork.get('tile:0,3:berry')).toMatchObject({ progress: 0 });
        expect(inventory.cellStock(0, 3).berry ?? 0).toBe(3);
        expect(inventory.of('rex').berry ?? 0).toBe(0);
    });
});
