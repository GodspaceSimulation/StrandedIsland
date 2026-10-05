// Procedural voxel island generation (the canvas).
//
// The island is a width × height grid of voxel columns. Each column is built
// from a heightmap driven by two octaves of seeded value noise (lattice +
// bilinear + smoothstep) shaped by a radial falloff so the center rises above
// the water line and the edges fall into the sea — a small island.
//
// Every column also carries RESOURCE DEPOSITS (TileResources on engine/types):
// timber in forests, stone on the highlands, iron lodes where the vein noise
// concentrates, and the unlimited sands of the beaches and dirts of the
// meadows. The deposits are what the tile appears as on the canvas
// (tileSurfaceKey below) and what the inventory plugin seeds its gatherable
// cell stocks from.
//
// Everything is deterministic: the same seed produces the exact same island,
// which is what the tests assert. `@presource/core` has no seeded PRNG, so the
// stream comes from engine/random.ts (mulberry32).

import { randomCreate, randomKeyed, type RandomSource } from '../../engine/random';
import type { Biome, Canvas, TerrainCell, TileResource, TileResources, VoxelKind } from '../../engine/types';
import { TILE_RESOURCES, UNLIMITED_TILE_RESOURCES } from '../../engine/types';
import type { PluginContext, WorldPlugin } from '../../engine/plugin';
import { tilePathKey, type TilePath } from '@godspace/core';

export type IslandTerrainOptions = {
    /** Grid width in cells (odd — 0,0 is the center). Default 37. */
    width?: number;
    /** Grid height in cells (odd — 0,0 is the center). Default 25. */
    height?: number;
    /** PRNG seed. Defaults to the world seed (passed by the plugin setup). */
    seed?: number;
    /** Water line in voxel units — columns strictly below are underwater. Default 3. */
    seaLevel?: number;
    /** Tallest possible ground column in voxels. Default 8. */
    maxHeight?: number;
    /** 0..1 — how much the raw noise (vs the radial falloff) shapes height. Default 0.55. */
    roughness?: number;
    /**
     * How many SUBTILE levels the generator produces below the root grid —
     * the recursive tiling configuration. Every tile of a produced level
     * opens into a full sub-grid of the SAME dimensions (a 20×20 world with
     * subtiles 1 holds 400 scale-0 tiles and 400×400 = 160,000 scale-1
     * tiles). Default 1: scale 0 (the island) and scale 1 (each tile's
     * interior). 0 produces no sub-grids at all. The generator itself is
     * level-agnostic (any parent cell yields a sub-grid), so raising this
     * number — and the world's scale ladder with it — goes arbitrarily deep.
     */
    subtiles?: number;
};

export type IslandStats = {
    land: number;
    water: number;
    forest: number;
    /** Cells carrying an iron lode deposit. */
    iron: number;
};

/**
 * Vein-noise threshold for iron lodes: a dry stone-surface cell whose vein
 * sample exceeds it carries an iron deposit. Calibrated so lodes stay rare
 * landmarks — on the reference seed-7 island 3 of the 9 highland cells
 * lode (vein samples 0.0756 … 0.5158).
 */
export const IRON_LODE_THRESHOLD = 0.5;

/**
 * Lattice value noise with bilinear interpolation and a smoothstep fade.
 * Returns a sampler function `(x, y) → [0, 1]` over the grid dimensions.
 */
const latticeNoise = (
    random: RandomSource,
    width: number,
    height: number,
    scale: number,
): ((x: number, y: number) => number) => {
    // Lattice resolution: one random value per `scale` cells, +1 for the edge
    const columns = Math.ceil(width / scale) + 1;
    const rows = Math.ceil(height / scale) + 1;
    const lattice: number[] = [];
    for (let index = 0; index < columns * rows; index++) {
        lattice.push(random());
    }

    return (x, y) => {
        // Continuous lattice position
        const gx = x / scale;
        const gy = y / scale;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        // Clamp so edge cells interpolate against the last lattice column
        const x1 = Math.min(x0 + 1, columns - 1);
        const y1 = Math.min(y0 + 1, rows - 1);
        // Smoothstep fade removes the bilinear "diamond" artifacts
        const tx = gx - x0;
        const ty = gy - y0;
        const fx = tx * tx * (3 - 2 * tx);
        const fy = ty * ty * (3 - 2 * ty);

        const topRow = y0 * columns;
        const bottomRow = y1 * columns;
        const top = lattice[topRow + x0] * (1 - fx) + lattice[topRow + x1] * fx;
        const bottom = lattice[bottomRow + x0] * (1 - fx) + lattice[bottomRow + x1] * fx;
        return top * (1 - fy) + bottom * fy;
    };
};

