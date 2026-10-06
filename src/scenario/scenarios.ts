// The island's standard scenarios — ten one-shot story templates.
//
// StrandedIsland produces its own scenarios: every time two castaways meet
// (plugins/story/storyPlugin.ts detects the encounter), ONE unused
// scenario is sampled from the deck (@godspace/core src/scenario) and
// played. The play adjusts the cast's profiles — hunger, thirst, energy,
// and the bond between them — through the stage hooks, then returns the
// narrative lines that get injected into the log as one coherent story
// block.
//
// The one-shot rule: each of these ten templates plays at most ONCE per
// world. The deck is built to hold thousands — more scenario packs simply
// add cards.
//
// Writing rules for a coherent story:
//   • the cast are role 0 (the protagonist) and role 1;
//   • the lines read as one continuous little story, 2–4 sentences;
//   • the profile deltas follow the needs plugin's semantics (hunger and
//     thirst RISE with exertion, energy FALLS — satisfy() clamps 0..100);
//   • every adjustment has a reason a reader can trace in the lines.

import type { ScenarioDefinition, ScenarioStage } from '@godspace/core';

/** The scenario's cast names — role 0 the protagonist, role 1 the partner. */
const castNames = (stage: ScenarioStage): [string, string] => [
    stage.cast[0]?.name ?? 'Someone',
    stage.cast[1]?.name ?? 'someone',
];

/** The ten standard island scenarios — one-shot story templates. */
export const STANDARD_SCENARIOS: ScenarioDefinition[] = [
    {
        id: 'shared-fire',
        title: 'Shared Fire',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { energy: 8 });
            stage.profile(1, { energy: 8 });
            stage.bond(0, 1, 8, 'the shared fire');
            return [
                `${first} coaxes a small fire out of dry grass while ${second} feeds it twigs.`,
                `They sit shoulder to shoulder as the flames chase off the evening chill, trading names for the stars they can name.`,
                `By the time the fire settles to embers, the silence between them feels like an agreement.`,
            ];
        },
    },
    {
        id: 'water-oath',
        title: 'The Water Oath',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { thirst: 6 });
            stage.profile(1, { thirst: -14 });
            stage.bond(0, 1, 10, 'the water oath');
            return [
                `${first} cups the last of the rainwater in two joined palms and offers it across.`,
                `${second} drinks half, then presses the rest back, insisting they split it evenly.`,
                `Without a word they seal the oath of the pool: neither drinks while the other goes dry.`,
            ];
        },
    },
    {
        id: 'reef-race',
        title: 'Race to the Reef',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { energy: -12, hunger: 8 });
            stage.profile(1, { energy: -12, hunger: 8 });
            stage.bond(0, 1, 6, 'the race');
            return [
                `${first} dares ${second} to race the tide line all the way to the reef shelf.`,
                `They sprint the wet sand, kicking spray, and ${second} takes it by a single stride.`,
                `Both collapse laughing on the shore — hungrier than they started, and lighter too.`,
            ];
        },
    },
    {
        id: 'spear-lessons',
        title: 'Spear Lessons',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { energy: -8 });
            stage.profile(1, { energy: -4 });
            stage.bond(0, 1, 12, 'the lessons');
            return [
                `${first} spends the afternoon teaching ${second} to balance a sharpened stick.`,
                `${second}'s first dozen throws sail wide of the driftwood target, but the thirteenth strikes true.`,
                `${first} claps ${second} on the shoulder, and something like pride settles between them.`,
            ];
        },
    },
    {
        id: 'long-argument',
        title: 'The Long Argument',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { energy: -6 });
            stage.profile(1, { energy: -6 });
            stage.bond(0, 1, -12, 'the argument');
            return [
                `A quarrel over the night's firewood splits the air between ${first} and ${second}.`,
                `Harsh words stack like storm clouds, each louder than the last, until neither remembers what started it.`,
                `They part at dusk without a truce, the argument still smouldering between them.`,
            ];
        },
    },
    {
        id: 'quiet-distrust',
        title: 'Quiet Distrust',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { hunger: 4 });
            stage.profile(1, { energy: -4 });
            stage.bond(0, 1, -8, 'the quiet distrust');
            return [
                `${first} notices ${second} counting the food stores and saying nothing about it.`,
                `No accusation is made, but the afternoon goes on with a new carefulness in it.`,
                `That night ${first} moves their own share of the berries a little closer to their bedroll.`,
            ];
        },
    },
    {
        id: 'storm-shelter',
        title: 'Storm Shelter',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { energy: 8, thirst: 4 });
            stage.profile(1, { energy: 8, thirst: 4 });
            stage.bond(0, 1, 9, 'the storm shelter');
            return [
                `Rain sweeps in without warning and ${first} drags ${second} beneath a leaning slab of rock.`,
                `They wait out the downpour pressed shoulder to shoulder, shouting old jokes over the drumming water.`,
                `When the sky clears, ${second} catches ${first} smiling — the first smile either has seen since the wreck.`,
            ];
        },
    },
    {
        id: 'night-watch',
        title: 'The Night Watch Pact',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { energy: -4 });
            stage.profile(1, { energy: -4 });
            stage.bond(0, 1, 14, 'the night watch pact');
            return [
                `${first} and ${second} agree to split the night into two watches against the island's noises.`,
                `The dark hours crawl — every rustle a story, every distant splash a question — but neither watch dozes.`,
                `At first light they shake on it: nobody on this island watches the dark alone again.`,
            ];
        },
    },
    {
        id: 'tideline-walk',
        title: 'Tideline Walk',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { energy: -6, hunger: 4 });
            stage.profile(1, { energy: -6, hunger: 4 });
            stage.bond(0, 1, 5, 'the tideline walk');
            return [
                `At first light ${first} and ${second} walk the tideline, hunting whatever the sea left behind.`,
                `They turn up sea glass, a rusted hinge, and one unbroken shell that ${second} pockets like a treasure.`,
                `By the time the sun clears the palms they have mapped half the beach in their heads — together.`,
            ];
        },
    },
    {
        id: 'gull-omen',
        title: 'The Gull Omen',
        castSize: 2,
        play: (stage) => {
            const [first, second] = castNames(stage);
            stage.profile(0, { energy: 2 });
            stage.profile(1, { energy: 2, thirst: 4 });
            stage.bond(0, 1, 7, 'the gull omen');
            return [
                `A white gull circles low overhead, and ${first} stops ${second} mid-stride to watch it.`,
                `${second} swears the bird is a good sign; ${first} laughs at the superstition and then knocks on wood anyway.`,
                `They walk on sharing the same lucky thought, whatever each of them chooses to call it.`,
            ];
        },
    },
];
