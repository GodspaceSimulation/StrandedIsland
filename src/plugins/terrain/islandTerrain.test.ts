// Tests for procedural island generation (plugins/terrain/islandTerrain.ts).
// Determinism is the contract — the exact biome maps below were captured from
// a reference run and must never drift.
//
// The world coordinate system is CENTERED: (0, 0) is the dead center of the
// canvas, so grid sizes must be ODD (even input is nudged up one cell). The
// canvas edge is always open sea — the island never touches the border.
//
// Every column also carries RESOURCE DEPOSITS (TileResources): tree ×2 on
// plain forests — tree ×6 on a DENSE grove (the moisture noise past
// DENSE_FOREST_MOISTURE_THRESHOLD: some tiles hold a lot of trees) — which
// grow where the moisture noise exceeds FOREST_MOISTURE_THRESHOLD, stone ×1
// on highlands, iron lodes where the vein noise exceeds IRON_LODE_THRESHOLD,
// and the UNLIMITED sand ×1 / dirt ×1 on beaches and meadows. Deposits drive
// the canvas surface (tileSurfaceKey) and seed the inventory plugin's cell
// stocks. Wood is NOT a deposit — it is the product of felling a tree (the
// lumber behaviour's chop → inventory.harvest).

import { describe, it, expect } from 'vitest';
import {
    generateIsland,
    islandTerrainPlugin,
    oddSize,
    tileDepositSummary,
    tileSurfaceKey,
    IRON_LODE_THRESHOLD,
    FOREST_MOISTURE_THRESHOLD,
    DENSE_FOREST_MOISTURE_THRESHOLD,
    FOREST_TREES,
    DENSE_FOREST_TREES,
} from './islandTerrain';
import { createWorld } from '../../engine/world';

describe('oddSize', () => {
    it('nudges even sizes up to the next odd size, odd sizes pass through', () => {
        // (0, 0) must be the exact canvas center — even widths have no middle
        expect(oddSize(36)).toBe(37);
        expect(oddSize(24)).toBe(25);
        expect(oddSize(37)).toBe(37);
        expect(oddSize(13)).toBe(13);
        expect(oddSize(85)).toBe(85);
        expect(oddSize(53)).toBe(53);
    });
});

