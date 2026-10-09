// Tests for the sleep plugin (plugins/sleep/sleepPlugin.ts) — the R4/T6
// DAILY SLEEP QUOTA model. Every scenario assembles the full plugin stack
// exactly like the scenario factory does, then drives it with one-minute
// steps (tickSize 1 — engine sub-stepping).
//
// The model under test:
//   priority-30 'sleep' ledger behaviour shadowing the rest fallback (25);
//   a 360-minute (option-tunable) daily quota per sleep day (06:00→06:00,
//   the shared clock contract src/scenario/dayCycle.ts), preferred window
//   22:00–06:00; the restore rides the needs plugin's recovery service ONE
//   world-minute at a time, only while the sleep task actually PROGRESSES
//   (the plan minute restores nothing; the completing minute restores
//   through the ledger's completion event); a preempted minute counts
//   nothing; unmet quota becomes capped debt at the day rollover and is
//   caught up in bounded daytime chunks.
//
// FLOAT NOTE: multi-step energy accumulations are pinned with
// toBeCloseTo(…, 10) — the per-minute arithmetic is exact, the low-order
// double drift across dozens of accumulations is not hand-derivable
// (single-step pins stay exact).

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from '../tasks/tasksPlugin';
import { behaviorPlugin } from '../behavior/behaviorPlugin';
import { survivalPlugin } from '../survival/survivalPlugin';
import { sleepPlugin } from './sleepPlugin';
import type { EntityProfile, EntityProfiles } from '../entity/entityPlugin';
import type { Actor } from '../../engine/types';

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(x, y), marker: name.slice(0, 1), condition: 'well', profile: { sex: 'male' } };
    return world.spawn(actor);
};

// Full stack WITH the sleep plugin mounted (the scenario order: terrain,
// inventory, needs, relationship, tasks, behavior, sleep). Hunger/thirst
// decay is zeroed so the only hunger/thirst movement is the recovery
// service's own equal charge; the energy decay (0.06/min) runs.
//
// THE QUOTA ISOLATION (options.movementFree) — the nightly-quota tests ask
// for a body whose ONLY energy movement is the 0.06 idle burn: the legacy
// flat movement charge (1 point per tile crossing — needsPlugin's
// LEGACY_MOVE_ENERGY) exhausts a wandering body below the 22 emergency
// line within the first sleep day (around minute 637 on the default
// wander), and the sanctioned emergency nap then legitimately reshapes
// the quota (quota 315 = 360 − 45) before the window ever opens. The
// quota tests pin the WINDOW/quota semantics, so they mount a
// MOVEMENT-FREE PROFILE DOUBLE into the needs plugin (crossings cost 0)
// — scoped to exactly those tests: the early fixtures pin the legacy
// 0.06 burn AND the 1-point crossing and must not change.
const movementFreeProfiles = (): EntityProfiles => {
    // One shared species record — needsPlugin reads only `stats` (the
    // decay rates: hunger/thirst 0 mirror the zeroed fixture, energy 0.06
    // the legacy idle burn, health 0) and `start` (the stock arrival —
    // identical to the profile-less STARTING_STATE). The EMPTY charged
    // set (both rates 0) keeps the recovery service's behavior identical
    // to the zeroed fixture's: nothing charges, nothing caps the restore.
    const profile: EntityProfile = {
        type: 'any',
        kind: 'creature',
        label: 'movement-free double',
        stats: { hunger: 0, thirst: 0, energy: 0.06, health: 0 },
        start: { hunger: 20, thirst: 20, energy: 100, health: 100 },
        attributes: { strength: 5, stamina: 10, speed: 10, dexterity: 5 },
        abilities: [],
        movement: {},
        inventorySize: 200,
    };
    return {
        // The same record answers for every species (the castaway AND the
        // quota test's coordinate-space boar alike)
        profileOf: () => profile,
        // No abilities — the double serves the needs plugin alone, which
        // never reads them
        hasAbility: () => false,
        moveMinutesOf: () => undefined,
        // THE ISOLATION ITSELF — every tile crossing is free
        moveEnergyOf: () => 0,
        inventorySizeOf: () => undefined,
    };
};

