// Tests for the farming plugin (plugins/farming/farmingPlugin.ts) — the
// cultivated berry plots: lifecycle, autonomy, the hungry-hand bridge rung,
// the atomic-claim payout discipline and terrain eligibility.
//
// The stack is assembled exactly like the scenario does (scenario/island.ts)
// and driven with the REAL world/task/tile-work APIs (world.step,
// tasks.taskOf, tasks.tileWork, needs.satisfy, inventory.of) — the outcomes
// are fully deterministic (zero needs decay, seeded terrain, no RNG in the
// farming rungs). Sub-step rhythm (engine/world.ts): a task planned during
// minute M's behavior tick first decrements at minute M+1's ledger tick —
// planned at minute 31, a 1-minute beat completes at minute 32.
//
// Pacing is overridden to minute scale (the forest plugin's test pattern):
// mature 30 / regrow 20 / plant 2 / tend 2 / harvest 2 / tend credit 10 /
// 3 berries per harvest / 4 plots max. Every expected value below was
// captured from reference runs and pinned exactly.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from '../tasks/tasksPlugin';
import { behaviorPlugin } from '../behavior/behaviorPlugin';
import { sleepPlugin } from '../sleep/sleepPlugin';
import { survivalPlugin } from '../survival/survivalPlugin';
import { entityPlugin } from '../entity/entityPlugin';
import { createFarmPlugin } from './farmingPlugin';
import type { FarmingPlugin, FarmingPluginOptions } from './farmingPlugin';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import type { Actor } from '../../engine/types';
import type { World } from '../../engine/world';

/** The minute-scale pacing every test shares (the defaults are day-scale). */
const FAST: Omit<FarmingPluginOptions, 'tasks' | 'inventory' | 'needs'> = {
    matureMinutes: 30,
    regrowMinutes: 20,
    plantMinutes: 2,
    tendMinutes: 2,
    harvestMinutes: 2,
    tendAdvanceMinutes: 10,
    berryPerHarvest: 3,
    maxPlots: 4,
};

type Stack = {
    world: World;
    inventory: InventoryPlugin;
    needs: NeedsPlugin;
    tasks: TasksPlugin;
    farming: FarmingPlugin;
};

/**
 * The full plugin stack with farming mounted after behavior (the rungs ride
 * the behavior plugin's every-minute planning sweep — the same dependency
 * the lumber and construction plugins have). Needs decay is pinned to zero
 * so every pressure value in the assertions is exactly what was injected.
 */
const buildStack = (
    farmOverrides: Partial<FarmingPluginOptions> = {},
    mount: { entity?: boolean; survival?: boolean; sleep?: boolean } = {},
): Stack => {
    // With the entity profiles mounted, the human's 200-weight bag becomes
    // the real capacity gate (the capacity test needs it)
    const entity = mount.entity ? entityPlugin() : undefined;
    const inventory = inventoryPlugin({ rainChancePerMinute: 0, profiles: entity });
    const needs = needsPlugin({
        hungerPerMinute: 0,
        thirstPerMinute: 0,
        energyPerMinute: 0,
    });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const farming = createFarmPlugin({
        ...FAST,
        ...farmOverrides,
        tasks,
        inventory,
        needs,
        profiles: entity,
    });
    const plugins = [
        islandTerrainPlugin(),
        inventory,
        needs,
        relationship,
        tasks,
        ...(mount.sleep ? [sleepPlugin({ needs, tasks })] : []),
        behavior,
        ...(mount.survival ? [survivalPlugin({ tasks })] : []),
        farming,
    ];
    const world = createWorld({ seed: 7, tickSize: 1, plugins });
    return { world, inventory, needs, tasks, farming };
};

const spawn = (world: World, id: string, name: string, x: number, y: number): Actor =>
    world.spawn({
        id,
        name,
        kind: 'sentient',
        type: 'human',
        position: position3(x, y),
        marker: name.slice(0, 1),
        condition: 'well',
        profile: { sex: 'male' },
    });

/** A coordinate-space beast fixture (the survival flee's threat read). */
const placeBoar = (world: World, x: number, y: number): void => {
    world.coordinates.place({
        id: 'boar-1',
        position: position3(x, y),
        kind: 'creature',
        type: 'boar',
        name: 'Grunt',
        marker: 'G',
        state: 'rooting',
    });
};

