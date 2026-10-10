// Tests for the fishing plugin (plugins/fishing/fishingPlugin.ts) — the T6
// focused correction suite: the R3 payment defect regression plus the net
// lifecycle end-to-end (eligibility, work duration, exact material payment
// at the claim, mid-task refusal, lazy timed accrual, collection math,
// autonomous accessibility, reset/dispose).
//
// All facts are pinned on the deterministic seed-7 island (default 25×17):
//   E1 (−5,−7)   the FIRST eligible shore cell (row-major) — a north beach
//                touching fishing water
//   (−4,−4)      a BARE eligible meadow on the river ring (no food, no bush
//                underfoot) — the craft-E2E stage
//   (−7,0)       a second eligible cell (woods beside the river), far from
//                E1 — the net-cap stage
//   (1,−2)(0,3)  inland dry cells — no cardinal fishing-water neighbour
//   (1,−7)       a PASSABLE river ford — fresh basin, refused for nets
//   (−12,−8)     open shallows (impassable) — refused
//   (2,−5)       an impassable lake column — refused
//   (8,2)        a far south beach — the collect agents' perch (13+ tiles
//                from E1: no wander reach within these step budgets)
//
// The stacks assemble the plugin the way the scenario mounts it
// (scenario/island.ts: terrain → profiles → inventory → needs → tasks →
// behavior → fishing) so the rungs plan autonomously; the pacing overrides
// shrink the rhythms so the timed assertions fit a test-sized step budget.
// The collect-clock math below the cap and at the clamped surface follows
// the independently established fraction semantics (Temp/t5-integration
// probe2e: a haul advances the clock by exactly the fish taken and the
// countdown survives; at the cap the clamped surplus re-emerges and the
// stored count never exceeds the ceiling).

import { describe, it, expect } from 'vitest';
import { position3, type Actor } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from '../tasks/tasksPlugin';
import { behaviorPlugin } from '../behavior/behaviorPlugin';
import { entityPlugin } from '../entity/entityPlugin';
import { inventoryRemove } from '../inventory/inventory';
import {
    createFishingPlugin,
    FISHING_BEHAVIOUR_ID,
    FISHING_BRIDGE_ID,
    FISH_NET_BUILD_TASK,
    FISH_NET_COLLECT_TASK,
    FISH_TOOL_TASK,
    NET_MATERIALS,
    type FishingPlugin,
} from './fishingPlugin';

// ── the reference geography (probed once, deterministic for seed 7) ──────────
const E1 = { x: -5, y: -7 }; // first eligible shore cell
const BARE_SHORE = { x: -4, y: -4 }; // bare eligible meadow (craft E2E)
const FAR_SHORE = { x: -7, y: 0 }; // second eligible cell (cap test)

/** The full stack, assembled like the scenario mounts it. The pacing
 * overrides default to the plugin's own declared constants. */
const buildStack = (overrides: Partial<Parameters<typeof createFishingPlugin>[0]> = {}) => {
    const profiles = entityPlugin();
    const inventory = inventoryPlugin({ rainChancePerMinute: 0, profiles });
    const needs = needsPlugin({ profiles, thirstPerMinute: 0, energyPerMinute: 0, hungerPerMinute: 0 });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
    const fishing = createFishingPlugin({
        tasks,
        inventory,
        needs,
        profiles,
        travelMinutesPerTile: 1,
        hungerTrigger: 60,
        ...overrides,
    });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), profiles, inventory, needs, relationship, tasks, behavior, fishing],
    });
    return { world, inventory, needs, tasks, fishing };
};

/** A sentient human fixture — the rungs plan it through the ladder. */
const spawnHuman = (
    world: ReturnType<typeof createWorld>,
    id: string,
    name: string,
    x: number,
    y: number,
): Actor => {
    const actor: Actor = {
        id,
        name,
        kind: 'sentient',
        type: 'human',
        position: position3(x, y),
        marker: name.slice(0, 1),
        condition: 'well',
        profile: { sex: 'male' },
    };
    return world.spawn(actor);
};