/**
 * Derives the biome from the surface situation of a column.
 * `depth` is how many water voxels sit above the seabed.
 */
const deriveBiome = (
    surface: VoxelKind,
    submerged: boolean,
    depth: number,
    forested: boolean,
): Biome => {
    if (submerged) {
        // Deep water (more than 1 voxel of water above the seabed) = ocean
        return depth > 1 ? 'ocean' : 'shallows';
    }
    if (forested) {
        return 'forest';
    }
    if (surface === 'stone') {
        return 'highland';
    }
    if (surface === 'sand') {
        return 'beach';
    }
    return 'meadow';
};

/**
 * Grid sizes are always odd: the world coordinate system is centered, (0, 0)
 * is the dead center of the canvas, so the center column/row must exist
 * exactly. Even sizes are nudged up to the next odd size.
 */
export const oddSize = (value: number): number => (value % 2 === 0 ? value + 1 : value);

/**
 * Generates the island canvas. Pure: same options → same canvas.
 *
 * Cell coordinates are world coordinates, centered on (0, 0) — the canvas
 * middle — running from −half to +half on both axes. Storage stays row-major
 * from the top-left corner (−halfX, −halfY): index = (y + halfY) * width + (x + halfX).
 */
export const generateIsland = (
    options: IslandTerrainOptions = {},
): Canvas & { stats: IslandStats } => {
    // Odd dims are a hard rule — the center must be exactly (0, 0)
    const width = oddSize(options.width ?? 37);
    const height = oddSize(options.height ?? 25);
    const seaLevel = options.seaLevel ?? 3;
    const maxHeight = options.maxHeight ?? 8;
    const roughness = options.roughness ?? 0.55;
    const random = randomCreate(options.seed ?? 1);
    // Half extents: (odd − 1) / 2 is exact — x, y run −half … +half
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;

    // Two noise octaves (coastline shape + local bumps) and a moisture map
    // that decides where forests grow on grass. Noise samples live in
    // grid space (0..width−1), NOT centered space — the lattice indexes
    // arrays and cannot take negative positions.
    //
    // STREAM SAFETY: every lattice consumes its random draws in creation
    // order, before the per-cell loop samples them (the loop draws nothing).
    // The vein lattice is created LAST, so its draws land at the tail of the
    // stream — adding it never shifts the coarse/fine/moisture values, and
    // the pinned seed-7 biome maps stay byte-identical.
    const coarse = latticeNoise(random, width, height, 4);
    const fine = latticeNoise(random, width, height, 2);
    const moisture = latticeNoise(random, width, height, 3);
    // Ore-vein map — where iron lodes hide inside the stone highlands
    const veins = latticeNoise(random, width, height, 2);

    const cells: TerrainCell[] = [];
    const stats: IslandStats = { land: 0, water: 0, forest: 0, iron: 0 };

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            // Centered world coordinates: 0,0 is the island center
            const x = col - halfX;
            const y = row - halfY;
            // Normalized position −1..1 from the center (which IS 0, 0 now)
            const nx = x / (halfX || 1);
            const ny = y / (halfY || 1);
            // Elliptical distance, 0 at center → 1 at the rim (clamped);
            // corners overshoot and clamp, edge midpoints sit exactly at 1
            const distance = Math.min(1, Math.sqrt(nx * nx + ny * ny));
            // Radial falloff: 1 at the center → 0 at the rim, squared so the
            // beach ring is wide and the peak is concentrated
            const falloff = 1 - distance * distance;

            // Height: noise shaped by falloff, clamped to 0..1
            const noise = coarse(col, row) * 0.65 + fine(col, row) * 0.35;
            const blended = Math.max(0, Math.min(1, noise * roughness + falloff * (1 - roughness)));
            // Island design rule: the canvas edge is always sea. The outermost
            // ring of cells is forced below the water line no matter what the
            // noise does at the rim, so the island never touches the border —
            // any grid size reads as an island floating in open water. The
            // coarse noise picks the ring's depth: shallows or full ocean.
            const onEdge = Math.abs(x) === halfX || Math.abs(y) === halfY;
            // Ground height in voxels: 0 (seafloor) … maxHeight (peak)
            const groundHeight = onEdge
                ? seaLevel - 1 - Math.round(coarse(col, row))
                : Math.round(blended * maxHeight);

            // Classify the surface. A column exactly at the water line is a
            // dry sandbar (walkable); only columns strictly below it are
            // submerged with water stacked up to the sea level.
            const submerged = groundHeight < seaLevel;
            // Surface ladder: seabed sand → sandbar/beach sand (sea level and
            // one above) → grass meadow → stone highland at the peaks
            const surface: VoxelKind = submerged
                ? 'sand'
                : groundHeight >= seaLevel + 4
                  ? 'stone'
                  : groundHeight <= seaLevel + 1
                    ? 'sand'
                    : 'grass';
            // Forests only grow on grass with enough moisture
            const forested = surface === 'grass' && moisture(col, row) > 0.6;

            // Build the voxel stack, bottom → top:
            //   stone × (ground-2), soil × 1, surface × 1,
            //   then water up to the sea level (submerged columns),
            //   then a forest voxel when wooded
            const stack: VoxelKind[] = [];
            if (groundHeight >= 3) {
                for (let index = 0; index < groundHeight - 2; index++) {
                    stack.push('stone');
                }
            }
            if (groundHeight >= 2) {
                stack.push('soil');
            }
            stack.push(surface);
            const depth = submerged ? seaLevel - groundHeight : 0;
            for (let index = 0; index < depth; index++) {
                stack.push('water');
            }
            if (forested) {
                stack.push('forest');
            }

            const biome = deriveBiome(surface, submerged, depth, forested);

            // ── Resource deposits ───────────────────────────────────────
            // What the tile carries as gatherable material. Deposits are a
            // tile property: the inventory plugin seeds its gatherable cell
            // stocks from them, and tileSurfaceKey derives the canvas
            // appearance from the top deposit (see below). Unlimited
            // resources (sand, dirt) keep a symbolic count of 1 — the
            // UNLIMITED_TILE_RESOURCES set protects them from depletion.
            const resources: TileResources = {};
            if (!submerged) {
                if (forested) {
                    // Forests stand on timber — 2 units, matching the old
                    // forest wood stock
                    resources.wood = 2;
                } else if (surface === 'stone') {
                    // Highlands are quarries: stone, plus an iron lode when
                    // the vein noise concentrates past the threshold
                    resources.stone = 1;
                    if (veins(col, row) > IRON_LODE_THRESHOLD) {
                        resources.iron = 1;
                        stats.iron = stats.iron + 1;
                    }
                } else if (surface === 'sand') {
                    // Beaches are made of sand — an unlimited deposit
                    resources.sand = 1;
                } else {
                    // Meadows grow on soil — dig dirt, unlimited
                    resources.dirt = 1;
                }
            }

            if (submerged) {
                stats.water = stats.water + 1;
            } else {
                stats.land = stats.land + 1;
                if (forested) {
                    stats.forest = stats.forest + 1;
                }
            }

            cells.push({
                x,
                y,
                voxels: stack,
                height: groundHeight,
                waterLevel: seaLevel,
                biome,
                // Water columns are impassable; everything dry is walkable
                passable: !submerged,
                resources,
            });
        }
    }

    return { width, height, cells, stats };
};

