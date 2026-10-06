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
            'needs',
            'relationship',
            // The task ledger advances before the behavior tick; the
            // behaviour governance plugins (sleep, survival, lumber) register
            // into the ledger right behind it; the storyteller runs after the
            // whole environment minute (scenario/island.ts mount order)
            'tasks',
            'behavior',
            'sleep',
            'survival',
            'lumber',
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
            { id: 'actor-2', name: 'Bram', position: { x: 9, y: -1, z: 0 }, sex: 'male' },
            { id: 'actor-3', name: 'Cove', position: { x: 1, y: 5, z: 0 }, sex: 'female' },
            { id: 'actor-4', name: 'Dune', position: { x: 5, y: -1, z: 0 }, sex: 'male' },
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
        const handle = createIslandWorld({ seed: 7 });
        handle.world.step();
        expect(handle.world.ticker.ticks()).toBe(1);
        // One step = ONE world minute (the Scale-0 pace). The task rhythm:
        // the lumber rung ranks above the idle wander — the woodless cast
        // plans wood first: Ael came ashore on a bare beach and travels to
        // the woods (1-minute fine steps), while the castaways standing on
        // treed tiles queue the 15-minute chop. The first ledger decrement
        // lands at minute 2 — after ONE step every task still holds time.
        // Kiki glides once and the seeded rain of minute 1 pools water.
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
            { x: 9, y: -1, z: 0 },
            { x: 1, y: 5, z: 0 },
            { x: 5, y: -1, z: 0 },
        ]);
        expect(handle.tasks.tasks().map((task) => ({ actorId: task.actorId, kind: task.kind, label: task.label, remaining: task.remaining }))).toEqual([
            { actorId: 'actor-1', kind: 'move', label: 'travels to trees', remaining: 1 },
            { actorId: 'actor-2', kind: 'chop', label: 'chops a tree', remaining: 15 },
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
            { x: 9, y: -1, z: 0 },
            { x: 1, y: 5, z: 0 },
            { x: 5, y: -1, z: 0 },
        ]);
        expect(Array.from(handle.world.actors.keys()).map((id) => handle.world.subOf(id))).toEqual([
            { x: -7, y: 0 },
            { x: -9, y: -5 },
            { x: -2, y: 3 },
            { x: -11, y: 8 },
        ]);
        // Eighteen more minutes: Ael keeps trekking east toward the woods
        // (19 interior fine steps — the wrap onto the next tile is still
        // one step away), the choppers finished at minute 16 and wandered
        // on (Dune's wandering wrapped off the tile's west edge — the
        // island position moved with it). The log gains the wilds' own
        // beat: Tusk the boar wanders in from the far shore at minute 6
        // (far from the cast — no meeting). The seeded rain of minute 10
        // shifted past the window — the survey's richer map moved the
        // inventory plugin's roll stream (the vine/seaweed draws), so no
        // rain lands inside these twenty minutes.
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
            { x: 9, y: -1, z: 0 },
            { x: 1, y: 5, z: 0 },
            { x: 5, y: -1, z: 0 },
        ]);
        expect(Array.from(handle.world.actors.keys()).map((id) => handle.world.subOf(id))).toEqual([
            { x: 11, y: 0 },
            { x: -9, y: -3 },
            { x: 0, y: 4 },
            { x: -12, y: 7 },
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
        const handle = createIslandWorld({ seed: 7, plugins: { sleep: false } });
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
        expect(frame.tiles[201].title).toBe('beach · height 3 · stone / soil / sand · sand ×∞ · Ael · well');
        // The tile appears as the resource it carries: the beach's unlimited
        // sand deposit paints it with the sand palette color
        expect(frame.tiles[201].background).toBe('#d3bd85');
        // Kiki wheels at the center (0,0): tile 8×25+12 = 212 carries the
        // flying glyph with her altitude superscript — a creature of type
        // bird, colored by the z-2 fade band (BIRD_ALTITUDE_STATES)
        expect(frame.tiles[212].glyphs).toEqual([
            { id: 'bird-1', glyph: 'K', color: '#7ec8e3bf', elevation: 2, kind: 'creature', type: 'bird', state: 'flying-2' },
        ]);
        expect(frame.tiles[212].title).toBe(
            'highland · height 7 · stone / stone / stone / stone / stone / soil / stone · stone ×1 · Kiki · flying-2 · z 2',
        );
        // The highland's stone deposit surfaces the tile with the stone
        // palette color
        expect(frame.tiles[212].background).toBe('#8d939e');
        // A treed tile: (3,−6) → tile 2×25+15 = 65 surfaces as tree, the
        // forest's deposit (no iron lode fits the 25×17 seed-7 island —
        // every vein sample stays below the lode threshold). Trees paint
        // GREEN on the canvas — the greenery of the standing woods.
        expect(frame.tiles[65].background).toBe('#4caf50');
        expect(frame.tiles[65].title).toBe(
            'forest · height 5 · stone / stone / stone / soil / grass / forest · tree ×2',
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
        // Cove stands at (1,5): tile 13×25+13 = 338 — the FEMALE emoji
        expect(frame.tiles[338].glyphs).toEqual([
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
        // highland under Kiki is a stone tile, Ael's shore a sand tile
        expect(frame.tiles[212].background).toBe('#8d939e');
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
        // Cove — the FEMALE emoji at her spot (1,5) → tile 338
        expect(frame.tiles[338].glyphs).toEqual([
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
            ['actor-2', 'sentient', 'human', 'Bram', 'well', 9, -1, 0],
            ['actor-3', 'sentient', 'human', 'Cove', 'well', 1, 5, 0],
            ['actor-4', 'sentient', 'human', 'Dune', 'well', 5, -1, 0],
        ]);
        // Terrain census: cell counts per SURFACE key (the tiles appear as
        // the resources they carry — dirt/sand/tree/stone/iron — with plain
        // water left as biome), alphabetical
        expect(frame.tables[1].rows).toEqual([
            ['dirt', 38],
            ['ocean', 46],
            ['sand', 160],
            ['shallows', 97],
            ['stone', 9],
            ['tree', 75],
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

    it('every species plans through the ledger: a 3000-minute reference run stays stale-free', () => {
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
        // The cast survived the whole march (weak bellies, no deaths —
        // health-zero never fired) and the wilds roam on
        expect(handle.world.events.log().filter((event) => event.kind === 'death')).toEqual([]);
        expect(Array.from(handle.world.actors.values()).map((actor) => actor.type)).toEqual([
            'human',
            'human',
            'human',
            'human',
        ]);
        expect(handle.predators.predators().map((boar) => boar.id)).toEqual(['boar-1', 'boar-2']);
    });
});