describe('fishingPlugin — the constructed net: eligibility and the exact bill', () => {
    it('pins the declared vocabulary — the bill is wood 2 + vine 2 and the default pacing', () => {
        // THE BILL — the payment regression's oracle: the materials are
        // declared with COUNTS, so a one-unit-per-line payment is a defect
        expect(NET_MATERIALS).toEqual([
            { item: 'wood', count: 2 },
            { item: 'vine', count: 2 },
        ]);
        const { fishing } = buildStack();
        expect(fishing.pacing()).toEqual({
            netBuildWork: 20,
            netCollectWork: 5,
            netCatchMinutes: 240,
            netCatchCap: 3,
            maxNets: 4,
        });
    });

    it('pays the FULL declared bill at the claim — nothing before, nothing missing after (R3)', () => {
        // THE DEFAULT PACING BUILD — the reviewer's exact framing: a bag
        // seeded with a SURPLUS (3 wood + 3 vine) makes the consumed count
        // unambiguous. The claim fires on the 20th work-minute (minute 21:
        // the plan opens the job at minute 1, one beat completes per step).
        const { world, inventory, tasks, fishing } = buildStack();
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        inventory.spawnKit('a', { wood: 3, vine: 3 });
        for (let minute = 1; minute <= 20; minute++) {
            world.step();
        }
        // NOTHING was consumed beforehand — the bag still holds the surplus
        // and the net does not exist yet (the labor is banked, not paid)
        expect(fishing.netAt(E1.x, E1.y)).toBeUndefined();
        expect(inventory.of('a')).toEqual({ wood: 3, vine: 3 });
        // The job stands one work-minute from the claim
        expect(tasks.tileWork.get(`tile:${E1.x},${E1.y}:net-build`)).toEqual({
            key: `tile:${E1.x},${E1.y}:net-build`,
            kind: 'net-build',
            units: 20,
            progress: 19,
            skill: 'craft',
        });
        world.step(); // minute 21 — the claim
        // The net rises AND the bag pays the full bill: 3−2 wood, 3−2 vine
        expect(inventory.of('a')).toEqual({ wood: 1, vine: 1 });
        expect(fishing.netAt(E1.x, E1.y)).toEqual({
            x: E1.x,
            y: E1.y,
            stored: 0,
            cap: 3,
            minutesToNext: 240,
            builtAt: 21,
        });
    });

    it('build work takes exactly the declared minutes — the net stands on the last beat', () => {
        // Override pacing: 4 build work-minutes → plan minute 1, beats
        // minutes 2–5, claim ON minute 5 (the bag seeded EXACTLY the bill
        // so the paid-out claim empties it — the count-aware payment drops
        // both keys at zero)
        const { world, inventory, tasks, fishing } = buildStack({ netBuildWork: 4 });
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        inventory.spawnKit('a', { wood: 2, vine: 2 });
        world.step(); // minute 1: the stewardship rung opens the shared job
        expect(tasks.taskOf('a')).toMatchObject({
            behaviour: FISHING_BEHAVIOUR_ID,
            kind: FISH_NET_BUILD_TASK,
            label: 'rigs a fishing net',
            minutes: 1,
        });
        expect(tasks.tileWork.get(`tile:${E1.x},${E1.y}:net-build`)).toEqual({
            key: `tile:${E1.x},${E1.y}:net-build`,
            kind: 'net-build',
            units: 4,
            progress: 0,
            skill: 'craft',
        });
        for (let minute = 2; minute <= 4; minute++) {
            world.step();
        }
        // Mid-build: three beats banked, the bag UNTOUCHED, no net yet
        expect(fishing.netAt(E1.x, E1.y)).toBeUndefined();
        expect(inventory.of('a')).toEqual({ wood: 2, vine: 2 });
        expect(tasks.tileWork.get(`tile:${E1.x},${E1.y}:net-build`)).toMatchObject({ progress: 3 });
        world.step(); // minute 5 — the claim: net rises, the bag empties
        expect(fishing.netAt(E1.x, E1.y)).toEqual({
            x: E1.x,
            y: E1.y,
            stored: 0,
            cap: 3,
            // The catch interval was NOT overridden here — the net opens on
            // the default 240-minute rhythm
            minutesToNext: 240,
            builtAt: 5,
        });
        expect(inventory.of('a')).toEqual({});
    });

    it('accepts dry shore ground touching fishing water and refuses everything else', () => {
        const { fishing, world } = buildStack();
        void world;
        // ELIGIBLE: the north beach touching the shallows, the woods beside
        // the river, the southern shore
        expect(fishing.eligibleAt(E1.x, E1.y)).toBe(true);
        expect(fishing.eligibleAt(FAR_SHORE.x, FAR_SHORE.y)).toBe(true);
        expect(fishing.eligibleAt(10, 3)).toBe(true);
        // INLAND: dry cells with no cardinal fishing-water neighbour
        expect(fishing.eligibleAt(1, -2)).toBe(false);
        expect(fishing.eligibleAt(0, 3)).toBe(false);
        expect(fishing.eligibleAt(0, 5)).toBe(false);
        expect(fishing.eligibleAt(8, 2)).toBe(false);
        // WATER ITSELF: the impassable shallows and the drowned lake
        expect(fishing.eligibleAt(-12, -8)).toBe(false);
        expect(fishing.eligibleAt(2, -5)).toBe(false);
        // THE PASSABLE FORD: fresh-basin biome — the net cannot stand IN
        // the river even where a body may wade it
        expect(fishing.eligibleAt(1, -7)).toBe(false);
    });

    it('respects the island net cap — no second build under maxNets', () => {
        const { world, inventory, fishing } = buildStack({
            netBuildWork: 4,
            netCollectWork: 2,
            netCatchMinutes: 1000,
            maxNets: 1,
        });
        // Ael rigs the island's one net on E1; Bram stands on the far shore
        // with the full bill — the cap refuses his ground
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        inventory.spawnKit('a', { wood: 2, vine: 2 });
        spawnHuman(world, 'b', 'Bram', FAR_SHORE.x, FAR_SHORE.y);
        inventory.spawnKit('b', { wood: 2, vine: 2 });
        for (let minute = 1; minute <= 10; minute++) {
            world.step();
        }
        // One net stands (Ael's); every other cell is capped out, including
        // the netted tile itself, and Bram's bag kept its bill (no claim
        // ran, no partial payment)
        expect(fishing.nets().length).toBe(1);
        expect(fishing.eligibleAt(FAR_SHORE.x, FAR_SHORE.y)).toBe(false);
        expect(fishing.eligibleAt(E1.x, E1.y)).toBe(false);
        expect(inventory.of('b')).toEqual({ wood: 2, vine: 2 });
    });

    it('refuses the claim atomically when the materials drain below the bill mid-build', () => {
        // The bag holds the bill through the whole build, then drops below
        // it JUST before the claim minute: the in-flight beat completes,
        // the claim revalidates the FULL bill and refuses — nothing is
        // paid (no partial wood/vine out of the bag), no net rises.
        const { world, inventory, tasks, fishing } = buildStack();
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        inventory.spawnKit('a', { wood: 3, vine: 3 });
        for (let minute = 1; minute <= 20; minute++) {
            world.step();
        }
        expect(tasks.tileWork.get(`tile:${E1.x},${E1.y}:net-build`)).toMatchObject({ progress: 19 });
        // THE MID-TASK DRAIN — two wood units vanish below the bill
        inventoryRemove(inventory.of('a'), 'wood', 2);
        expect(inventory.of('a')).toEqual({ wood: 1, vine: 3 });
        world.step(); // minute 21 — the claim attempt on the short bag
        // NOTHING landed: no net, no partial payment, and the completed
        // job stays standing with its labor (the failed claim rolls the
        // payout back, the minutes stand)
        expect(fishing.netAt(E1.x, E1.y)).toBeUndefined();
        expect(inventory.of('a')).toEqual({ wood: 1, vine: 3 });
        expect(tasks.tileWork.get(`tile:${E1.x},${E1.y}:net-build`)).toEqual({
            key: `tile:${E1.x},${E1.y}:net-build`,
            kind: 'net-build',
            units: 20,
            progress: 20,
            skill: 'craft',
        });
        // And the rung never re-plans the build on the short bag — the
        // actor falls to the idle filler
        world.step();
        expect(tasks.taskOf('a')?.kind).not.toBe(FISH_NET_BUILD_TASK);
    });

    it('never opens a build without the materials in hand — missing inputs plan nothing', () => {
        const { world, tasks, fishing } = buildStack();
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        for (let minute = 1; minute <= 8; minute++) {
            world.step();
        }
        // No bag, no job, no net — and the actor never queued a build beat
        expect(fishing.netAt(E1.x, E1.y)).toBeUndefined();
        expect(tasks.tileWork.get(`tile:${E1.x},${E1.y}:net-build`)).toBeUndefined();
        expect(tasks.taskOf('a')?.kind).not.toBe(FISH_NET_BUILD_TASK);
    });
});