// ── Tile appearance ──────────────────────────────────────────────────────────
// The tile's RESOURCES decide what it appears as on the canvas: a tile shows
// up as the resource it carries (timber tiles, ore tiles, sand tiles…), so
// the god reads the island as a resource map, not just a biome map.

/** The minimal cell slice the surface derivation reads. */
export type TileSurfaceCell = {
    biome?: string;
    resources?: TileResources;
};

/**
 * Deposit-priority order for the canvas surface — the rarest deposit wins
 * the tile's look so landmarks stand out (an iron lode shows through the
 * stone it sits in; timber shows through the meadow it borders).
 */
const RESOURCE_SURFACE_PRIORITY: readonly TileResource[] = ['iron', 'wood', 'stone', 'sand', 'dirt'];

/**
 * The canvas surface key of a tile: its top-priority deposit, falling back
 * to the plain biome when the tile carries no resources (sea columns, or a
 * land tile whose finite deposits were gathered away).
 */
export const tileSurfaceKey = (cell: TileSurfaceCell): string | undefined => {
    const resources = cell.resources ?? {};
    const deposit = RESOURCE_SURFACE_PRIORITY.find((resource) => (resources[resource] ?? 0) > 0);
    return deposit ?? cell.biome;
};

/** One "wood ×2" / "sand ×∞" fragment for hover titles and inspectors. */
const depositFragment = (resource: TileResource, count: number): string =>
    UNLIMITED_TILE_RESOURCES.includes(resource) ? `${resource} ×∞` : `${resource} ×${count}`;