describe('generateIsland', () => {
    it('produces the exact biome map for seed 7 (7×5)', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Full biome names per cell, row-major
        const map = Array.from({ length: island.height }, (_, row) =>
            Array.from({ length: island.width }, (_, col) => island.cells[row * island.width + col].biome).join(' '),
        );
        expect(map).toEqual([
            'shallows shallows shallows shallows shallows shallows ocean',
            'shallows shallows beach beach beach shallows ocean',
            'shallows beach forest forest beach beach shallows',
            'ocean beach beach forest beach beach shallows',
            'ocean ocean ocean ocean ocean ocean shallows',
        ]);
        expect(island.stats).toEqual({ land: 13, water: 22, forest: 3, iron: 0 });
    });

    it('produces the exact biome map for seed 7 at default size (25×17)', () => {
        const island = generateIsland({ seed: 7 });
        expect(island.width).toBe(25);
        expect(island.height).toBe(17);
        // The map is grown at this moisture cutoff — lowering it regrows the
        // woods (the old inline 0.6 kept the meadows at 52 forests here)
        expect(FOREST_MOISTURE_THRESHOLD).toBe(0.5);
        // Two-letter biome codes per cell, row-major
        const map = Array.from({ length: island.height }, (_, row) =>
            Array.from({ length: island.width }, (_, col) => island.cells[row * island.width + col].biome.slice(0, 2)).join(''),
        );
        expect(map).toEqual([
            "shshshshshshococococococococococococshshshshshshsh",
            "shocshococshshbebebebebebebebebebebebeshshshshshsh",
            "shshshshshbebebebebebebebebebefobebebebeshshbeshsh",
            "shshshbebebebebebebebebebebefofofofobebebeshshshsh",
            "ocshshbebebebebebebebebebemefofofofofobebebeshshsh",
            "ocshbebebebebebememememememefofofofofofobebebeshsh",
            "shshbebebebebebemefofomememefofofofofofofobebeshsh",
            "shshbebebebemememefomehihimefofofofofofofofobeshsh",
            "shbebebebefofofobemehihihihifofobebefofofofobebesh",
            "shbebebebefofofofomemehihihifofofofomemefobebebesh",
            "shshbebebebefofomemememememefofofofofofofobebeshsh",
            "shocshbebebebememememememememebebebefofofobebeshsh",
            "shococshbebebebebebebemefomebebebebefofofobeshshoc",
            "shocshshshbebebebebemefofofobebebebebebebebeshshsh",
            "shshbebeshbebebebebefofofofobebebebebeshshshshshsh",
            "ocshbebebebebebebebebebebebebebebebeshocococococsh",
            "ococococococococococococococococococshshshshshshsh",
        ]);
        expect(island.stats).toEqual({ land: 282, water: 143, forest: 75, iron: 0 });
    });

    it('carries resource deposits: trees on forests, sand/dirt unlimited, bare sea', () => {
        const island = generateIsland({ seed: 7 });
        // The grove ladder: plain woods carry 2 trees, DENSE groves (the
        // moisture band past the dense line) carry a lot — 6 — and the
        // constants pin the ladder itself
        expect(FOREST_MOISTURE_THRESHOLD).toBe(0.5);
        expect(DENSE_FOREST_MOISTURE_THRESHOLD).toBe(0.78);
        expect(FOREST_TREES).toBe(2);
        expect(DENSE_FOREST_TREES).toBe(6);
        // Forest (3,−6): a plain grove — a finite deposit of 2
        expect(island.cells.find((cell) => cell.x === 3 && cell.y === -6)?.resources).toEqual({ tree: 2 });
        // Forest (5,−5): a DENSE grove — 6 trees standing on one tile (the
        // landmark woods a lot of trees make)
        expect(island.cells.find((cell) => cell.x === 5 && cell.y === -5)?.resources).toEqual({ tree: 6 });
        // The dense census: 12 of the island's 75 forests densified past
        // the line, 63 stay plain groves
        expect(island.cells.filter((cell) => (cell.resources.tree ?? 0) === 6).length).toBe(12);
        expect(island.cells.filter((cell) => (cell.resources.tree ?? 0) === 2).length).toBe(63);
        // Beach (−4,−7): unlimited sand — a symbolic count the inventory
        // never depletes (UNLIMITED_TILE_RESOURCES)
        expect(island.cells.find((cell) => cell.x === -4 && cell.y === -7)?.resources).toEqual({ sand: 1 });
        // Meadow (1,−4): unlimited dirt
        expect(island.cells.find((cell) => cell.x === 1 && cell.y === -4)?.resources).toEqual({ dirt: 1 });
        // Sea (−12,−8): no deposits — the sea stocks fish, not tile resources
        expect(island.cells.find((cell) => cell.x === -12 && cell.y === -8)?.resources).toEqual({});
    });

    it('hides iron lodes in the stone highlands (vein noise, seed 7)', () => {
        // The 37×25 reference board: exactly 3 of the 9 highland cells lode
        // at IRON_LODE_THRESHOLD = 0.5 (vein samples 0.0756 … 0.5158)
        const reference = generateIsland({ seed: 7, width: 37, height: 25 });
        expect(IRON_LODE_THRESHOLD).toBe(0.5);
        expect(reference.stats.iron).toBe(3);
        const lodes = reference.cells
            .filter((cell) => (cell.resources.iron ?? 0) > 0)
            .map((cell) => `${cell.x},${cell.y}`);
        expect(lodes).toEqual(['-7,1', '-5,2', '-5,3']);
        // A lode carries stone AND iron — the ore sits in the rock
        expect(reference.cells.find((cell) => cell.x === -5 && cell.y === 3)?.resources).toEqual({
            stone: 1,
            iron: 1,
        });
        // …while the plain highland next door keeps only its stone
        expect(reference.cells.find((cell) => cell.x === -7 && cell.y === 0)?.resources).toEqual({ stone: 1 });
        // The smaller 25×17 default island keeps every vein sample below the
        // threshold (0.1552 … 0.4076) — its iron census reads 0
        expect(generateIsland({ seed: 7 }).stats.iron).toBe(0);
    });

    it('derives the canvas surface from the tile deposits (tileSurfaceKey)', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Deposits win: the 7×5 island surfaces as tree / sand / dirt
        expect(island.cells.map((cell) => tileSurfaceKey(cell))).toEqual([
            'shallows', 'shallows', 'shallows', 'shallows', 'shallows', 'shallows', 'ocean',
            'shallows', 'shallows', 'sand', 'sand', 'sand', 'shallows', 'ocean',
            'shallows', 'sand', 'tree', 'tree', 'sand', 'sand', 'shallows',
            'ocean', 'sand', 'sand', 'tree', 'sand', 'sand', 'shallows',
            'ocean', 'ocean', 'ocean', 'ocean', 'ocean', 'ocean', 'shallows',
        ]);
        // Deposit priority puts the rarest resource first: a stone tile with
        // an iron lode surfaces as iron (37×25 reference cell (−5,3))
        const reference = generateIsland({ seed: 7, width: 37, height: 25 });
        expect(tileSurfaceKey(reference.cells.find((cell) => cell.x === -5 && cell.y === 3)!)).toBe('iron');
        // A deposit-less tile falls back to its plain biome (sea columns —
        // the default island's edge cell)
        const current = generateIsland({ seed: 7 });
        expect(tileSurfaceKey(current.cells.find((cell) => cell.x === -12 && cell.y === -8)!)).toBe('shallows');
        // Gathered-away deposits fall back too — the cell shape only needs
        // biome + resources
        expect(tileSurfaceKey({ biome: 'forest', resources: {} })).toBe('forest');
        expect(tileSurfaceKey({ biome: 'meadow' })).toBe('meadow');
    });

    it('summarizes deposits for hover titles and inspectors (tileDepositSummary)', () => {
        expect(tileDepositSummary({ tree: 2 })).toBe('tree ×2');
        expect(tileDepositSummary({ stone: 1, iron: 1 })).toBe('stone ×1 · iron ×1');
        // Unlimited deposits render the infinity marker, never a bare count
        expect(tileDepositSummary({ sand: 1 })).toBe('sand ×∞');
        expect(tileDepositSummary({ dirt: 1, berry: 2 } as never)).toBe('dirt ×∞');
        expect(tileDepositSummary({})).toBe('');
        expect(tileDepositSummary(undefined)).toBe('');
    });

    it('centers the world: coordinates run −half … +half with (0, 0) the middle', () => {
        const island = generateIsland({ seed: 7 });
        const xs = island.cells.map((cell) => cell.x);
        const ys = island.cells.map((cell) => cell.y);
        expect(Math.min(...xs)).toBe(-12);
        expect(Math.max(...xs)).toBe(12);
        expect(Math.min(...ys)).toBe(-8);
        expect(Math.max(...ys)).toBe(8);
        // The middle cell exists and is exactly (0, 0)
        expect(island.cells[8 * 25 + 12]).toMatchObject({ x: 0, y: 0 });
    });

    it('the canvas edge is always open sea — the island never touches the border', () => {
        const island = generateIsland({ seed: 7 });
        // Every outermost-ring cell is submerged water
        const edge = island.cells.filter(
            (cell) => Math.abs(cell.x) === 12 || Math.abs(cell.y) === 8,
        );
        expect(edge.length).toBe(2 * 25 + 2 * 15);
        expect(edge.every((cell) => !cell.passable)).toBe(true);
        expect(edge.every((cell) => cell.voxels[cell.voxels.length - 1] === 'water')).toBe(true);
        // Reference mix of shallows and ocean on the rim (coarse noise depth)
        expect(edge.filter((cell) => cell.biome === 'ocean').length).toBe(34);
        expect(edge.filter((cell) => cell.biome === 'shallows').length).toBe(46);
    });

    it('builds voxel columns bottom → top with soil under the surface', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Forest cell (0,0) — the canvas middle: stone bedrock, soil, grass
        // surface, forest on top, trees standing on it
        expect(island.cells[2 * 7 + 3]).toEqual({
            x: 0,
            y: 0,
            voxels: ['stone', 'stone', 'stone', 'soil', 'grass', 'forest'],
            height: 5,
            waterLevel: 3,
            biome: 'forest',
            passable: true,
            resources: { tree: 2 },
        });
        // Top-left corner (−3,−2): shallow seabed sand + water stacked to
        // the sea level — no deposits on a sea column
        expect(island.cells[0]).toEqual({
            x: -3,
            y: -2,
            voxels: ['soil', 'sand', 'water'],
            height: 2,
            waterLevel: 3,
            biome: 'shallows',
            passable: false,
            resources: {},
        });
    });

    it('is deterministic: same seed → identical canvases', () => {
        const a = generateIsland({ seed: 42, width: 9, height: 7 });
        const b = generateIsland({ seed: 42, width: 9, height: 7 });
        expect(a.cells).toEqual(b.cells);
    });

    it('different seeds produce different canvases', () => {
        const a = generateIsland({ seed: 1, width: 9, height: 7 });
        const b = generateIsland({ seed: 2, width: 9, height: 7 });
        expect(a.cells).not.toEqual(b.cells);
    });

    it('even size input is nudged up to odd', () => {
        const island = generateIsland({ seed: 7, width: 12, height: 10 });
        expect(island.width).toBe(13);
        expect(island.height).toBe(11);
    });

    it('water columns are impassable with a water surface; sandbars are walkable', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        const waterCells = island.cells.filter((cell) => !cell.passable);
        const landCells = island.cells.filter((cell) => cell.passable);
        expect(waterCells.length).toBe(22);
        expect(landCells.length).toBe(13);
        // Every impassable column's surface voxel is water
        expect(waterCells.every((cell) => cell.voxels[cell.voxels.length - 1] === 'water')).toBe(true);
        // No walkable column's surface is water
        expect(landCells.every((cell) => cell.voxels[cell.voxels.length - 1] !== 'water')).toBe(true);
    });
});