describe('fishingPlugin — the lazy catch: timed accrual and collection', () => {
    it('banks one fish per interval, up to the cap, with the countdown running below it', () => {
        // Override pacing: interval 10, cap 3. The builder despawns after
        // the claim so NOBODY hauls — the reads are pure clock math.
        const { world, inventory, fishing } = buildStack({
            netBuildWork: 4,
            netCollectWork: 2,
            netCatchMinutes: 10,
            netCatchCap: 3,
        });
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        inventory.spawnKit('a', { wood: 2, vine: 2 });
        for (let minute = 1; minute <= 5; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toMatchObject({ builtAt: 5, stored: 0 });
        world.despawn('a');
        // Minute 9 (4 past the claim): 4/10 of an interval — no fish yet,
        // the countdown reads the exact remainder
        for (let minute = 0; minute < 4; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 0, cap: 3, minutesToNext: 6, builtAt: 5 });
        // Minute 15 (10 past): the FIRST fish banks, the next interval opens
        for (let minute = 0; minute < 6; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 1, cap: 3, minutesToNext: 10, builtAt: 5 });
        // Minute 25: the second fish
        for (let minute = 0; minute < 10; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 2, cap: 3, minutesToNext: 10, builtAt: 5 });
        // Minute 35: the THIRD fish — the cap; the countdown closes
        for (let minute = 0; minute < 10; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 3, cap: 3, minutesToNext: 0, builtAt: 5 });
        // Minute 45: the cap HOLDS — a full weir accrues nothing more
        for (let minute = 0; minute < 10; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 3, cap: 3, minutesToNext: 0, builtAt: 5 });
    });

    it('collection pays what fits, advances the clock by exactly the fish taken, and preserves the fraction', () => {
        const { world, inventory, fishing } = buildStack({
            netBuildWork: 4,
            netCollectWork: 2,
            netCatchMinutes: 10,
            netCatchCap: 3,
        });
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        inventory.spawnKit('a', { wood: 2, vine: 2 });
        for (let minute = 1; minute <= 5; minute++) {
            world.step();
        }
        world.despawn('a');
        // Minute 19: one fish banked, 6 minutes of the next interval run
        for (let minute = 0; minute < 14; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 1, cap: 3, minutesToNext: 6, builtAt: 5 });
        // THE PARTIAL HAUL — Cy's bag weighs 175 (3×40 stone + 25 dirt +
        // 30 sand): exactly ONE 25-weight fish fits. The haul takes that
        // one fish and advances the net's clock by exactly ONE interval —
        // the 6-minute remainder toward the next catch is UNTOUCHED.
        const cy = spawnHuman(world, 'c', 'Cy', 8, 2);
        inventory.spawnKit('c', { stone: 3, dirt: 1, sand: 1 });
        expect(fishing.collect(E1.x, E1.y, cy)).toBe(1);
        expect(inventory.of('c')).toEqual({ stone: 3, dirt: 1, sand: 1, fish: 1 });
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 0, cap: 3, minutesToNext: 6, builtAt: 5 });
        // THE PRESERVED FRACTION RIPENS: exactly 6 minutes later the next
        // fish banks — the hauled-away time was never lost
        for (let minute = 0; minute < 6; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 1, cap: 3, minutesToNext: 10, builtAt: 5 });
        // THE CLAMPED SURFACE: 30 more minutes run the clock to minute 55 —
        // four raw intervals, capped at the visible 3
        for (let minute = 0; minute < 30; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 3, cap: 3, minutesToNext: 0, builtAt: 5 });
        // A haul from the CLAMPED-FULL net (Flo, again exactly one fish of
        // room) pays one fish and the stored count STAYS full — the cap had
        // hidden a surplus interval, which re-emerges instantly
        const flo = spawnHuman(world, 'f', 'Flo', 8, 2);
        inventory.spawnKit('f', { stone: 3, dirt: 1, sand: 1 });
        expect(fishing.collect(E1.x, E1.y, flo)).toBe(1);
        expect(inventory.of('f')).toEqual({ stone: 3, dirt: 1, sand: 1, fish: 1 });
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 3, cap: 3, minutesToNext: 0, builtAt: 5 });
        // THE CAPACITY REFUSAL — Dio's bag is at the full 200: nothing fits,
        // the haul pays nothing and the net (and its clock) stand untouched
        const dio = spawnHuman(world, 'd', 'Dio', 8, 2);
        inventory.spawnKit('d', { stone: 5 });
        expect(fishing.collect(E1.x, E1.y, dio)).toBe(0);
        expect(inventory.of('d')).toEqual({ stone: 5 });
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 3, cap: 3, minutesToNext: 0, builtAt: 5 });
        // THE SUCCESSFUL HAUL — Ela's empty bag takes the WHOLE catch (3),
        // and the clock advances exactly three intervals: the weir reads
        // empty with a fresh full countdown
        const ela = spawnHuman(world, 'e', 'Ela', 8, 2);
        expect(fishing.collect(E1.x, E1.y, ela)).toBe(3);
        expect(inventory.of('e')).toEqual({ fish: 3 });
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 0, cap: 3, minutesToNext: 10, builtAt: 5 });
        // The empty net pays nothing; a non-net tile pays nothing
        expect(fishing.collect(E1.x, E1.y, ela)).toBe(0);
        expect(fishing.collect(1, -2, ela)).toBe(0);
    });

    it('haul work takes exactly the declared minutes — the catch lands on the last collect beat', () => {
        // Override pacing: 2 build work-minutes, 5 collect work-minutes,
        // a 1-minute interval so a fish is banked the moment the net stands
        const { world, inventory, tasks, fishing } = buildStack({
            netBuildWork: 2,
            netCollectWork: 5,
            netCatchMinutes: 1,
            netCatchCap: 3,
        });
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        inventory.spawnKit('a', { wood: 2, vine: 2 });
        for (let minute = 1; minute <= 3; minute++) {
            world.step();
        }
        // The net stands (claim minute 3); the FIRST fish banks one
        // interval later — minute 4
        expect(fishing.netAt(E1.x, E1.y)).toMatchObject({ builtAt: 3, stored: 0 });
        // The empty weir gives the rung nothing — the idle filler wanders
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders' });
        world.step(); // minute 4 — the first fish banks, the rung plans the haul
        expect(fishing.netAt(E1.x, E1.y)).toMatchObject({ stored: 1 });
        // The five collect beats run minutes 5–9 and the fish lands ON the
        // fifth
        expect(tasks.taskOf('a')).toMatchObject({
            behaviour: FISHING_BEHAVIOUR_ID,
            kind: FISH_NET_COLLECT_TASK,
            label: 'hauls the net',
        });
        for (let minute = 5; minute <= 8; minute++) {
            world.step();
        }
        // Four beats banked — the bag is still empty (the payout waits for
        // the claim, not the labor)
        expect(inventory.of('a')).toEqual({});
        world.step(); // minute 9 — the claim: the catch lands
        // The claim hauls the net's WHOLE standing catch: the 1-minute
        // interval stacked six raw minutes by now, capped at 3 — the work
        // DURATION is what this test pins (five beats, no payout before)
        expect(inventory.of('a')).toEqual({ fish: 3 });
    });

    it('hauls autonomously: the rung walks back to the ripe net and banks the catch', () => {
        const { world, inventory, fishing } = buildStack({
            netBuildWork: 4,
            netCollectWork: 2,
            netCatchMinutes: 10,
            netCatchCap: 3,
        });
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        inventory.spawnKit('a', { wood: 2, vine: 2 });
        for (let minute = 1; minute <= 5; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toMatchObject({ builtAt: 5 });
        // The builder's bag is empty (the bill was paid) — she wanders
        // while the weir fills; the stewardship rung pulls her back and
        // the collect beats land the fish (deterministic for seed 7:
        // the haul claim fires on minute 17)
        for (let minute = 6; minute <= 16; minute++) {
            world.step();
            expect(inventory.of('a')).toEqual({});
        }
        world.step(); // minute 17 — the haul
        expect(inventory.of('a')).toEqual({ fish: 1 });
        // The net clock advanced exactly one interval (built 5 + 10 → the
        // countdown reads 8 at minute 17) and the body stood ON the net
        // tile through the claim (the on-tile gate held)
        expect(fishing.netAt(E1.x, E1.y)).toEqual({ x: E1.x, y: E1.y, stored: 0, cap: 3, minutesToNext: 8, builtAt: 5 });
        expect(world.actors.get('a')).toMatchObject({ position: { x: E1.x, y: E1.y, z: 0 } });
    });
});

