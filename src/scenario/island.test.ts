// Tests for the scenario composition root (scenario/island.ts).

import { describe, it, expect } from 'vitest';
import { createIslandWorld } from './island';

describe('createIslandWorld', () => {
    it('assembles all stock plugins in tick order (packages + environment)', () => {
        const handle = createIslandWorld({ seed: 7 });
        expect(handle.world.plugins.list().map((plugin) => plugin.id)).toEqual([
            'island-terrain',
            // The species registry — the per-type vocabulary the rest of the
            // environment reads (stats, attributes, abilities, movement,
            // inventory sizes)
            'entity',
            'inventory',
            // The forest ecology mounts right behind the inventory — its
            // tick advances the woods and its setup mounts the wood
            // harvest provider into the inventory
            'forest',
            'needs',
            'relationship',
            // The task ledger advances before the behavior tick; the
            // behaviour governance plugins (sleep, survival, lumber,
            // construction) register into the ledger right behind it; the
            // storyteller runs after the whole environment minute
            // (scenario/island.ts mount order)
            'tasks',
            'behavior',
            'sleep',
            'survival',
            'lumber',
            'construction',
            'story',
            'birds',
            'sharks',
            'predators',
            // The @godspace/canvas representation plugins, loaded by the engine
            'ascii-canvas',
            'unicode-canvas',
            'svg-canvas',
            'data-canvas',
        ]);
        expect(handle.world.ticker.tickSize()).toBe(1);
        // The canvas exists after terrain setup — the default 25×17 island
        // in centered coordinates ((0, 0) the exact middle)
        expect(handle.world.canvas).toEqual({
            width: 25,
            height: 17,
            cells: expect.any(Array),
        });
    });

    it('spawns the cast at the island edge with a starting kit', () => {
        const handle = createIslandWorld({ seed: 7 });
        // The ship wrecked on the coast — every castaway comes ashore on the
        // outermost dry ring (ranked by rim closeness, spread by stride).
        // Captured reference positions for the default 25×17 island. The
        // PROFILE rides along: each castaway's fixed sex (the gendered
        // emoji + the Entity Inspector's profile row draw it)
        expect(Array.from(handle.world.actors.values()).map((actor) => ({
            id: actor.id,
            name: actor.name,
            position: actor.position,
            sex: actor.profile.sex,
        }))).toEqual([
            { id: 'actor-1', name: 'Ael', position: { x: -11, y: 0, z: 0 }, sex: 'male' },
            { id: 'actor-2', name: 'Bram', position: { x: -9, y: -2, z: 0 }, sex: 'male' },
            { id: 'actor-3', name: 'Cove', position: { x: -2, y: 5, z: 0 }, sex: 'female' },
            { id: 'actor-4', name: 'Dune', position: { x: -5, y: -1, z: 0 }, sex: 'male' },
        ]);
        // Every landing spot is dry land, ranked from the outermost dry ring
        // inward (Ael's pick — edge[0] — IS the outermost land cell: no dry
        // cell ranks closer to the rim on this island)
        Array.from(handle.world.actors.values()).forEach((actor) => {
            expect(handle.world.cellAt(actor.position.x, actor.position.y)?.passable).toBe(true);
        });
        // The outermost dry ring's exact rim score, ranked first
        const rimScore = (cell: { x: number; y: number }) =>
            Math.max(Math.abs(cell.x) / 12, Math.abs(cell.y) / 8);
        const land = handle.world.landCells();
        const outermost = land
            .slice()
            .sort((left, right) => rimScore(right) - rimScore(left))[0];
        expect(outermost).toMatchObject({ x: -11, y: 0 });
        expect(rimScore(outermost)).toBeCloseTo(0.9166666666666666, 12);
        // Every castaway sits on the ground plane (z = 0) in the coordinate
        // record — the 3D spatial record holds the whole world
        expect(
            Array.from(handle.world.actors.keys()).map((id) => handle.world.coordinates.positionOf(id)?.z),
        ).toEqual([0, 0, 0, 0]);
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 2, flint: 1 });
        expect(handle.inventory.of('actor-4')).toEqual({ berry: 2, flint: 1 });
    });

    it('releases a seabird wheeling above the island center at cruise altitude', () => {
        const handle = createIslandWorld({ seed: 7 });
        const bird = handle.birds.birdOf('bird-1');
        expect(bird).toEqual({
            id: 'bird-1',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
            // World coordinates are centered — the island center IS (0, 0);
            // cruise altitude z = 2
            position: { x: 0, y: 0, z: 2 },
        });
        // The bird lives in the 3D spatial record — a creature of type bird,
        // its display state the z-2 fade band ('flying-2')
        expect(handle.world.coordinates.entryOf('bird-1')).toEqual({
            id: 'bird-1',
            position: { x: 0, y: 0, z: 2 },
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying-2',
        });
        // Birds are not castaways — they stay out of the actor registry
        expect(handle.world.actors.has('bird-1')).toBe(false);
        // Release log line lands after the four castaway spawns
        expect(handle.world.events.log().map((event) => event.message)).toEqual([
            'Ael washes ashore.',
            'Bram washes ashore.',
            'Cove washes ashore.',
            'Dune washes ashore.',
            'Kiki wheels above the island.',
        ]);
    });

    it('actorCount caps the cast', () => {
        const handle = createIslandWorld({ seed: 7, actorCount: 2 });
        expect(Array.from(handle.world.actors.keys())).toEqual(['actor-1', 'actor-2']);
    });

    it('runs: one Scale-0 tile per tick — the woodless cast works the woods, silently', () => {
        // The construction governance is OFF for this pin: its rungs
        // (deliver 24 … build 21) outrank the lumber chop (10) and would
        // re-plan the cast onto the build projects from minute 2 — the
        // pre-construction Scale-0 pacing contract is what's under test here
        // (the construction march has its own test below).
        const handle = createIslandWorld({ seed: 7, plugins: { construction: false } });
        handle.world.step();
        expect(handle.world.ticker.ticks()).toBe(1);
        // One step = ONE world minute (the Scale-0 pace). The task rhythm:
        // the lumber rung ranks above the idle wander — the woodless cast
        // plans wood first: Ael and Bram came ashore on bare shore and
        // travel to the woods (1-minute fine steps), while the castaways
        // standing on treed tiles queue the 15-minute chop. The first ledger
        // decrement lands at minute 2 — after ONE step every task still holds
        // time. Kiki glides once and the seeded rain of minute 1 pools water.
        expect(handle.world.ticker.elapsed()).toBe(1);
        // The whole motion stays out of the log — the event bus carries the
        // story (spawns, encounters, exchanges), never the position plumbing
        expect(handle.world.events.log().map((event) => event.kind)).toEqual([
            'spawn',
            'spawn',
            'spawn',
            'spawn',
            'spawn',
        ]);
        expect(Array.from(handle.world.actors.values()).map((actor) => ({ ...actor.position }))).toEqual([
            { x: -11, y: 0, z: 0 },
            { x: -9, y: -2, z: 0 },
            { x: -2, y: 5, z: 0 },
            { x: -5, y: -1, z: 0 },
        ]);
        expect(handle.tasks.tasks().map((task) => ({ actorId: task.actorId, kind: task.kind, label: task.label, remaining: task.remaining }))).toEqual([
            { actorId: 'actor-1', kind: 'move', label: 'travels to trees', remaining: 1 },
            { actorId: 'actor-2', kind: 'move', label: 'travels to trees', remaining: 1 },
            { actorId: 'actor-3', kind: 'chop', label: 'chops a tree', remaining: 15 },
            { actorId: 'actor-4', kind: 'chop', label: 'chops a tree', remaining: 15 },
        ]);
        // The SECOND minute carries the first completing task: Ael
        // fine-steps exactly ONE Scale-0 tile east (an interior move — the
        // island view's coarse position does not move yet); the choppers
        // stay put, counting their trees down.
        handle.world.step();
        expect(handle.world.ticker.elapsed()).toBe(2);
        expect(handle.world.events.log().map((event) => event.kind)).toEqual([
            'spawn',
            'spawn',
            'spawn',
            'spawn',
            'spawn',
        ]);
        expect(Array.from(handle.world.actors.values()).map((actor) => ({ ...actor.position }))).toEqual([
            { x: -11, y: 0, z: 0 },
            { x: -9, y: -2, z: 0 },
            { x: -2, y: 5, z: 0 },
            { x: -5, y: -1, z: 0 },
        ]);
        expect(Array.from(handle.world.actors.keys()).map((id) => handle.world.subOf(id))).toEqual([
            { x: -7, y: 0 },
            { x: -9, y: -8 },
            { x: -3, y: -2 },
            { x: -8, y: 2 },
        ]);
        // Eighteen more minutes: Ael keeps trekking east toward the woods
        // (19 interior fine steps — the wrap onto the next tile is still
        // one step away), the choppers finished at minute 16 and wandered
        // on (Dune's wandering wrapped off the tile's west edge — the
        // island position moved with it). The log gains the wilds' own
        // beat: Tusk the boar wanders in from the far shore at minute 6
        // (far from the cast — no meeting). The seeded rain of minute 8
        // now lands inside the window (the 0.8 basins shifted the survey's
        // roll stream — the water rhythm moved earlier).
        for (let index = 0; index < 18; index++) {
            handle.world.step();
        }
        expect(handle.world.ticker.elapsed()).toBe(20);
        expect(handle.world.events.log().map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Ael washes ashore.', time: 0 },
            { kind: 'spawn', message: 'Bram washes ashore.', time: 0 },
            { kind: 'spawn', message: 'Cove washes ashore.', time: 0 },
            { kind: 'spawn', message: 'Dune washes ashore.', time: 0 },
            { kind: 'spawn', message: 'Kiki wheels above the island.', time: 0 },
            { kind: 'spawn', message: 'Tusk wanders in from the wilds.', time: 6 },
            { kind: 'weather', message: 'Rain sweeps the island.', time: 8 },
        ]);
        // The boar roams the far shore — no castaway has met it yet. Tusk
        // is a living thing: the behavior plugin plans it through the
        // ledger (the predators plugin's own roam yields to the busy gate),
        // so its wandered position reads from the ledger's picks
        expect(handle.predators.predators()).toEqual([
            { id: 'boar-1', name: 'Tusk', marker: 'T', x: 3, y: 7 },
        ]);
        expect(Array.from(handle.world.actors.values()).map((actor) => ({ ...actor.position }))).toEqual([
            { x: -11, y: 0, z: 0 },
            { x: -9, y: -2, z: 0 },
            { x: -2, y: 5, z: 0 },
            { x: -5, y: -1, z: 0 },
        ]);
        expect(Array.from(handle.world.actors.keys()).map((id) => handle.world.subOf(id))).toEqual([
            { x: 11, y: 0 },
            { x: 9, y: -8 },
            { x: -4, y: -3 },
            { x: -7, y: 3 },
        ]);
    });

    it('plugin toggles swap environment behaviour out entirely', () => {
        // No tasks plugin → the behavior plugin cannot mount (it needs the
        // ledger) — actors stand still forever
        const still = createIslandWorld({ seed: 7, plugins: { tasks: false } });
        const before = Array.from(still.world.actors.values()).map((actor) => ({ ...actor.position }));
        for (let index = 0; index < 5; index++) {
            still.world.step();
        }
        const after = Array.from(still.world.actors.values()).map((actor) => ({ ...actor.position }));
        expect(after).toEqual(before);
        expect(still.world.plugins.has('tasks')).toBe(false);
        expect(still.world.plugins.has('behavior')).toBe(false);
        // Sleep needs the ledger too
        expect(still.world.plugins.has('sleep')).toBe(false);

        // Only terrain → a bare canvas world with no actors at all
        const bare = createIslandWorld({
            seed: 7,
            plugins: {
                inventory: false,
                needs: false,
                relationship: false,
                tasks: false,
                behavior: false,
                sleep: false,
                birds: false,
                sharks: false,
                ascii: false,
                unicode: false,
                svg: false,
                data: false,
            },
            actorCount: 0,
        });
        expect(bare.world.plugins.list().map((plugin) => plugin.id)).toEqual(['island-terrain', 'entity']);
        expect(bare.world.canvas.width).toBe(25);


        // Birds off → no bird in the spatial record, no birds plugin
        const grounded = createIslandWorld({ seed: 7, plugins: { birds: false } });
        expect(grounded.world.plugins.has('birds')).toBe(false);
        expect(grounded.world.coordinates.count()).toBe(4);
        expect(grounded.birds.birds()).toEqual([]);

        // ASCII canvas off → the ascii sibling is gone from the roster and
        // its frame is empty (unicode + svg + data still render)
        const unseen = createIslandWorld({ seed: 7, plugins: { ascii: false } });
        expect(unseen.world.plugins.has('ascii-canvas')).toBe(false);
        expect(unseen.ascii.frame()).toEqual({ columns: 0, rows: 0, tiles: [] });
        expect(unseen.world.plugins.has('unicode-canvas')).toBe(true);
        expect(unseen.world.plugins.has('svg-canvas')).toBe(true);
        expect(unseen.world.plugins.has('data-canvas')).toBe(true);

        // Unicode + data canvases off → only the ascii sibling renders
        const plain = createIslandWorld({ seed: 7, plugins: { unicode: false, data: false } });
        expect(plain.world.plugins.has('unicode-canvas')).toBe(false);
        expect(plain.world.plugins.has('data-canvas')).toBe(false);
        expect(plain.unicode.frame()).toEqual({ columns: 0, rows: 0, tiles: [] });
        expect(plain.data.frame()).toEqual({ tables: [] });

        // SVG canvas off → the vector sibling is gone, its frame empty
        const flat = createIslandWorld({ seed: 7, plugins: { svg: false } });
        expect(flat.world.plugins.has('svg-canvas')).toBe(false);
        expect(flat.svg.frame()).toEqual({ columns: 0, rows: 0, size: 26, tiles: [] });
    });

    it('with sleep off, an exhausted actor rests the old instant-rest way', () => {
        // The construction governance is OFF for this pin: its rungs outrank
        // the lumber chop and would re-route Dune's minutes 12–20 onto the
        // build projects (the rest arithmetic below pins the pure
        // sleep-off/instant-rest fallback, not the construction march).
        const handle = createIslandWorld({ seed: 7, plugins: { sleep: false, construction: false } });
        expect(handle.world.plugins.has('sleep')).toBe(false);
        expect(handle.world.plugins.has('tasks')).toBe(true);
        expect(handle.world.plugins.has('behavior')).toBe(true);
        // Drain Dune to the rest trigger (energy ≤ 22) and run 20 steps
        // (20 world minutes — the rest task is planned at minute 1 and
        // completes at minute 11; then the lumber rung takes over — Dune
        // stands on a treed tile and chops)
        handle.needs.satisfy('actor-4', { energy: -80 });
        for (let index = 0; index < 20; index++) {
            handle.world.step();
        }
        // The priority-25 rest rung of the behavior ladder handled it: the
        // 10-minute rest task with the one-shot +12 recovery (no per-minute
        // sleep restore), then pure decay through minute 20
        expect(handle.needs.of('actor-4').energy).toBe(30.800000000000026);
        // After the rest, the woodless Dune chops the tree standing on
        // Dune's tile (the lumber rung, priority 10 — below the rest rung)
        expect(handle.tasks.taskOf('actor-4')).toMatchObject({ kind: 'chop', label: 'chops a tree', remaining: 6 });
        expect(handle.world.events.log().filter((event) => event.actorId === 'actor-4').map((event) => ({ kind: event.kind, message: event.message, time: event.time }))).toEqual([
            { kind: 'spawn', message: 'Dune washes ashore.', time: 0 },
        ]);
    });

    it('the ascii canvas frame mirrors the world: tiles, glyphs and altitude', () => {
        const handle = createIslandWorld({ seed: 7 });
        const frame = handle.ascii.frame();
        // One tile per island cell, row-major (25×17 = 425)
        expect(frame.columns).toBe(25);
        expect(frame.rows).toBe(17);
        expect(frame.tiles.length).toBe(425);
        // Ael stands on the shore at (−11,0): tile 8×25+1 = 201 carries his
        // grounded glyph — a sentient of the human race — on a sand tile
        expect(frame.tiles[201].glyphs).toEqual([
            { id: 'actor-1', glyph: 'A', color: '#5cb85c', elevation: 0, kind: 'sentient', type: 'human', state: 'well' },
        ]);
        // R4: the column's bedrock reads gravel (not the stone that the
        // old endless ground supply buried under everything) and the beach
        // is no stone-bearing — the unlimited ground reads sand + dirt
        expect(frame.tiles[201].title).toBe('beach · height 3 · gravel / dirt / sand · sand ×∞ · dirt ×∞ · Ael · well');
        // The tile appears as the resource its ground is: the beach's
        // unlimited sand surface paints it with the sand palette color
        expect(frame.tiles[201].background).toBe('#d3bd85');
        // Kiki wheels at the center (0,0): tile 8×25+12 = 212 carries the
        // flying glyph with her altitude superscript — a creature of type
        // bird, colored by the z-2 fade band (BIRD_ALTITUDE_STATES)
        expect(frame.tiles[212].glyphs).toEqual([
            { id: 'bird-1', glyph: 'K', color: '#7ec8e3bf', elevation: 2, kind: 'creature', type: 'bird', state: 'flying-2' },
        ]);
        // R4: the highland's column is GRAVEL (the rock the finite stone
        // mines off) and its stock is the finite rock-site count (3) —
        // the old endless deposit reads ×∞ no more
        expect(frame.tiles[212].title).toBe(
            'highland · height 7 · gravel / gravel / gravel / gravel / gravel / dirt / gravel · stone ×3 · dirt ×∞ · Kiki · flying-2 · z 2',
        );
        // R6 — the highland cell PAINTS as its dominant visible type: the
        // stone-capped column sits among mostly-dirt children, so the coarse
        // tile wears the dirt palette color (the rock stock still rides the
        // title above)
        expect(frame.tiles[212].background).toBe('#5d4425');
        // A treed tile: (4,−5) → tile 3×25+16 = 91 surfaces as tree, the
        // forest's deposit (no iron lode fits the 25×17 seed-7 island —
        // every vein sample stays below the lode threshold; the 0.85-era
        // (3,−6) tile 65 became a beach at the lowered 0.8 threshold).
        // Trees paint GREEN on the canvas — the greenery of the standing
        // woods. The deposit count is the tile's neighborhood-counted
        // stand (T2's densified edge band reads 383; the R4 gravel column
        // carries no stone line).
        expect(frame.tiles[91].background).toBe('#4caf50');
        expect(frame.tiles[91].title).toBe(
            'forest · height 5 · gravel / gravel / gravel / dirt / grass / forest · tree ×383 · dirt ×∞ · grass ×∞',
        );
    });

    it('the unicode canvas frame mirrors the ascii world with emoji glyphs', () => {
        const handle = createIslandWorld({ seed: 7 });
        const frame = handle.unicode.frame();
        // Same frame model as the ascii canvas — one tile per cell
        expect(frame.columns).toBe(25);
        expect(frame.rows).toBe(17);
        expect(frame.tiles.length).toBe(425);
        // Ael renders as the GENDERED human emoji at his shore position
        // (tile 201) — his profile (male) resolves the glyph through the
        // plugin's per-entry `glyphOf` override (scenario sexGlyphOf), not
        // the stock type map (whose 🧍 stays the coarse fallback)
        expect(frame.tiles[201].glyphs).toEqual([
            { id: 'actor-1', glyph: '🧍‍♂️', color: '#5cb85c', elevation: 0, kind: 'sentient', type: 'human', state: 'well' },
        ]);
        // Cove stands at (−2,5): tile 13×25+10 = 335 — the FEMALE emoji
        expect(frame.tiles[335].glyphs).toEqual([
            { id: 'actor-3', glyph: '🧍‍♀️', color: '#5cb85c', elevation: 0, kind: 'sentient', type: 'human', state: 'well' },
        ]);
        // Kiki renders as the bird emoji with her altitude superscript —
        // her type 'bird' resolves through the type map, her color the z-2
        // fade band
        expect(frame.tiles[212].glyphs).toEqual([
            { id: 'bird-1', glyph: '🐦', color: '#7ec8e3bf', elevation: 2, kind: 'creature', type: 'bird', state: 'flying-2' },
        ]);
        // Empty sea tiles stay BARE — terrain shows as color only, no
        // per-tile emoji flood (the unicode fix)
        expect(frame.tiles[0].glyphs).toEqual([]);
        // The unicode tab paints the SAME resource-driven surfaces: the
        // highland under Kiki is a dominant-dirt tile (R6), Ael's shore a sand tile
        expect(frame.tiles[212].background).toBe('#5d4425');
        expect(frame.tiles[201].background).toBe('#d3bd85');
        // The emoji palettes resolve through the legend source: types carry
        // the species glyphs, kinds the coarse fallbacks — and the ground
        // items ride the type map too (ITEM_TYPE_GLYPHS merged in), so the
        // zoomed views draw the coconut as 🥥
        expect(handle.unicode.palette().types.bird).toBe('🐦');
        expect(handle.unicode.palette().types.human).toBe('🧍');
        expect(handle.unicode.palette().kinds.creature).toBe('🐾');
        expect(handle.unicode.palette().kinds.sentient).toBe('🧑');
        expect(handle.unicode.palette().types.coconut).toBe('🥥');
        expect(handle.unicode.palette().types.berry).toBe('🍒');
        expect(handle.unicode.palette().types.fish).toBe('🐟');
    });

    it('decorates rock sites with the rock icon — stock-driven, rock over tree, basins bare', () => {
        // R3/R4 — the 🪨 decoration tracks the LIVE finite stone stock:
        // it stands while the tile carries mineable rock and drops the
        // moment the stock is worked away (the frame re-derives per read)
        const handle = createIslandWorld({ seed: 7 });
        const frame = handle.unicode.frame();
        // Kiki's highland (0,0) — tile 212 — carries the finite 3-unit rock
        // site: it decorates 'rock' (the bird glyph rides ABOVE the
        // decoration — separate channels, the entity still wins the tile)
        expect(frame.tiles[212].decoration).toBe('rock');
        // A treed tile decorates 'tree' — the 383-tree edge wood (4,−5)
        expect(frame.tiles[91].decoration).toBe('tree');
        // A bare beach decorates nothing (the no-flood rule stands)
        expect(frame.tiles[201].decoration).toBeUndefined();
        // ── DEPLETION — the icon drops with the stock (coarse scale) ──────
        // Work the site's whole stock away (what the mine gate does unit by
        // unit) — the next frame reads NO rock decoration on the tile
        handle.world.cellAt(0, 0)!.resources.stone = 0;
        expect(handle.unicode.frame().tiles[212].decoration).toBeUndefined();
        // …and the ascii + svg siblings follow the same live read
        expect(handle.ascii.frame().tiles[212].decoration).toBeUndefined();
        expect(handle.svg.frame().tiles[212].decoration).toBeUndefined();
        // A partial stock keeps the icon (binary rule: any live unit shows)
        handle.world.cellAt(0, 0)!.resources.stone = 1;
        expect(handle.unicode.frame().tiles[212].decoration).toBe('rock');
        // ── ROCK RANKS ABOVE TREE ───────────────────────────────────────────
        // A hypothetical tree + rock co-occurrence must show the 🪨 (the
        // mineable rock site is the gameplay landmark — it may not hide
        // under the coverage-faded canopy): stand stone on the wood tile
        handle.world.cellAt(4, -5)!.resources.stone = 2;
        expect(handle.unicode.frame().tiles[91].decoration).toBe('rock');
        delete handle.world.cellAt(4, -5)!.resources.stone;
        expect(handle.unicode.frame().tiles[91].decoration).toBe('tree');
        // ── BASIN SUPPRESSION — water surfaces wear no standing icon ───────
        // A carved lake/pond tile paints water: even a stone stock stamped
        // on it decorates nothing (the same rule that suppresses the canopy
        // over the basin)
        const basin = handle.world.canvas.cells.find(
            (cell) => cell.biome === 'lake' || cell.biome === 'pond',
        )!;
        basin.resources.stone = 2;
        const basinIndex =
            (basin.y + (handle.world.canvas.height - 1) / 2) * handle.world.canvas.width +
            (basin.x + (handle.world.canvas.width - 1) / 2);
        expect(handle.unicode.frame().tiles[basinIndex].decoration).toBeUndefined();
    });

    it('the svg canvas frame mirrors the ascii world as a vector document', () => {
        const handle = createIslandWorld({ seed: 7 });
        const frame = handle.svg.frame();
        // Same frame model as the ascii canvas — one tile per cell — plus
        // the tile edge: the SAME 26px occupation the ascii canvas paints,
        // so swapping canvases never moves the board
        expect(frame.columns).toBe(25);
        expect(frame.rows).toBe(17);
        expect(frame.size).toBe(26);
        expect(frame.tiles.length).toBe(425);
        // Ael renders as the GENDERED human emoji (the per-entry sex
        // resolver, same as the unicode canvas) at his shore position,
        // colored by the shared state palette
        expect(frame.tiles[201].glyphs).toEqual([
            { id: 'actor-1', glyph: '🧍‍♂️', color: '#5cb85c', elevation: 0, kind: 'sentient', type: 'human', state: 'well' },
        ]);
        // Cove — the FEMALE emoji at her spot (−2,5) → tile 335
        expect(frame.tiles[335].glyphs).toEqual([
            { id: 'actor-3', glyph: '🧍‍♀️', color: '#5cb85c', elevation: 0, kind: 'sentient', type: 'human', state: 'well' },
        ]);
        // Kiki renders as the bird emoji with her altitude superscript
        expect(frame.tiles[212].glyphs).toEqual([
            { id: 'bird-1', glyph: '🐦', color: '#7ec8e3bf', elevation: 2, kind: 'creature', type: 'bird', state: 'flying-2' },
        ]);
        // Terrain is the rect fill — empty sea carries no glyph (flood fix)
        expect(frame.tiles[0].glyphs).toEqual([]);
        // The legend source shares the ascii tile palette
        expect(handle.svg.palette().tiles.ocean).toBe('#173a52');
    });

    it('the data canvas frame renders plain tables of the live world', () => {
        const handle = createIslandWorld({ seed: 7 });
        const frame = handle.data.frame();
        // Three tables: entity positions, terrain census, canvas overview
        expect(frame.tables.map((table) => table.title)).toEqual(['Positions', 'Terrain', 'Canvas']);
        // Positions: bird first (kind order — 'creature' sorts before
        // 'sentient'), then the cast in id order — exact centered
        // coordinates and facets per row
        expect(frame.tables[0].headers).toEqual(['id', 'kind', 'type', 'name', 'state', 'x', 'y', 'z']);
        expect(frame.tables[0].rows).toEqual([
            ['bird-1', 'creature', 'bird', 'Kiki', 'flying-2', 0, 0, 2],
            ['actor-1', 'sentient', 'human', 'Ael', 'well', -11, 0, 0],
            ['actor-2', 'sentient', 'human', 'Bram', 'well', -9, -2, 0],
            ['actor-3', 'sentient', 'human', 'Cove', 'well', -2, 5, 0],
            ['actor-4', 'sentient', 'human', 'Dune', 'well', -5, -1, 0],
        ]);
        // Terrain census: cell counts per DOMINANT VISIBLE type (R6 — each
        // coarse tile reads the majority of its children: the tree-fringed
        // meadows surface as grass (29 → 63), the rock sites and the lone
        // iron lode read as the dirt around them (stone 8 → 0, iron 1 → 0,
        // dirt 0 → 9), and the tree census drops to the true canopy (59);
        // the 0.8-threshold basins grow five lakes and eight ponds — every
        // basin paints water), alphabetical
        expect(frame.tables[1].rows).toEqual([
            ['dirt', 9],
            ['grass', 63],
            ['lake', 5],
            ['ocean', 46],
            ['pond', 8],
            ['sand', 138],
            ['shallows', 97],
            ['tree', 59],
        ]);
        // Canvas overview: the 25×17 frame
        expect(frame.tables[2].rows).toEqual([
            ['width', 25],
            ['height', 17],
            ['cells', 425],
        ]);
    });

    it('anchors the view-scale ladder: scale 0 the tile interior, scale 1 the island default view', () => {
        const handle = createIslandWorld({ seed: 7 });
        // The ladder counts UP from the lowest level: scale 0 is the tile
        // interior (the simulation ground, where the castaways move around)
        // and scale 1 is the island — THE DEFAULT VIEW, showing where the
        // Scale-0 entities stand. The ladder reaches as deep as the terrain
        // generates sub-grids (one level by default).
        expect(handle.scale.base()).toBe(0);
        expect(handle.scale.current()).toBe(1);
        expect(handle.scale.atBase()).toBe(false);
        expect(handle.scale.range()).toEqual({ min: 0, max: 1 });
        // Zooming OUT from the island (the widest view) is a no-op — there is
        // no wider view above this island in the simulation
        expect(handle.scale.canZoomOut()).toBe(false);
        expect(handle.scale.zoomOut()).toBe(1);
        // One step IN descends into the tile interior — the simulation ground;
        // zooming in at the floor clamps
        expect(handle.scale.zoomIn()).toBe(0);
        expect(handle.scale.canZoomIn()).toBe(false);
        expect(handle.scale.zoomIn()).toBe(0);
        expect(handle.scale.atBase()).toBe(true);
        // Back to the default view
        expect(handle.scale.zoomOut()).toBe(1);
        expect(handle.scale.atBase()).toBe(false);
    });

    it('the tick carries its fixed world minute at every view (the Scale-0 pacing rule)', () => {
        const handle = createIslandWorld({ seed: 7 });
        // ONE world minute per tick — StrandedIsland's time-per-tick rule.
        // The scale ladder is a pure VIEW ladder: zooming never re-times the
        // clock.
        expect(handle.world.ticker.tickSize()).toBe(1);
        handle.scale.zoomIn();
        expect(handle.world.ticker.tickSize()).toBe(1);
        // A step at scale 0 (the tile interior) advances exactly one
        // world-minute — the simulation always runs at the Scale-0 pace
        handle.world.step();
        expect(handle.world.ticker.elapsed()).toBe(1);
        handle.scale.zoomOut();
        expect(handle.world.ticker.tickSize()).toBe(1);
        // The scale system's own mutators leave the clock untouched too
        handle.scale.set(0);
        expect(handle.world.ticker.tickSize()).toBe(1);
        handle.scale.set(1);
        expect(handle.world.ticker.tickSize()).toBe(1);
    });

    it('generates the recursive tile ladder: every island tile opens into a full sub-grid', () => {
        const handle = createIslandWorld({ seed: 7 });
        // The default island (25×17 = 425 root tiles — the scale-1 view)
        // holds 425 × 425 = 180,625 interior tiles (the scale-0 ground) —
        // the same math that gives a 20×20 world its 400 root tiles and
        // 400×400 = 160,000 interior tiles
        expect(handle.terrain.tilesAt(1)).toBe(425);
        expect(handle.terrain.tilesAt(0)).toBe(425 * 425);
        expect(handle.terrain.depth()).toBe(1);
        // One tile's sub-grid, materialized: the SAME dimensions as the root
        const sub = handle.terrain.canvasFor([{ x: -11, y: 0 }]);
        expect(sub?.width).toBe(25);
        expect(sub?.height).toBe(17);
        expect(sub?.cells.length).toBe(425);
        // …an interior subtile resolves through cellFor (the tile itself),
        // while a deeper GRID is beyond the generated depth
        expect(handle.terrain.cellFor([{ x: -11, y: 0 }, { x: 0, y: 0 }])).toBeDefined();
        expect(handle.terrain.canvasFor([{ x: -11, y: 0 }, { x: 0, y: 0 }])).toBeUndefined();
        expect(handle.terrain.canvasFor([{ x: -11, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }])).toBeUndefined();
    });

    it('exposes the plugin handles for god-side control', () => {
        const handle = createIslandWorld({ seed: 7, actorCount: 2 });
        // The entity profiles ride the handle too — the god reads any
        // species' definition (stats, attributes, abilities, movement,
        // inventory size)
        expect(handle.entity.profileOf('human')?.attributes).toEqual({
            strength: 8, stamina: 10, speed: 10, dexterity: 10,
        });
        expect(handle.entity.hasAbility('human', 'mine')).toBe(true);
        expect(handle.entity.hasAbility('human', 'fly')).toBe(false);
        expect(handle.entity.moveEnergyOf('bird', 'fly')).toBe(2.5);
        expect(handle.entity.inventorySizeOf('shark')).toBe(1);
        // The god can force an exchange between the two castaways
        const ael = handle.world.actors.get('actor-1');
        const bram = handle.world.actors.get('actor-2');
        const forced = handle.inventory.exchange(ael, bram, { flint: 1 }, { berry: 1 });
        expect(forced).toBe(true);
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 3 });
        expect(handle.inventory.of('actor-2')).toEqual({ berry: 1, flint: 2 });
        expect(handle.relationship.relation('actor-1', 'actor-2')).toBe(0);
        // …and inspect needs directly (health full — the reservoir every
        // body wakes unharmed with)
        expect(handle.needs.of('actor-1')).toEqual({ hunger: 20, thirst: 20, energy: 100, health: 100 });
        // The task ledger and sleep plugins ride the handle too — the god
        // can read the cast's current tasks straight away
        expect(handle.tasks.ledger).toBeDefined();
        expect(handle.tasks.tasks()).toEqual([]);
        expect(handle.sleep).toBeDefined();
    });

    it('every living thing carries the survival stats — the bird decays by its species rates', () => {
        const handle = createIslandWorld({ seed: 7 });
        // Kiki is not a castaway, but she carries the four survival stats
        // all the same — starting values and decay rates from the bird
        // profile, health full like every fresh body
        expect(handle.needs.of('bird-1')).toEqual({ hunger: 10, thirst: 10, energy: 100, health: 100 });
        handle.world.step();
        handle.world.step();
        // Bird decay: 0.02 / 0.03 / −0.05 per world minute (a human decays
        // 0.1 / 0.15 / −0.06 — the species' own metabolism). Kiki glided
        // both minutes: two fly-row charges (2.5 each) ride on top. Health
        // stays full — nothing hurt her
        expect(handle.needs.of('bird-1')).toEqual({
            hunger: 10.04,
            thirst: 10.059999999999999,
            energy: 94.9,
            health: 100,
        });
        // The castaways decayed at the human rates for the same two minutes
        // — float drift pinned from the run
        expect(handle.needs.of('actor-1')).toEqual({
            hunger: 20.200000000000003,
            thirst: 20.299999999999997,
            energy: 99.88,
            health: 100,
        });
        // The god can drive a creature's stats directly (the bite drains,
        // the god can too)
        handle.needs.satisfy('bird-1', { energy: -90 });
        expect(handle.needs.of('bird-1').energy).toBe(4.900000000000006);
    });

    it('the entity profiles govern the bags — the cast starting kit fits the eight-unit bag', () => {
        const handle = createIslandWorld({ seed: 7, actorCount: 1 });
        // The kit (berry 2 + flint 1 = 3 units) clamped nowhere near the
        // human's eight-unit capacity
        expect(handle.inventory.capacityOf('actor-1')).toBe(8);
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 2, flint: 1 });
    });

    // THE LONG MARCHES — 3000 world minutes each, the heaviest runs in the
    // suite. The explicit timeout keeps them deterministic under parallel
    // worker load (a 5s default has flaked on loaded machines — the march
    // itself is pure computation, the budget is only for slow hardware).
    it('every species plans through the ledger: a 3000-minute reference run stays stale-free', async () => {
        // The long march: every living thing plans every minute (the
        // behavior plugin's whole-world sweep), the birds roost and sleep,
        // the boars run the full survival ladder, the sharks rest — and no
        // departed body ever leaves a stale queue behind (the tasks
        // plugin's despawn/death cancellation). Captured from the seed-7
        // reference run; the whole march stays deterministic.
        const handle = createIslandWorld({ seed: 7 });
        const alive = (id: string) =>
            handle.world.actors.has(id) || handle.world.coordinates.entryOf(id) !== undefined;
        const creatureTaskKinds = new Set<string>();
        let stale = 0;
        for (let minute = 1; minute <= 3000; minute++) {
            handle.world.step();
            handle.tasks.tasks().forEach((task) => {
                // NO STALE TASKS — every queued task's body still lives
                if (!alive(task.actorId)) {
                    stale = stale + 1;
                }
                // The creature slice of the ledger: a coordinate-space
                // resident (bird, shark, boar) carrying a task
                const entry = handle.world.coordinates.entryOf(task.actorId);
                if (entry && entry.kind === 'creature') {
                    creatureTaskKinds.add(`${entry.type}:${task.kind}`);
                }
            });
        }
        // Not one stale task in 3000 world minutes — despawned birds and
        // swept-out sharks take their queues with them
        expect(stale).toBe(0);
        // The species' task vocabulary over the march: birds seek roosts
        // ('seeks a roost' move tasks) and sleep; the boars run the whole
        // survival ladder (drink, eat, gather, wander, sleep); a spent
        // shark slept its slumber
        expect([...creatureTaskKinds].sort()).toEqual([
            'bird:move',
            'bird:sleep',
            'boar:collect',
            'boar:drink',
            'boar:eat',
            'boar:gather',
            'boar:move',
            'boar:sleep',
            'shark:sleep',
        ]);
        // ZERO DEATHS in 3000 world minutes — the ORIGINAL no-death
        // reference the R1–R5 terrain + the R4 tool economy must preserve.
        // The island's food is per-cell capped and regrows (×∞ deposits,
        // e.g. the bush refills to its cap), so the supply never runs out —
        // the earlier re-pin of 2 deaths at 2910 / 2931 was the hunger rung's
        // passability-blind food targeting (a fish stocked in impassable
        // shallows), fixed by pruning the hunger targets to PASSABLE cells
        // plus the berry bushes as forage — see
        // plugins/behavior/behaviorPlugin.ts. The wilds roam on.
        expect(
            handle.world.events.log().filter((event) => event.kind === 'death').map((event) => ({ actorId: event.actorId, tick: event.tick })),
        ).toEqual([]);
        expect(Array.from(handle.world.actors.values()).map((actor) => actor.type)).toEqual([
            'human',
            'human',
            'human',
            'human',
        ]);
        expect(handle.predators.predators().map((boar) => boar.id)).toEqual(['boar-1', 'boar-2']);
    }, 30000);

    it('the autonomous build loop: the cast completes the full plan in 6000 minutes', () => {
        // THE T4 MARCH — the construction governance (plugins/construction)
        // plans one stock structure at a time through the shared stack: the
        // crew fetches the raw materials demand-directed (never bagfuls of
        // lumber the site stopped needing), crafts the processed parts
        // (frond→thatch/cloth, vine→rope, wood→plank), ferries the staging
        // progressively past the eight-unit bag, and works the site one
        // world-minute stage at a time once it is fully staged. The needs
        // ladder always outranks the construction rungs (rest 25 … flee 60),
        // so nobody starves building. Captured from the seed-7 reference
        // run; the whole march stays deterministic.
        //
        // THE 6000-MINUTE HORIZON — the terrain's neighborhood redesign
        // (the 8-neighbor density model + the meadows' localized tree
        // ingress) intentionally reshaped the cast's travel/food geography:
        // the food treks grew (10 → 31 trips, up to ~90 world minutes
        // each), which slowed the wood-fetch cadence and moved the boat
        // past the old 3000-minute pin. The construction governance itself
        // is unchanged — with the starvation corrections in (zero-death
        // march), the plan completes deterministically at shelter 343,
        // raft 933, house 1517, boat 3428 and fort 3769 of the seed-7
        // reference run (measured after the craft-gate / survival-release
        // fixes; the earlier 4470 boat pin captured the buggy starvation
        // run), so the reference horizon is 6000 (measured 3769 + a
        // generous margin for the crew to reach the horizon idle).
        const handle = createIslandWorld({ seed: 7 });
        // THE FOREST IN THE MARCH — the ecology is mounted (the default):
        // the woods are static at the real-year pace (no recruitment, no
        // spread, no visible wood growth over 6000 minutes), so the march's
        // completion is a construction-pace result — the crew chops pool
        // wood off the standing trees, the neighborhood-counted stands
        // never thinning enough to move the wood fetches' targets
        const alive = (id: string) =>
            handle.world.actors.has(id) || handle.world.coordinates.entryOf(id) !== undefined;
        let stale = 0;
        for (let minute = 1; minute <= 6000; minute++) {
            handle.world.step();
            // NO STALE TASKS — every queued task's body still lives
            handle.tasks.tasks().forEach((task) => {
                if (!alive(task.actorId)) {
                    stale = stale + 1;
                }
            });
        }
        // ZERO DEATHS over the full 6000-minute horizon — the ORIGINAL
        // all-cast reference the terrain + tool corrections must preserve.
        // The earlier re-pin (Dune 2910 / Bram 2931 / Ael 3250) was three
        // distinct starvation mechanics, not a food shortage — the global
        // stock never ran low: (a) the hunger rung's passability-blind
        // targeting (a fish in impassable shallows) — fixed by pruning the
        // hunger targets to passable cells; (b) the craft rung's bag-room
        // gate refused a full hand although the craft's NET change is
        // negative (fronds 3 → cloth 1 frees two slots — two of the cast
        // were stuck exactly on 3 fronds with the boat's cloth line open)
        // — the craft gate is now a net bag-fit check; (c) a full hand of
        // SURPLUS no project owes can only be freed by a construction rung
        // that was also gated on room, so the body clogged re-planning a
        // chop with food underfoot — past the desperation line the thirst
        // / hunger rungs now abandon one expendable unit and take the
        // underfoot forage. Count the deaths from the log, not per-minute.
        const deaths = handle.world.events.log().filter((event) => event.kind === 'death').length;
        expect(stale).toBe(0);
        expect(deaths).toBe(0);
        expect(Array.from(handle.world.actors.keys())).toEqual(['actor-1', 'actor-2', 'actor-3', 'actor-4']);
        // FIVE stock structures stand complete at the 6000-minute mark:
        // the shelter (wood 2 + thatch 2, 10 work), the raft (wood 4 +
        // rope 2, 30), the house (wood 4 + plank 4 + thatch 4 — TWELVE
        // staging units through eight-unit bags, 40 work), the boat
        // (plank 6 + rope 4 + cloth 2, 60 — built at minute 3428 of the
        // captured zero-death reference run) and the fort (stone 8 + wood 4,
        // 120 work — built at minute 3769, inside the horizon's tail).
        expect(handle.construction.completedBlueprints()).toEqual(['shelter', 'raft', 'house', 'boat', 'fort']);
        expect(handle.construction.project()).toBeUndefined();
        expect(
            handle.construction.sites.sites().map((site) => ({
                id: site.id,
                blueprintId: site.blueprintId,
                state: site.state,
                parent: site.parent,
                anchor: site.anchor,
                scale: site.scale,
                rotation: site.rotation,
                work: site.work,
                delivered: site.delivered,
            })),
        ).toEqual([
            { id: 's-1', blueprintId: 'shelter', state: 'built', parent: [{ x: 0, y: 0 }], anchor: { x: 0, y: 0 }, scale: 0, rotation: 0, work: 10, delivered: { wood: 2, thatch: 2 } },
            { id: 's-2', blueprintId: 'raft', state: 'built', parent: [{ x: -7, y: 5 }], anchor: { x: 0, y: 0 }, scale: 0, rotation: 0, work: 30, delivered: { wood: 4, rope: 2 } },
            { id: 's-3', blueprintId: 'house', state: 'built', parent: [{ x: -1, y: 0 }], anchor: { x: 0, y: 0 }, scale: 0, rotation: 0, work: 40, delivered: { wood: 4, thatch: 4, plank: 4 } },
            { id: 's-4', blueprintId: 'boat', state: 'built', parent: [{ x: 7, y: 5 }], anchor: { x: 0, y: 0 }, scale: 0, rotation: 0, work: 60, delivered: { plank: 6, rope: 4, cloth: 2 } },
            { id: 's-5', blueprintId: 'fort', state: 'built', parent: [{ x: 1, y: 0 }], anchor: { x: 0, y: 0 }, scale: 0, rotation: 0, work: 120, delivered: { stone: 8, wood: 4 } },
        ]);
        // The staged materials cap exactly at the requirements — the shared
        // registry refuses over-staging, so the delivered ledgers never hold
        // a surplus unit
        handle.construction.sites.sites().forEach((site) => {
            const definition = handle.construction.blueprints.definitionOf(site.blueprintId);
            definition?.requires.forEach((line) => {
                expect(site.delivered[line.item] ?? 0).toBeLessThanOrEqual(line.count);
            });
        });
        // The built footprints wall their fine cells (the gate excepted) —
        // the completed shelter's wall blocks, its gate stays usable
        const shelterCells = handle.construction.sites.cellsOf('s-1') ?? [];
        expect(handle.world.structures?.blocksFineSpot(0, 0, shelterCells[1].x, shelterCells[1].y)).toBe(true);
        expect(handle.world.structures?.blocksFineSpot(0, 0, shelterCells[0].x, shelterCells[0].y)).toBe(false);
        // The vessels are not launched by the simulation — the launch is the
        // god's control; both hulls stand built and launchable
        expect(handle.construction.vessels()).toEqual([]);
        const raftVessel = handle.construction.launch('s-2');
        expect(raftVessel).toEqual({
            id: 'v-1',
            siteId: 's-2',
            blueprintId: 'raft',
            label: 'Raft',
            x: -7,
            y: 5,
            launchedAt: 6000,
        });
        const boatVessel = handle.construction.launch('s-4');
        expect(boatVessel).toEqual({
            id: 'v-2',
            siteId: 's-4',
            blueprintId: 'boat',
            label: 'Boat',
            x: 7,
            y: 5,
            launchedAt: 6000,
        });
        // The launch log lines (world-scale happenings)
        expect(handle.world.events.log().filter((event) => event.kind === 'launch').map((event) => event.message)).toEqual([
            'The raft is launched into the water at (-7, 5).',
            'The boat is launched into the water at (7, 5).',
        ]);
    }, 60000);
});
