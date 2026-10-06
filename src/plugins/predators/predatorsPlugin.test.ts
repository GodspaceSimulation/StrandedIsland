// Tests for the predators plugin (plugins/predators/predatorsPlugin.ts).
// The boars are the land beasts a castaway can meet and be hurt by — the
// survival behaviour's reason to flee. All outcomes were captured from
// reference runs — the rolls are fully deterministic per seed.
//
// The boar model: coordinate-space residents (kind 'creature', type
// 'boar', state 'roaming') that never join the actor registry — the same
// registry pattern as the sharks. One arrival roll per world-minute
// spawns a boar on a rim LAND cell under the population cap; each boar
// roams one land tile every 2nd world-minute (the lumbering gait) and can
// MAUL a castaway sharing its tile: one bite roll per minute, a bite
// drains 15 energy points AND wounds 20 health points through the wired
// needs plugin (health at 0 is death) and lands in the log as an 'attack'
// event. A boar carrying ledger tasks skips its own roam that minute (the
// behavior plugin plans grounded creatures; two drivers would double-step).

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { needsPlugin } from '../needs/needsPlugin';
import { entityPlugin } from '../entity/entityPlugin';
import { predatorsPlugin, BOAR_TYPE_GLYPH } from './predatorsPlugin';
import type { Actor } from '../../engine/types';

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(x, y), marker: name.slice(0, 1), condition: 'well', profile: { sex: 'male' } };
    return world.spawn(actor);
};

// Terrain + needs + predators, with the bite pinned to always land
const buildStack = (options: Parameters<typeof predatorsPlugin>[0] = {}) => {
    const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
    const predators = predatorsPlugin({ biteChancePerMinute: 1, needs, ...options });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), needs, predators],
    });
    return { world, needs, predators };
};

describe('predatorsPlugin', () => {
    it('release places a boar on a rim land cell, outside the actor registry', () => {
        const { world, predators } = buildStack();
        const boar = predators.release();
        // The roster pick: the far-shore band draw landed on (−5, 7) for
        // seed 7
        expect(boar).toEqual({ id: 'boar-1', name: 'Tusk', marker: 'T', x: -5, y: 7 });
        // The cell is dry land on the island's outermost dry band (the
        // canvas edge itself is always open sea)
        expect(world.cellAt(-5, 7)?.passable).toBe(true);
        // A boar is a creature of the coordinate space — never a castaway
        expect(world.actors.has('boar-1')).toBe(false);
        expect(world.coordinates.entryOf('boar-1')).toMatchObject({
            kind: 'creature',
            type: 'boar',
            state: 'roaming',
        });
        // The arrival is a world-scale happening — it stays in the log
        expect(world.events.log().at(-1)).toMatchObject({
            kind: 'spawn',
            message: 'Tusk wanders in from the wilds.',
        });
    });

    it('a boar sharing a tile with a castaway mauls them: the bite drains energy AND wounds health', () => {
        const { world, needs, predators } = buildStack();
        spawn(world, 'a', 'Ael', 6, 2);
        const boar = predators.release();
        // The boar is herded onto Ael's tile for the meeting
        world.coordinates.move('boar-1', position3(6, 2));
        void boar;
        world.step();
        // One bite landed: 15 energy points gone (needs frozen otherwise)
        // and 20 health points wounded — the reservoir between Ael and
        // death (a cornered castaway can bleed out; a drained reservoir
        // kills, plugins/needs)
        expect(needs.of('a').energy).toBe(85);
        expect(needs.of('a').health).toBe(80);
        // The mauling is a story between two entities — it stays in the log
        expect(world.events.log().filter((event) => event.kind === 'attack')).toEqual([
            expect.objectContaining({
                kind: 'attack',
                actorId: 'a',
                message: 'Tusk mauls Ael.',
            }),
        ]);
    });

    it('a bite option pins its own wound depth', () => {
        const { world, needs, predators } = buildStack({ biteDamage: 45 });
        spawn(world, 'a', 'Ael', 6, 2);
        predators.release();
        world.coordinates.move('boar-1', position3(6, 2));
        world.step();
        // The custom wound: 45 health points off the reservoir
        expect(needs.of('a').health).toBe(55);
        expect(needs.of('a').energy).toBe(85);
    });

    it('a boar roams the land, one tile every 2nd minute, never into the water', () => {
        const { world, predators } = buildStack();
        predators.release();
        // Ten minutes of roaming: the boar steps on minutes 2, 4, 6, 8,
        // 10 (the lumbering gait) — every position stays on dry land
        const trail: Array<{ x: number; y: number }> = [];
        for (let minute = 1; minute <= 10; minute++) {
            world.step();
            const record = predators.predatorOf('boar-1') as { x: number; y: number };
            trail.push({ x: record.x, y: record.y });
            expect(world.cellAt(record.x, record.y)?.passable).toBe(true);
        }
        // Captured reference trail (seed 7)
        expect(trail).toEqual([
            { x: -5, y: 7 },  // minute 1 — no step (the gait steps on even minutes)
            { x: -6, y: 6 },  // minute 2
            { x: -6, y: 6 },  // minute 3 — no step
            { x: -7, y: 5 },  // minute 4
            { x: -7, y: 5 },  // minute 5 — no step
            { x: -8, y: 4 },  // minute 6
            { x: -8, y: 4 },  // minute 7 — no step
            { x: -7, y: 4 },  // minute 8
            { x: -7, y: 4 },  // minute 9 — no step
            { x: -7, y: 5 },  // minute 10
        ]);
    });

    it('the herd arrives on the seeded roll and respects the population cap', () => {
        // Every minute rolls an arrival while the herd is under the cap
        const { world, predators } = buildStack({ arriveChancePerMinute: 1, maxPredators: 2 });
        world.step();
        expect(predators.predators().map((boar) => boar.id)).toEqual(['boar-1']);
        world.step();
        // The cap holds the herd at two
        expect(predators.predators().map((boar) => boar.id)).toEqual(['boar-1', 'boar-2']);
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        expect(predators.predators().length).toBe(2);
        expect(world.events.log().filter((event) => event.kind === 'spawn').length).toBe(2);
    });

    it('the bite only lands with the needs plugin wired; dispose clears the wilds', () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
        const predators = predatorsPlugin({ biteChancePerMinute: 1 });
        const world = createWorld({ seed: 7, tickSize: 1, plugins: [islandTerrainPlugin(), needs, predators] });
        // No wiring — the roll runs, the maul stays unwounded
        spawn(world, 'a', 'Ael', 6, 2);
        predators.release();
        world.coordinates.move('boar-1', position3(6, 2));
        world.step();
        expect(needs.of('a').energy).toBe(100);
        expect(world.events.log().filter((event) => event.kind === 'attack')).toEqual([]);
        // Dispose: the boars leave the coordinate space with the plugin
        predators.dispose();
        expect(predators.predators()).toEqual([]);
        expect(world.coordinates.positionOf('boar-1')).toBeUndefined();
    });

    it('exports the boar glyph for the canvas type palettes', () => {
        expect(BOAR_TYPE_GLYPH).toEqual({ boar: '🐗' });
    });
});