const buildStack = (options: { movementFree?: boolean } = {}) => {
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const tasks = tasksPlugin();
    // The tasks handle rides the needs options — the resting-metabolism
    // read (a body mid sleep/rest suspends its awake hunger/thirst decay)
    const needs = needsPlugin({
        hungerPerMinute: 0,
        thirstPerMinute: 0,
        tasks,
        // Only the quota tests ask for the movement-free isolation
        ...(options.movementFree ? { profiles: movementFreeProfiles() } : {}),
    });
    const relationship = relationshipPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const sleep = sleepPlugin({ needs, tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, sleep],
    });
    return { world, inventory, needs, relationship, tasks, behavior, sleep };
};

// DEFAULT rates (hunger 0.1 / thirst 0.15 awake): the sleep minutes
// must suspend that UNEQUAL baseline — the recovery service's equal
// charge is the sleeping minute's whole hunger/thirst spend.
// T5 fix — hoisted to module scope: the "needs ladder outranks the
// slumber" describe referenced it while it was describe-local (the
// ReferenceError `buildMetabolicStack is not defined`).
const buildMetabolicStack = () => {
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const tasks = tasksPlugin();
    const needs = needsPlugin({ tasks });
    const relationship = relationshipPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const sleep = sleepPlugin({ needs, tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, sleep],
    });
    return { world, inventory, needs, tasks, sleep };
};

