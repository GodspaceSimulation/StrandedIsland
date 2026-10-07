// Procedural voxel island generation (the canvas).
//
// The island is a width × height grid of voxel columns. Each column is built
// from a heightmap driven by two octaves of seeded value noise (lattice +
// bilinear + smoothstep) shaped by a radial falloff so the center rises above
// the water line and the edges fall into the sea — a small island.
//
// Every column also carries RESOURCE DEPOSITS (TileResources on engine/types)
// under two rules:
//
//   GROUND SUPPLY (infinite) — every ground voxel material a DRY column is
//   actually built from supplies its resource forever, at the symbolic count
//   of 1: stone voxels → stone ×∞, dirt voxels → dirt ×∞, grass voxels →
//   grass ×∞, sand voxels → sand ×∞. The match is by voxel NAME (the
//   resource token inside the name — "voxel names with 'stone' 'grass'
//   produce infinite resource of that type at the tile"), never by biome,
//   and it reads the ACTUAL voxel column (underlayers included — the dirt
//   under a meadow and the stone bedrock under everything supply too).
//   Submerged columns supply nothing (no dry habitat, no access — the sea
//   keeps its plain biome look and stocks fish only). Takes stay gated by
//   bag capacity and the 'mine' ability (stone/iron) but never deplete the
//   ground. Mirrored onto every fine cell at the zoomed scale.
//
//   THE FOREST STAND (finite, biological) — a forested tile seeds a
//   PERSISTENT FINE-SCALE TREE RECORD (ForestStand below): FOREST_COVERAGE
//   of the tile's fine cells hold one tree each, at mixed seeded ages. The
//   stand is authoritative; the tile's `tree` deposit count MIRRORS the
//   standing tree count (the inventory plugin's gatherable stock seeds from
//   it, the canvas surface reads it). The plugins/forest ecology grows the
//   trees' wood, recruits new ones and spreads the woods — see that plugin.
//
// The deposits are what the tile appears as on the canvas (tileSurfaceKey
// below) and what the inventory plugin seeds its gatherable cell stocks
// from. Wood is NOT a deposit — it is the product of cutting wood off a
// tree (the lumber behaviour's chop → inventory.harvest).
//
// Everything is deterministic: the same seed produces the exact same island,
// which is what the tests assert. `@presource/core` has no seeded PRNG, so the
// stream comes from engine/random.ts (mulberry32) via @godspace/core.