/**
 * Human readable deposit summary of a tile's resources, in
 * TILE_RESOURCES order: "wood ×2 · iron ×1" — empty when bare.
 */
export const tileDepositSummary = (resources?: TileResources): string =>
    TILE_RESOURCES.filter((resource) => (resources?.[resource] ?? 0) > 0)
        .map((resource) => depositFragment(resource, resources?.[resource] ?? 0))
        .join(' · ');

/**
 * The terrain plugin — installs the island as the world's canvas in `setup`.
 * Re-running `setup` (by removing/re-adding the plugin) regenerates it.
 * `stats()` reports the last generated island's composition. `resize()`
 * regenerates the island at a new grid size in place (same seed → the same
 * island, just larger or smaller), for the god-view's World Size controls.
 *
 * The plugin also owns the RECURSIVE SUB-GRIDS (the scale ladder's content):
 * `canvasFor(path)` resolves any tile address to its grid — the root canvas
 * for the empty path, the tile's sub-grid for a deeper path — generating
 * each sub-grid deterministically from its parent cell (world seed + tile
 * address) and caching it until the parent's deposits change. Sub-grid
 * dims equal the root grid's dims: zooming in never changes the board size
 * (the recursion rule — a 20×20 world holds 400×400 scale-1 tiles with
 * subtiles 1). `tilesAt(scale)` counts the tiles of a level, `cellFor(path)`
 * resolves one tile, `depth()` reports the configured subtile levels.
 */
