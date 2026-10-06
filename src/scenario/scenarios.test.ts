// Tests for the island's standard scenarios (scenario/scenarios.ts).
//
// Every scenario is played against a recording stage; the tests pin the
// EXACT profile deltas, bond moves and narrative lines — the story text is
// deterministic, so the log's story blocks are too.

import { describe, it, expect } from 'vitest';
import { STANDARD_SCENARIOS } from './scenarios';
import type { ScenarioStage } from '@godspace/core';

/** Recording stage factory — captures every adjustment the play makes. */
const recordingStage = (): {
    stage: ScenarioStage;
    profiles: Array<{ index: number; deltas: Record<string, number> }>;
    bonds: Array<{ a: number; b: number; delta: number; reason?: string }>;
} => {
    const profiles: Array<{ index: number; deltas: Record<string, number> }> = [];
    const bonds: Array<{ a: number; b: number; delta: number; reason?: string }> = [];
    const stage: ScenarioStage = {
        tick: 10,
        time: 100,
        cast: [
            { id: 'actor-1', name: 'Ael' },
            { id: 'actor-2', name: 'Bram' },
        ],
        profile: (index, deltas) => {
            profiles.push({ index, deltas });
        },
        bond: (a, b, delta, reason) => {
            bonds.push({ a, b, delta, reason });
        },
    };
    return { stage, profiles, bonds };
};

/** Plays one scenario by id and returns its outcome. */
const playScenario = (id: string) => {
    const scenario = STANDARD_SCENARIOS.find((definition) => definition.id === id);
    if (!scenario) {
        throw new Error(`unknown scenario ${id}`);
    }
    const { stage, profiles, bonds } = recordingStage();
    const lines = scenario.play(stage);
    return { lines, profiles, bonds };
};

