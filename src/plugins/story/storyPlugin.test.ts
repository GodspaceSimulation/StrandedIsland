// Tests for the story plugin (plugins/story/storyPlugin.ts).
//
// The plugin is tested with a BESPOKE single-card deck (injected through
// the options) so the wiring is pinned exactly: encounter detection, the
// one-story-per-minute gate, the cooldown, profile routing onto needs,
// bond routing onto relationships, the one-shot exhaustion and the exact
// log block shape. The stock island scenarios have their own suite
// (scenario/scenarios.test.ts).

import { describe, it, expect } from 'vitest';
import { createScenarioDeck, position3, type ScenarioDeck, type ScenarioDefinition } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { storyPlugin } from './storyPlugin';
import type { Actor } from '../../engine/types';

/** A bespoke single-card deck — the play's effects are pinned by the test. */
const bespokeScenario: ScenarioDefinition = {
    id: 'test-story',
    title: 'Test Story',
    castSize: 2,
    play: (stage) => {
        stage.profile(0, { hunger: -5, energy: 10 });
        stage.profile(1, { thirst: -7 });
        stage.bond(0, 1, 9, 'the bespoke test');
        return ['Line one.', 'Line two.'];
    },
};

const buildDeck = (): ScenarioDeck => {
    const deck = createScenarioDeck({ seed: 7 });
    deck.define(bespokeScenario);
    return deck;
};

// Full stack — terrain (the meeting ring needs passable tiles), needs,
// relationships and the story plugin with the injected deck
const buildStack = (options: Parameters<typeof storyPlugin>[0] = {}) => {
    const deck = options.deck ?? buildDeck();
    const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
    const relationship = relationshipPlugin({ driftPerMinute: 0 });
    const story = storyPlugin({ ...options, needs, relationship, deck });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin({ width: 11, height: 7 }), needs, relationship, story],
    });
    return { world, needs, relationship, story, deck };
};

const spawn = (world: ReturnType<typeof createWorld>, id: string, name: string, x: number, y: number): Actor => {
    const actor: Actor = { id, name, kind: 'sentient', type: 'human', position: position3(x, y), marker: name.slice(0, 1), condition: 'well', profile: { sex: 'male' } };
    return world.spawn(actor);
};