describe('islandTerrainPlugin', () => {
    it('builds the world canvas from the world seed in setup', () => {
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 7, height: 5 })] });
        expect(world.canvas.width).toBe(7);
        expect(world.canvas.height).toBe(5);
        expect(world.canvas.cells.length).toBe(35);
        expect(world.cellAt(0, 0)?.biome).toBe('forest');
    });

    it('exposes generation stats', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [plugin] });
        expect(plugin.stats()).toEqual({ land: 13, water: 22, forest: 3, iron: 0 });
    });

    it('respects a seed override independent of the world seed', () => {
        const world = createWorld({
            seed: 99,
            plugins: [islandTerrainPlugin({ width: 7, height: 5, seed: 7 })],
        });
        expect(world.canvas.width).toBe(7);
        // Same seed 7 → same interior biome at the canvas middle
        expect(world.cellAt(0, 0)?.biome).toBe('forest');
    });

    it('size reports the configured grid size', () => {
        const plugin = islandTerrainPlugin({ width: 13, height: 9 });
        createWorld({ seed: 7, plugins: [plugin] });
        expect(plugin.size()).toEqual({ width: 13, height: 9 });
    });

    it('resize regenerates the canvas in place and logs the redraw', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const events = world.events.log().length;
        plugin.resize(21, 13);
        expect(world.canvas.width).toBe(21);
        expect(world.canvas.height).toBe(13);
        expect(world.canvas.cells.length).toBe(273);
        expect(plugin.size()).toEqual({ width: 21, height: 13 });
        expect(plugin.stats()).toEqual({ land: 162, water: 111, forest: 44, iron: 0 });
        // The redraw is announced on the story feed (a world-scale
        // happening — the god reshaped the world)
        expect(world.events.log()[events]).toEqual({
            id: events + 1,
            tick: 0,
            time: 0,
            kind: 'world',
            message: 'The island is redrawn at 21×13.',
        });
        // The edge rule holds at the new size too
        const edge = world.canvas.cells.filter(
            (cell) => Math.abs(cell.x) === 10 || Math.abs(cell.y) === 6,
        );
        expect(edge.every((cell) => !cell.passable)).toBe(true);
        // The center rises above the water line on any size
        expect(world.cellAt(0, 0)?.passable).toBe(true);
    });

    it('resize keeps the seed: the same island, bigger or smaller', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const small = createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 7, height: 5 })] });
        // The reference 7×5 center column, regenerated at default size
        plugin.resize(25, 17);
        expect(small.cellAt(0, 0)?.biome).toBe('forest');
        expect(small.cellAt(0, 0)?.height).toBe(5);
    });

    it('resize normalizes even input to odd', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        plugin.resize(36, 24);
        expect(world.canvas.width).toBe(37);
        expect(world.canvas.height).toBe(25);
        expect(world.events.log().at(-1)?.message).toBe('The island is redrawn at 37×25.');
    });

    it('resize before setup defers to the next setup', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        plugin.resize(21, 13);
        expect(plugin.size()).toEqual({ width: 21, height: 13 });
        // The first setup regenerates at the deferred size
        const world = createWorld({ seed: 7, plugins: [plugin] });
        expect(world.canvas.width).toBe(21);
        expect(world.canvas.height).toBe(13);
    });

    // ── The recursive sub-grids (the tile ladder's content) ──────────────────

    it('configures one subtile level by default and counts the tiles per scale', () => {
        const plugin = islandTerrainPlugin();
        createWorld({ seed: 7, plugins: [plugin] });
        expect(plugin.depth()).toBe(1);
        // The ladder counts UP from the interior ground: scale 0 (the
        // simulation ground) multiplies the grid by itself, scale 1 (the
        // ladder's top) is the island root — a 25×17 world holds 425×425 =
        // 180,625 interior tiles and 425 root tiles (the sub-grid dims
        // equal the root dims)
        expect(plugin.tilesAt(0)).toBe(25 * 17 * 25 * 17);
        expect(plugin.tilesAt(1)).toBe(25 * 17);
        const tiny = islandTerrainPlugin({ width: 5, height: 5, subtiles: 2 });
        createWorld({ seed: 7, plugins: [tiny] });
        expect(tiny.depth()).toBe(2);
        // Two subtile levels: scale 0 the deepest interior (25⁴), scale 1
        // the first interior (25²), scale 2 the island root (25)
        expect(tiny.tilesAt(0)).toBe(15625);
        expect(tiny.tilesAt(1)).toBe(625);
        expect(tiny.tilesAt(2)).toBe(25);
    });

    it('generates a sub-grid with the ROOT grid dimensions from the parent cell', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const sub = plugin.canvasFor([{ x: 0, y: 0 }]);
        expect(sub).toBeDefined();
        // The recursion rule: same dims, one tile per subtile
        expect(sub?.width).toBe(7);
        expect(sub?.height).toBe(5);
        expect(sub?.cells.length).toBe(35);
        // Every subtile inherits the parent column — the interior ground IS
        // the tile's ground (the center is a forest at height 5)
        sub?.cells.forEach((cell) => {
            expect(cell.voxels).toEqual(world.cellAt(0, 0)?.voxels);
            expect(cell.height).toBe(world.cellAt(0, 0)?.height);
            expect(cell.waterLevel).toBe(world.cellAt(0, 0)?.waterLevel);
            expect(cell.biome).toBe(world.cellAt(0, 0)?.biome);
            expect(cell.passable).toBe(world.cellAt(0, 0)?.passable);
        });
    });

    it('distributes the parent deposits onto the subtiles (the zoomed view)', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The forest center carries tree ×2 → exactly two tree subtiles,
        // pinned to their seeded positions
        const forest = plugin.canvasFor([{ x: 0, y: 0 }]);
        const treeTiles = forest?.cells.filter((cell) => (cell.resources.tree ?? 0) > 0);
        expect(treeTiles?.map((cell) => [cell.x, cell.y, cell.resources.tree])).toEqual([
            [2, -2, 1],
            [1, 0, 1],
        ]);
        // The rest of the forest interior is bare ground (biome surface)
        expect(forest?.cells.filter((cell) => Object.keys(cell.resources).length === 0).length).toBe(33);
        // An unlimited deposit IS the ground — every subtile carries the
        // symbolic deposit so the zoom preserves the tile's look
        const beach = world.cellAt(1, -1);
        expect(beach?.resources).toEqual({ sand: 1 });
        const beachSub = plugin.canvasFor([{ x: 1, y: -1 }]);
        expect(beachSub?.cells.every((cell) => cell.resources.sand === 1)).toBe(true);
        // A sea column has no deposits — its sub-grid is bare too
        const seaSub = plugin.canvasFor([{ x: 3, y: 1 }]);
        expect(seaSub?.cells.every((cell) => Object.keys(cell.resources).length === 0)).toBe(true);
    });

    it('resolves tiles at depth (cellFor) and rejects beyond the configured depth', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // A length-1 path resolves the root canvas cell
        expect(plugin.cellFor([{ x: 0, y: 0 }])).toEqual(world.cellAt(0, 0));
        // A length-2 path resolves a subtile of the forest's sub-grid — one
        // of the two seeded tree subtiles
        const subtile = plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }]);
        expect(subtile?.biome).toBe('forest');
        expect(subtile?.resources).toEqual({ tree: 1 });
        // Depth 1: a length-2 path still resolves; length 3 is beyond the
        // generated content (the ladder bounds the reach)
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }, { x: 0, y: 0 }])).toBeUndefined();
        expect(plugin.canvasFor([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }])).toBeUndefined();
        // Out-of-bounds tiles are undefined
        expect(plugin.cellFor([{ x: 99, y: 0 }])).toBeUndefined();
        // The empty path is the root grid itself
        expect(plugin.canvasFor([])).toBe(world.canvas);
    });

    it('regenerates sub-grids when the parent deposits change (fingerprint)', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The forest carries tree ×2 → two tree subtiles; the first seeded
        // slot sits at (2, −2)
        const before = plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }]);
        expect(before?.resources).toEqual({ tree: 1 });
        // The god fells one tree off the parent tile
        world.cellAt(0, 0)!.resources.tree = 1;
        // The cached sub-grid invalidated — one tree subtile remains, at
        // the first seeded scatter position
        const after = plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }]);
        expect(after?.resources).toEqual({ tree: 1 });
        const treeTiles = plugin
            .canvasFor([{ x: 0, y: 0 }])
            ?.cells.filter((cell) => (cell.resources.tree ?? 0) > 0);
        expect(treeTiles?.length).toBe(1);
        // Felled to zero: the whole interior goes bare
        world.cellAt(0, 0)!.resources.tree = 0;
        expect(
            plugin.canvasFor([{ x: 0, y: 0 }])?.cells.every((cell) => Object.keys(cell.resources).length === 0),
        ).toBe(true);
    });

    it('is deterministic: the same seed and address regenerate identically', () => {
        const first = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [first] });
        const second = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [second] });
        expect(second.canvasFor([{ x: 0, y: 0 }])).toEqual(first.canvasFor([{ x: 0, y: 0 }]));
    });
});
