// Tests for the needs environment plugin (plugins/needs/needsPlugin.ts).

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { needsPlugin, conditionOf } from './needsPlugin';
import { entityPlugin } from '../entity/entityPlugin';
import type { Actor } from '../../engine/types';

const spawnActor = (world: ReturnType<typeof createWorld>, id = 'a', name = 'Ael') => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(0, 0), marker: name.slice(0, 1), condition: 'well', profile: { sex: 'male' } };
    world.spawn(actor);
    return actor;
};

describe('needsPlugin', () => {
    it('decays needs per minute — three 1-minute steps drift 3 minutes worth', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 7, plugins: [needs] });
        spawnActor(world);
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        // 3 steps × 1 world-minute of per-minute decay — the recalibrated
        // defaults: hunger 100/2880 (a 2-day horizon), thirst 100/1440
        // (a 1-day horizon), −0.06/min energy. Floats pinned from reference.
        // Health stays exactly 100: the reservoir only moves when something
        // hurts the entity, and an unharmed body never regenerates past full
        expect(needs.of('a')).toEqual({
            hunger: 20.104166666666664,
            thirst: 20.20833333333333,
            energy: 99.82,
            health: 100,
        });
    });

    it('decay scales with tick size — an hour tick moves needs 6× a 10-min tick', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 7, tickSize: 60, plugins: [needs] });
        spawnActor(world);
        world.step();
        // 60 world-minutes of the same per-minute rates (the recalibrated
        // 2-day hunger / 1-day thirst horizons)
        expect(needs.of('a')).toEqual({
            hunger: 22.083333333333286,
            thirst: 24.166666666666572,
            energy: 96.39999999999986,
            health: 100,
        });
    });

    it('one hour-long step equals sixty 1-minute steps — the smallest-scale rule', () => {
        // The step size is only a batch: the logic inside always runs one
        // world-minute at a time, so both worlds end in the same state
        const stepped = needsPlugin();
        const hourly = needsPlugin();
        const minuteWorld = createWorld({ seed: 7, tickSize: 1, plugins: [stepped] });
        const hourWorld = createWorld({ seed: 7, tickSize: 60, plugins: [hourly] });
        spawnActor(minuteWorld, 'm');
        spawnActor(hourWorld, 'h');
        for (let index = 0; index < 60; index++) {
            minuteWorld.step();
        }
        hourWorld.step();
        expect(stepped.of('m')).toEqual(hourly.of('h'));
        expect(stepped.of('m')).toEqual({
            hunger: 22.083333333333286,
            thirst: 24.166666666666572,
            energy: 96.39999999999986,
            health: 100,
        });
    });

    it('starting state is a little hungry, not starving — and unharmed', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 7, plugins: [needs] });
        spawnActor(world);
        expect(needs.of('a')).toEqual({ hunger: 20, thirst: 20, energy: 100, health: 100 });
    });

    it('satisfy applies clamped deltas', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 7, plugins: [needs] });
        spawnActor(world);
        // Eating drops hunger — but never below 0
        needs.satisfy('a', { hunger: -50 });
        expect(needs.of('a').hunger).toBe(0);
        // Resting tops energy — never above 100
        needs.satisfy('a', { energy: 50 });
        expect(needs.of('a').energy).toBe(100);
        // A bite wounds health — the reservoir clamps both ways
        needs.satisfy('a', { health: -30 });
        expect(needs.of('a').health).toBe(70);
        needs.satisfy('a', { health: 200 });
        expect(needs.of('a').health).toBe(100);
        // Mid-range values apply exactly
        needs.satisfy('a', { hunger: 20, thirst: 10, energy: -40, health: -20 });
        expect(needs.of('a')).toEqual({ hunger: 20, thirst: 30, energy: 60, health: 80 });
    });

    it('moved charges one extra energy point per cell', () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
        const world = createWorld({ seed: 7, tickSize: 10, plugins: [needs] });
        spawnActor(world);
        needs.moved('a');
        needs.moved('a');
        needs.moved('a');
        expect(needs.of('a').energy).toBe(97);
    });

    it('threshold crossings stay silent — the log is a story teller', () => {
        const needs = needsPlugin();
        const world = createWorld({ seed: 1, tickSize: 10, plugins: [needs] });
        spawnActor(world);
        needs.satisfy('a', { hunger: 48.5 }); // 68.5 — below the 70 threshold
        // Five 10-minute steps at the recalibrated 2-day hunger horizon
        // (100/2880 per minute): 40 minutes lands at 69.89 — still under;
        // the 50-minute mark crosses 70. The exact float ladder is the
        // plugin's per-minute accumulation; only the crossing matters here
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        // No 'needs' event ever lands: a solo state change is simulation,
        // not a story between entities
        expect(world.events.log().filter((event) => event.kind === 'needs')).toEqual([]);
        // The condition ladder still derived weak from the crossing
        expect(world.actors.get('a')?.condition).toBe('weak');
    });

    it('energy collapse crosses silently too', () => {
        // 0.05/min × 10 min = −0.5 energy per tick
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0.05 });
        const world = createWorld({ seed: 1, tickSize: 10, plugins: [needs] });
        spawnActor(world);
        needs.satisfy('a', { energy: -89 }); // 11 — above the 10 collapse line
        world.step(); // 10.5 — still above
        needs.satisfy('a', { energy: -0.4 }); // 10.1 — just above the line
        world.step(); // crossing: decays to 9.6 ≤ 10 during the tick
        // Silent — the collapse is the actor's own state, not a story
        expect(world.events.log().filter((event) => event.kind === 'needs')).toEqual([]);
        expect(world.actors.get('a')?.condition).toBe('critical');
    });

    it('derives the actor condition ladder and mirrors it into the coordinate record', () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
        const world = createWorld({ seed: 1, tickSize: 10, plugins: [needs] });
        const actor = spawnActor(world);
        world.step();
        expect(actor.condition).toBe('well');
        needs.satisfy('a', { hunger: 50 }); // 70 → weak
        world.step();
        expect(actor.condition).toBe('weak');
        // The ascii canvas reads its glyph color from the coordinate record
        expect(world.coordinates.entryOf('a')?.state).toBe('weak');
        needs.satisfy('a', { hunger: 20 }); // 90 → critical
        world.step();
        expect(actor.condition).toBe('critical');
        expect(world.coordinates.entryOf('a')?.state).toBe('critical');
    });

    it('starvation kills after the pinned damage window and despawns the actor', () => {
        // R6 — the deficit drains are per-deficit options; pinning the
        // hunger drain to 5/min reproduces a 20-minute death window
        const needs = needsPlugin({ hungerPerMinute: 2, thirstPerMinute: 0, energyPerMinute: 0, hungerDamagePerMinute: 5 });
        const world = createWorld({ seed: 1, tickSize: 10, plugins: [needs] });
        spawnActor(world);
        for (let index = 0; index < 8; index++) {
            world.step();
        }
        // Hunger hits 100 during step 4 (+2/min × 40 min), the 20-minute
        // damage window (100 / 5 per minute) runs out during step 6
        expect(world.actors.size).toBe(0);
        const messages = world.events.log().map((event) => event.message);
        // Starvation's ENDING is the story: death stays in the log (the
        // threshold pings stay silent)
        expect(messages).toEqual([
            'Ael washes ashore.',
            'Ael is no more.',
            'Ael has died.',
        ]);
    });
});