describe('sleepPlugin', () => {
    it('registers the priority-30 behaviour between the roost and the rest fallback (25)', () => {
        const { tasks } = buildStack();
        expect(tasks.ledger.behaviours().map((module) => ({ id: module.id, priority: module.priority }))).toEqual([
            { id: 'thirst', priority: 50 },
            { id: 'hunger', priority: 40 },
            { id: 'roost', priority: 33 },
            { id: 'sleep', priority: 30 },
            { id: 'rest', priority: 25 },
            { id: 'social', priority: 20 },
            { id: 'wander', priority: 0 },
        ]);
    });

    it('a drained actor sleeps an emergency nap: the restore rides the PROGRESSED minutes', () => {
        const { world, needs, tasks, sleep } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        needs.satisfy('a', { energy: -80 }); // energy 20 ≤ 22 → the emergency nap
        world.step();
        // Minute 1 is the PLAN minute: the 45-minute task queued, but no
        // world minute of sleep has elapsed — NOTHING restored yet (the
        // taskLedger rhythm: planned at minute M, the first decrement is
        // minute M+1). The minute spent only the awake energy decay.
        expect(tasks.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'sleep',
            kind: 'sleep',
            label: 'sleeps',
            minutes: 45,
            total: 45,
            remaining: 45,
        });
        expect(needs.of('a').energy).toBeCloseTo(19.94, 10); // 20 − 0.06
        expect(sleep.accountOf('a')).toEqual({ day: 0, slept: 0, debt: 0 });
        for (let index = 0; index < 4; index++) {
            world.step();
        }
        // Minutes 2-5: one progressed minute each — +1.2 restore against
        // the 0.06 decay, one counted minute each
        expect(needs.of('a').energy).toBeCloseTo(24.5, 10); // 19.94 + 4 × 1.14
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'sleep', remaining: 41 });
        expect(sleep.accountOf('a')).toEqual({ day: 0, slept: 4, debt: 0 });
        for (let index = 0; index < 40; index++) {
            world.step();
        }
        // Minute 45: the task holds with one minute left — 44 restores so far
        expect(needs.of('a').energy).toBeCloseTo(70.1, 10); // 19.94 + 44 × 1.14
        expect(tasks.taskOf('a')?.remaining).toBe(1);
        expect(sleep.accountOf('a')).toEqual({ day: 0, slept: 44, debt: 0 });
        world.step();
        // Minute 46: the sleep task completed — the COMPLETING minute
        // restored through the ledger's completion event (+1.14), then the
        // actor re-planned a wander
        expect(needs.of('a').energy).toBeCloseTo(71.24, 10);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        expect(sleep.accountOf('a')).toEqual({ day: 0, slept: 45, debt: 0 });
        // The whole slumber stays out of the log — dozing off is a solo
        // beat, not a story between entities
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
        ]);
        expect(world.events.log().filter((event) => event.kind === 'sleep')).toEqual([]);
    });

    it('a drained actor keeps sleeping minute after minute until the slumber ends', () => {
        const { world, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        needs.satisfy('a', { energy: -80 });
        world.step();
        // One step: the plan minute — queued but not yet slept
        expect(needs.of('a').energy).toBeCloseTo(19.94, 10);
        expect(tasks.taskOf('a')?.kind).toBe('sleep');
        for (let index = 0; index < 4; index++) {
            world.step();
        }
        // Minute 5: four progressed minutes (energy per step rises 1.14)
        expect(needs.of('a').energy).toBeCloseTo(24.5, 10);
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'sleep', remaining: 41 });
        // Nothing logged across the whole slumber
        expect(world.events.log().filter((event) => event.kind === 'sleep').length).toBe(0);
    });

    it('the nightly quota sleeps a FULL-ENERGY body through the 22:00–06:00 window', () => {
        // QUOTA ISOLATION — movement-free (see movementFreeProfiles): the
        // window semantics pin a body whose only burn is the idle rate
        const { world, needs, tasks, sleep } = buildStack({ movementFree: true });
        spawn(world, 'a', 'Ael', 8, 2);
        // The 10:00 arrival: 719 world minutes of wake walk the clock to
        // 21:59 — the quota is unmet but the window is shut, and the
        // full-energy body never naps
        for (let index = 0; index < 719; index++) {
            world.step();
        }
        expect(needs.of('a').energy).toBeCloseTo(100 - 0.06 * 719, 6); // ~56.86
        expect(tasks.taskOf('a')?.kind).not.toBe('sleep');
        expect(sleep.accountOf('a')).toEqual({ day: 0, slept: 0, debt: 0 });
        world.step(); // minute 720: 22:00 (minuteOfDay 1320) — the window opens
        // The quota is unmet and the window is open: the sleep rung takes
        // the minute AT FULL ENERGY, queueing the whole remaining quota
        // (360 ≤ the 480 minutes left before 06:00)
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'sleep', kind: 'sleep', minutes: 360, remaining: 360 });
        for (let index = 0; index < 2; index++) {
            world.step();
        }
        // Two progressed sleep minutes: two restores (the energy climbs
        // back), two counted minutes
        expect(needs.of('a').energy).toBeGreaterThan(56.86);
        expect(sleep.accountOf('a')).toEqual({ day: 0, slept: 2, debt: 0 });
        // The rest of the night: 358 more minutes fill the quota exactly
        // (the slumber completes at 04:00 — elapsed 1080)
        for (let index = 0; index < 358; index++) {
            world.step();
        }
        expect(sleep.accountOf('a')).toEqual({ day: 0, slept: 360, debt: 0 });
        // Quota met mid-window — the gate declines, the body wakes
        expect(tasks.taskOf('a')?.kind).not.toBe('sleep');
        // 06:00 rollover (minute 1200): a filled quota leaves no debt
        for (let index = 0; index < 120; index++) {
            world.step();
        }
        expect(sleep.accountOf('a')).toEqual({ day: 1, slept: 0, debt: 0 });
    });

    it('an interrupted slumber counts nothing and rolls the shortfall into debt', () => {
        // QUOTA ISOLATION — movement-free (see movementFreeProfiles)
        const { world, needs, tasks, sleep } = buildStack({ movementFree: true });
        spawn(world, 'a', 'Ael', 8, 2);
        // Walk to the window open (22:00, minute 720)
        for (let index = 0; index < 720; index++) {
            world.step();
        }
        expect(tasks.taskOf('a')?.kind).toBe('sleep'); // the night slumber queued
        // THE INTERRUPTION — the god's hand standing in for the danger
        // (a flee, a hunger rung): every queued sleep task is canceled
        // before its first decrement, so NO minute ever progresses. The
        // gate re-opens every minute (quota unmet, window open) and the
        // body re-plans — but a preempted minute is never counted and
        // never restores. The 22:00 slumber itself is pulled BEFORE the
        // loop's first minute: it was planned in minute 720 and would
        // otherwise progress (and count) in minute 721 before the hand
        // reaches it.
        tasks.cancel('a');
        for (let index = 0; index < 480; index++) {
            world.step();
            if (tasks.taskOf('a')?.kind === 'sleep') {
                tasks.cancel('a');
            }
        }
        // Minute 1200 has run: the 06:00 rollover turned the whole unmet
        // quota into debt (capped at one quota) — and nothing was counted
        // through the interrupted night, nothing restored either
        expect(sleep.accountOf('a')).toEqual({ day: 1, slept: 0, debt: 360 });
        expect(needs.of('a').energy).toBeCloseTo(100 - 0.06 * 1200, 6);
        // THE CATCH-UP — the debt drives daytime sleep in bounded 90-minute
        // chunks whatever the clock says
        world.step(); // minute 1201: the catch-up chunk queues (fresh, not yet decremented)
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'sleep', kind: 'sleep', minutes: 90, remaining: 90 });
        expect(sleep.accountOf('a')).toEqual({ day: 1, slept: 0, debt: 360 });
        // …and the catch-up minutes COUNT (the quota first: a full day's
        // 360 fills before the overflow starts paying the debt back)
        for (let index = 0; index < 2; index++) {
            world.step();
        }
        expect(tasks.taskOf('a')?.remaining).toBe(88);
        expect(sleep.accountOf('a')).toEqual({ day: 1, slept: 2, debt: 360 });
    });

    it('an emergency flee preempts the slumber — the interrupted minute counts nothing', () => {
        // QUOTA ISOLATION — movement-free (see movementFreeProfiles): the
        // flee preemption is pinned before any emergency nap can reshape
        // the quota
        const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
        const tasks = tasksPlugin();
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, tasks, profiles: movementFreeProfiles() });
        const relationship = relationshipPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
        const sleep = sleepPlugin({ needs, tasks });
        const survival = survivalPlugin({ tasks, travelMinutesPerTile: 1 });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, sleep, survival],
        });
        spawn(world, 'a', 'Ael', 8, 2);
        for (let index = 0; index < 720; index++) {
            world.step();
        }
        expect(tasks.taskOf('a')?.kind).toBe('sleep'); // the night slumber queued at 22:00
        // A wild boar closes in: the priority-60 flee outranks the sleep
        // rung and pre-empts the queue the very next minute
        const here = world.actors.get('a')?.position ?? position3(0, 0);
        world.coordinates.place({
            id: 'boar-1',
            position: position3(here.x + 1, here.y),
            kind: 'creature',
            type: 'boar',
            name: 'Tusk',
            marker: 'T',
            state: 'roaming',
        });
        world.step();
        // The flee took the minute — the sleep task is gone from the head
        expect(tasks.taskOf('a')?.kind).not.toBe('sleep');
        expect(sleep.accountOf('a').slept).toBe(0);
        // The boar gone, the slumber re-plans (the gate still holds)
        world.coordinates.remove('boar-1');
        world.step();
        expect(tasks.taskOf('a')?.kind).toBe('sleep');
    });

    it('removing the sleep plugin falls back to the instant-rest ladder', () => {
        const { world, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        needs.satisfy('a', { energy: -80 }); // energy 20 ≤ 22
        world.plugins.remove('sleep');
        // The update-on-remove rule: the behaviour is gone AND its queued
        // tasks are cancelled — the actor is idle before any step ran
        expect(tasks.ledger.behaviours().map((module) => module.id)).toEqual(['thirst', 'hunger', 'roost', 'rest', 'social', 'wander']);
        expect(tasks.tasks()).toEqual([]);
        for (let index = 0; index < 11; index++) {
            world.step();
        }
        // The old rest ladder: a 10-minute rest task (no per-minute restore —
        // the +12 recovery lands once, on completion at minute 11, through
        // the needs recovery service)
        expect(needs.of('a').energy).toBeCloseTo(31.34, 10); // 20 − 0.06×11 + 12
        expect(tasks.taskOf('a')).toMatchObject({ kind: 'move', label: 'wanders', remaining: 1 });
        // The instant rest is silent too
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
        ]);
    });

    it('removing sleep mid-slumber cancels the task silently', () => {
        const { world, needs, tasks } = buildStack();
        spawn(world, 'a', 'Ael', 8, 2); // dry beach — (6,2) is an impassable pond now
        needs.satisfy('a', { energy: -80 });
        world.step();
        // One step: the plan minute — queued, nothing restored
        expect(needs.of('a').energy).toBeCloseTo(19.94, 10);
        expect(tasks.taskOf('a')?.kind).toBe('sleep');
        world.plugins.remove('sleep');
        // The sleep task vanished with the behaviour
        expect(tasks.tasks()).toEqual([]);
        for (let index = 0; index < 11; index++) {
            world.step();
        }
        // The tired actor re-plans the rest fallback and recovers the old way
        expect(needs.of('a').energy).toBeCloseTo(31.28, 10); // 19.94 − 0.06×11 + 12
        expect(world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
        ]);
        // Nothing about the cancelled slumber or the fallback rest logged
        expect(world.events.log().filter((event) => event.kind === 'sleep' || event.kind === 'rest').length).toBe(0);
    });
});