describe('predatorsPlugin — the entity profiles: the attribute-driven gait', () => {
    /** The stack with entity profiles mounted — the boar lives by its stats. */
    const buildStatStack = (options: Parameters<typeof predatorsPlugin>[0] = {}) => {
        const profiles = entityPlugin();
        const needs = needsPlugin({ profiles });
        const predators = predatorsPlugin({ biteChancePerMinute: 1, needs, profiles, ...options });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), needs, predators],
        });
        return { world, needs, predators };
    };

    it('the pace derives from the boar Speed attribute — the same lumbering gait', () => {
        const { world, predators, needs } = buildStatStack();
        predators.release();
        // The profile's walk row (Speed 6 → 2 minutes a tile) IS the legacy
        // pace: the captured trail repeats exactly
        const trail: Array<{ x: number; y: number }> = [];
        for (let minute = 1; minute <= 10; minute++) {
            world.step();
            const record = predators.predatorOf('boar-1') as { x: number; y: number };
            trail.push({ x: record.x, y: record.y });
        }
        expect(trail).toEqual([
            { x: -5, y: 7 }, { x: -6, y: 6 }, { x: -6, y: 6 }, { x: -7, y: 5 },
            { x: -7, y: 5 }, { x: -8, y: 4 }, { x: -8, y: 4 }, { x: -7, y: 4 },
            { x: -7, y: 4 }, { x: -7, y: 5 },
        ]);
        // The roaming burn: five walks × 0.83 (the walk row) + the species
        // decay 0.04 × 10 minutes — the float drift of ten rounds of decay
        // is pinned from the reference run
        expect(needs.of('boar-1').energy).toBe(95.44999999999995);
    });

    it('an exhausted boar grazes where it stands instead of lumbering on', () => {
        const { world, predators, needs } = buildStatStack();
        predators.release();
        // Drain the boar under the graze line
        needs.satisfy('boar-1', { energy: -81 }); // 19
        world.step(); // minute 1 — odd, the gait does not step (decay 18.96)
        expect(predators.predatorOf('boar-1')).toEqual({ id: 'boar-1', name: 'Tusk', marker: 'T', x: -5, y: 7 });
        world.step(); // minute 2 — even: the pick runs, the GRAZE holds the boar
        expect(predators.predatorOf('boar-1')).toEqual({ id: 'boar-1', name: 'Tusk', marker: 'T', x: -5, y: 7 });
        // The graze recovery (+4) outpaces the decay (−0.04): 18.92 + 4
        expect(needs.of('boar-1').energy).toBe(22.92);
        world.step(); // minute 3 — odd, nothing
        world.step(); // minute 4 — energy 22.88 > the line: the gait resumes
        expect(predators.predatorOf('boar-1')).toEqual({ id: 'boar-1', name: 'Tusk', marker: 'T', x: -6, y: 6 });
    });
});