/** The first tile the farm may legally stand on (row-major, deterministic). */
const firstEligible = (world: World, farming: FarmingPlugin) => {
    const cell = world.canvas.cells.find((entry) => farming.eligibleAt(entry.x, entry.y));
    if (!cell) {
        throw new Error('seed 7 must offer at least one eligible farmland tile');
    }
    return cell;
};

/** The second eligible tile (distinct from the first — the cap test). */
const secondEligible = (world: World, farming: FarmingPlugin, notX: number, notY: number) => {
    const cell = world.canvas.cells.find(
        (entry) => (entry.x !== notX || entry.y !== notY) && farming.eligibleAt(entry.x, entry.y),
    );
    if (!cell) {
        throw new Error('seed 7 must offer at least two eligible farmland tiles');
    }
    return cell;
};

describe('farmingPlugin — the plot lifecycle (plant → immature → ripe → harvest → renewed growth)', () => {
    it('a hungry human harvests a ripe plot, eats the crop, and the plot re-fruits', () => {
        // tendMinutes 999: the post-eat idle minutes bank tend labor but the
        // tend job never CLAIMS inside the test, so the regrow timestamp the
        // harvest set stays exactly observable
        const { world, inventory, needs, tasks, farming } = buildStack({ tendMinutes: 999 });
        const bed = firstEligible(world, farming);

        // The god-side plant at minute 0 — the plot stands IMMATURE
        expect(farming.plant(bed.x, bed.y)).toBe(true);
        expect(farming.plotAt(bed.x, bed.y)).toEqual({
            x: bed.x,
            y: bed.y,
            stage: 'immature',
            plantedAt: 0,
            matureAt: 30,
            cycles: 0,
            yieldPerHarvest: 3,
        });

        // Grow the clock WITHOUT anybody on the plot (30 bare minutes)
        for (let index = 0; index < 30; index++) {
            world.step();
        }
        expect(farming.plotAt(bed.x, bed.y)?.stage).toBe('ripe');

        // The hungry hand arrives — no food in the bag, the crop ripe underfoot
        spawn(world, 'a', 'Nia', bed.x, bed.y);
        needs.satisfy('a', { hunger: 45 }); // 20 + 45 = 65 ≥ 60 — the trigger
        world.step(); // minute 31
        // THE HUNGRY-HAND BRIDGE (41): the ordinary hunger rung (40) cannot
        // see the plot — this rung queues the harvest beat on the tile's
        // shared farm-harvest job (2 work-minutes, the forage skill)
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'farm-harvest',
            kind: 'farmHarvest',
            label: 'harvests the plot',
            minutes: 1,
            payload: { x: bed.x, y: bed.y },
            total: 1,
            remaining: 1,
        });
        expect(tasks.tileWork.get(`tile:${bed.x},${bed.y}:farm-harvest`)).toEqual({
            key: `tile:${bed.x},${bed.y}:farm-harvest`,
            kind: 'farm-harvest',
            units: 2,
            progress: 0,
            skill: 'forage',
        });

        world.step(); // minute 32 — beat 1 banks, beat 2 replans
        expect(tasks.tileWork.get(`tile:${bed.x},${bed.y}:farm-harvest`)?.progress).toBe(1);

        world.step(); // minute 33 — beat 2 finishes the job: the atomic claim pays out
        // The berries land in the bag (3 — the whole ripe batch) and the
        // RENEWED GROWTH clock starts: matureAt = 33 + 20, cycles 1
        expect(inventory.of('a')).toEqual({ berry: 3 });
        expect(farming.plotAt(bed.x, bed.y)).toEqual({
            x: bed.x,
            y: bed.y,
            stage: 'immature',
            plantedAt: 0,
            matureAt: 53,
            cycles: 1,
            yieldPerHarvest: 3,
        });
        // The finished job left the ledger (claimed, never duplicated)
        expect(tasks.tileWork.get(`tile:${bed.x},${bed.y}:farm-harvest`)).toBeUndefined();
        // The bag now holds food — the bridge gate closes and the ORDINARY
        // hunger rung takes the minute: eat the berry (−14 nutrition)
        expect(tasks.taskOf('a')).toMatchObject({
            behaviour: 'hunger',
            kind: 'eat',
            payload: { itemId: 'berry' },
            remaining: 2,
        });

        world.step(); // minute 34 — eat counts down
        world.step(); // minute 35 — the berry is consumed
        expect(inventory.of('a')).toEqual({ berry: 2 });
        expect(needs.of('a').hunger).toBe(51); // 65 − 14 — the crop fed the body

        // The renewal matures: at minute 53 the plot fruits again
        for (let index = 0; index < 18; index++) {
            world.step();
        }
        expect(world.ticker.elapsed()).toBe(53);
        expect(farming.plotAt(bed.x, bed.y)).toMatchObject({ stage: 'ripe', cycles: 1 });
    });

    it('autonomy: an idle human plants the island first plot underfoot', () => {
        const { world, tasks, farming } = buildStack();
        const bed = firstEligible(world, farming);
        spawn(world, 'a', 'Nia', bed.x, bed.y);

        world.step(); // minute 1 — the farm rung (12) outranks the wander filler
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'farm',
            kind: 'farmPlant',
            label: 'plants a berry plot',
            minutes: 1,
            payload: { x: bed.x, y: bed.y },
            total: 1,
            remaining: 1,
        });
        expect(tasks.tileWork.get(`tile:${bed.x},${bed.y}:farm-plant`)).toEqual({
            key: `tile:${bed.x},${bed.y}:farm-plant`,
            kind: 'farm-plant',
            units: 2,
            progress: 0,
            skill: 'forage',
        });

        world.step(); // minute 2 — beat 1 banks
        world.step(); // minute 3 — beat 2 claims: the plot is born at minute 3
        expect(farming.plots()).toEqual([
            {
                x: bed.x,
                y: bed.y,
                stage: 'immature',
                plantedAt: 3,
                matureAt: 33,
                cycles: 0,
                yieldPerHarvest: 3,
            },
        ]);
        // A new farm is a world-scale happening — the log line the god-view reads
        const farmEvents = world.events.log().filter((event) => event.kind === 'farm');
        expect(farmEvents).toHaveLength(1);
        expect(farmEvents[0]).toMatchObject({
            actorId: 'a',
            message: `Nia plants a berry plot at (${bed.x}, ${bed.y}).`,
        });
    });

    it('two workers on one ripe plot pay out exactly once, and tending credits growth', () => {
        const { world, inventory, needs, tasks, farming } = buildStack();
        const bed = firstEligible(world, farming);
        expect(farming.plant(bed.x, bed.y)).toBe(true);
        for (let index = 0; index < 30; index++) {
            world.step(); // grow the crop with nobody around
        }

        // A is comfortable (hunger 20 — the routine farm rung still harvests);
        // B is starving (65 — the bridge rung harvests too). Both work ONE job.
        spawn(world, 'a', 'Nia', bed.x, bed.y);
        spawn(world, 'b', 'Cove', bed.x, bed.y);
        needs.satisfy('b', { hunger: 45 });

        world.step(); // minute 31 — both queue harvest beats on the same job
        expect(tasks.tileWork.get(`tile:${bed.x},${bed.y}:farm-harvest`)?.units).toBe(2);
        world.step(); // minute 32 — A banks 1, B banks 2 → B wins the atomic claim
        // ONE batch (3 berries) left the plot — into B's bag only
        expect(inventory.of('b')).toEqual({ berry: 3 });
        expect(farming.plotAt(bed.x, bed.y)).toMatchObject({ matureAt: 52, cycles: 1 });
        world.step(); // minute 33 — B eats, A starts the tend job
        world.step(); // minute 34 — B's eat lands; A's tend job claims (+10 growth)
        // THE NO-DUPLICATION PROOF: 3 berries total ever paid (2 in the bag +
        // 1 eaten); A's bag stayed EMPTY — the shared job never double-payouts
        expect(inventory.of('a')).toEqual({});
        expect(inventory.of('b')).toEqual({ berry: 2 });
        expect(needs.of('b').hunger).toBe(51);
        // THE TEND PAYOUT: the completed pass pulled the fruit 10 minutes
        // earlier (52 → 42) and the cycle count stands at 1
        expect(farming.plotAt(bed.x, bed.y)).toMatchObject({ matureAt: 42, cycles: 1 });
        // The harvest job is gone; the tend job re-opened fresh at minute 34
        expect(tasks.tileWork.get(`tile:${bed.x},${bed.y}:farm-harvest`)).toBeUndefined();
        expect(tasks.tileWork.get(`tile:${bed.x},${bed.y}:farm-tend`)).toEqual({
            key: `tile:${bed.x},${bed.y}:farm-tend`,
            kind: 'farm-tend',
            units: 2,
            progress: 0,
            skill: 'forage',
        });
    });
});

