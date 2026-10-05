// Tests for the god-view App (src/App.tsx).
// Every test pins <App seed={7} /> so assertions run against the
// deterministic seed-7 island (default 37×25, centered coordinates — (0, 0)
// is the canvas middle); the random-roll behaviour of an unpinned reload
// has its own dedicated test below.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { App } from './App';

describe('App', () => {
    it('renders the god view with title, clock and the full island grid', () => {
        render(<App seed={7} />);
        expect(screen.getByRole('heading', { name: /stranded island/i })).toBeDefined();
        // Seed 7, tickSize 10 — the island's calendar is born at 10:00 on
        // January 1, 1609 (scenario/temporal.ts), January opens Winter
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:00');
        // Default view is the unicode (emoji) canvas — 925 voxel cells
        expect(screen.getByTestId('world-grid-unicode').children.length).toBe(925);
        // All four castaways are on the board
        expect(screen.getByTestId('actor-chip-Ael').textContent).toContain('Ael');
        expect(screen.getByTestId('actor-chip-Bram').textContent).toContain('Bram');
        expect(screen.getByTestId('actor-chip-Cove').textContent).toContain('Cove');
        expect(screen.getByTestId('actor-chip-Dune').textContent).toContain('Dune');
        // The plugin roster shows the mounted environment modules — the
        // seabirds plugin plus the four @godspace/canvas representations
        expect(screen.getByTestId('plugin-roster').textContent).toBe(
            'Island Terrain · Inventories & Exchange · Survival Needs · Relationships · Agent Behavior · Seabirds · ASCII Canvas · Unicode Canvas · SVG Canvas · Data Canvas',
        );
        // Kiki wheels above the island center (0,0) at z 2 — tile index
        // (0+12)×37+(0+18) = 462, her altitude drawn as a superscript emoji
        const grid = screen.getByTestId('world-grid-unicode');
        expect((grid.children[462] as HTMLElement).textContent).toBe('🐦²');
        expect((grid.children[462] as HTMLElement).title).toContain('Kiki · flying · z 2');
        // Ael came ashore at the island edge (17,−11) — tile (−11+12)×37+(17+18)
        // = 72, the human emoji, no altitude
        expect((grid.children[72] as HTMLElement).textContent).toBe('🧍');
        expect((grid.children[72] as HTMLElement).title).toContain('Ael · well');
    });

    it('every castaway row carries the compact 3-bar wellbeing overview', () => {
        render(<App seed={7} />);
        // Starting needs: hunger 20, thirst 20, energy 100 → wellbeing bars
        // invert the pressure: fullness 80, hydration 80, energy 100
        const stats = screen.getByTestId('actor-stats-Ael');
        expect(stats.children.length).toBe(3);
        // Hover titles name the metric (fullness/hydration are the inverted reads)
        expect((stats.children[0] as HTMLElement).title).toBe('Fullness 80%');
        expect((stats.children[1] as HTMLElement).title).toBe('Hydration 80%');
        expect((stats.children[2] as HTMLElement).title).toBe('Energy 100%');
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
    });

    it('the world log stays collapsed until opened', () => {
        render(<App seed={7} />);
        // Four spawn events + Kiki's arrival, hidden behind the toggle
        expect(screen.queryByTestId('event-log')).toBeNull();
        fireEvent.click(screen.getByTestId('log-toggle'));
        expect(screen.getAllByTestId('event-row').length).toBe(5);
        // Collapsing again hides them
        fireEvent.click(screen.getByTestId('log-toggle'));
        expect(screen.queryByTestId('event-log')).toBeNull();
    });

    it('stepping one tick advances the clock; the opened log shows the moves', () => {
        render(<App seed={7} />);
        fireEvent.click(screen.getByTestId('log-toggle'));
        fireEvent.click(screen.getByTestId('step-button'));
        // tickSize 10 → the clock moved 10 world minutes (from the 10:00 birth)
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:10');
        // Five arrivals + 50 moves: every castaway wanders once per
        // world-minute (4 × 10) and Kiki glides once per minute (10) — the
        // step's minutes run one at a time (the smallest-scale rule).
        // The log view shows the newest 30 of the 55 events.
        expect(screen.getAllByTestId('event-row').length).toBe(30);
        // Newest first: the seabird glided last (birds tick after behavior)
        expect(screen.getAllByTestId('event-row')[0].textContent).toContain('Kiki glides north.');
        // Temporal calendar stamps on the log rows: every step-1 event is
        // stamped 10 minutes past the 10:00 birth, January 1 of Year 1609
        expect(screen.getAllByTestId('event-row')[0].textContent).toContain('Jan 1 · 10:10');
    });

    it('the inspector opens in the left rail when a castaway is selected', () => {
        render(<App seed={7} />);
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        // Inspector shows Ael's condition and starting kit
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('2 Berries');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('1 Flint');
        // History is hidden until its toggle is clicked
        expect(screen.queryByTestId('actor-history')).toBeNull();
        fireEvent.click(screen.getByTestId('history-toggle'));
        expect(screen.getByTestId('actor-history').textContent).toContain('Ael washes ashore.');
        // Deselect clears the inspector entirely
        fireEvent.click(screen.getByTestId('history-toggle'));
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
        expect(screen.queryByTestId('actor-history')).toBeNull();
    });

    it('the bonds list holds exactly one row per fellow castaway — never self, never foreign pairs', () => {
        // The cast must sit close together for socials to fire within 60
        // ticks — pin an 11×7 island (spread positions captured below)
        render(<App seed={7} terrain={{ width: 11, height: 7 }} />);
        // Fresh world (tick 0): every pair is unacquainted → neutral (0)
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        const fresh = screen.getByTestId('actor-relations');
        expect(
            Array.from(fresh.children).map((child) => child.textContent),
        ).toEqual(['Bram — neutral (0)', 'Cove — neutral (0)', 'Dune — neutral (0)']);

        // 60 seeded steps (seed 7) — drift and socials move the values
        for (let tick = 0; tick < 60; tick++) {
            fireEvent.click(screen.getByTestId('step-button'));
        }
        // Values captured from the deterministic run (relationship drift
        // 0.02/min + behavior socials): 25.02→25, 12→12 — Cove crossed the
        // friendliness threshold (≥ 25)
        const stepped = screen.getByTestId('actor-relations');
        expect(
            Array.from(stepped.children).map((child) => child.textContent),
        ).toEqual(['Bram — neutral (0)', 'Cove — friendly (25)', 'Dune — neutral (12)']);

        // A different selection never shows its own name either — the list is
        // always the OTHER castaways, so pairs between third parties cannot
        // be mislabelled as the inspected actor's bonds.
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        fireEvent.click(screen.getByTestId('actor-chip-Bram'));
        const bram = screen.getByTestId('actor-relations');
        const bramRows = Array.from(bram.children).map((child) => child.textContent);
        expect(bramRows).toEqual(['Ael — neutral (0)', 'Cove — neutral (6)', 'Dune — neutral (21)']);
        expect(bramRows.join('|')).not.toContain('Bram');
    });

    it('the view scale defines the step time — zooming in refines the tick', () => {
        render(<App seed={7} />);
        fireEvent.click(screen.getByTestId('step-button'));
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:10');
        // Scale 0: one tick is 10 minutes — the scale line names both
        expect(screen.getByTestId('tick-label').textContent).toContain('Scale 0');
        expect(screen.getByTestId('tick-label').textContent).toContain('× 10 min');
        // Zoom into a tile: scale 1 → one tick is now ONE minute
        fireEvent.click(screen.getByTestId('unicode-tile-17--11'));
        fireEvent.click(screen.getByTestId('zoom-in'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
        expect(screen.getByTestId('tick-label').textContent).toContain('Scale 1');
        expect(screen.getByTestId('tick-label').textContent).toContain('× 1 min');
        // A step at scale 1 advances exactly one world minute
        fireEvent.click(screen.getByTestId('step-button'));
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:11');
        // Zoom back out: the step widens to 10 minutes again
        fireEvent.click(screen.getByTestId('zoom-out'));
        expect(screen.getByTestId('tick-label').textContent).toContain('× 10 min');
        fireEvent.click(screen.getByTestId('step-button'));
        expect(screen.getByTestId('world-clock').textContent).toBe('Year 1609 · Winter · Jan 1 · 10:21');
    });

    it('clicking an empty land tile shows its terrain and ground stock, no residents', () => {
        render(<App seed={7} />);
        // Before any click the Tile Inspector waits for a pick
        expect(screen.getByTestId('tile-empty').textContent).toBe('Click a tile to inspect it.');
        // Tile (−10,−11) — a quiet beach: no glyph. It surfaces as SAND (the
        // unlimited deposit decides the tile's look) with a coconut + hidden
        // shell on the ground. Clicked on the default unicode board.
        fireEvent.click(screen.getByTestId('unicode-tile--10--11'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(-10, -11) · sand');
        expect(screen.getByTestId('tile-resources').textContent).toBe('sand ×∞');
        expect(screen.getByTestId('tile-terrain-meta').textContent).toBe(
            'height 3 · water line 3 · walkable',
        );
        expect(screen.getByTestId('tile-voxels').textContent).toBe('stone, soil, sand');
        // Scale-0 granularity: the ground generalizes into its CATEGORIES —
        // coconut is a food, the sand/shell mirrors are materials
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['Foods ×1', 'Materials ×2']);
        // Nobody lives here
        expect(
            Array.from(screen.getByTestId('tile-residents').children).map((child) => child.textContent),
        ).toEqual(['No one here.']);
        // A tile without a castaway never opens the actor inspector
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
    });

    it('clicking a sea tile shows the submerged voxel column with its fish stock', () => {
        render(<App seed={7} />);
        // Tile (−18,−12) — the top-left corner: shallow seabed under one
        // water voxel, fish swim here; sea columns carry no deposits, so
        // the tile keeps its plain biome surface
        fireEvent.click(screen.getByTestId('unicode-tile--18--12'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(-18, -12) · shallows');
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
        // Tile (17,−11) — Ael's shore landing spot, unlimited sand + a
        // coconut on the ground
        fireEvent.click(screen.getByTestId('unicode-tile-17--11'));
        // Tile layer: terrain + stock + Ael as the resident. Scale-0
        // granularity: the coconut generalizes to its category
        expect(screen.getByTestId('tile-position').textContent).toBe('(17, -11) · sand');
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
        // Tile (0,0) — the canvas middle: a meadow (dirt tile) under Kiki
        // the flying gull (z 2)
        fireEvent.click(screen.getByTestId('unicode-tile-0-0'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(0, 0) · dirt');
        expect(screen.getByTestId('tile-resources').textContent).toBe('dirt ×∞');
        // All living things are actors: the bird is listed as a resident
        expect(
            Array.from(screen.getByTestId('tile-residents').children).map((child) => child.textContent),
        ).toEqual(['Kiki — bird · flying · z 2']);
        // Meadow floor: unlimited dirt + berries — generalized to categories
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['Foods ×2', 'Materials ×1']);
        // …but birds stay out of the castaway inspector — no actor card opens
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
        expect(screen.getByTestId('actor-panel-empty').textContent).toBe(
            'Select a castaway to inspect.',
        );
    });

    it('the tile inspector follows every subsequent click', () => {
        render(<App seed={7} />);
        // First inspect Dune's meadow landing spot…
        fireEvent.click(screen.getByTestId('unicode-tile--8-3'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(-8, 3) · dirt');
        expect(
            Array.from(screen.getByTestId('tile-residents').children).map((child) => child.textContent),
        ).toEqual(['Dune — human · well']);
        // …then hop over to a submerged shallows tile
        fireEvent.click(screen.getByTestId('unicode-tile--18--12'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(-18, -12) · shallows');
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
        fireEvent.click(screen.getByTestId('unicode-tile-17--11'));
        // The resident row for Ael is a button — click it to focus the
        // actor inspector on him
        fireEvent.click(screen.getByText('Ael — human · well'));
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('2 Berries');
    });

    it('zooming into an inspected tile opens its sub-grid — the same UI, one level down', () => {
        render(<App seed={7} />);
        // Scale 0 — the island view. Zoom-out is unreachable at the floor
        // (there is no wider view above the island) and zoom-in needs an
        // inspected tile — the zoom's target
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 0');
        expect((screen.getByTestId('zoom-out') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('zoom-in') as HTMLButtonElement).disabled).toBe(true);
        // Ael's shore tile (17, −11) becomes the zoom target
        fireEvent.click(screen.getByTestId('unicode-tile-17--11'));
        expect((screen.getByTestId('zoom-in') as HTMLButtonElement).disabled).toBe(false);
        // Zoom in: the SAME unicode tab renders the tile's sub-grid — the
        // identical dimensions (37×25 = 925 tiles), identical interactions,
        // the tiles now SUBTILES. The selection moved to the center subtile.
        fireEvent.click(screen.getByTestId('zoom-in'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
        expect(screen.getByTestId('world-grid-unicode').children.length).toBe(925);
        expect(screen.getByTestId('tile-position').textContent).toBe('(17, -11) · (0, 0) · sand');
        // The zoomed tiles are the beach's interior: every subtile carries
        // the unlimited sand — the beach's look survives the zoom — and Ael
        // stands at his fine spot (11, 3) inside his tile's sub-grid
        const aelSubtile = screen.getByTestId('unicode-tile-11-3');
        expect(aelSubtile.textContent).toBe('🧍');
        expect(aelSubtile.title).toContain('Ael · well');
        // The ground items become VISIBLE canvas objects at scale 1: the
        // coconut lies at its scattered subtile (11, −9), drawn as its emoji
        const coconut = screen.getByTestId('unicode-tile-11--9');
        expect(coconut.textContent).toBe('🥥');
        expect(coconut.title).toContain('Coconut');
        // The sub-grid keeps every inspection working exactly like scale 0:
        // clicking the inspected subtile opens the Tile Inspector's lineage
        fireEvent.click(screen.getByTestId('unicode-tile-0-0'));
        expect(screen.getByTestId('tile-position').textContent).toBe('(17, -11) · (0, 0) · sand');
        expect(screen.getByTestId('tile-resources').textContent).toBe('sand ×∞');
        // The item-level granularity: the coconut's subtile lists it BY NAME
        fireEvent.click(coconut);
        expect(screen.getByTestId('tile-position').textContent).toBe('(17, -11) · (11, -9) · sand');
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['1 Coconut']);
        // …and clicking Ael's subtile opens the actor inspector straight
        // from the zoomed view
        fireEvent.click(aelSubtile);
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
        // Zoom out: the island returns with the parent tile still inspected
        // (the zoom lineage pops one step)
        fireEvent.click(screen.getByTestId('zoom-out'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 0');
        expect(screen.getByTestId('world-grid-unicode').children.length).toBe(925);
        expect(screen.getByTestId('tile-position').textContent).toBe('(17, -11) · sand');
        expect((screen.getByTestId('zoom-in') as HTMLButtonElement).disabled).toBe(false);
    });

    it('ground items appear as canvas objects only from scale 1 up', () => {
        render(<App seed={7} />);
        // Scale 0: the meadow tile (0,0) shows Kiki only — the berries stay
        // list-only (the category read), never canvas objects here
        expect((screen.getByTestId('unicode-tile-0-0').textContent)).toBe('🐦²');
        // Zoom into the meadow: its two berries stand at their scattered
        // subtiles (−1,−1) and (−5,−3) as visible objects
        fireEvent.click(screen.getByTestId('unicode-tile-0-0'));
        fireEvent.click(screen.getByTestId('zoom-in'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
        expect(screen.getByTestId('unicode-tile--1--1').textContent).toBe('🍒');
        expect(screen.getByTestId('unicode-tile--5--3').textContent).toBe('🍒');
        // Kiki stands at her fine spot (6, −10) with her altitude superscript
        expect(screen.getByTestId('unicode-tile-6--10').textContent).toBe('🐦²');
        // The berry subtiles list their berries by name (item granularity)
        fireEvent.click(screen.getByTestId('unicode-tile--1--1'));
        expect(
            Array.from(screen.getByTestId('tile-ground').children).map((child) => child.textContent),
        ).toEqual(['1 Berry']);
        // Zoom out to the sea tile and in again: the fish floats as an
        // object at its scattered subtile (−4, −10)
        fireEvent.click(screen.getByTestId('zoom-out'));
        fireEvent.click(screen.getByTestId('unicode-tile--18--12'));
        fireEvent.click(screen.getByTestId('zoom-in'));
        const fish = screen.getByTestId('unicode-tile--4--10');
        expect(fish.textContent).toBe('🐟');
        expect(fish.title).toContain('Fish');
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
        // Same 925 tiles at the emoji tile size; Kiki renders as the bird
        // emoji with her altitude superscript at the center (0,0) — tile
        // 462; Ael as the human emoji at his shore spot (17,−11) — tile 72
        const uni = screen.getByTestId('world-grid-unicode');
        expect(uni.children.length).toBe(925);
        expect((uni.children[462] as HTMLElement).textContent).toBe('🐦²');
        expect((uni.children[72] as HTMLElement).textContent).toBe('🧍');
        // Empty tiles stay BARE — no per-tile terrain emoji flood
        // (top-left corner shallows, tile 0: background color only)
        expect((uni.children[0] as HTMLElement).textContent).toBe('');
        // Clicks still inspect: Ael's emoji tile opens the actor inspector
        fireEvent.click(screen.getByTestId('unicode-tile-17--11'));
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');

        // ── ASCII tab — the letter twin ──────────────────────────────────
        fireEvent.click(screen.getByTestId('canvas-tab-ascii'));
        expect(screen.getByTestId('world-grid').children.length).toBe(925);
        expect((screen.getByTestId('world-grid').children[72] as HTMLElement).textContent).toBe('A');

        // ── SVG tab — the vector twin ─────────────────────────────────────
        fireEvent.click(screen.getByTestId('canvas-tab-svg'));
        const board = screen.getByTestId('world-grid-svg') as SVGSVGElement;
        // The viewBox spans 37×26 × 25×26 user units — the SAME 26px tile
        // occupation the ascii/unicode boards draw
        expect(board.getAttribute('viewBox')).toBe('0 0 962 650');
        // One tile group per island cell (37×25 = 925)
        const tiles = board.querySelectorAll('g');
        expect(tiles.length).toBe(925);
        // Ael renders as the human emoji text at his shore tile (index 72)
        expect(tiles[72].querySelector('text')?.textContent).toBe('🧍');
        // Kiki wheels at the center — her glyph carries the altitude superscript
        expect(tiles[462].querySelector('text')?.textContent).toBe('🐦²');
        // Empty sea tiles draw NO text — terrain shows through the rect fill
        // alone (the flood fix); the fill is the exact biome palette color
        // (top-left corner: the shallows of tile (-18, −12))
        expect(tiles[0].querySelector('text')).toBeNull();
        expect(tiles[0].querySelector('rect')?.getAttribute('fill')).toBe('#265d7d');
        // Native SVG hover notes ride every tile group
        expect(tiles[0].querySelector('title')?.textContent).toContain('shallows');
        // Clicks still inspect: Ael's SVG tile opens the actor inspector
        fireEvent.click(screen.getByTestId('svg-tile-17--11'));
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
        expect(positions.textContent).toContain('17');
        // Terrain census + canvas overview — the census counts SURFACE keys
        // (tiles appear as the resources they carry: dirt/sand/wood/stone/iron)
        expect(screen.getByTestId('data-table-terrain').textContent).toContain('sand');
        expect(screen.getByTestId('data-table-terrain').textContent).toContain('iron');
        expect(screen.getByTestId('data-table-canvas').textContent).toContain('925');

        // ── Back to Unicode — the default view ────────────────────────────
        fireEvent.click(screen.getByTestId('canvas-tab-unicode'));
        expect(screen.getByTestId('world-grid-unicode').children.length).toBe(925);
        expect((screen.getByTestId('world-grid-unicode').children[72] as HTMLElement).textContent).toBe('🧍');
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
        // `repeat(37, 26px)` and only minifies around separators)
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
        // Both grids repeat the SAME 26px columns for the 37-wide island
        expect(gridRule(asciiClass)).toContain('grid-template-columns:repeat(37,26px)');
        expect(gridRule(unicodeClass)).toContain('grid-template-columns:repeat(37,26px)');
        // The SVG tab carries its geometry in the viewBox instead — same
        // 26px tile edge, no CSS grid to overflow
        fireEvent.click(screen.getByTestId('canvas-tab-svg'));
        expect(
            (screen.getByTestId('world-grid-svg') as SVGSVGElement).getAttribute('viewBox'),
        ).toBe('0 0 962 650');
    });

    it('the World Size controls reshape the island in place', () => {
        render(<App seed={7} />);
        // The live terrain size shows in the panel and drives the pickers
        expect(screen.getByTestId('world-size-current').textContent).toBe('37 × 25');
        expect((screen.getByTestId('world-size-width') as HTMLSelectElement).value).toBe('37');
        expect((screen.getByTestId('world-size-height') as HTMLSelectElement).value).toBe('25');
        // Nothing to apply while the pickers match the live size
        expect((screen.getByTestId('world-size-apply') as HTMLButtonElement).disabled).toBe(true);
        // Pick a smaller world: 21×13
        fireEvent.change(screen.getByTestId('world-size-width'), { target: { value: '21' } });
        expect((screen.getByTestId('world-size-apply') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.change(screen.getByTestId('world-size-height'), { target: { value: '13' } });
        fireEvent.click(screen.getByTestId('world-size-apply'));
        // The canvas regenerated — 21×13 = 273 tiles (the default emoji view)
        expect(screen.getByTestId('world-size-current').textContent).toBe('21 × 13');
        expect(screen.getByTestId('world-grid-unicode').children.length).toBe(273);
        // The pickers reset to the live size after applying
        expect((screen.getByTestId('world-size-width') as HTMLSelectElement).value).toBe('21');
        expect((screen.getByTestId('world-size-height') as HTMLSelectElement).value).toBe('13');
        expect((screen.getByTestId('world-size-apply') as HTMLButtonElement).disabled).toBe(true);
        // Kiki still wheels above the center (0,0) — tile (0+6)×21+(0+10) = 136
        expect((screen.getByTestId('world-grid-unicode').children[136] as HTMLElement).textContent).toBe('🐦²');
        // The cast is still on the board (settled onto dry land if needed)
        expect(screen.getByTestId('actor-chip-Ael').textContent).toContain('Ael');
        expect(screen.getByTestId('actor-chip-Dune').textContent).toContain('Dune');
        // The redraw landed in the world log
        fireEvent.click(screen.getByTestId('log-toggle'));
        expect(screen.getAllByTestId('event-row').length).toBe(6);
        expect(screen.getAllByTestId('event-row')[0].textContent).toContain(
            'The island is redrawn at 21×13.',
        );
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