describe('storyPlugin', () => {
    it('plays the first encountered pair: profiles route to needs, bonds to relationships, the story lands as ONE block', () => {
        const { world, needs, relationship, story } = buildStack();
        // Ael and Bram share tile (0,0) — the closest possible meeting
        spawn(world, 'a', 'Ael', 0, 0);
        spawn(world, 'b', 'Bram', 0, 0);
        world.step();
        // The stage routed the profile deltas onto the needs plugin —
        // from the starting { hunger 20, thirst 20, energy 100 }, clamped.
        // Health stays full — the meeting fed nobody and hurt nobody
        expect(needs.of('a')).toEqual({ hunger: 15, thirst: 20, energy: 100, health: 100 });
        expect(needs.of('b')).toEqual({ hunger: 20, thirst: 13, energy: 100, health: 100 });
        // …and the bond delta onto the relationship plugin (no drift in
        // this fixture — the value is exactly the scenario's move)
        expect(relationship.relation('a', 'b')).toBe(9);
        expect(relationship.level('a', 'b')).toBe('neutral');
        // The deck card is spent
        expect(story.deck().usedIds()).toEqual(['test-story']);
        expect(story.deck().unusedCount()).toBe(0);
        // ONE story block in the log — the coherent story of the meeting
        // (the log's 4th event: two spawns, the bond's relationship line,
        // then the story)
        expect(world.events.log().filter((event) => event.kind === 'story')).toEqual([
            {
                id: 4,
                tick: 1,
                time: 1,
                kind: 'story',
                actorId: 'a',
                message: 'Line one. Line two.',
                detail: {
                    scenario: 'test-story',
                    title: 'Test Story',
                    cast: ['Ael', 'Bram'],
                    lines: ['Line one.', 'Line two.'],
                },
            },
        ]);
        // The bond move logged its relationship line with the scenario's reason
        expect(world.events.log()[2]).toEqual({
            id: 3,
            tick: 1,
            time: 1,
            kind: 'relationship',
            message: 'Ael and Bram grow closer (the bespoke test).',
        });
    });

    it('the meeting ring is Chebyshev: adjacent tiles meet, distance 2 does not', () => {
        const { world, story } = buildStack();
        spawn(world, 'a', 'Ael', 0, 0);
        // One tile east — inside the ring
        spawn(world, 'b', 'Bram', 1, 0);
        world.step();
        expect(story.deck().usedIds()).toEqual(['test-story']);
        expect(world.events.log().some((event) => event.kind === 'story')).toBe(true);

        // A fresh world with the pair one step beyond the ring
        const apart = buildStack();
        spawn(apart.world, 'a', 'Ael', 0, 0);
        spawn(apart.world, 'b', 'Bram', 2, 0);
        apart.world.step();
        expect(apart.story.deck().usedIds()).toEqual([]);
        expect(apart.world.events.log().some((event) => event.kind === 'story')).toBe(false);
    });

    it('at most one story per minute; the cooldown keeps the cast apart between beats', () => {
        // Zero cooldown would allow back-to-back stories only across
        // minutes — with cooldown 0 each minute could still fire one (the
        // one-story-per-minute gate). Set cooldown 2 so minute 2 is too
        // soon after minute 1.
        const { world, story } = buildStack({ encounterCooldownMinutes: 2 });
        // THREE castaways share the tile — three eligible pairs
        spawn(world, 'a', 'Ael', 0, 0);
        spawn(world, 'b', 'Bram', 0, 0);
        spawn(world, 'c', 'Cove', 0, 0);
        // A second card so a second beat has material
        story.deck().define({
            id: 'test-story-2',
            title: 'Test Story 2',
            play: () => ['Second beat.'],
        });
        world.step();
        expect(story.deck().usedIds()).toEqual(['test-story']);
        world.step();
        // Minute 2: within the 2-minute cooldown of BOTH prior castaways —
        // no encounter fires (Cove was never in a story, but the first
        // eligible pair needs two ready castaways and only Cove qualifies)
        expect(story.deck().usedIds()).toEqual(['test-story']);
        world.step();
        // Minute 3: Ael and Bram are off cooldown (3 − 1 ≥ 2) — a second
        // story plays with a fresh pair
        expect(story.deck().usedIds()).toEqual(['test-story', 'test-story-2']);
        expect(world.events.log().filter((event) => event.kind === 'story').length).toBe(2);
    });

    it('the story stops when the well runs dry — encounters fall silent', () => {
        const { world, story } = buildStack({ encounterCooldownMinutes: 0 });
        spawn(world, 'a', 'Ael', 0, 0);
        spawn(world, 'b', 'Bram', 0, 0);
        // The single card plays on minute 1…
        world.step();
        expect(story.deck().usedCount()).toBe(1);
        // …and every minute after is silent — no card, no story
        world.step();
        world.step();
        expect(story.deck().usedCount()).toBe(1);
        expect(world.events.log().filter((event) => event.kind === 'story').length).toBe(1);
    });

    it('lonely worlds tell no stories; despawned mid-roster castaways are skipped safely', () => {
        // A single castaway never meets anyone
        const alone = buildStack();
        spawn(alone.world, 'a', 'Ael', 0, 0);
        alone.world.step();
        expect(alone.story.deck().usedCount()).toBe(0);

        // A pair that separates (one despawned) before any encounter
        const parted = buildStack();
        spawn(parted.world, 'a', 'Ael', 0, 0);
        spawn(parted.world, 'b', 'Bram', 5, 5);
        parted.world.step();
        expect(parted.story.deck().usedCount()).toBe(0);
        parted.world.despawn('b');
        parted.world.step();
        expect(parted.story.deck().usedCount()).toBe(0);
    });

    it('without a custom deck the plugin defines the standard ten scenarios', () => {
        const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
        const relationship = relationshipPlugin({ driftPerMinute: 0 });
        const story = storyPlugin({ needs, relationship });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), needs, relationship, story],
        });
        expect(story.deck().all().map((scenario) => scenario.id)).toEqual([
            'shared-fire',
            'water-oath',
            'reef-race',
            'spear-lessons',
            'long-argument',
            'quiet-distrust',
            'storm-shelter',
            'night-watch',
            'tideline-walk',
            'gull-omen',
        ]);
        expect(world.plugins.has('story')).toBe(true);
    });

    it('dispose clears the encounter ledger and drops the deck binding', () => {
        const { world, story } = buildStack();
        spawn(world, 'a', 'Ael', 0, 0);
        spawn(world, 'b', 'Bram', 0, 0);
        world.step();
        expect(story.deck().usedCount()).toBe(1);
        world.plugins.remove('story');
        // Reading after dispose is a hard error — the deck binding is gone
        expect(() => story.deck()).toThrow('story plugin read before setup');
    });

    it('reading the deck before setup is a hard error', () => {
        const needs = needsPlugin();
        const relationship = relationshipPlugin();
        const story = storyPlugin({ needs, relationship });
        expect(() => story.deck()).toThrow('story plugin read before setup');
    });
});