describe('needsPlugin — every entity carries the survival stats', () => {
    /** The stack the per-type tests share: entity profiles mounted. */
    const buildStack = () => {
        const profiles = entityPlugin();
        // R6 — the DEFAULT deficit drains are now realistic-slow (3.5 / 10
        // in-game days); the creature-death fixture below pins the old
        // 30-minute doom pace explicitly so the short drive stays honest.
        const needs = needsPlugin({
            profiles,
            hungerDamagePerMinute: 100 / 30,
            thirstDamagePerMinute: 100 / 30,
        });
        const world = createWorld({ seed: 7, tickSize: 1, plugins: [needs, profiles] });
        return { world, needs, profiles };
    };

    it('per-type decay rates — a bird metabolism is a fraction of a castaway one', () => {
        const { world, needs } = buildStack();
        spawnActor(world);
        // A bird in the coordinate space (kind creature / type bird — the
        // profile key the per-type resolution reads)
        world.coordinates.place({
            id: 'bird-1',
            position: position3(1, 0, 2),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying-2',
        });
        world.step(); // one world-minute of decay
        // Human: 100/2880 hunger / 100/1440 thirst / −0.06 energy per minute
        // (the recalibrated horizons); bird: 0.02 / 0.03 / −0.05.
        // Health drains nowhere (every stock species carries a 0 drain)
        expect(needs.of('a')).toEqual({ hunger: 20.03472222222222, thirst: 20.069444444444443, energy: 99.94, health: 100 });
        expect(needs.of('bird-1')).toEqual({ hunger: 10.02, thirst: 10.03, energy: 99.95, health: 100 });
    });

    it('per-type starting values — a shark wakes dry-eyed, a boar half-fed', () => {
        const { world, needs } = buildStack();
        world.coordinates.place({
            id: 'shark-1',
            position: position3(-5, 4),
            kind: 'creature',
            type: 'shark',
            name: 'Finn',
            marker: 'F',
            state: 'swimming',
        });
        world.coordinates.place({
            id: 'boar-1',
            position: position3(4, 7),
            kind: 'creature',
            type: 'boar',
            name: 'Tusk',
            marker: 'T',
            state: 'roaming',
        });
        // First touch creates the species' starting state — health full
        // for every species (the reservoir every body wakes unharmed with)
        expect(needs.of('shark-1')).toEqual({ hunger: 10, thirst: 0, energy: 100, health: 100 });
        expect(needs.of('boar-1')).toEqual({ hunger: 30, thirst: 20, energy: 100, health: 100 });
    });

    it('movement charges the profile burn per kind — walking is cheap, running is dear', () => {
        const { world, needs } = buildStack();
        spawnActor(world);
        needs.satisfy('a', { energy: 0 }); // no-op, state materialized
        // Human walk row: 1 energy per crossing — the legacy flat point
        needs.moved('a', 'walk');
        // Run row: 3 energy — fleeing burns threefold
        needs.moved('a', 'run');
        // Swim row: 2 energy
        needs.moved('a', 'swim');
        expect(needs.of('a').energy).toBe(94);
        // A bird crossing the air pays the fly row: 2.5
        world.coordinates.place({
            id: 'bird-1',
            position: position3(0, 0, 2),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying-2',
        });
        needs.moved('bird-1', 'fly');
        expect(needs.of('bird-1').energy).toBe(97.5);
    });

    it('a movement kind the species lacks falls back to its walk row', () => {
        const { world, needs } = buildStack();
        spawnActor(world);
        // A human has no fly row — the cost resolves to the walk row (1)
        needs.moved('a', 'fly');
        expect(needs.of('a').energy).toBe(99);
    });

    it('a creature starved past its health reservoir dies like any castaway', () => {
        const { world, needs } = buildStack();
        world.coordinates.place({
            id: 'bird-1',
            position: position3(0, 0, 0),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'perched',
        });
        // Crank the bird's hunger to the starvation line and hold it there.
        // The reservoir drains 100/30 ≈ 3.33 health per starving minute —
        // thirty minutes at the line is a drained bird
        needs.satisfy('bird-1', { hunger: 80 }); // 90
        for (let index = 0; index < 60; index++) {
            needs.satisfy('bird-1', { hunger: 5 });
            world.step(); // hunger clamps at 100 for a full doom window
        }
        // DEATH AT ZERO — every entity: the bird's health ran dry and the
        // body left the coordinate space (world.despawn only reaches the
        // registry, so the sweep removes the creature directly)
        expect(world.coordinates.entryOf('bird-1')).toBeUndefined();
        const deaths = world.events.log().filter((event) => event.kind === 'death');
        expect(deaths.map((event) => event.message)).toEqual(['Kiki has died.']);
        expect(deaths.map((event) => event.actorId)).toEqual(['bird-1']);
    });

    it('starvation drains health at the pinned pace while the belly stays empty', () => {
        // Pinned hunger drain 5/min → death 20 minutes after the line —
        // the realistic DEFAULT (100/(10×1440)) is tested in the R6
        // horizon suite below; the mechanism (drain-while-at-the-line,
        // regen-while-fed) is what this fixture pins.
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0, hungerDamagePerMinute: 5 });
        const world = createWorld({ seed: 1, tickSize: 1, plugins: [needs] });
        spawnActor(world);
        needs.satisfy('a', { hunger: 80 }); // 100 — AT the line
        world.step(); // first starving minute
        expect(needs.of('a').health).toBe(95);
        world.step();
        expect(needs.of('a').health).toBe(90);
        // A fed belly stops the bleeding: below the line the wounds CLOSE
        needs.satisfy('a', { hunger: -55 }); // 45 — fed again
        world.step();
        expect(needs.of('a').health).toBe(90.2); // +0.2 regen per fed minute
    });

    it('a wounded body heals while hunger and thirst both sit under the belly line', () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
        const world = createWorld({ seed: 1, tickSize: 1, plugins: [needs] });
        spawnActor(world);
        needs.satisfy('a', { health: -40 }); // wounded to 60
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        // 5 fed minutes × 0.2 regen — the belly closes the wounds (floats
        // pinned from the reference stream)
        expect(needs.of('a').health).toBeCloseTo(61, 12);
        // A thirsty body stops healing: the belly line needs BOTH under 50
        needs.satisfy('a', { thirst: 31 }); // 51 — past the belly line
        world.step();
        expect(needs.of('a').health).toBeCloseTo(61, 12); // no healing
    });

    it('a wound below zero kills outright — the bite can be fatal', () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
        const world = createWorld({ seed: 1, tickSize: 1, plugins: [needs] });
        spawnActor(world);
        needs.satisfy('a', { health: -40 }); // 60
        world.step(); // still standing
        expect(world.actors.has('a')).toBe(true);
        needs.satisfy('a', { health: -100 }); // clamped to 0
        world.step(); // the reservoir runs dry
        expect(world.actors.size).toBe(0);
        const messages = world.events.log().map((event) => event.message);
        expect(messages).toEqual([
            'Ael washes ashore.',
            'Ael is no more.',
            'Ael has died.',
        ]);
    });

    it('creature stats never overwrite the coordinate facet — the bird band survives', () => {
        const { world } = buildStack();
        world.coordinates.place({
            id: 'bird-1',
            position: position3(0, 0, 2),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying-2',
        });
        world.step();
        world.step();
        // The altitude band is the facet state — the needs sweep must not
        // re-tag it with a condition
        expect(world.coordinates.entryOf('bird-1')?.state).toBe('flying-2');
    });

    it('stale creature states are pruned after the creature despawns', () => {
        const { world, needs } = buildStack();
        world.coordinates.place({
            id: 'bird-1',
            position: position3(0, 0, 2),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying-2',
        });
        world.step(); // the bird's state exists (10.02 / 10.03 after decay)
        world.coordinates.remove('bird-1'); // the glide past the world's edge
        world.step(); // the sweep prunes what is no longer living
        // Re-touching creates a FRESH state — and a vanished id has no
        // species anymore, so the legacy arrival values prove the bird's
        // decayed state did not survive
        expect(needs.of('bird-1')).toEqual({ hunger: 20, thirst: 20, energy: 100, health: 100 });
    });

    it('without profiles the flat legacy rates apply to every entity', () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 1 });
        const world = createWorld({ seed: 7, tickSize: 1, plugins: [needs] });
        spawnActor(world);
        world.coordinates.place({
            id: 'bird-1',
            position: position3(0, 0, 2),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying-2',
        });
        world.step();
        // Both lose 1 energy: no profiles, one flat vocabulary
        expect(needs.of('a').energy).toBe(99);
        expect(needs.of('bird-1')).toEqual({ hunger: 20, thirst: 20, energy: 99, health: 100 });
    });

    it('recovery restores energy BACKED BY equal hunger/thirst — capped, resource-limited (R4)', () => {
        // DEFAULT rates (0.1 hunger / 0.15 thirst awake) — both resources
        // are in the charge set; no steps run, so the decay never applies.
        // R4 recalibration — the metabolic charge is 0.25 per restored
        // point (rest pays a quarter of its gain, never the day's
        // dominant consumption); the charge stays EQUAL across resources
        // and scales with the ACTUAL restore.
        const needs = needsPlugin();
        const world = createWorld({ seed: 7, plugins: [needs] });
        spawnActor(world);
        // Ten requested points restore ten and charge 2.5 hunger + 2.5 thirst
        needs.satisfy('a', { energy: -10 }); // 90
        expect(needs.recovery('a', 10)).toBe(10);
        expect(needs.of('a')).toEqual({ hunger: 22.5, thirst: 22.5, energy: 100, health: 100 });
        // THE ENERGY CAP — the request truncates at the headroom and the
        // charge equals the ACTUAL restore only (no phantom cost at the cap)
        needs.satisfy('a', { energy: -5, hunger: -10, thirst: -10 }); // 95 / 12.5 / 12.5
        expect(needs.recovery('a', 10)).toBe(5);
        expect(needs.of('a')).toEqual({ hunger: 13.75, thirst: 13.75, energy: 100, health: 100 });
        // THE EMPTY SOURCE — a charged resource at the 100 line yields NO
        // energy and charges nothing (nothing converts from nothing)
        needs.satisfy('a', { energy: -50, hunger: 86.25, thirst: -20 }); // 50 / 100 / 0
        expect(needs.recovery('a', 10)).toBe(0);
        expect(needs.of('a')).toEqual({ hunger: 100, thirst: 0, energy: 50, health: 100 });
        // THE RESOURCE LIMIT — the tighter charged resource truncates the
        // restore: hunger 95 has 5 charge room = 20 restoreable energy
        // (5 / 0.25), so a 10-point request lands fully and charges 2.5.
        needs.satisfy('a', { hunger: -5 }); // 95 / 0
        expect(needs.recovery('a', 10)).toBe(10);
        expect(needs.of('a')).toEqual({ hunger: 97.5, thirst: 2.5, energy: 60, health: 100 });
        // …and the truncation itself: 30 requested against 2.5 charge room
        // (hunger 97.5 → 2.5 headroom → 10 restoreable) caps at 10
        expect(needs.recovery('a', 30)).toBe(10);
        expect(needs.of('a')).toEqual({ hunger: 100, thirst: 5, energy: 70, health: 100 });
        // Non-positive requests are silent no-ops
        expect(needs.recovery('a', 0)).toBe(0);
        expect(needs.recovery('a', -3)).toBe(0);
        expect(needs.of('a').energy).toBe(70);
    });

    it('recovery charges only the pressures the species consumes — a rate-0 resource is free', () => {
        // The legacy flat vocabulary with a rate-0 thirst (the shark's
        // metabolism — it lives in its drink): the charge set is hunger alone
        const needs = needsPlugin({ hungerPerMinute: 0.1, thirstPerMinute: 0, energyPerMinute: 0 });
        const world = createWorld({ seed: 7, plugins: [needs] });
        spawnActor(world);
        needs.satisfy('a', { energy: -10 });
        expect(needs.recovery('a', 10)).toBe(10);
        // Hunger charged at the 0.25 ratio; the rate-0 thirst untouched
        expect(needs.of('a')).toEqual({ hunger: 22.5, thirst: 20, energy: 100, health: 100 });
    });

    it('the exported condition ladder reads the pressure thresholds', () => {
        expect(conditionOf({ hunger: 0, thirst: 0, energy: 100, health: 100 })).toBe('well');
        expect(conditionOf({ hunger: 70, thirst: 0, energy: 100, health: 100 })).toBe('weak');
        expect(conditionOf({ hunger: 90, thirst: 0, energy: 100, health: 100 })).toBe('critical');
        expect(conditionOf({ hunger: 0, thirst: 0, energy: 25, health: 100 })).toBe('weak');
        expect(conditionOf({ hunger: 0, thirst: 0, energy: 10, health: 100 })).toBe('critical');
        // The health thresholds join the same ladder — wounded bodies read
        // weak at ≤ 50 and critical at ≤ 25 whatever the belly says
        expect(conditionOf({ hunger: 0, thirst: 0, energy: 100, health: 50 })).toBe('weak');
        expect(conditionOf({ hunger: 0, thirst: 0, energy: 100, health: 25 })).toBe('critical');
    });
});

