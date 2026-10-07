// Tests for procedural island generation (plugins/terrain/islandTerrain.ts).
// Determinism is the contract — the exact biome maps below were captured from
// a reference run and must never drift.
//
// The world coordinate system is CENTERED: (0, 0) is the dead center of the
// canvas, so grid sizes must be ODD (even input is nudged up one cell). The
// canvas edge is always open sea — the island never touches the border.
//
// Every column also carries RESOURCE DEPOSITS (TileResources) under two
// rules: the INFINITE GROUND SUPPLY — every ground voxel material a dry
// column is built from, at the symbolic count of 1 (stone/dirt/grass/sand —
// never depleted, mirrored onto every fine cell); and the FINITE biological
// TREE STAND — forested tiles seed FOREST_COVERAGE (90%) of their fine
// cells with one persistent tree each, the tile's tree deposit mirroring
// the standing count (383 on the 425-cell default island, Math.round of
// 382.5). Iron lodes stay finite vein landmarks. Wood is NOT a deposit —
// it is the product of cutting a tree's wood pool (the lumber behaviour's
// chop → inventory.harvest → plugins/forest).

import { describe, it, expect } from 'vitest';
import {
    generateIsland,
    islandTerrainPlugin,
    oddSize,
    tileDepositSummary,
    tileSurfaceKey,
    forestTreeCount,
    FOREST_COVERAGE,
    IRON_LODE_THRESHOLD,
    FOREST_MOISTURE_THRESHOLD,
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

    it('carries resource deposits: the voxel ground supply, the tree stand, bare sea', () => {
        const island = generateIsland({ seed: 7 });
        // The density ladder: EVERY forested tile seeds 90% of its fine
        // cells — FOREST_COVERAGE pins the fraction, forestTreeCount pins
        // the exact rounding choice (Math.round(0.9 × 425) = 383)
        expect(FOREST_COVERAGE).toBe(0.9);
        expect(forestTreeCount(25, 17)).toBe(383);
        expect(forestTreeCount(7, 5)).toBe(32);
        // Forest (3,−6): the tile mirrors its seeded 383-tree stand, PLUS
        // the voxel ground supply its column is built from (stone bedrock,
        // the dirt under it, the grass the woods stand on)
        expect(island.cells.find((cell) => cell.x === 3 && cell.y === -6)?.resources).toEqual({
            stone: 1,
            dirt: 1,
            grass: 1,
            tree: 383,
        });
        // Every one of the island's 75 forests carries exactly 383 trees
        expect(island.cells.filter((cell) => (cell.resources.tree ?? 0) === 383).length).toBe(75);
        // Beach (−4,−7): the column is stone/dirt/sand — all three supply
        expect(island.cells.find((cell) => cell.x === -4 && cell.y === -7)?.resources).toEqual({
            stone: 1,
            dirt: 1,
            sand: 1,
        });
        // Meadow (1,−4): stone bedrock + dirt + the grass cover
        expect(island.cells.find((cell) => cell.x === 1 && cell.y === -4)?.resources).toEqual({
            stone: 1,
            dirt: 1,
            grass: 1,
        });
        // The ground-supply censuses: every dry land cell carries stone
        // (the bedrock under everything) and dirt; grass covers meadows
        // AND woods (113 = 75 forests + 38 meadows); sand only the beaches
        expect(island.cells.filter((cell) => (cell.resources.stone ?? 0) > 0).length).toBe(282);
        expect(island.cells.filter((cell) => (cell.resources.dirt ?? 0) > 0).length).toBe(282);
        expect(island.cells.filter((cell) => (cell.resources.grass ?? 0) > 0).length).toBe(113);
        expect(island.cells.filter((cell) => (cell.resources.sand ?? 0) > 0).length).toBe(160);
        // Sea (−12,−8): no deposits — submerged columns supply nothing
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
        // A lode carries stone AND iron — the ore sits in the rock (the
        // column's dirt underlayer supplies beside them)
        expect(reference.cells.find((cell) => cell.x === -5 && cell.y === 3)?.resources).toEqual({
            stone: 1,
            dirt: 1,
            iron: 1,
        });
        // …while the plain highland next door keeps its stone + dirt supply
        expect(reference.cells.find((cell) => cell.x === -7 && cell.y === 0)?.resources).toEqual({
            stone: 1,
            dirt: 1,
        });
        // The smaller 25×17 default island keeps every vein sample below the
        // threshold (0.1552 … 0.4076) — its iron census reads 0
        expect(generateIsland({ seed: 7 }).stats.iron).toBe(0);
    });

    it('derives the canvas surface from the tile deposits and its ground (tileSurfaceKey)', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Landmarks win: the 7×5 island surfaces as tree / sand (the
        // treed woods, the beaches) — the seabed keeps its biome
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
        // The tile's GROUND reads the topmost resource-bearing voxel: a
        // meadow surfaces as its grass cover (its own resource identity —
        // not the dirt under it), a highland as its stone
        const current = generateIsland({ seed: 7 });
        expect(tileSurfaceKey(current.cells.find((cell) => cell.x === 1 && cell.y === -4)!)).toBe('grass');
        expect(tileSurfaceKey(current.cells.find((cell) => cell.x === 0 && cell.y === 0)!)).toBe('stone');
        // A clearcut wood keeps its forest look (the forest voxel stands —
        // the canopy branch reads the voxels directly)
        expect(tileSurfaceKey({ biome: 'meadow', resources: { stone: 1, dirt: 1, grass: 1 }, voxels: ['stone', 'dirt', 'grass'] })).toBe('grass');
        expect(tileSurfaceKey({ biome: 'forest', resources: { grass: 1 }, voxels: ['stone', 'dirt', 'grass', 'forest'] })).toBe('forest');
        // A deposit-less shape (sea column, test fixture) falls back to its
        // plain biome — the ground branch only keys resources the tile carries
        expect(tileSurfaceKey({ biome: 'meadow' })).toBe('meadow');
        expect(tileSurfaceKey({ biome: 'shallows', resources: {}, voxels: ['dirt', 'sand', 'water'] })).toBe('shallows');
    });

    it('summarizes deposits for hover titles and inspectors (tileDepositSummary)', () => {
        expect(tileDepositSummary({ tree: 383 })).toBe('tree ×383');
        expect(tileDepositSummary({ stone: 1, dirt: 1, iron: 1 })).toBe('stone ×∞ · iron ×1 · dirt ×∞');
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

    it('builds voxel columns bottom → top with dirt under the surface', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Forest cell (0,0) — the canvas middle: stone bedrock, dirt, grass
        // surface, forest on top, the seeded 32-tree stand mirrored
        expect(island.cells[2 * 7 + 3]).toEqual({
            x: 0,
            y: 0,
            voxels: ['stone', 'stone', 'stone', 'dirt', 'grass', 'forest'],
            height: 5,
            waterLevel: 3,
            biome: 'forest',
            passable: true,
            resources: { stone: 1, dirt: 1, grass: 1, tree: 32 },
        });
        // Top-left corner (−3,−2): shallow seabed sand + water stacked to
        // the sea level — no deposits on a sea column
        expect(island.cells[0]).toEqual({
            x: -3,
            y: -2,
            voxels: ['dirt', 'sand', 'water'],
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
        // The forest center seeds 32 trees (90% of 35 fine cells) — their
        // PERSISTENT fine positions carry one tree unit each, and every
        // subtile mirrors the ground supply (stone/dirt/grass ×∞)
        const forest = plugin.canvasFor([{ x: 0, y: 0 }]);
        const treeTiles = forest?.cells.filter((cell) => (cell.resources.tree ?? 1) === 1 && cell.resources.tree === 1);
        expect(treeTiles?.map((cell) => [cell.x, cell.y])).toEqual([
            [-3, -2], [-1, -2], [0, -2], [1, -2], [2, -2], [3, -2],
            [-3, -1], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1], [3, -1],
            [-3, 0], [-2, 0], [0, 0], [1, 0], [2, 0], [3, 0],
            [-3, 1], [-2, 1], [0, 1], [1, 1], [2, 1], [3, 1],
            [-3, 2], [-2, 2], [-1, 2], [0, 2], [1, 2], [2, 2], [3, 2],
        ]);
        // Exactly three bare fine cells remain (35 − 32) — the seeded gaps
        expect(forest?.cells.filter((cell) => cell.resources.tree === undefined).length).toBe(3);
        // A treed subtile carries its tree + the ground supply; a bare one
        // only the supply
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }])?.resources).toEqual({
            stone: 1,
            dirt: 1,
            grass: 1,
            tree: 1,
        });
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: -1, y: 0 }])?.resources).toEqual({
            stone: 1,
            dirt: 1,
            grass: 1,
        });
        // The unlimited ground supply IS the ground — every subtile of the
        // beach carries the symbolic deposits (the zoom preserves the look)
        const beach = world.cellAt(1, -1);
        expect(beach?.resources).toEqual({ stone: 1, dirt: 1, sand: 1 });
        const beachSub = plugin.canvasFor([{ x: 1, y: -1 }]);
        expect(beachSub?.cells.every((cell) => cell.resources.sand === 1 && cell.resources.stone === 1 && cell.resources.dirt === 1)).toBe(true);
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
        // of the 32 stand-authored tree subtiles
        const subtile = plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }]);
        expect(subtile?.biome).toBe('forest');
        expect(subtile?.resources).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 1 });
        // Depth 1: a length-2 path still resolves; length 3 is beyond the
        // generated content (the ladder bounds the reach)
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }, { x: 0, y: 0 }])).toBeUndefined();
        expect(plugin.canvasFor([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }])).toBeUndefined();
        // Out-of-bounds tiles are undefined
        expect(plugin.cellFor([{ x: 99, y: 0 }])).toBeUndefined();
        // The empty path is the root grid itself
        expect(plugin.canvasFor([])).toBe(world.canvas);
    });

    it('mirrors the persistent stand: felling one tree moves exactly its subtile (no reshuffle)', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The stand's FIRST seeded positions (−3,−2), (−1,−2) carry trees;
        // felling them off the record (what two full chops do — the mirror
        // drops with the stand, plugins/forest syncMirror) leaves every
        // OTHER position byte-identical — the trees never reshuffle
        const before = plugin.canvasFor([{ x: 0, y: 0 }])!.cells.map((cell) => cell.resources.tree ?? 0);
        expect(before.filter((count) => count === 1).length).toBe(32);
        plugin.forestOf(0, 0)!.trees.delete('-3,-2');
        plugin.forestOf(0, 0)!.trees.delete('-1,-2');
        world.cellAt(0, 0)!.resources.tree = 30;
        const after = plugin.canvasFor([{ x: 0, y: 0 }])!.cells.map((cell) => cell.resources.tree ?? 0);
        expect(after.filter((count) => count === 1).length).toBe(30);
        // The surviving positions are byte-identical to the seeded layout
        after.forEach((count, index) => {
            if (before[index] === 0) {
                expect(count).toBe(0);
            }
        });
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: -3, y: -2 }])?.resources).toEqual({
            stone: 1,
            dirt: 1,
            grass: 1,
        });
    });

    it('regenerates sub-grids when the parent deposits change (fingerprint)', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The forest mirrors its 32-tree stand; the fingerprint (deposits +
        // voxels + biome) changes when a tree is felled off the record —
        // the cached sub-grid invalidates and the mirror re-reads the stand
        const sub = plugin.canvasFor([{ x: 0, y: 0 }]);
        expect(sub?.cells.filter((cell) => (cell.resources.tree ?? 0) === 1).length).toBe(32);
        const firstPass = sub!.cells.map((cell) => cell.resources.tree ?? 0);
        // A regeneration with an UNCHANGED parent serves the cached grid
        expect(plugin.canvasFor([{ x: 0, y: 0 }])).toBe(sub);
        // Drop the standing-tree mirror by one (what a full fell does) —
        // the sub-grid invalidates and re-mirrors
        world.cellAt(0, 0)!.resources.tree = 31;
        plugin.forestOf(0, 0)!.trees.delete('-3,-2');
        const second = plugin.canvasFor([{ x: 0, y: 0 }]);
        expect(second?.cells.filter((cell) => (cell.resources.tree ?? 0) === 1).length).toBe(31);
        // The reshape is exact: only the felled position went bare
        second!.cells.forEach((cell, index) => {
            const before = firstPass[index];
            const now = cell.resources.tree ?? 0;
            if (before === 0) {
                expect(now).toBe(0);
            }
        });
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: -3, y: -2 }])?.resources.tree).toBeUndefined();
    });

    it('is deterministic: the same seed and address regenerate identically', () => {
        const first = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [first] });
        const second = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [second] });
        expect(second.canvasFor([{ x: 0, y: 0 }])).toEqual(first.canvasFor([{ x: 0, y: 0 }]));
    });
});
