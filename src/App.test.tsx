// Tests for the god-view App (src/App.tsx).
// Every test pins <App seed={7} /> so assertions run against the
// deterministic seed-7 island (default 25×17, centered coordinates — (0, 0)
// is the canvas middle); the random-roll behaviour of an unpinned reload
// has its own dedicated test below.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { App } from './App';
import { Dashboard } from './features/dashboard';
import { bumpRevision } from './features/worldBridge';
import { createIslandWorld } from './scenario/island';

describe('App', () => {
    it('renders the god view with title, clock and the full island grid', () => {
        render(<App seed={7} />);
        expect(screen.getByRole('heading', { name: /stranded island/i })).toBeDefined();
        // Seed 7, tickSize 1 (one world minute per tick) — the island's
        // calendar is born at 10:00 on January 1, 1609 (scenario/temporal.ts),
        // January opens Winter
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:00');
        // Default view is the unicode (emoji) canvas — 425 voxel cells
        expect(screen.getByTestId('world-grid-unicode').children.length).toBe(425);
        // All four castaways are on the board
        expect(screen.getByTestId('actor-chip-Ael').textContent).toContain('Ael');
        expect(screen.getByTestId('actor-chip-Bram').textContent).toContain('Bram');
        expect(screen.getByTestId('actor-chip-Cove').textContent).toContain('Cove');
        expect(screen.getByTestId('actor-chip-Dune').textContent).toContain('Dune');
        // Kiki wheels above the island center (0,0) at z 2 — tile index
        // (0+8)×25+(0+12) = 212, the plain emoji — no z-index superscript on
        // characters (the altitude reads through the fade band + hover title)
        const grid = screen.getByTestId('world-grid-unicode');
        expect((grid.children[212] as HTMLElement).textContent).toBe('🐦');
        expect((grid.children[212] as HTMLElement).title).toContain('Kiki · flying-2 · z 2');
        // Ael came ashore at the island edge (−11,0) — tile (0+8)×25+(−11+12)
        // = 201, the GENDERED human emoji (his profile sex is male), no altitude
        expect((grid.children[201] as HTMLElement).textContent).toBe('🧍‍♂️');
        expect((grid.children[201] as HTMLElement).title).toContain('Ael · well');
    });

    it('every castaway row carries the compact 4-bar wellbeing overview', () => {
        render(<App seed={7} />);
        // Starting needs: hunger 20, thirst 20, energy 100, health 100 →
        // wellbeing bars invert the pressure: fullness 80, hydration 80,
        // energy 100, health 100
        const stats = screen.getByTestId('actor-stats-Ael');
        expect(stats.children.length).toBe(4);
        // Hover titles name the metric (fullness/hydration are the inverted reads)
        expect((stats.children[0] as HTMLElement).title).toBe('Fullness 80%');
        expect((stats.children[1] as HTMLElement).title).toBe('Hydration 80%');
        expect((stats.children[2] as HTMLElement).title).toBe('Energy 100%');
        expect((stats.children[3] as HTMLElement).title).toBe('Health 100%');
        // The factory emits prop-driven styles as Emotion classes (inside a
        // @media (min-width: 0px) block) — assert the exact CSS rule output
        const cssText = Array.from(document.querySelectorAll('style'))
            .map((tag) => tag.textContent ?? '')
            .join('');
        const hungerFill = stats.children[0].children[0] as HTMLElement;
        expect(cssText).toContain(`.${hungerFill.className}{width:80%;background:#d97b3f;}`);
        const thirstFill = stats.children[1].children[0] as HTMLElement;
        expect(cssText).toContain(`.${thirstFill.className}{width:80%;background:#3d9be9;}`);
        const energyFill = stats.children[2].children[0] as HTMLElement;
        expect(cssText).toContain(`.${energyFill.className}{width:100%;background:#8bc34a;}`);
        const healthFill = stats.children[3].children[0] as HTMLElement;
        expect(cssText).toContain(`.${healthFill.className}{width:100%;background:#d9534f;}`);
    });

    it('the Story tab stays collapsed until opened; opening shows the story so far', () => {
        render(<App seed={7} />);
        // The story panel is closed by default — the tab sits top right
        expect(screen.queryByTestId('story-panel')).toBeNull();
        fireEvent.click(screen.getByTestId('story-tab'));
        expect(screen.getByTestId('story-panel')).toBeDefined();
        // Five beats so far: the four castaways wash ashore, Kiki wheels in
        expect(screen.getAllByTestId('story-entry').length).toBe(5);
        // Newest first — Kiki's arrival is the last logged, so the first shown
        expect(screen.getAllByTestId('story-entry')[0].textContent).toContain(
            'Kiki wheels above the island.',
        );
        // Collapsing again hides the story
        fireEvent.click(screen.getByTestId('story-tab'));
        expect(screen.queryByTestId('story-panel')).toBeNull();
    });

    it('stepping one tick advances the clock; the cast queues its first tasks', () => {
        render(<App seed={7} />);
        fireEvent.click(screen.getByTestId('step-button'));
        // One tick = ONE world minute (the Scale-0 pace) — the clock moved
        // one minute past the 10:00 birth
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:01');
        // The task-driven rhythm: the woodless cast plans the lumber rung
        // first — every castaway QUEUED a task at minute 1 (Ael travels to
        // the woods, the castaways on treed tiles chop). No story fires
        // (the cast landed far apart) and the motion is silent — the story
        // still holds the five spawn beats.
        fireEvent.click(screen.getByTestId('story-tab'));
        expect(screen.getAllByTestId('story-entry').length).toBe(5);
        // The roster rows now carry the actors' current task labels
        expect(screen.getByTestId('actor-task-actor-1').textContent).toBe('· travels to trees');
        expect(screen.getByTestId('actor-task-actor-4').textContent).toBe('· chops a tree');
    });

    it('the Entity Inspector opens in the left rail when a castaway is selected', () => {
        render(<App seed={7} />);
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        // The inspector reads as the ENTITY Inspector and it lives in the
        // left rail (beside the roster)
        expect(screen.getByRole('heading', { name: /entity inspector/i })).toBeDefined();
        // Inspector shows Ael's condition, profile and starting kit
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
        // The PROFILE row — the sex badge + sex (the fact the gendered
        // canvas emoji draw)
        expect(screen.getByTestId('actor-profile').textContent).toBe('♂ male');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('2 Berries');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('1 Flint');
        // The entity profile's ATTRIBUTES — the numbers that determine every
        // consumption and pace (Strength/Stamina/Speed/Dexterity)
        const attributes = screen.getByTestId('actor-attributes');
        expect(Array.from(attributes.children).map((child) => child.textContent)).toEqual([
            'Strength8', 'Stamina10', 'Speed10', 'Dexterity10',
        ]);
        // The ABILITIES — the species' capability set (no fly for people)
        expect(screen.getByTestId('actor-abilities').textContent).toBe('walkrunswimminecraft');
        // The bag's SIZE — the species-defined capacity with the kit inside
        expect(screen.getByTestId('actor-carry').textContent).toBe('Carries 3 / 8');
        // Deselect clears the inspector entirely
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
    });

    it('every living entity is listed on the left — the roster carries the creatures too', () => {
        render(<App seed={7} />);
        // The four castaways AND Kiki the seabird (the coordinate space is
        // the roster's source — every living thing appears)
        expect(screen.getByTestId('actor-chip-Ael')).toBeDefined();
        expect(screen.getByTestId('actor-chip-Bram')).toBeDefined();
        expect(screen.getByTestId('actor-chip-Cove')).toBeDefined();
        expect(screen.getByTestId('actor-chip-Dune')).toBeDefined();
        expect(screen.getByTestId('actor-chip-Kiki')).toBeDefined();
        // The bird's species tag rides the name row
        expect(screen.getByTestId('actor-chip-Kiki').textContent).toContain('bird');
        // The bird's stat bars read the bird profile's starting values:
        // fullness 90, hydration 90, energy 100 — and health full like
        // every fresh body
        const stats = screen.getByTestId('actor-stats-Kiki');
        expect((stats.children[0] as HTMLElement).title).toBe('Fullness 90%');
        expect((stats.children[1] as HTMLElement).title).toBe('Hydration 90%');
        expect((stats.children[2] as HTMLElement).title).toBe('Energy 100%');
        expect((stats.children[3] as HTMLElement).title).toBe('Health 100%');
    });

    it('a wounded body reads its health bar down in the roster and the inspector', () => {
        // A Dashboard mounted over a handle the test owns — the wound is
        // driven through the needs handle (the same satisfy the predators
        // plugin wires for a bite)
        const island = createIslandWorld({ seed: 7 });
        render(<Dashboard island={island} onReroll={() => undefined} />);
        // The mutation + the bridge pulse flush inside act — the world
        // change owes the view a re-render
        act(() => {
            island.needs.satisfy('actor-1', { health: -40 }); // Ael wounded to 60
            bumpRevision();
        });
        // The roster's health micro bar reads the wound
        const stats = screen.getByTestId('actor-stats-Ael');
        expect((stats.children[3] as HTMLElement).title).toBe('Health 60%');
        // The Entity Inspector's Health row reads the same reservoir
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        expect(screen.getByText('Health').parentElement?.textContent).toBe('Health60');
    });

    it('a body whose health runs out dies and leaves the roster; the log tells the ending', () => {
        const island = createIslandWorld({ seed: 7, actorCount: 1 });
        render(<Dashboard island={island} onReroll={() => undefined} />);
        // The reservoir drains to zero (a mauling's worth, twice over);
        // the mutation and the step flush inside act
        act(() => {
            island.needs.satisfy('actor-1', { health: -100 });
            island.world.step(); // the sweep finds the dry reservoir
            bumpRevision();
        });
        // Ael is gone from the roster — health 0 is death, for every body
        expect(screen.queryByTestId('actor-chip-Ael')).toBeNull();
        // The death is the story's ending — it stays in the log
        fireEvent.click(screen.getByTestId('story-tab'));
        expect(
            screen.getAllByTestId('story-entry').some((entry) => entry.textContent?.includes('Ael has died.')),
        ).toBe(true);
    });

    it('the Entity Inspector opens for a creature — species profile, attributes, abilities, beak-bag', () => {
        render(<App seed={7} />);
        // The roster chip selects the bird
        fireEvent.click(screen.getByTestId('actor-chip-Kiki'));
        // The condition derives from the same stat ladder (no record field
        // for creatures — the facet state is the altitude band)
        expect(screen.getByTestId('actor-condition').textContent).toBe('Kiki · well');
        // The PROFILE row reads the species label — no sex badge for a gull
        expect(screen.getByTestId('actor-profile').textContent).toBe('Seabird');
        // The bird's attributes (Strength 2, Stamina 8 — the soft-winged build)
        const attributes = screen.getByTestId('actor-attributes');
        expect(Array.from(attributes.children).map((child) => child.textContent)).toEqual([
            'Strength2', 'Stamina8', 'Speed10', 'Dexterity6',
        ]);
        // The bird's abilities: flight AND the ground hop, nothing else
        expect(screen.getByTestId('actor-abilities').textContent).toBe('flywalk');
        // The beak-bag: three units of carry, empty at birth
        expect(screen.getByTestId('actor-carry').textContent).toBe('Carries 0 / 3');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('Empty hands.');
        // Creatures keep no bond graph — the Bonds section never renders
        expect(screen.queryByTestId('actor-relations')).toBeNull();
    });

    it('a creature resident row opens the entity inspector from the tile', () => {
        render(<App seed={7} />);
        // Kiki wheels above the canvas middle — her tile (0,0) lists her as
        // a resident; clicking the ROW (not the tile) selects her
        fireEvent.click(screen.getByTestId('unicode-tile-0-0'));
        fireEvent.click(screen.getByText('Kiki — bird · flying-2 · z 2'));
        expect(screen.getByTestId('actor-condition').textContent).toBe('Kiki · well');
        expect(screen.getByTestId('actor-abilities').textContent).toBe('flywalk');
    });

    it('the female profile reads in the inspector and draws the female emoji', () => {
        render(<App seed={7} />);
        // Cove is the cast's woman: ♀ in the Entity Inspector, 🧍‍♀️ on the
        // unicode canvas at (1,5) — tile (5+8)×25+(1+12) = 338
        fireEvent.click(screen.getByTestId('actor-chip-Cove'));
        expect(screen.getByTestId('actor-profile').textContent).toBe('♀ female');
        expect(screen.getByTestId('world-grid-unicode').children[338].textContent).toBe('🧍‍♀️');
    });

    it('the bonds list holds exactly one row per fellow castaway — never self, never foreign pairs', () => {
        // Pin an 11×7 island (the compact board keeps the cast near enough
        // for encounters): one minute in, Ael and Cove meet and a scenario
        // fires from the one-shot deck
        render(<App seed={7} terrain={{ width: 11, height: 7 }} />);
        // Fresh world (tick 0): every pair is unacquainted → neutral (0)
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        const fresh = screen.getByTestId('actor-relations');
        expect(
            Array.from(fresh.children).map((child) => child.textContent),
        ).toEqual(['Bram — neutral (0)', 'Cove — neutral (0)', 'Dune — neutral (0)']);

        // 60 seeded steps (seed 7, one world minute each). Two scenarios
        // play (Spear Lessons +12, Ael–Cove, and Quiet Distrust −8,
        // Ael–Bram — the one-shot deck's first two cards for this seed) and
        // the drift nets the bonds to −7.72 / 10.82 — the DISPLAYED values
        // round to −8 and 11.
        for (let tick = 0; tick < 60; tick++) {
            fireEvent.click(screen.getByTestId('step-button'));
        }
        const stepped = screen.getByTestId('actor-relations');
        expect(
            Array.from(stepped.children).map((child) => child.textContent),
        ).toEqual(['Bram — neutral (-8)', 'Cove — neutral (11)', 'Dune — neutral (0)']);

        // A different selection never shows its own name either — the list is
        // always the OTHER castaways, so pairs between third parties cannot
        // be mislabelled as the inspected actor's bonds. Both scenarios bound
        // Ael to Cove and Bram — Cove's own bonds are untouched.
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        fireEvent.click(screen.getByTestId('actor-chip-Bram'));
        const bram = screen.getByTestId('actor-relations');
        const bramRows = Array.from(bram.children).map((child) => child.textContent);
        expect(bramRows).toEqual(['Ael — neutral (-8)', 'Cove — neutral (0)', 'Dune — neutral (0)']);
        expect(bramRows.join('|')).not.toContain('Bram');

        // The story feed carries the two encounters as coherent story blocks —
        // newest first, the latest scenario's block on top. The feed holds
        // 10 beats: five spawns, the two bond moves, the two story blocks
        // and Kiki's exit past the world's edge.
        fireEvent.click(screen.getByTestId('story-tab'));
        const entries = screen.getAllByTestId('story-entry');
        expect(entries.length).toBe(10);
        expect(entries[0].textContent).toContain('Quiet Distrust');
        expect(entries[0].textContent).toContain('Ael notices Bram counting the food stores');
    });

    it('the tick carries its fixed world minute at every view — the scale ladder is a pure view', () => {
        render(<App seed={7} />);
        fireEvent.click(screen.getByTestId('step-button'));
        // One tick = ONE world minute at the default (island) view
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:01');
        // Scale 1 (the island) — one tick is 1 minute, the scale line names both
        expect(screen.getByTestId('tick-label').textContent).toContain('Scale 1');
        expect(screen.getByTestId('tick-label').textContent).toContain('× 1 min');
        // Zoom into Ael's shore tile (−11,0): scale 0, the tile interior —
        // the tick is UNCHANGED (the view ladder never re-times the clock)
        fireEvent.click(screen.getByTestId('unicode-tile--11-0'));
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 0');
        expect(screen.getByTestId('tick-label').textContent).toContain('Scale 0');
        expect(screen.getByTestId('tick-label').textContent).toContain('× 1 min');
        // A step at scale 0 advances exactly one world minute
        fireEvent.click(screen.getByTestId('step-button'));
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:02');
        // Toggle back out: the step carries the same single minute
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        expect(screen.getByTestId('tick-label').textContent).toContain('× 1 min');
        fireEvent.click(screen.getByTestId('step-button'));
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:03');
    });

    it('clicking an empty land tile shows its terrain and ground stock, no residents', () => {
        render(<App seed={7} />);
        // Before any click the Tile Inspector waits for a pick
        expect(screen.getByTestId('tile-empty').textContent).toBe('Click a tile to inspect it.');
        // Tile (−5,−7) — a quiet beach: no glyph. It surfaces as SAND (the
        // unlimited deposit decides the tile's look) with a coconut on the
        // ground. Clicked on the default unicode board.
        fireEvent.click(screen.getByTestId('unicode-tile--5--7'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(-5, -7) · sand');
        expect(screen.getByTestId('tile-resources').textContent).toBe('sand ×∞');
        expect(screen.getByTestId('tile-terrain-meta').textContent).toBe(
            'height 3 · water line 3 · walkable',
        );
        expect(screen.getByTestId('tile-voxels').textContent).toBe('stone, soil, sand');
        // Scale-0 granularity: the ground generalizes into its CATEGORIES —
        // coconut is a food, the sand mirror is a material
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['Foods ×1', 'Materials ×1']);
        // Nobody lives here
        expect(
            Array.from(screen.getByTestId('tile-residents').children).map((child) => child.textContent),
        ).toEqual(['No one here.']);
        // A tile without a castaway never opens the actor inspector
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
    });

    it('clicking a sea tile shows the submerged voxel column with its fish stock', () => {
        render(<App seed={7} />);
        // Tile (−12,−8) — the top-left corner: shallow seabed under one
        // water voxel, fish swim here; sea columns carry no deposits, so
        // the tile keeps its plain biome surface
        fireEvent.click(screen.getByTestId('unicode-tile--12--8'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(-12, -8) · shallows');
        expect(screen.getByTestId('tile-resources').textContent).toBe('—');
        expect(screen.getByTestId('tile-terrain-meta').textContent).toBe(
            'height 2 · water line 3 · submerged',
        );
        expect(screen.getByTestId('tile-voxels').textContent).toBe('soil, sand, water');
        // The fish generalizes to its category at scale 0
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['Foods ×1']);
        expect(
            Array.from(screen.getByTestId('tile-residents').children).map((child) => child.textContent),
        ).toEqual(['No one here.']);
    });

    it('clicking a castaway tile opens both the tile inspector and the actor inspector', () => {
        render(<App seed={7} />);
        // Tile (−11,0) — Ael's shore landing spot, unlimited sand + a
        // coconut on the ground
        fireEvent.click(screen.getByTestId('unicode-tile--11-0'));
        // Tile layer: terrain + stock + Ael as the resident. Scale-0
        // granularity: the coconut generalizes to its category
        expect(screen.getByTestId('tile-position').textContent).toBe('(-11, 0) · sand');
        expect(screen.getByTestId('tile-ground').textContent).toContain('Foods ×1');
        expect(
            Array.from(screen.getByTestId('tile-residents').children).map((child) => child.textContent),
        ).toEqual(['Ael — human · well']);
        // Actor layer: the inspector opens for the castaway standing there
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('2 Berries');
    });

    it('clicking a bird tile shows the bird as a resident but no actor card', () => {
        render(<App seed={7} />);
        // Tile (0,0) — the canvas middle: a stone highland under Kiki the
        // flying gull (z 2)
        fireEvent.click(screen.getByTestId('unicode-tile-0-0'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(0, 0) · stone');
        expect(screen.getByTestId('tile-resources').textContent).toBe('stone ×1');
        // All living things are actors: the bird is listed as a resident
        expect(
            Array.from(screen.getByTestId('tile-residents').children).map((child) => child.textContent),
        ).toEqual(['Kiki — bird · flying-2 · z 2']);
        // Highland floor: the stone deposit — generalized to categories.
        // This run's highland hid a flint too (the survey's chance stream
        // moved with the richer map) — the tool is its own category
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['Materials ×1', 'Tools ×1']);
        // …but the tile click selects no entity — no inspector card opens
        // (the resident ROW would; the tile click alone does not)
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
        expect(screen.getByTestId('actor-panel-empty').textContent).toBe(
            'Select an entity to inspect.',
        );
    });

    it('the tile inspector follows every subsequent click', () => {
        render(<App seed={7} />);
        // First inspect Dune's forest landing spot…
        fireEvent.click(screen.getByTestId('unicode-tile-5--1'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(5, -1) · tree');
        expect(
            Array.from(screen.getByTestId('tile-residents').children).map((child) => child.textContent),
        ).toEqual(['Dune — human · well']);
        // …then hop over to a submerged shallows tile
        fireEvent.click(screen.getByTestId('unicode-tile--12--8'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(-12, -8) · shallows');
        expect(screen.getByTestId('tile-terrain-meta').textContent).toBe(
            'height 2 · water line 3 · submerged',
        );
        expect(screen.getByTestId('tile-voxels').textContent).toBe('soil, sand, water');
        // The fish generalizes to its category at scale 0
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['Foods ×1']);
        expect(
            Array.from(screen.getByTestId('tile-residents').children).map((child) => child.textContent),
        ).toEqual(['No one here.']);
        // The castaway inspector keeps Dune — tile picks and actor picks are
        // independent inspections
        expect(screen.getByTestId('actor-condition').textContent).toBe('Dune · well');
    });

    it('a resident row opens the full actor card for castaways', () => {
        render(<App seed={7} />);
        fireEvent.click(screen.getByTestId('unicode-tile--11-0'));
        // The resident row for Ael is a button — click it to focus the
        // Entity Inspector on him
        fireEvent.click(screen.getByText('Ael — human · well'));
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('2 Berries');
    });

    it('tile picks and entity picks highlight in two different colors on the canvas', () => {
        render(<App seed={7} />);
        // Emotion emits TWO rules per styled cell — the shared static paint
        // and the prop-driven (custom) one inside a @media wrapper — so the
        // rule reader walks EVERY class of the element and keeps the rule
        // carrying the border declaration (kept raw — the border value's
        // inner spaces read naturally)
        const ruleOf = (element: Element): string => {
            const css = Array.from(document.querySelectorAll('style'))
                .map((tag) => tag.textContent ?? '')
                .join('');
            const rules = Array.from(element.classList).flatMap((className) =>
                [...css.matchAll(new RegExp(`\\.${className}[^{]*\\{[^}]*\\}`, 'g'))].map((match) => match[0]),
            );
            return rules.find((rule) => rule.includes('border:')) ?? '';
        };
        // An ENTITY pick (roster chip → Ael selected): his unicode tile
        // wears the TEAL accent border (the Entity Inspector's subject)
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        const ael = screen.getByTestId('unicode-tile--11-0');
        expect(ruleOf(ael)).toContain('border:2px solid #63b995');
        // Nobody picked: the tile drops back to the plain hairline
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        expect(ruleOf(ael)).toContain('border:1px solid rgba(0,0,0,0.3)');
        // A TILE pick (an empty beach inspected): the AMBER tileAccent
        // border — a different color than the entity pick's teal
        fireEvent.click(screen.getByTestId('unicode-tile--5--7'));
        const beach = screen.getByTestId('unicode-tile--5--7');
        expect(ruleOf(beach)).toContain('border:2px solid #c98a2d');
        // One tile both inspected AND its castaway selected (clicking a
        // castaway's tile does both): the ENTITY pick wins the paint —
        // teal, never amber
        fireEvent.click(screen.getByTestId('unicode-tile--11-0'));
        expect(ruleOf(ael)).toContain('border:2px solid #63b995');
    });

    it('the ONE zoom toggle flips the two-rung ladder: island view ↔ tile interior', () => {
        render(<App seed={7} />);
        // Scale 1 — the island view (the default). There is no wider view
        // above the island, and zooming in needs an inspected tile (its
        // target) — with nothing picked the single toggle stands off
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
        expect((screen.getByTestId('zoom-toggle') as HTMLButtonElement).disabled).toBe(true);
        // Ael's shore tile (−11, 0) becomes the zoom target
        fireEvent.click(screen.getByTestId('unicode-tile--11-0'));
        expect((screen.getByTestId('zoom-toggle') as HTMLButtonElement).disabled).toBe(false);
        // Toggle: the SAME unicode tab renders the tile's sub-grid — the
        // identical dimensions (25×17 = 425 tiles), identical interactions,
        // the tiles now SUBTILES. The scale descends to 0 — the tile
        // interior, the simulation ground. The selection moved to the center
        // subtile.
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 0');
        expect(screen.getByTestId('world-grid-unicode').children.length).toBe(425);
        expect(screen.getByTestId('tile-position').textContent).toBe('(-11, 0) · (0, 0) · sand');
        // The zoomed tiles are the beach's interior: every subtile carries
        // the unlimited sand — the beach's look survives the zoom — and Ael
        // stands at his fine spot (−8, 0) inside his tile's sub-grid
        const aelSubtile = screen.getByTestId('unicode-tile--8-0');
        expect(aelSubtile.textContent).toBe('🧍‍♂️');
        expect(aelSubtile.title).toContain('Ael · well');
        // The ground items become VISIBLE canvas objects in the interior
        // view: the coconut lies at its scattered subtile (−11, 5), drawn as
        // its emoji
        const coconut = screen.getByTestId('unicode-tile--11-5');
        expect(coconut.textContent).toBe('🥥');
        expect(coconut.title).toContain('Coconut');
        // The sub-grid keeps every inspection working exactly like the
        // island view: clicking the inspected subtile opens the Tile
        // Inspector's lineage
        fireEvent.click(screen.getByTestId('unicode-tile-0-0'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(-11, 0) · (0, 0) · sand');
        expect(screen.getByTestId('tile-resources').textContent).toBe('sand ×∞');
        // The item-level granularity: the coconut's subtile lists it BY NAME
        fireEvent.click(coconut);
        expect(screen.getByTestId('tile-position').textContent).toBe('(-11, 0) · (-11, 5) · sand');
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['1 Coconut']);
        // …and clicking Ael's subtile opens the Entity Inspector straight
        // from the zoomed view
        fireEvent.click(aelSubtile);
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
        // Toggle out again: the island returns with the parent tile still
        // inspected (the zoom lineage pops one step) — and the toggle can
        // zoom straight back in
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
        expect(screen.getByTestId('world-grid-unicode').children.length).toBe(425);
        expect(screen.getByTestId('tile-position').textContent).toBe('(-11, 0) · sand');
        expect((screen.getByTestId('zoom-toggle') as HTMLButtonElement).disabled).toBe(false);
    });

    it('scrolling the mouse wheel over a tile board zooms the selected tile in and out', () => {
        render(<App seed={7} />);
        // Island view, nothing selected — the wheel is NOT hijacked: no
        // zoom target (the same contract the Zoom In button has), so the
        // page keeps its scroll and the view stays put
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
        fireEvent.wheel(screen.getByTestId('world-grid-unicode'), { deltaY: -120 });
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
        // A selected tile is the zoom target: scrolling UP descends into
        // it — the same relay the Zoom In button drives (the selection
        // extends with the sub-grid's center tile)
        fireEvent.click(screen.getByTestId('unicode-tile--11-0'));
        fireEvent.wheel(screen.getByTestId('world-grid-unicode'), { deltaY: -120 });
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 0');
        expect(screen.getByTestId('tile-position').textContent).toBe('(-11, 0) · (0, 0) · sand');
        // Scrolling DOWN pops back up the lineage — the Zoom Out relay
        fireEvent.wheel(screen.getByTestId('world-grid-unicode'), { deltaY: 120 });
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
        expect(screen.getByTestId('tile-position').textContent).toBe('(-11, 0) · sand');
        // At the ladder's top (island view) scroll-down cannot zoom out
        // either — the wheel is inert again
        fireEvent.wheel(screen.getByTestId('world-grid-unicode'), { deltaY: 120 });
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
    });

    it('ground items appear as canvas objects only in the interior view (scale 0)', () => {
        render(<App seed={7} />);
        // Scale 1 (the island view): the meadow tile (1,−4) shows nothing but
        // terrain — the berries stay list-only (the category read), never
        // canvas objects
        expect((screen.getByTestId('unicode-tile-1--4').textContent)).toBe('');
        // Zoom into the meadow: the interior view (scale 0) — its two berries
        // stand at their scattered subtiles (5,1) and (7,−6) as visible objects
        fireEvent.click(screen.getByTestId('unicode-tile-1--4'));
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 0');
        expect(screen.getByTestId('unicode-tile-5-1').textContent).toBe('🍒');
        expect(screen.getByTestId('unicode-tile-7--6').textContent).toBe('🍒');
        // The berry subtiles list their berries by name (item granularity)
        fireEvent.click(screen.getByTestId('unicode-tile-5-1'));
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['1 Berry']);
        // Kiki zoomed at her own tile stands at her fine spot (4, −6) — no
        // altitude superscript (the stone stock never becomes a canvas
        // object: tile-resource units ARE the subtile surfaces)
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        fireEvent.click(screen.getByTestId('unicode-tile-0-0'));
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        expect(screen.getByTestId('unicode-tile-4--6').textContent).toBe('🐦');
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        // The fish floats as an object at its scattered subtile (9, 5)
        fireEvent.click(screen.getByTestId('unicode-tile--12--8'));
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        const fish = screen.getByTestId('unicode-tile-9-5');
        expect(fish.textContent).toBe('🐟');
        expect(fish.title).toContain('Fish');
    });

    it('treed tiles draw the tree icon in unicode and the vector tree in svg', () => {
        render(<App seed={7} />);
        // A treed tile with nobody standing on it: (3,−6) → tile
        // (−6+8)×25+(3+12) = 65 — the unicode tab draws the 🌳 tree emoji
        // (the woods, visible at last; the decoration rides the frame data
        // the canvas plugins expose)
        const treed = screen.getByTestId('unicode-tile-3--6');
        expect(treed.textContent).toBe('🌳');
        expect(treed.querySelector('[data-testid="tree-icon-unicode"]')).not.toBeNull();
        expect(treed.title).toContain('tree ×2');
        // A treed tile with a castaway standing on it: Dune came ashore on
        // the treed tile (5,−1) — the entity wins the tile, no tree icon
        expect(screen.getByTestId('unicode-tile-5--1').textContent).toBe('🧍‍♂️');
        // A bare meadow tile draws nothing — terrain is color-only (the
        // no-flood rule the decorations never break)
        expect(screen.getByTestId('unicode-tile-1--4').textContent).toBe('');
        // ── The SVG twin — the vector tree icon ──────────────────────────
        fireEvent.click(screen.getByTestId('canvas-tab-svg'));
        const board = screen.getByTestId('world-grid-svg') as SVGSVGElement;
        const tiles = board.querySelectorAll('g');
        const treedTile = tiles[65];
        // The vector tree: canopy circle + trunk rect, NO text glyph (the
        // svg twin of the 🌳 emoji)
        expect(treedTile.querySelector('text')).toBeNull();
        expect(treedTile.querySelector('[data-testid="tree-icon-svg-canopy"]')).not.toBeNull();
        expect(treedTile.querySelector('[data-testid="tree-icon-svg-trunk"]')).not.toBeNull();
        // Dune's treed tile keeps its entity text — the entity always wins
        expect(tiles[192].querySelector('text')?.textContent).toBe('🧍‍♂️');
        // A bare sea tile draws neither icon nor text
        expect(tiles[0].querySelector('[data-testid="tree-icon-svg-canopy"]')).toBeNull();
        expect(tiles[0].querySelector('text')).toBeNull();
    });

    it('the canvas area tabs between Data, ASCII, Unicode and SVG representations', () => {
        render(<App seed={7} />);
        // Unicode (emoji) is the default tab
        expect(screen.getByTestId('canvas-tab-unicode')).toBeDefined();
        expect(screen.getByTestId('world-grid-unicode')).toBeDefined();
        expect(screen.queryByTestId('world-grid')).toBeNull();
        expect(screen.queryByTestId('world-grid-svg')).toBeNull();
        expect(screen.queryByTestId('data-tables')).toBeNull();

        // ── The default unicode view ─────────────────────────────────────
        // Same 425 tiles at the emoji tile size; Kiki renders as the bird
        // emoji at the center (0,0) — tile 212 (no altitude superscript);
        // Ael as the GENDERED human emoji (male) at his shore spot (−11,0)
        // — tile 201
        const uni = screen.getByTestId('world-grid-unicode');
        expect(uni.children.length).toBe(425);
        expect((uni.children[212] as HTMLElement).textContent).toBe('🐦');
        expect((uni.children[201] as HTMLElement).textContent).toBe('🧍‍♂️');
        // Empty tiles stay BARE — no per-tile terrain emoji flood
        // (top-left corner shallows, tile 0: background color only)
        expect((uni.children[0] as HTMLElement).textContent).toBe('');
        // Clicks still inspect: Ael's emoji tile opens the actor inspector
        fireEvent.click(screen.getByTestId('unicode-tile--11-0'));
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');

        // ── ASCII tab — the letter twin ──────────────────────────────────
        fireEvent.click(screen.getByTestId('canvas-tab-ascii'));
        expect(screen.getByTestId('world-grid').children.length).toBe(425);
        expect((screen.getByTestId('world-grid').children[201] as HTMLElement).textContent).toBe('A');

        // ── SVG tab — the vector twin ─────────────────────────────────────
        fireEvent.click(screen.getByTestId('canvas-tab-svg'));
        const board = screen.getByTestId('world-grid-svg') as SVGSVGElement;
        // The viewBox spans 25×26 × 17×26 user units — the SAME 26px tile
        // occupation the ascii/unicode boards draw
        expect(board.getAttribute('viewBox')).toBe('0 0 650 442');
        // One tile group per island cell (25×17 = 425)
        const tiles = board.querySelectorAll('g');
        expect(tiles.length).toBe(425);
        // Ael renders as the gendered human emoji text at his shore tile
        // (index 201)
        expect(tiles[201].querySelector('text')?.textContent).toBe('🧍‍♂️');
        // Kiki wheels at the center — the plain emoji, no altitude superscript
        expect(tiles[212].querySelector('text')?.textContent).toBe('🐦');
        // Empty sea tiles draw NO text — terrain shows through the rect fill
        // alone (the flood fix); the fill is the exact biome palette color
        // (top-left corner: the shallows of tile (−12, −8))
        expect(tiles[0].querySelector('text')).toBeNull();
        expect(tiles[0].querySelector('rect')?.getAttribute('fill')).toBe('#265d7d');
        // Native SVG hover notes ride every tile group
        expect(tiles[0].querySelector('title')?.textContent).toContain('shallows');
        // Clicks still inspect: Ael's SVG tile opens the actor inspector
        fireEvent.click(screen.getByTestId('svg-tile--11-0'));
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');

        // ── Data tab — the plain-tables view ──────────────────────────────
        fireEvent.click(screen.getByTestId('canvas-tab-data'));
        expect(screen.queryByTestId('world-grid')).toBeNull();
        const tables = screen.getByTestId('data-tables');
        expect(tables.children.length).toBe(3);
        // Positions table: bird first (kind order), then the cast in id order
        const positions = screen.getByTestId('data-table-positions');
        expect(positions.textContent).toContain('Positions');
        expect(positions.textContent).toContain('bird-1');
        expect(positions.textContent).toContain('Ael');
        expect(positions.textContent).toContain('-11');
        // Terrain census + canvas overview — the census counts SURFACE keys
        // (tiles appear as the resources they carry: dirt/sand/wood/stone/iron)
        expect(screen.getByTestId('data-table-terrain').textContent).toContain('sand');
        expect(screen.getByTestId('data-table-terrain').textContent).toContain('stone');
        expect(screen.getByTestId('data-table-canvas').textContent).toContain('425');

        // ── Back to Unicode — the default view ────────────────────────────
        fireEvent.click(screen.getByTestId('canvas-tab-unicode'));
        expect(screen.getByTestId('world-grid-unicode').children.length).toBe(425);
        expect((screen.getByTestId('world-grid-unicode').children[201] as HTMLElement).textContent).toBe('🧍‍♂️');
    });

    it('every tile canvas occupies the SAME tile grid as the ascii canvas', () => {
        // The layout-parity contract: the unicode tab once painted 30px
        // emoji tiles and blew this panel wide. Every tile tab now derives
        // its grid rule from the ascii canvas' 26px tile.
        render(<App seed={7} />);
        const css = () =>
            Array.from(document.querySelectorAll('style'))
                .map((tag) => tag.textContent ?? '')
                .join('');
        // Extracts the emotion grid rule belonging to one mounted board
        // (whitespace stripped — stylis keeps the space inside
        // `repeat(25, 26px)` and only minifies around separators)
        const gridRule = (className: string): string =>
            (css().match(
                new RegExp(`\\.${className}[^{]*\\{[^}]*grid-template-columns:[^;}]*`),
            )?.[0] ?? '').replace(/\s+/g, '');
        // Capture each board's class while ITS tab is mounted (one canvas at
        // a time renders, but emotion rules persist across tab switches) —
        // the unicode board mounts by default, so the ascii board is
        // mounted by clicking its tab first
        fireEvent.click(screen.getByTestId('canvas-tab-ascii'));
        const asciiClass = (screen.getByTestId('world-grid') as HTMLElement).className;
        fireEvent.click(screen.getByTestId('canvas-tab-unicode'));
        const unicodeClass = (screen.getByTestId('world-grid-unicode') as HTMLElement).className;
        // Both grids repeat the SAME 26px columns for the 25-wide island
        expect(gridRule(asciiClass)).toContain('grid-template-columns:repeat(25,26px)');
        expect(gridRule(unicodeClass)).toContain('grid-template-columns:repeat(25,26px)');
        // The SVG tab carries its geometry in the viewBox instead — same
        // 26px tile edge, no CSS grid to overflow
        fireEvent.click(screen.getByTestId('canvas-tab-svg'));
        expect(
            (screen.getByTestId('world-grid-svg') as SVGSVGElement).getAttribute('viewBox'),
        ).toBe('0 0 650 442');
    });

    it('the header reroll regenerates the whole world — fresh seed, picked size', () => {
        // Pin the Math.random stream so both rolls are deterministic:
        // 0.123456 → the INITIAL seed 123456, 0.654321 → the REROLL seed
        // 654321 (a reroll NEVER reuses the previous seed)
        const roll = vi.spyOn(Math, 'random').mockReturnValue(0.123456);
        try {
            render(<App />);
            expect(screen.getByTestId('world-seed').textContent).toBe('123456');
            // The pickers read the live terrain size (the 25×17 default)
            expect((screen.getByTestId('world-size-width') as HTMLSelectElement).value).toBe('25');
            expect((screen.getByTestId('world-size-height') as HTMLSelectElement).value).toBe('17');
            // Pick a smaller world: 21×13, then reroll
            roll.mockReturnValue(0.654321);
            fireEvent.change(screen.getByTestId('world-size-width'), { target: { value: '21' } });
            fireEvent.change(screen.getByTestId('world-size-height'), { target: { value: '13' } });
            fireEvent.click(screen.getByTestId('world-size-reroll'));
            // A brand-new world: seed 654321, canvas 21×13 = 273 tiles (the
            // default emoji view), the pickers showing the new live size
            expect(screen.getByTestId('world-seed').textContent).toBe('654321');
            expect(screen.getByTestId('world-grid-unicode').children.length).toBe(273);
            expect((screen.getByTestId('world-size-width') as HTMLSelectElement).value).toBe('21');
            expect((screen.getByTestId('world-size-height') as HTMLSelectElement).value).toBe('13');
            // Kiki wheels above the new center (0,0) — tile (0+6)×21+(0+10) = 136
            expect((screen.getByTestId('world-grid-unicode').children[136] as HTMLElement).textContent).toBe('🐦');
            // A fresh cast washed ashore: the story holds exactly the new
            // world's five spawn beats (four castaways + the bird, newest
            // first) — the old world's chronicle is gone with it
            fireEvent.click(screen.getByTestId('story-tab'));
            const entries = screen.getAllByTestId('story-entry');
            expect(entries.length).toBe(5);
            expect(entries[0].textContent).toContain('Kiki wheels above the island.');
            expect(entries[1].textContent).toContain('washes ashore');
            expect(screen.getByTestId('actor-chip-Ael').textContent).toContain('Ael');
            expect(screen.getByTestId('actor-chip-Dune').textContent).toContain('Dune');
        } finally {
            // Restore the real Math.random so no other test sees the fake
            roll.mockRestore();
        }
    });

    it('every reload rolls a completely random seed when none is pinned', () => {
        // Pin the Math.random stream so the roll is deterministic in the
        // test: 0.123456 × 1000000 → seed 123456
        const roll = vi.spyOn(Math, 'random').mockReturnValue(0.123456);
        try {
            const first = render(<App />);
            // The rolled seed shows in the header subtitle
            expect(screen.getByTestId('world-seed').textContent).toBe('123456');
            // A remount is a reload: the next roll draws a different value
            // (0.654321 → seed 654321) → a different island
            roll.mockReturnValue(0.654321);
            first.unmount();
            render(<App />);
            expect(screen.getByTestId('world-seed').textContent).toBe('654321');
        } finally {
            // Restore the real Math.random so no other test sees the fake
            roll.mockRestore();
        }
    });
});