describe('fishingPlugin — the hungry hand: tools, accessibility, teardown', () => {
    it('crafts the spear through the bridge rung and lands the shore cast end-to-end', () => {
        // The BARE shore (−4,−4): eligible ground beside the river, no food
        // and no bush underfoot — the bridge's craft is the only relief.
        // The default recipe pacing: a 5-minute craft, then the hunger
        // rung's 3-minute cast.
        const { world, inventory, needs, tasks, fishing } = buildStack();
        spawnHuman(world, 'a', 'Ael', BARE_SHORE.x, BARE_SHORE.y);
        inventory.spawnKit('a', { wood: 1, flint: 1 });
        needs.satisfy('a', { hunger: 55 }); // 65 ≥ the 60 trigger
        world.step(); // minute 1: the bridge plans the craft
        expect(tasks.taskOf('a')).toMatchObject({
            behaviour: FISHING_BRIDGE_ID,
            kind: FISH_TOOL_TASK,
            label: 'crafts a spear',
            minutes: 5,
        });
        for (let minute = 2; minute <= 5; minute++) {
            world.step();
        }
        // The craft has NOT applied mid-task — the raw inputs still ride
        expect(inventory.of('a')).toEqual({ wood: 1, flint: 1 });
        world.step(); // minute 6 — the craft applies at completion
        expect(inventory.of('a')).toEqual({ spear: 1 });
        // The hunger rung takes over: the shore cast at the river
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'hunger', kind: 'fish', label: 'fishes' });
        for (let minute = 7; minute <= 8; minute++) {
            world.step();
        }
        expect(inventory.of('a')).toEqual({ spear: 1 });
        world.step(); // minute 9 — the cast lands
        expect(inventory.of('a')).toEqual({ spear: 1, fish: 1 });
        // No net was ever needed — the unlimited water fed the hand
        expect(fishing.nets()).toEqual([]);
    });

    it('refuses the tool craft atomically when the inputs vanish mid-task', () => {
        // The rod recipe (wood + vine — no flint in the bag); the vine is
        // consumed while the craft runs: the completion gate finds the
        // recipe unsatisfiable and NOTHING changes (the minutes were the
        // cost — no partial input loss, no rod)
        const { world, inventory, needs, tasks } = buildStack();
        spawnHuman(world, 'a', 'Ael', BARE_SHORE.x, BARE_SHORE.y);
        inventory.spawnKit('a', { wood: 1, vine: 1 });
        needs.satisfy('a', { hunger: 55 });
        world.step(); // the bridge plans the ROD (spear needs the flint)
        expect(tasks.taskOf('a')).toMatchObject({ kind: FISH_TOOL_TASK, label: 'crafts a rod' });
        inventoryRemove(inventory.of('a'), 'vine', 1);
        expect(inventory.of('a')).toEqual({ wood: 1 });
        for (let minute = 2; minute <= 6; minute++) {
            world.step();
        }
        // The craft refused atomically: the wood never moved, no rod
        expect(inventory.of('a')).toEqual({ wood: 1 });
        expect(tasks.taskOf('a')?.kind).not.toBe(FISH_TOOL_TASK);
    });

    it('reset clears the fishery and dispose drops the rungs', () => {
        const { world, inventory, tasks, fishing } = buildStack({
            netBuildWork: 4,
            netCollectWork: 2,
            netCatchMinutes: 10,
        });
        spawnHuman(world, 'a', 'Ael', E1.x, E1.y);
        inventory.spawnKit('a', { wood: 2, vine: 2 });
        for (let minute = 1; minute <= 5; minute++) {
            world.step();
        }
        expect(fishing.netAt(E1.x, E1.y)).toBeDefined();
        // THE REGENERATION RESET — the nets are keyed to old-map tile
        // addresses: a re-survey wipes them and re-opens the ground
        fishing.reset();
        expect(fishing.nets()).toEqual([]);
        expect(fishing.netAt(E1.x, E1.y)).toBeUndefined();
        expect(fishing.eligibleAt(E1.x, E1.y)).toBe(true);
        // THE DISPOSE — the plugin leaves the ledger: both rungs drop,
        // the nets clear, and the world-less reads refuse
        world.plugins.remove('fishing');
        expect(tasks.ledger.behaviours().map((module) => module.id)).not.toContain(FISHING_BEHAVIOUR_ID);
        expect(tasks.ledger.behaviours().map((module) => module.id)).not.toContain(FISHING_BRIDGE_ID);
        expect(fishing.netAt(E1.x, E1.y)).toBeUndefined();
        expect(fishing.eligibleAt(E1.x, E1.y)).toBe(false);
        // The fishery is inert afterwards: no rung plans a build, no net
        // ever rises again
        for (let minute = 0; minute < 6; minute++) {
            world.step();
        }
        expect(fishing.nets()).toEqual([]);
        expect(tasks.taskOf('a')?.kind).not.toBe(FISH_NET_BUILD_TASK);
    });
});