import { randomCreate, randomKeyed, type RandomSource } from '@godspace/core';
import type { Biome, Canvas, TerrainCell, TileResource, TileResources, VoxelKind } from '../../engine/types';
import { TILE_RESOURCES, UNLIMITED_TILE_RESOURCES } from '../../engine/types';
import type { PluginContext, WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';
import { tilePathKey, type TilePath } from '@godspace/core';

/** The terrain plugin handle's shape (the forest plugin coordinates with it). */
export type IslandTerrainPlugin = ReturnType<typeof islandTerrainPlugin>;

export type IslandTerrainOptions = {
    /** Grid width in cells (odd — 0,0 is the center). Default 25. */
    width?: number;
    /** Grid height in cells (odd — 0,0 is the center). Default 17. */
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
     * opens into a full sub-grid of the SAME dimensions (a 25×17 world with
     * subtiles 1 holds 425 island tiles — the scale-1 view — and
     * 425×425 = 180,625 interior tiles — the scale-0 view). Default 1:
     * scale 0 (each tile's interior — the simulation ground) and scale 1
     * (the island). 0 produces no sub-grids at all. The generator itself is
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
 * landmarks — on the 37×25 seed-7 reference board 3 of the 9 highland cells
 * lode (vein samples 0.0756 … 0.5158), while the smaller 25×17 default
 * island keeps all 9 samples below it (0.1552 … 0.4076 — its iron census
 * reads 0; the tests pin both boards).
 */
export const IRON_LODE_THRESHOLD = 0.5;

/**
 * Moisture threshold for forests: a dry grass-surface cell whose moisture
 * sample exceeds it grows one — trees stand on the tile (the deriveBiome
 * ladder and the tree deposit both read `forested` below). Lowered from the
 * old inline 0.6 so the meadows read as woodland more often: on the seed-7
 * 25×17 reference island the forest census moves 52 → 75 (see
 * islandTerrain.test.ts).
 */
export const FOREST_MOISTURE_THRESHOLD = 0.5;

/**
 * The DENSE GROVE line — SUPERSEDED. Every forested tile now seeds the same
 * fine-scale tree stand at FOREST_COVERAGE coverage (90% of the tile's fine
 * cells — "90% of the map at scale 0 is covered in tree"); the old plain ×2 /
 * dense ×6 deposit ladder is gone because the zoomed interior is where the
 * density lives now.
 */

/**
 * Tree coverage of a forest tile's fine cells at generation — "90% of the
 * map at scale 0 is covered in tree". The default island's 25×17 sub-grid
 * holds 425 fine cells → Math.round(0.9 × 425) = 383 trees per forest tile
 * (the rounding choice is pinned: 382.5 rounds UP to 383). Growth and
 * recruitment may carry an uncut stand toward the full 100% over the years
 * (plugins/forest documents the cap); felled spots refill by recruitment.
 */
export const FOREST_COVERAGE = 0.9;

/**
 * The exact standing-tree count a forest tile seeds: FOREST_COVERAGE of the
 * sub-grid's fine cells, half-up rounded (Math.round — 382.5 → 383 on the
 * 425-cell default island).
 */
export const forestTreeCount = (width: number, height: number): number =>
    Math.round(FOREST_COVERAGE * width * height);

// ── The persistent forest stands ─────────────────────────────────────────────
//
// The fine-scale tree record of ONE parent tile. The terrain plugin owns the
// registry (its sub-grid generation is what consumes the positions — see
// generateSubCanvas); the plugins/forest ecology reads and mutates the stands
// through this plugin's `forestOf` / `forestPlant` API. Seeding happens in
// `generateIsland`'s wake (regenerate → seedStands): every forested tile gets
// forestTreeCount positions from its own keyed stream, each carrying a
// VIRGIN record the ecology ages lazily (see plugins/forest poolOf).

/** One standing tree of a forest stand — the wood-growth bookkeeping. */
export type ForestTreeRecord = {
    /**
     * Birth minute on the ecology clock. Seeded old growth carries a
     * NEGATIVE birth (the tree stood before the world did); virgin records
     * (born 0 AND baseMinute 0 — see poolOf in plugins/forest) are aged
     * lazily from `seedAge` on first read.
     */
    born: number;
    /** Wood pool baseline (integer) standing at `baseMinute`. */
    base: number;
    /** The minute the baseline was taken (birth or the last harvest fold). */
    baseMinute: number;
    /** Fractional growth carry — numerator over the rate's denominator. */
    carry: number;
    /**
     * Pre-drawn age fraction [0,1) for VIRGIN seeded trees — the ecology's
     * lazy aging turns it into `born = −floor(seedAge × maturity)` once.
     * Recruited/spread saplings carry none (they are born in-world).
     */
    seedAge?: number;
};

/** The persistent fine-scale tree record of one forest tile. */
export type ForestStand = {
    /** Standing trees by fine-spot key "x,y" (centered sub-grid coordinates). */
    trees: Map<string, ForestTreeRecord>;
};

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
    const width = oddSize(options.width ?? 25);
    const height = oddSize(options.height ?? 17);
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
            // Forests only grow on grass wet enough — the moisture map
            // decides where the woods stand on the meadows
            const forested = surface === 'grass' && moisture(col, row) > FOREST_MOISTURE_THRESHOLD;

            // Build the voxel stack, bottom → top:
            //   stone × (ground-2), dirt × 1, surface × 1,
            //   then water up to the sea level (submerged columns),
            //   then a forest voxel when wooded
            const stack: VoxelKind[] = [];
            if (groundHeight >= 3) {
                for (let index = 0; index < groundHeight - 2; index++) {
                    stack.push('stone');
                }
            }
            if (groundHeight >= 2) {
                stack.push('dirt');
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
            // appearance from the tile (see below). Two seeding rules:
            //
            //   GROUND SUPPLY — every ground voxel material the DRY column
            //   is built from, at the symbolic count of 1: unlimited, never
            //   depleted by takes (UNLIMITED_TILE_RESOURCES), mirrored onto
            //   every fine cell at the zoom. Submerged columns supply
            //   nothing (no habitat, no access — the sea keeps its look).
            //
            //   THE TREE STAND — forested tiles seed the persistent
            //   fine-scale record (seedStands after generation); the count
            //   mirrors the seeded stand size. Felling/recruitment move the
            //   mirror with the stand (plugins/forest).
            const resources: TileResources = {};
            if (!submerged) {
                if (stack.includes('stone')) {
                    resources.stone = 1;
                }
                if (stack.includes('dirt')) {
                    resources.dirt = 1;
                }
                if (stack.includes('grass')) {
                    resources.grass = 1;
                }
                if (stack.includes('sand')) {
                    resources.sand = 1;
                }
                if (forested) {
                    resources.tree = forestTreeCount(width, height);
                } else if (surface === 'stone' && veins(col, row) > IRON_LODE_THRESHOLD) {
                    // Iron lodes hide in the stone highlands — the vein
                    // noise's rare landmark (a FINITE deposit; the mine gate
                    // limits who takes it)
                    resources.iron = 1;
                    stats.iron = stats.iron + 1;
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
// The tile's DEPOSITS + ACTUAL VOXELS decide what it appears as on the
// canvas: landmarks first (an iron lode, standing trees), then the tile's
// own GROUND material (the topmost voxel that maps to a resource, read from
// the real column), falling back to the plain biome. The underlayer supplies
// (the dirt under a meadow, the bedrock stone under everything) appear in
// the Resources lists but never repaint the tile — the tile reads as what
// its SURFACE is.

/** The minimal cell slice the surface derivation reads. */
export type TileSurfaceCell = {
    biome?: string;
    resources?: TileResources;
    voxels?: VoxelKind[];
};

/**
 * The canvas surface key of a tile:
 *   iron lode → 'iron'; standing trees → 'tree' — the landmarks stand out;
 *   a forest voxel (the standing canopy — a clearcut wood keeps the look) →
 *   'forest'; else the topmost ground voxel that maps to a carried resource
 *   ('grass' | 'sand' | 'stone' | 'dirt') — the tile reads as its ground;
 *   else the plain biome (sea columns, or the deposit-less fallback shapes).
 */
export const tileSurfaceKey = (cell: TileSurfaceCell): string | undefined => {
    const resources = cell.resources ?? {};
    if ((resources.iron ?? 0) > 0) {
        return 'iron';
    }
    if ((resources.tree ?? 0) > 0) {
        return 'tree';
    }
    const voxels = cell.voxels;
    if (voxels && voxels.length > 0) {
        // The standing canopy outranks the ground — a clearcut wood keeps
        // its forest look (the forest voxel still stands)
        if (voxels.includes('forest')) {
            return 'forest';
        }
        // The tile's GROUND: the topmost voxel whose material is carried as
        // a resource (the resource-backed check keeps deposit-less shapes —
        // sea columns, test fixtures — on their plain biome)
        for (let index = voxels.length - 1; index >= 0; index--) {
            const kind = voxels[index];
            if ((kind === 'grass' || kind === 'sand' || kind === 'stone' || kind === 'dirt') &&
                (resources[kind] ?? 0) > 0) {
                return kind;
            }
        }
    }
    return cell.biome;
};

/** One "tree ×2" / "sand ×∞" fragment for hover titles and inspectors. */
const depositFragment = (resource: TileResource, count: number): string =>
    UNLIMITED_TILE_RESOURCES.includes(resource) ? `${resource} ×∞` : `${resource} ×${count}`;

/**
 * Human readable deposit summary of a tile's resources, in
 * TILE_RESOURCES order: "tree ×2 · iron ×1" — empty when bare.
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
 * (the recursion rule — a 25×17 world holds 425×425 scale-0 tiles with
 * subtiles 1). `tilesAt(scale)` counts the tiles of a ladder level (the
 * ladder counts UP from the interior ground: scale 0 the deepest generated
 * level, scale = depth the island root), `cellFor(path)` resolves one tile,
 * `depth()` reports the configured subtile levels.
 *
 * The plugin also owns the PERSISTENT FOREST STANDS (the fine-scale tree
 * records the zoom mirrors and the plugins/forest ecology mutates):
 * `forestOf(tile)` reads a tile's stand, `forestPlant(tile, fine, record)`
 * adds one tree (recruitment + spread conversions plant through it).
 */
export const islandTerrainPlugin = (options: IslandTerrainOptions = {}): WorldPlugin<World> & {
    stats(): IslandStats | undefined;
    /** Current grid size (as configured — the canvas is regenerated to match). */
    size(): { width: number; height: number };
    /** Regenerates the island at a new grid size, replacing the whole canvas. */
    resize(width: number, height: number): void;
    /** How many subtile levels the generator produces below the root grid. */
    depth(): number;
    /** Tile count of one ladder level (scale = depth → the island root itself). */
    tilesAt(scale: number): number;
    /** The grid at a tile address — the root canvas for the empty path. */
    canvasFor(path: TilePath): Canvas | undefined;
    /** One tile at a tile address (the parent path resolves its grid). */
    cellFor(path: TilePath): TerrainCell | undefined;
    /** The persistent forest stand of a parent tile (undefined: none). */
    forestOf(x: number, y: number): ForestStand | undefined;
    /** Adds one tree to a tile's stand (creating it), and returns the stand. */
    forestPlant(x: number, y: number, fine: { x: number; y: number }, record: ForestTreeRecord): ForestStand;
} => {
    // Last generation stats, exposed for the god-view roster
    let lastStats: IslandStats | undefined;
    // Configured grid size — the default, overridable by options and
    // changeable at runtime through resize(). Odd rule enforced here too:
    // (0, 0) must be the exact canvas center.
    const dims = { width: oddSize(options.width ?? 25), height: oddSize(options.height ?? 17) };
    // Subtile levels below the root (the recursive tiling configuration)
    const subtileDepth = options.subtiles ?? 1;
    // The plugin context captured in setup — resize() needs the world (canvas
    // swap + event emission) between lifecycle hooks
    let bound: PluginContext<World> | null = null;
    // The seed the last generation resolved (options.seed ?? world seed) —
    // sub-grid generation keys its streams off the same seed
    let resolvedSeed = options.seed ?? 1;
    // Sub-grid cache, keyed by tile path — a zoomed-in view re-renders every
    // pulse, so regenerating 425 cells each time would burn the frame; the
    // fingerprint (parent deposits + height + water line + biome + voxels)
    // invalidates a cached grid exactly when the parent tile changed
    // (gathering, tree work, the forest spread's biome conversion)
    const subCanvases = new Map<string, { stamp: string; canvas: Canvas }>();
    // FIFO cap — zooming around must not accumulate grids without bound
    const SUB_CANVAS_CACHE = 32;
    // The persistent forest stands — keyed by PARENT tile "x,y" (the ROOT
    // grid's coordinates; sub-grid positions live INSIDE each stand).
    // Rebuilt on every regeneration (resize = a reshaped world, fresh stands).
    const forestStands = new Map<string, ForestStand>();

    /** One generation pass: builds the canvas and installs it on the world. */
    const regenerate = (context: PluginContext<World>) => {
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
        // Seed the persistent forest stands from the fresh canvas (every
        // forested tile gets its FOREST_COVERAGE fine positions with virgin
        // records the ecology ages lazily — plugins/forest poolOf)
        seedStands();
    };

    /**
     * Seeds the persistent forest stands: every forested parent tile gets
     * forestTreeCount fine positions, drawn from its own keyed stream. The
     * positions come off a SEEDED SHUFFLE of the whole fine grid (Fisher-
     * Yates over all spots, take the first count) so the density is EXACT —
     * no collision-re-roll can under-fill a near-full stand. Each position
     * carries a VIRGIN record (born 0 / baseMinute 0 / base 1) plus its
     * pre-drawn age fraction — the ecology's lazy aging (plugins/forest
     * poolOf) turns the fraction into a negative birth minute on first
     * read, so the seeded woods hold mixed ages and wood immediately.
     */
    const seedStands = () => {
        forestStands.clear();
        const count = forestTreeCount(dims.width, dims.height);
        const halfX = (dims.width - 1) / 2;
        const halfY = (dims.height - 1) / 2;
        bound?.world.canvas.cells.forEach((cell) => {
            if ((cell.resources.tree ?? 0) <= 0) {
                return;
            }
            const stream = randomKeyed(resolvedSeed, `forest:${cell.x},${cell.y}`);
            // All fine spots, seeded-shuffled once — the first `count` hold trees
            const spots: Array<{ x: number; y: number }> = [];
            for (let row = 0; row < dims.height; row++) {
                for (let col = 0; col < dims.width; col++) {
                    spots.push({ x: col - halfX, y: row - halfY });
                }
            }
            for (let index = spots.length - 1; index > 0; index--) {
                const swap = Math.floor(stream() * (index + 1));
                const held = spots[index];
                spots[index] = spots[swap];
                spots[swap] = held;
            }
            const stand: ForestStand = { trees: new Map() };
            for (let unit = 0; unit < count; unit++) {
                const spot = spots[unit];
                stand.trees.set(`${spot.x},${spot.y}`, {
                    born: 0,
                    base: 1,
                    baseMinute: 0,
                    carry: 0,
                    // The pre-drawn age fraction — the SAME stream the
                    // positions drew from, so seeding stays one pass
                    seedAge: stream(),
                });
            }
            forestStands.set(`${cell.x},${cell.y}`, stand);
        });
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

    // The parent-change stamp of a cell: its deposits + height + water line
    // + biome + voxel stack. The forest ecology now DOES reshape columns
    // after generation (the spread conversion stacks a forest voxel onto a
    // converted meadow and re-biomes it), so the stamp carries the voxels
    // and biome too — a stamp change invalidates the cached sub-grid exactly
    // when the parent tile changed (gathering, tree work, spread).
    const fingerprintOf = (cell: TerrainCell): string =>
        `${TILE_RESOURCES.map((resource) => cell.resources[resource] ?? 0).join(',')}|${cell.height}|${cell.waterLevel}|${cell.biome}|${cell.voxels.join('+')}`;

    /**
     * Generates one tile's sub-grid from its parent cell — the microscopic
     * zoom. The sub-grid has the ROOT grid's dimensions (the recursion rule:
     * zooming in never changes the board shape), and every subtile inherits
     * the parent column (voxels, height, water line, passability, biome):
     * the tile's interior ground IS the tile's ground. The parent's deposits
     * distribute across the subtiles — the zoom reveals WHERE they stand:
     *   the INFINITE ground supply (stone/dirt/grass/sand) IS the ground —
     *     every subtile carries the symbolic deposit so the zoom preserves
     *     the tile's look (rocks full-matching every stone-voxel tile);
     *   the TREE stand is PERSISTENT — the forest record's fine positions
     *     put one tree unit each on their exact subtile; felling and
     *     recruitment never reshuffle the other positions (the stand is
     *     authoritative, the parent count mirrors it — the fingerprint
     *     still invalidates the cache when the mirror moves, and the
     *     regenerated grid re-reads the SAME positions);
     *   remaining finite deposits (an iron lode) scatter one unit per
     *     seeded subtile.
     */
    const generateSubCanvas = (parent: TerrainCell, pathKey: string): Canvas => {
        const width = dims.width;
        const height = dims.height;
        const halfX = (width - 1) / 2;
        const halfY = (height - 1) / 2;

        // The parent's persistent stand — its positions author the tree
        // mirror (a stand-less forest tile falls back to the seeded scatter
        // below, the pre-ecology shape)
        const stand = forestOf(parent.x, parent.y);

        // Pre-scatter the remaining finite deposits (an iron lode — and the
        // legacy tree scatter when no stand exists): each unit lands on its
        // own seeded subtile position (a bounded re-roll keeps units from
        // stacking when the grid has room to spread them)
        const deposits = new Map<string, TileResources>();
        TILE_RESOURCES.forEach((resource) => {
            if (UNLIMITED_TILE_RESOURCES.includes(resource)) {
                return;
            }
            // The tree mirror is stand-authored — no scatter when a stand exists
            if (resource === 'tree' && stand) {
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
                // The persistent tree: the stand's exact fine position puts
                // ONE tree unit here (a fine cell holds at most one tree)
                if (stand?.trees.has(`${x},${y}`)) {
                    resources.tree = 1;
                }
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

    // ── The persistent forest stand registry ─────────────────────────────────
    // The terrain plugin OWNS the stands (its sub-grid generation mirrors
    // them); the plugins/forest ecology mutates them through this pair.

    /** A tile's persistent stand (undefined: the tile holds no forest). */
    const forestOf = (x: number, y: number): ForestStand | undefined =>
        forestStands.get(`${x},${y}`);

    /** Adds one tree to a tile's stand, creating the stand when absent. */
    const forestPlant = (
        x: number,
        y: number,
        fine: { x: number; y: number },
        record: ForestTreeRecord,
    ): ForestStand => {
        const key = `${x},${y}`;
        let stand = forestStands.get(key);
        if (!stand) {
            stand = { trees: new Map() };
            forestStands.set(key, stand);
        }
        stand.trees.set(`${fine.x},${fine.y}`, record);
        return stand;
    };

    return {
        id: 'island-terrain',
        label: 'Island Terrain',
        setup: (context: PluginContext<World>) => {
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
        // The ladder counts UP from the interior ground: scale 0 the deepest
        // generated level ((w·h)^(depth+1) tiles), scale = depth the island
        // root (w·h tiles). Above the island the exponent clamps at 0 — the
        // island as ONE tile of a still-wider (ungenerated) space.
        tilesAt: (scale) =>
            Math.pow(dims.width * dims.height, Math.max(0, subtileDepth + 1 - scale)),
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
        forestOf: (x, y) => forestOf(x, y),
        forestPlant: (x, y, fine, record) => forestPlant(x, y, fine, record),
    };
};