describe('needsPlugin — the resting metabolism read (R4, the tasks option)', () => {
    /**
     * The stub ledger read — the exact shape the sweep reads through the
     * `tasks` option (plugins/tasks/taskLedger.ts is handed over by the
     * scenario assembly): one head-task kind per entity, or undefined
     * (no ledger, or an idle body). Pinning at THIS layer keeps the
     * RESTING_KINDS contract unit-exact; the full sleep/rest stacks are
     * covered end-to-end by the sleep plugin suite.
     */
    const withTasks = (kind: string | undefined) => ({
        taskOf: (entityId: string) => (kind === undefined ? undefined : { kind }),
    });

    it('a sleeping or resting head suspends the awake hunger/thirst decay — the recovery charge is the minute\u2019s whole spend', () => {
        // Both sanctioned resting kinds, one world-minute each: the
        // unequal awake baseline (hunger 0.1 / thirst 0.15) never runs,
        // while the idle energy burn (−0.06) does — the restore is the
        // recovery service's business (the sleep/rest governance), not
        // the sweep's
        for (const kind of ['sleep', 'rest']) {
            const needs = needsPlugin({ tasks: withTasks(kind) });
            const world = createWorld({ seed: 7, tickSize: 1, plugins: [needs] });
            spawnActor(world);
            world.step();
            expect(needs.of('a')).toEqual({ hunger: 20, thirst: 20, energy: 99.94, health: 100 });
        }
    });

    it('any other head — or no ledger read at all — runs the flat awake baseline', () => {
        // A move head (the common case), a non-resting work head, and the
        // undefined read (a run without the tasks plugin): the unequal
        // baseline applies to every one of them
        for (const kind of ['move', 'eat', undefined]) {
            const needs = needsPlugin({ tasks: withTasks(kind) });
            const world = createWorld({ seed: 7, tickSize: 1, plugins: [needs] });
            spawnActor(world);
            world.step();
            expect(needs.of('a')).toEqual({ hunger: 20.03472222222222, thirst: 20.069444444444443, energy: 99.94, health: 100 });
        }
    });

    it('a resting body with an EMPTY source recovers nothing — and starvation still wounds it', () => {
        // The stub pins the head as a rest task for the whole run — the
        // body never leaves its rest, and its hunger sits at the 100 line
        // (the source the recovery service converts from is EMPTY)
        const needs = needsPlugin({ tasks: withTasks('rest'), hungerDamagePerMinute: 5 });
        const world = createWorld({ seed: 7, tickSize: 1, plugins: [needs] });
        spawnActor(world);
        needs.satisfy('a', { energy: -80, hunger: 80 }); // energy 20, hunger 100
        world.step();
        // THE RESTING MINUTE: no energy gained (the recovery service
        // blocks on the empty source — nothing converts from nothing),
        // no hunger/thirst charge (nothing to charge onto), and the
        // idle burn still runs
        expect(needs.of('a')).toEqual({ hunger: 100, thirst: 20, energy: 19.94, health: 95 });
        // Second resting minute: the starvation damage keeps draining the
        // reservoir while the body lies there — resting is not a shield.
        // (Multi-step energy accumulation: pinned close — the FLOAT NOTE
        // convention the sleep suite established.)
        world.step();
        expect(needs.of('a').health).toBe(90);
        expect(needs.of('a').energy).toBeCloseTo(19.88, 10);
        // …and the recovery stays blocked however hard the rest asks
        expect(needs.recovery('a', 12)).toBe(0);
        expect(needs.of('a').energy).toBeCloseTo(19.88, 10);
    });
});