describe('farmingPlugin — eligibility, capacity and the payout discipline', () => {
    it('water, basins, rock and beach ground are all refused', () => {
        const { world, farming } = buildStack();
        const sea = world.canvas.cells.find((cell) => cell.biome === 'ocean');
        const basin = world.canvas.cells.find(
            (cell) => cell.biome === 'lake' || cell.biome === 'pond',
        );
        const rock = world.canvas.cells.find((cell) => cell.biome === 'highland');
        const sand = world.canvas.cells.find((cell) => cell.biome === 'beach');
        const boulders = world.canvas.cells.find((cell) => (cell.carving?.rock.length ?? 0) > 0);
        // The seed-7 fixture pins (these throw loudly if the terrain worker moves them)
        expect(sea).toBeDefined();
        expect(basin).toBeDefined();
        expect(rock).toBeDefined();
        expect(sand).toBeDefined();
        expect(boulders).toBeDefined();

        expect(farming.eligibleAt(sea!.x, sea!.y)).toBe(false); // the sea
        expect(farming.eligibleAt(basin!.x, basin!.y)).toBe(false); // fresh basins
        expect(farming.eligibleAt(rock!.x, rock!.y)).toBe(false); // the highland
        expect(farming.eligibleAt(sand!.x, sand!.y)).toBe(false); // the beach
        // The boulder-carved ground refuses cultivation (the carve read)
        expect(farming.eligibleAt(boulders!.x, boulders!.y)).toBe(false);
        // And the god-side plant obeys the same law
        expect(farming.plant(basin!.x, basin!.y)).toBe(false);
        expect(farming.plots()).toEqual([]);
    });

    it('one plot per tile, and the island-wide cap bounds the density', () => {
        const { world, farming } = buildStack({ maxPlots: 1 });
        const bed = firstEligible(world, farming);
        expect(farming.plant(bed.x, bed.y)).toBe(true);
        // The same tile can never carry a second plot
        expect(farming.plant(bed.x, bed.y)).toBe(false);
        expect(farming.eligibleAt(bed.x, bed.y)).toBe(false);
        // The cap: with one plot standing, no other tile is eligible
        const other = world.canvas.cells.find(
            (cell) => (cell.x !== bed.x || cell.y !== bed.y) && cell.passable && cell.biome === 'meadow',
        );
        if (other) {
            expect(farming.eligibleAt(other.x, other.y)).toBe(false);
        }
        expect(farming.plots()).toHaveLength(1);
    });

    it('a bag with no room for a berry never gets the payout — the finished job rolls back', () => {
        // The entity profiles mount the human's 200-weight carry
        const { world, inventory, needs, tasks, farming } = buildStack({}, { entity: true });
        const bed = firstEligible(world, farming);
        expect(farming.plant(bed.x, bed.y)).toBe(true);
        for (let index = 0; index < 30; index++) {
            world.step();
        }
        const castaway = spawn(world, 'a', 'Nia', bed.x, bed.y);
        // Ten 20-weight logs fill the 200-weight bag exactly — no room for a berry
        inventory.spawnKit(castaway.id, { wood: 10 });
        expect(inventory.capacityOf(castaway.id)).toBe(200);
        needs.satisfy('a', { hunger: 45 }); // 65 — pressed, but the hand is full

        world.step(); // minute 31 — the routine farm rung queues the beat
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'farm', kind: 'farmHarvest' });
        world.step(); // minute 32 — beat 1 banks
        world.step(); // minute 33 — beat 2 claims; the payout REFUSES (room 0) and
        // the finished job returns with its progress (the labor is never lost)
        expect(tasks.tileWork.get(`tile:${bed.x},${bed.y}:farm-harvest`)).toEqual({
            key: `tile:${bed.x},${bed.y}:farm-harvest`,
            kind: 'farm-harvest',
            units: 2,
            progress: 2,
            skill: 'forage',
        });
        // NO free food: the plot stands ripe and unharvested, the bag unchanged
        expect(inventory.of('a')).toEqual({ wood: 10 });
        expect(farming.plotAt(bed.x, bed.y)).toMatchObject({ stage: 'ripe', cycles: 0, matureAt: 30 });
    });

    it('a hungry human CARRING food eats first — the bridge rung never churns the queue', () => {
        const { world, inventory, needs, tasks, farming } = buildStack();
        const bed = firstEligible(world, farming);
        expect(farming.plant(bed.x, bed.y)).toBe(true);
        for (let index = 0; index < 30; index++) {
            world.step();
        }
        const castaway = spawn(world, 'a', 'Nia', bed.x, bed.y);
        inventory.spawnKit(castaway.id, { berry: 1 });
        needs.satisfy('a', { hunger: 45 });
        world.step(); // minute 31
        // The bag already holds food → the 41 bridge declines; the ordinary
        // hunger rung (40) eats (the equal-priority no-churn rule intact)
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'hunger', kind: 'eat' });
    });

    it('reset() wipes the plots for a regenerated map; removePlot drops one', () => {
        const { world, farming } = buildStack();
        const bed = firstEligible(world, farming);
        expect(farming.plant(bed.x, bed.y)).toBe(true);
        expect(farming.plots()).toHaveLength(1);
        // THE REGENERATION HOOK — the scenario calls this beside resurvey()
        farming.reset();
        expect(farming.plots()).toEqual([]);
        expect(farming.plotAt(bed.x, bed.y)).toBeUndefined();
        // The ground is plantable again after the reset
        expect(farming.plant(bed.x, bed.y)).toBe(true);
        expect(farming.removePlot(bed.x, bed.y)).toBe(true);
        expect(farming.removePlot(bed.x, bed.y)).toBe(false);
    });
});