describe('sleepPlugin — the resting metabolism and the equal recovery charge', () => {
    // The DEFAULT-rate stack (buildMetabolicStack) is hoisted to module
    // scope above — shared with the "needs ladder outranks the slumber"
    // describe below.

    it('a sleeping minute spends hunger and thirst EQUALLY — the awake baseline is suspended', () => {
        const { world, needs, sleep } = buildMetabolicStack();
        spawn(world, 'a', 'Ael', 8, 2);
        needs.satisfy('a', { energy: -80 }); // 20 ≤ 22 → the emergency nap
        world.step(); // the plan minute: still an AWAKE minute (unequal baseline runs)
        const afterPlan = needs.of('a');
        expect(afterPlan.hunger).toBeCloseTo(20.1, 10); // +0.1 awake hunger
        expect(afterPlan.thirst).toBeCloseTo(20.15, 10); // +0.15 awake thirst
        for (let index = 0; index < 4; index++) {
            world.step();
        }
        const slept = needs.of('a');
        // Four sleep minutes: the baseline did NOT run — the ONLY spend is
        // the recovery charge (1.2 hunger + 1.2 thirst per restored point,
        // 4 restores), EQUAL on both resources
        expect(slept.hunger - afterPlan.hunger).toBeCloseTo(4.8, 10);
        expect(slept.thirst - afterPlan.thirst).toBeCloseTo(4.8, 10);
        expect(sleep.accountOf('a').slept).toBe(4);
    });

    it('the recovery service charges equal hunger/thirst, caps at the energy headroom, and refuses an empty resource', () => {
        const { world, needs } = buildMetabolicStack();
        spawn(world, 'a', 'Ael', 8, 2);
        // From energy 90: ten points restore and charge ten hunger + ten thirst
        needs.satisfy('a', { energy: -10 }); // 90
        expect(needs.recovery('a', 10)).toBe(10);
        expect(needs.of('a')).toEqual({ hunger: 30, thirst: 30, energy: 100, health: 100 });
        // THE CAP — at the energy headroom the request truncates and the
        // charge equals the ACTUAL restore only
        needs.satisfy('a', { energy: -5 }); // 95
        expect(needs.recovery('a', 10)).toBe(5);
        expect(needs.of('a')).toEqual({ hunger: 35, thirst: 35, energy: 100, health: 100 });
        // THE EMPTY SOURCE — a resource at the 100 line yields no energy
        // and charges nothing (nothing converts from nothing)
        needs.satisfy('a', { energy: -50, hunger: 50 }); // energy 50, hunger 85
        expect(needs.recovery('a', 10)).toBe(10); // room: hunger 15, thirst 65
        expect(needs.of('a').hunger).toBe(95);
        expect(needs.recovery('a', 10)).toBe(5); // hunger headroom runs out mid-restore
        // T5 fix — the energy arithmetic: 50 (before the two restores above)
        // + 10 (line above's actual) + 5 (this call's actual) = 65. The
        // pinned 55 forgot the first restore the test itself asserts.
        expect(needs.of('a')).toEqual({ hunger: 100, thirst: 50, energy: 65, health: 100 });
        expect(needs.recovery('a', 10)).toBe(0); // hunger EMPTY — no gain, no charge
        expect(needs.of('a')).toEqual({ hunger: 100, thirst: 50, energy: 65, health: 100 });
        // A non-positive request is a silent no-op
        expect(needs.recovery('a', 0)).toBe(0);
        expect(needs.recovery('a', -5)).toBe(0);
    });

    it('a species without a pressure is not charged it — the shark pays hunger alone', () => {
        // The legacy flat vocabulary with a rate-0 thirst: the shark's
        // drink is the sea (entityPlugin — "a shark lives IN its drink")
        const needs = needsPlugin({ thirstPerMinute: 0 });
        const world = createWorld({ seed: 7, plugins: [needs] });
        const actor: Actor = { id: 's', name: 'Finn', kind: 'sentient', type: 'human', position: position3(0, 0), marker: 'F', condition: 'well', profile: { sex: 'male' } };
        world.spawn(actor);
        needs.satisfy('s', { energy: -20 }); // 80
        expect(needs.recovery('s', 10)).toBe(10);
        // Hunger charged 1:1; the rate-0 thirst untouched
        expect(needs.of('s')).toEqual({ hunger: 30, thirst: 20, energy: 90, health: 100 });
    });
});