describe('needsPlugin — R6 realistic deficit attrition (exact in-game horizons)', () => {
    /**
     * The DEFAULT-rate fixture with the belly pressures FROZEN (decay 0):
     * the only movement is the deficit's health drain, so the death minute
     * is the horizon itself. 1440 world-minutes a day (dayCycle contract):
     *   empty thirst → death at minute 5041 (3.5 days + the float's last
     *                  rounding step — the drain is 100/5040 per minute)
     *   empty hunger → death at minute 14401 (~10 days)
     *   both empty   → additive drains, death at minute 3734 (~2.6 days)
     * The exact minutes are the deterministic accumulation of the pinned
     * per-minute double (probed, not approximated).
     */
    const frozen = () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
        const world = createWorld({ seed: 3, tickSize: 1, plugins: [needs] });
        spawnActor(world);
        return { world, needs };
    };

    it('empty thirst drains full health in 3.5 in-game days — no rapid doom', () => {
        const { world, needs } = frozen();
        needs.satisfy('a', { thirst: 80 }); // 100 — empty, held (rate 0)
        // THE OLD DOOM IS GONE: thirty minutes at the line (the legacy
        // doom window) barely marks the body
        for (let minute = 0; minute < 30; minute++) {
            world.step();
        }
        expect(world.actors.has('a')).toBe(true);
        expect(needs.of('a').health).toBeCloseTo(100 - 30 * (100 / 5040), 10);
        // The 3.5-day horizon: at minute 5039 exactly one drain's worth of
        // health is left; minute 5040 empties the reservoir to the float's
        // last rounding dust (alive); 5041 lands the death
        for (let minute = 30; minute < 5039; minute++) {
            world.step();
        }
        expect(world.actors.has('a')).toBe(true);
        expect(needs.of('a').health).toBeCloseTo(100 / 5040, 10);
        world.step(); // minute 5040
        expect(world.actors.has('a')).toBe(true);
        expect(needs.of('a').health).toBeLessThan(1e-9);
        world.step(); // minute 5041 — the reservoir runs dry
        expect(world.actors.has('a')).toBe(false);
        expect(world.events.log().some((event) => event.kind === 'death')).toBe(true);
    });

    it('empty hunger drains full health in ~10 in-game days', () => {
        const { world, needs } = frozen();
        needs.satisfy('a', { hunger: 80 }); // 100 — empty, held
        for (let minute = 1; minute < 14400; minute++) {
            world.step();
        }
        expect(world.actors.has('a')).toBe(true); // minute 14399 — ~10 days, alive
        world.step(); // minute 14400 — the drain's last rounding dust left
        expect(world.actors.has('a')).toBe(true);
        world.step(); // minute 14401 — death
        expect(world.actors.has('a')).toBe(false);
    });

    it('both deficits empty stack the drains — death inside the thirst window', () => {
        const { world, needs } = frozen();
        needs.satisfy('a', { hunger: 80, thirst: 80 }); // both 100
        for (let minute = 1; minute < 3734; minute++) {
            world.step();
        }
        expect(world.actors.has('a')).toBe(true); // minute 3733
        world.step(); // minute 3734 — 100 / (thirstDrain + hungerDrain)
        expect(world.actors.has('a')).toBe(false);
    });

    it('a fed belly never negates the deficit wound — damage outranks regen every minute', () => {
        // Hunger AT the line with thirst comfortably watered: the body is
        // half-wounded and "fed" by the thirst side, yet the empty hunger
        // line wounds — the regen branch never runs the same minute
        const { world, needs } = frozen();
        needs.satisfy('a', { hunger: 80, health: -50 }); // hunger 100, health 50
        world.step();
        expect(needs.of('a').health).toBeCloseTo(50 - 100 / 14400, 12);
        world.step();
        expect(needs.of('a').health).toBeCloseTo(50 - 2 * (100 / 14400), 12);
    });
});