describe('farmingPlugin — the ladder yields to the emergencies and to creatures', () => {
    it('a threat nearby takes the minute and the standing plant job keeps its labor', () => {
        const { world, tasks, farming } = buildStack({ plantMinutes: 5 }, { survival: true });
        const bed = firstEligible(world, farming);
        spawn(world, 'a', 'Nia', bed.x, bed.y);
        world.step(); // minute 1 — the farm rung opens the plant job
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'farm', kind: 'farmPlant' });

        placeBoar(world, bed.x + 1, bed.y); // the flee radius (Chebyshev 1)
        world.step(); // minute 2 — the beat banks its minute, then the flee (60) takes the body
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'survival', kind: 'move' });
        // THE STANDING WORK SURVIVES the interruption (the tile-work rule):
        // one work-minute banked, the job waiting for the farmer's return
        expect(tasks.tileWork.get(`tile:${bed.x},${bed.y}:farm-plant`)?.progress).toBe(1);
    });

    it('thirst (50) takes the minute from the farm rung (12)', () => {
        const { world, needs, tasks, farming } = buildStack({ plantMinutes: 5 });
        const bed = firstEligible(world, farming);
        spawn(world, 'a', 'Nia', bed.x, bed.y);
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'farm' });
        needs.satisfy('a', { thirst: 50 }); // 20 + 50 = 70 ≥ 65 — the thirst trigger
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'thirst' });
    });

    it('night exhaustion — the sleep rung (30) preempts the farm rung (12)', () => {
        const { world, needs, tasks, farming } = buildStack({ plantMinutes: 5 }, { sleep: true });
        const bed = firstEligible(world, farming);
        spawn(world, 'a', 'Nia', bed.x, bed.y);
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'farm' });
        needs.satisfy('a', { energy: -80 }); // 20 ≤ 22 — the emergency nap line
        world.step();
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'sleep', kind: 'sleep' });
    });

    it('creatures never farm: a gull on a ripe plot just wanders', () => {
        const { world, tasks, farming } = buildStack();
        const bed = firstEligible(world, farming);
        expect(farming.plant(bed.x, bed.y)).toBe(true);
        world.coordinates.place({
            id: 'bird-1',
            position: position3(bed.x, bed.y),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'perched',
        });
        for (let index = 0; index < 2; index++) {
            world.step();
        }
        // The farm gates demand kind 'sentient' — the gull keeps the idle filler
        expect(tasks.taskOf('bird-1')).toMatchObject({ behaviour: 'wander' });
    });
});