describe('sleepPlugin — the needs ladder outranks the slumber (R4: no sleeping through starvation)', () => {
    it('a hungry sleeper wakes: the hunger rung preempts the slumber the minute the need crosses 60', () => {
        const { world, needs, tasks, sleep, inventory } = buildMetabolicStack();
        spawn(world, 'a', 'Ael', 8, 2);
        // A berry in the bag — the hunger rung's step 1 relieves from the
        // bag, so the wake is pinned to an EAT task, not a terrain-dependent
        // trek
        inventory.spawnKit('a', { berry: 1 });
        needs.satisfy('a', { energy: -80 }); // 20 ≤ 22 → the emergency nap
        world.step(); // the plan minute: the 45-minute nap queued
        expect(tasks.taskOf('a')?.kind).toBe('sleep');
        // Force the hunger trigger over the line: hunger 20.1 + 40 = 60.1 ≥ 60
        needs.satisfy('a', { hunger: 40 });
        world.step();
        // The constant per-minute prioritization: hunger (40) is STRICTLY
        // higher than the sleep rung (30) — the slumber is abandoned
        // mid-work and the eat takes the head. The body seeks the need
        // instead of dozing through it
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'hunger', kind: 'eat', remaining: 2 });
        // The interrupted slumber counted NOTHING — the ledger tick had
        // already progressed the sleep task one minute when the hunger
        // rung took it, and a preempted minute never counts and never
        // restores (the sleep sweep drops the cursor on the lost head)
        expect(sleep.accountOf('a')).toEqual({ day: 0, slept: 0, debt: 0 });
    });

    it('an urgent need preempts a rest mid-work — the interrupted rest pays no recovery', () => {
        // The stack WITHOUT the sleep plugin: the behavior ladder's
        // priority-25 instant-rest fallback is live (the sleep shadow gone)
        const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
        const tasks = tasksPlugin();
        const needs = needsPlugin({ tasks });
        const relationship = relationshipPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior],
        });
        spawn(world, 'a', 'Ael', 8, 2);
        inventory.spawnKit('a', { berry: 1 });
        needs.satisfy('a', { energy: -80 }); // 20 ≤ 22 → the rest rung
        world.step(); // the plan minute: the 10-minute rest queued
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'rest', kind: 'rest', minutes: 10 });
        needs.satisfy('a', { hunger: 40 }); // 60.1 ≥ 60 — the urgent need
        world.step();
        // Constant priority evaluation: hunger (40) outranks rest (25) —
        // the rest task is abandoned mid-work, the eat takes the head
        expect(tasks.taskOf('a')).toMatchObject({ behaviour: 'hunger', kind: 'eat', remaining: 2 });
        // EFFECTS FOLLOW EXECUTION, NEVER PLANNING: the abandoned rest
        // never completed, so its one-shot +12 recovery never landed —
        // the energy carries only the two awake idle burns
        // (multi-step accumulation pinned close — the FLOAT NOTE convention)
        expect(needs.of('a').energy).toBeCloseTo(20 - 0.06 * 2, 10);
    });

    it('every living thing sleeps by the same schedule — a coordinate-space creature fills the nightly quota too', () => {
        // QUOTA ISOLATION — movement-free (see movementFreeProfiles): the
        // double answers for the boar's species too, so the creature's
        // only burn is the idle rate
        const { world, tasks, sleep } = buildStack({ movementFree: true });
        // A wild boar grounded in the coordinate space — the behavior
        // plugin plans it through the same ladder and the sleep rung gates
        // it by the same clock (the sleeping bird/boar/shark rule)
        world.coordinates.place({
            id: 'boar-1',
            position: position3(4, 7),
            kind: 'creature',
            type: 'boar',
            name: 'Tusk',
            marker: 'T',
            state: 'roaming',
        });
        // The 10:00 arrival: 719 wake minutes walk the clock to 21:59 (the
        // rates are zeroed in this fixture, so no rung ever interferes —
        // the ONLY pressure is the window clock)
        for (let index = 0; index < 719; index++) {
            world.step();
        }
        expect(tasks.taskOf('boar-1')?.kind).not.toBe('sleep');
        world.step(); // minute 720: 22:00 — the window opens for the boar too
        // The whole remaining quota queued, exactly like the castaway's
        expect(tasks.taskOf('boar-1')).toMatchObject({ behaviour: 'sleep', kind: 'sleep', minutes: 360, remaining: 360 });
        for (let index = 0; index < 2; index++) {
            world.step();
        }
        // Two progressed slumber minutes counted on the boar's own account
        expect(sleep.accountOf('boar-1')).toEqual({ day: 0, slept: 2, debt: 0 });
    });
});