describe('STANDARD_SCENARIOS', () => {
    it('ships exactly the ten standard story templates, each a two-cast play', () => {
        expect(STANDARD_SCENARIOS.map((scenario) => scenario.id)).toEqual([
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
        STANDARD_SCENARIOS.forEach((scenario) => {
            expect(scenario.castSize).toBe(2);
            expect(scenario.title.length).toBeGreaterThan(0);
        });
    });

    it('every scenario writes its cast names into a coherent 3-line story', () => {
        STANDARD_SCENARIOS.forEach((scenario) => {
            const { lines } = playScenario(scenario.id);
            expect(lines.length).toBe(3);
            // The cast names ride the narrative (the story is ABOUT them)
            expect(lines.join(' ')).toContain('Ael');
            expect(lines.join(' ')).toContain('Bram');
        });
    });

    it('shared-fire rests both castaways and bonds them', () => {
        const { lines, profiles, bonds } = playScenario('shared-fire');
        expect(lines).toEqual([
            'Ael coaxes a small fire out of dry grass while Bram feeds it twigs.',
            'They sit shoulder to shoulder as the flames chase off the evening chill, trading names for the stars they can name.',
            'By the time the fire settles to embers, the silence between them feels like an agreement.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { energy: 8 } },
            { index: 1, deltas: { energy: 8 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: 8, reason: 'the shared fire' }]);
    });

    it("water-oath quenches the partner at the protagonist's expense", () => {
        const { lines, profiles, bonds } = playScenario('water-oath');
        expect(lines).toEqual([
            'Ael cups the last of the rainwater in two joined palms and offers it across.',
            'Bram drinks half, then presses the rest back, insisting they split it evenly.',
            'Without a word they seal the oath of the pool: neither drinks while the other goes dry.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { thirst: 6 } },
            { index: 1, deltas: { thirst: -14 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: 10, reason: 'the water oath' }]);
    });

    it('reef-race tires and famishes both castaways, bonding them over the sprint', () => {
        const { lines, profiles, bonds } = playScenario('reef-race');
        expect(lines).toEqual([
            'Ael dares Bram to race the tide line all the way to the reef shelf.',
            'They sprint the wet sand, kicking spray, and Bram takes it by a single stride.',
            'Both collapse laughing on the shore — hungrier than they started, and lighter too.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { energy: -12, hunger: 8 } },
            { index: 1, deltas: { energy: -12, hunger: 8 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: 6, reason: 'the race' }]);
    });

    it('spear-lessons costs the teacher more and bonds them hardest so far', () => {
        const { lines, profiles, bonds } = playScenario('spear-lessons');
        expect(lines).toEqual([
            'Ael spends the afternoon teaching Bram to balance a sharpened stick.',
            "Bram's first dozen throws sail wide of the driftwood target, but the thirteenth strikes true.",
            'Ael claps Bram on the shoulder, and something like pride settles between them.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { energy: -8 } },
            { index: 1, deltas: { energy: -4 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: 12, reason: 'the lessons' }]);
    });

    it('long-argument wears both down and sours the bond', () => {
        const { lines, profiles, bonds } = playScenario('long-argument');
        expect(lines).toEqual([
            "A quarrel over the night's firewood splits the air between Ael and Bram.",
            'Harsh words stack like storm clouds, each louder than the last, until neither remembers what started it.',
            'They part at dusk without a truce, the argument still smouldering between them.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { energy: -6 } },
            { index: 1, deltas: { energy: -6 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: -12, reason: 'the argument' }]);
    });

    it('quiet-distrust is a wary, lopsided beat that cools the bond', () => {
        const { lines, profiles, bonds } = playScenario('quiet-distrust');
        expect(lines).toEqual([
            'Ael notices Bram counting the food stores and saying nothing about it.',
            'No accusation is made, but the afternoon goes on with a new carefulness in it.',
            'That night Ael moves their own share of the berries a little closer to their bedroll.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { hunger: 4 } },
            { index: 1, deltas: { energy: -4 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: -8, reason: 'the quiet distrust' }]);
    });

    it('storm-shelter rests both and lifts the bond, at a thirst cost of the soaking wait', () => {
        const { lines, profiles, bonds } = playScenario('storm-shelter');
        expect(lines).toEqual([
            'Rain sweeps in without warning and Ael drags Bram beneath a leaning slab of rock.',
            'They wait out the downpour pressed shoulder to shoulder, shouting old jokes over the drumming water.',
            'When the sky clears, Bram catches Ael smiling — the first smile either has seen since the wreck.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { energy: 8, thirst: 4 } },
            { index: 1, deltas: { energy: 8, thirst: 4 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: 9, reason: 'the storm shelter' }]);
    });

    it('night-watch is the strongest positive bond move', () => {
        const { lines, profiles, bonds } = playScenario('night-watch');
        expect(lines).toEqual([
            "Ael and Bram agree to split the night into two watches against the island's noises.",
            'The dark hours crawl — every rustle a story, every distant splash a question — but neither watch dozes.',
            'At first light they shake on it: nobody on this island watches the dark alone again.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { energy: -4 } },
            { index: 1, deltas: { energy: -4 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: 14, reason: 'the night watch pact' }]);
    });

    it('tideline-walk walks the shore side by side, bonding gently', () => {
        const { lines, profiles, bonds } = playScenario('tideline-walk');
        expect(lines).toEqual([
            'At first light Ael and Bram walk the tideline, hunting whatever the sea left behind.',
            'They turn up sea glass, a rusted hinge, and one unbroken shell that Bram pockets like a treasure.',
            'By the time the sun clears the palms they have mapped half the beach in their heads — together.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { energy: -6, hunger: 4 } },
            { index: 1, deltas: { energy: -6, hunger: 4 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: 5, reason: 'the tideline walk' }]);
    });

    it('gull-omen shares a lucky thought and a small rest', () => {
        const { lines, profiles, bonds } = playScenario('gull-omen');
        expect(lines).toEqual([
            'A white gull circles low overhead, and Ael stops Bram mid-stride to watch it.',
            'Bram swears the bird is a good sign; Ael laughs at the superstition and then knocks on wood anyway.',
            'They walk on sharing the same lucky thought, whatever each of them chooses to call it.',
        ]);
        expect(profiles).toEqual([
            { index: 0, deltas: { energy: 2 } },
            { index: 1, deltas: { energy: 2, thirst: 4 } },
        ]);
        expect(bonds).toEqual([{ a: 0, b: 1, delta: 7, reason: 'the gull omen' }]);
    });
});