export const islandTerrainPlugin = (options: IslandTerrainOptions = {}): WorldPlugin & {
    stats(): IslandStats | undefined;
    /** Current grid size (as configured — the canvas is regenerated to match). */
    size(): { width: number; height: number };
    /** Regenerates the island at a new grid size, replacing the whole canvas. */
    resize(width: number, height: number): void;
    /** How many subtile levels the generator produces below the root grid. */
    depth(): number;
    /** Tile count of one scale level (scale 0 → the root grid itself). */
    tilesAt(scale: number): number;
    /** The grid at a tile address — the root canvas for the empty path. */
    canvasFor(path: TilePath): Canvas | undefined;
    /** One tile at a tile address (the parent path resolves its grid). */
    cellFor(path: TilePath): TerrainCell | undefined;
} => {
    // Last generation stats, exposed for the god-view roster
    let lastStats: IslandStats | undefined;
    // Configured grid size — the default, overridable by options and
    // changeable at runtime through resize(). Odd rule enforced here too:
    // (0, 0) must be the exact canvas center.
    const dims = { width: oddSize(options.width ?? 37), height: oddSize(options.height ?? 25) };
    // Subtile levels below the root (the recursive tiling configuration)
    const subtileDepth = options.subtiles ?? 1;
    // The plugin context captured in setup — resize() needs the world (canvas
    // swap + event emission) between lifecycle hooks
    let bound: PluginContext | null = null;
    // The seed the last generation resolved (options.seed ?? world seed) —
    // sub-grid generation keys its streams off the same seed
    let resolvedSeed = options.seed ?? 1;
    // Sub-grid cache, keyed by tile path — a zoomed-in view re-renders every
    // pulse, so regenerating 925 cells each time would burn the frame; the
    // fingerprint (parent deposits + height + water line) invalidates a
    // cached grid exactly when the parent tile changed (gathering, regrowth)
    const subCanvases = new Map<string, { stamp: string; canvas: Canvas }>();
    // FIFO cap — zooming around must not accumulate grids without bound
    const SUB_CANVAS_CACHE = 32;

    /** One generation pass: builds the canvas and installs it on the world. */
    const regenerate = (context: PluginContext) => {
        // Default seed: the world seed, so one global seed drives everything
        resolvedSeed = options.seed ?? context.world.seed;
        const generated = generateIsland({
            seed: resolvedSeed,
            width: dims.width,
            height: dims.height,
            seaLevel: options.seaLevel,
            maxHeight: options.maxHeight,
            roughness: options.roughness,
        });
        context.world.canvas = {
            width: generated.width,
            height: generated.height,
            cells: generated.cells,
        };
        lastStats = generated.stats;
    };

    // The centered row-major cell lookup on an ARBITRARY canvas (world.cellAt
    // is bound to the root holder; sub-grids resolve through here)
    const cellOn = (canvas: Canvas, x: number, y: number): TerrainCell | undefined => {
        const halfX = (canvas.width - 1) / 2;
        const halfY = (canvas.height - 1) / 2;
        if (y < -halfY || y > halfY || x < -halfX || x > halfX) {
            return undefined;
        }
        return canvas.cells[(y + halfY) * canvas.width + (x + halfX)];
    };

    // The parent-change stamp of a cell: its deposits + height + water line.
    // Voxels/biome/passability never change after generation, so the stamp
    // catches exactly the mutations that reshape a sub-grid (a gathered
    // deposit removes its subtile, regrowth adds one back)
    const fingerprintOf = (cell: TerrainCell): string =>
        `${TILE_RESOURCES.map((resource) => cell.resources[resource] ?? 0).join(',')}|${cell.height}|${cell.waterLevel}`;

    /**
     * Generates one tile's sub-grid from its parent cell — the microscopic
     * zoom. The sub-grid has the ROOT grid's dimensions (the recursion rule:
     * zooming in never changes the board shape), and every subtile inherits
     * the parent column (voxels, height, water line, passability, biome):
     * the tile's interior ground IS the tile's ground. The parent's deposits
     * distribute across the subtiles — the zoom reveals WHERE they stand:
     *   finite deposits (wood ×2 on a forest tile) scatter one unit per
     *     seeded subtile — the individual trees/rocks/ore pockets, gathered
     *     or regrown deposits reshape the scatter through the fingerprint;
     *   unlimited deposits (sand, dirt) ARE the ground — every subtile
     *     carries the symbolic deposit so the zoom preserves the tile's look.
     */
    const generateSubCanvas = (parent: TerrainCell, pathKey: string): Canvas => {
        const width = dims.width;
        const height = dims.height;
        const halfX = (width - 1) / 2;
        const halfY = (height - 1) / 2;

        // Pre-scatter the finite deposits: each unit of each finite resource
        // lands on its own seeded subtile position (a bounded re-roll keeps
        // units from stacking when the grid has room to spread them)
        const deposits = new Map<string, TileResources>();
        TILE_RESOURCES.forEach((resource) => {
            if (UNLIMITED_TILE_RESOURCES.includes(resource)) {
                return;
            }
            const count = parent.resources[resource] ?? 0;
            if (count <= 0) {
                return;
            }
            const stream = randomKeyed(resolvedSeed, `sub:${pathKey}:${resource}`);
            const taken = new Set<string>();
            for (let unit = 0; unit < count; unit++) {
                let x = 0;
                let y = 0;
                for (let attempt = 0; attempt < 24; attempt++) {
                    x = Math.floor(stream() * width) - halfX;
                    y = Math.floor(stream() * height) - halfY;
                    if (!taken.has(`${x},${y}`)) {
                        break;
                    }
                }
                taken.add(`${x},${y}`);
                const record = deposits.get(`${x},${y}`) ?? {};
                record[resource] = (record[resource] ?? 0) + 1;
                deposits.set(`${x},${y}`, record);
            }
        });

        const cells: TerrainCell[] = [];
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const x = col - halfX;
                const y = row - halfY;
                const resources: TileResources = { ...(deposits.get(`${x},${y}`) ?? {}) };
                // Unlimited deposits are the ground itself — every subtile
                // carries the symbolic deposit so the zoomed tile keeps the
                // look its parent paints with (the microscopic-zoom rule)
                TILE_RESOURCES.forEach((resource) => {
                    if (
                        UNLIMITED_TILE_RESOURCES.includes(resource) &&
                        (parent.resources[resource] ?? 0) > 0
                    ) {
                        resources[resource] = 1;
                    }
                });
                cells.push({
                    x,
                    y,
                    voxels: [...parent.voxels],
                    height: parent.height,
                    waterLevel: parent.waterLevel,
                    biome: parent.biome,
                    passable: parent.passable,
                    resources,
                });
            }
        }
        return { width, height, cells };
    };

    // Resolves a tile address to its grid: the empty path is the root
    // canvas; every deeper level resolves its parent cell and serves the
    // cached sub-grid (or generates + caches one). Beyond the configured
    // subtile depth there is nothing to resolve.
    const canvasAtPath = (path: TilePath): Canvas | undefined => {
        if (!bound) {
            return undefined;
        }
        let canvas = bound.world.canvas;
        for (let level = 0; level < path.length; level++) {
            if (level >= subtileDepth) {
                return undefined;
            }
            const parentCell = cellOn(canvas, path[level].x, path[level].y);
            if (!parentCell) {
                return undefined;
            }
            const key = tilePathKey(path.slice(0, level + 1));
            const stamp = fingerprintOf(parentCell);
            const cached = subCanvases.get(key);
            if (cached && cached.stamp === stamp) {
                canvas = cached.canvas;
                continue;
            }
            canvas = generateSubCanvas(parentCell, key);
            subCanvases.set(key, { stamp, canvas });
            // FIFO eviction — the freshly inserted entry sorts last, so the
            // oldest grids drop first
            while (subCanvases.size > SUB_CANVAS_CACHE) {
                const oldest = subCanvases.keys().next().value;
                if (oldest === undefined) {
                    break;
                }
                subCanvases.delete(oldest);
            }
        }
        return canvas;
    };

    return {
        id: 'island-terrain',
        label: 'Island Terrain',
        setup: (context: PluginContext) => {
            // Remember the context so resize() can regenerate outside setup
            bound = context;
            regenerate(context);
        },
        stats: () => lastStats,
        size: () => ({ ...dims }),
        resize: (width, height) => {
            // The odd rule holds for runtime resizes as well — an even input
            // is nudged up to the next odd size (log reflects the real size)
            const finalWidth = oddSize(width);
            const finalHeight = oddSize(height);
            dims.width = finalWidth;
            dims.height = finalHeight;
            if (!bound) {
                // Never set up — nothing to regenerate yet; the next setup
                // picks the new dims up
                return;
            }
            regenerate(bound);
            // The reshaped root invalidates every cached sub-grid (their
            // dims and parents all changed with it)
            subCanvases.clear();
            // The god reshaped the world — say so in the log
            bound.world.events.emit({
                kind: 'world',
                message: `The island is redrawn at ${finalWidth}×${finalHeight}.`,
            });
        },
        depth: () => subtileDepth,
        tilesAt: (scale) => Math.pow(dims.width * dims.height, scale + 1),
        canvasFor: (path) => canvasAtPath(path),
        cellFor: (path) => {
            if (path.length === 0) {
                return undefined;
            }
            const canvas = canvasAtPath(path.slice(0, -1));
            if (!canvas) {
                return undefined;
            }
            const tail = path[path.length - 1];
            return cellOn(canvas, tail.x, tail.y);
        },
    };
};
