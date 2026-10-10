// Procedural voxel island generation (the canvas).
//
// The island is a width × height grid of voxel columns. Each column is built
// from a heightmap driven by two octaves of seeded value noise (lattice +
// bilinear + smoothstep) shaped by a radial falloff so the center rises above
// the water line and the edges fall into the sea — a small island.
//
// R4 — THE RIVERS: after the basins drown, the generator carves up to
// RIVER_COUNT meandering fresh-water courses from the interior highlands down
// to the open sea (the generateIsland river pass documents the walk: greedy
// height descent + keyed per-cell jitter + direction persistence, cardinal
// connectivity guaranteed, a BFS corridor finishing any stalled course). A
// river cell is a PASSABLE shallow ford (engine/types.ts Biome 'river') whose
// water the inventory gathers INEXHAUSTIBLY (plugins/inventory) — the island
// reads organic and its fresh water never runs dry.
//
// Every column also carries RESOURCE DEPOSITS (TileResources on engine/types)
// under two rules:
//
//   GROUND SUPPLY (infinite) — every ground voxel material a DRY column is
//   actually built from supplies its resource forever, at the symbolic count
//   of 1: dirt voxels → dirt ×∞, grass voxels → grass ×∞, sand voxels →
//   sand ×∞. The match is by voxel NAME (the resource token inside the name),
//   never by biome, and it reads the ACTUAL voxel column (underlayers
//   included — the dirt under a meadow supplies too; the GRAVEL bedrock under
//   everything supplies nothing — gravel is terrain, not a resource token).
//   Submerged columns supply nothing (no dry habitat, no access — the sea
//   keeps its plain biome look and stocks fish only). Takes stay gated by
//   bag capacity and the 'mine' ability (stone/iron) but never deplete the
//   ground. Mirrored onto every fine cell at the zoomed scale.
//
//   FINITE STONE (the rock sites) — STONE IS NO LONGER THE GROUND'S
//   INFINITE SUPPLY: the old "every column with a stone voxel carries stone
//   ×∞" is gone (a gravel-to-stone rename of the rock terrain — VoxelKind
//   'gravel' — and stone's removal from UNLIMITED_TILE_RESOURCES). The stone
//   resource now stands ONLY where a visible rock site does, as a FINITE,
//   mineable, drawable deposit:
//     highland tiles (the gravel-surface peaks) — STONE_PER_HIGHLAND each
//     (the rock site the mine gate works; the 🪨 icon + the 'stone' surface
//     key read it while its stock stands);
//     boulder-crowned fine cells (the rock-spillover band, rockSpillSpots)
//     — the crowns are the visible boulders: at the zoom, each crown fine
//     cell carries one stone unit while the parent tile's stock covers it
//     (generateSubCanvas's crown-first distribution — the remaining stock
//     scatters onto ordinary fine cells as standing piles).
//     THE FINITE STONE GUARANTEE — like the iron guarantee below, every
//     playable island carries at least STONE_GUARANTEE_MIN stones (the
//     campaign's 1-stone axe + 8-stone fort need 9; 12 leaves headroom):
//     highlands top up cyclically; a highland-less island stamps the whole
//     shortfall on its PEAK (the highest dry cell — a stone heap visible on
//     the island view).
//   Deterministic and seed-keyed: the distribution reads no random stream
//   (row-major order + the fixed constants), so the noise-lattice stream
//   above and the biome map stay untouched.
//
//   THE FOREST STAND (finite, biological) — a forested tile seeds a
//   PERSISTENT FINE-SCALE TREE RECORD (ForestStand below): the tile's
//   NEIGHBORHOOD COVERAGE of its fine cells hold one tree each, at mixed
//   seeded ages (the 8-neighbor model below). The stand is authoritative;
//   the tile's `tree` deposit count MIRRORS the standing tree count (the
//   inventory plugin's gatherable stock seeds from it, the canvas surface
//   reads it). The plugins/forest ecology grows the trees' wood, recruits
//   new ones and spreads the woods — see that plugin.
//
//   THE NEIGHBORHOOD MODEL — resources generated within a tile are
//   affected by ALL EIGHT of its neighbors (NEIGHBOR_OFFSETS from
//   @godspace/core — 4 cardinals + 4 diagonals), with the cardinal
//   directions weighing DOUBLE the diagonals. The model is a pure function
//   of the finished biome map (generation pass 2 below — no random draws,
//   so the noise-lattice stream order above is untouched), classified per
//   neighbor's actual biome name ('meadow' — the engine/types biome
//   vocabulary — never a 'grassland' alias):
//
//     forest neighbor   — the woods feed the woods: the tile's tree
//                         coverage GAINS (FOREST_NEIGHBOR_* weights). A
//                         forest ringed by 8 forests clamps to the FULL
//                         100% stand — 425 trees on the default island,
//                         not the old uniform 90% cap; a forest with only
//                         4 forest neighbors lands well below it.
//     meadow neighbor   — THE GRASSLAND'S COMPLEMENT (R1): a meadow edge
//                         feeds its forest neighbors on the GAIN side at
//                         the very same FOREST_NEIGHBOR_* weights (a
//                         meadow edge prices a forest tile's coverage
//                         exactly like a forest edge). IN ADDITION, the
//                         MEADOW tile itself gains its own LOCALIZED TREE
//                         INGRESS (meadowIngressSpots below): a thin stand
//                         of trees along the shared edge. The meadow keeps
//                         its biome; its trees are a real persistent stand
//                         the ecology's chop harvests and the spread
//                         conversion joins.
//     highland neighbor — the rock crowds the woods: the tile's coverage
//                         DROPS (ROCK_NEIGHBOR_* weights) AND a
//                         rock-spillover band is carved along the shared
//                         edge (rockSpillSpots below) — the TileCarving on
//                         engine/types.ts; the zoomed interior crowns the
//                         band's fine cells with a boulder voxel (their top
//                         surface reads as rock) and no tree stands on a
//                         boulder.
//     beach / water     — sand and sea feed nothing (no contribution).
//
//   Out-of-grid positions (beyond the canvas rim) are not neighbors — the
//   rim is always open sea anyway. Highland edges never change after
//   generation (the ecology only converts meadows), so a carve is stable
//   for its tile's life; the sub-grid fingerprint stamps it regardless,
//   so cached grids invalidate exactly when the carve is present or
//   changes (fingerprintOf below).
//
// The deposits are what the tile appears as on the canvas (tileSurfaceKey
// below) and what the inventory plugin seeds its gatherable cell stocks
// from. Wood is NOT a deposit — it is the product of cutting wood off a
// tree (the lumber behaviour's chop → inventory.harvest).
//
// Everything is deterministic: the same seed produces the exact same island,
// which is what the tests assert. `@presource/core` has no seeded PRNG, so the
// stream comes from engine/random.ts (mulberry32) via @godspace/core.

import { arrayEach } from '@presource/core';
import { NEIGHBOR_OFFSETS, randomCreate, randomKeyed, type RandomSource } from '@godspace/core';
import type { Biome, Canvas, TerrainCell, TileCarving, TileResource, TileResources, VoxelKind } from '../../engine/types';
import { isFreshBasin, TILE_RESOURCES, UNLIMITED_TILE_RESOURCES } from '../../engine/types';
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
    /** Total FINITE STONE standing on the island (the sum of every tile's
     *  stone deposit after the finite-stone guarantee — the gatherable
     *  rock stock; the 🪨 icons and the 'stone' surfaces track it). */
    stone: number;
};

/**
 * Vein-noise threshold for iron lodes: a dry gravel-surface cell (the
 * highland) whose vein sample exceeds it carries an iron deposit. Calibrated
 * so lodes stay rare
 * landmarks — on the 37×25 seed-7 reference board 3 of the 9 highland cells
 * lode (vein samples 0.0756 … 0.5158), while the smaller 25×17 default
 * island keeps all 9 samples below it (0.1552 … 0.4076). The vein noise
 * alone would leave the default island lode-less, so generateIsland's
 * iron guarantee (the row-major first highland cell) stamps it a single
 * lode (its iron census reads 1; the tests pin both boards).
 */
export const IRON_LODE_THRESHOLD = 0.5;

/**
 * The FINITE STONE stock of one HIGHLAND tile at generation — the localized
 * visible rock site (the gravel-surface peak that reads as the 'stone'
 * surface key and carries the 🪨 marker while its stock stands). Chosen for
 * the campaign's early needs: the 1-stone axe + the 8-stone fort owe 9
 * stones before anything else, so a handful of highlands must each cover
 * more than a single tool's edge (3 per site — 9 highlands seed-7 style
 * island: 27 stones standing) while the finite-stone guarantee (below)
 * still guarantees the island-wide floor for rocky-poor seeds.
 */
export const STONE_PER_HIGHLAND = 3;

/**
 * The FINITE STONE GUARANTEE floor: every playable island carries at least
 * this many stones after the guarantee pass (the campaign's axe 1 + fort 8
 * = 9 leaves a headroom of 3 — a second fort edge or tool repair). The pass
 * (generateIsland's stone-guarantee, after the iron guarantee) tops
 * highlands up cyclically when their base stock falls short; a HIGHLAND-LESS
 * island (degenerate/low seeds) stamps
 * the whole shortfall on its PEAK — the highest dry cell (row-major tie) —
 * as a visible stone heap. Deterministic: row-major order + the constants
 * only (no random draws — the noise stream is untouched).
 */
export const STONE_GUARANTEE_MIN = 12;

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
 * The BASE tree coverage of a forest tile's fine cells at generation — the
 * coverage of an ISOLATED wood (no forest neighbors at all). The
 * neighborhood model builds on it: each forest neighbor adds
 * FOREST_NEIGHBOR_CARDINAL (cardinals) / FOREST_NEIGHBOR_DIAGONAL
 * (diagonals), each highland neighbor subtracts its ROCK_NEIGHBOR_* weight,
 * and the total clamps to [0, 1] — a fully ringed wood reaches the FULL
 * 100% (every fine cell holds a tree — 425 on the default island), while
 * half-surrounded woods land below the old uniform 90% seeding. Recruitment
 * may still carry an uncut stand to the full 100% over the years
 * (plugins/forest documents the cap); felled spots refill by recruitment.
 * Raised 0.45 → 0.60 for the resource-density fix (T2): sparse woods read
 * as an empty island; a denser base stand thickens every isolated wood
 * (an isolated 25×17 wood now seeds Math.round(0.60 × 425) = 255 trees,
 * not 191).
 */
export const FOREST_COVERAGE = 0.6;

/**
 * Coverage gain per CARDINAL forest neighbor (left/right/up/down — the
 * strong directions; diagonals weigh half). 8 forest neighbors: 4 cardinals
 * + 4 diagonals = 0.45 + 4×0.1 + 4×0.05 = 1.05 → clamped 1.0 → the full
 * 425-tree stand on the default island.
 */
export const FOREST_NEIGHBOR_CARDINAL = 0.1;

/** Coverage gain per DIAGONAL forest neighbor — half the cardinal weight. */
export const FOREST_NEIGHBOR_DIAGONAL = 0.05;

/**
 * Coverage penalty per CARDINAL highland (rocky) neighbor — the rock crowds
 * the woods out beside it (paired with the spillover band, rockSpillSpots).
 */
export const ROCK_NEIGHBOR_CARDINAL = 0.1;

/** Coverage penalty per DIAGONAL highland neighbor — half the cardinal. */
export const ROCK_NEIGHBOR_DIAGONAL = 0.05;

/**
 * Meadow TREE INGRESS per cardinal forest neighbor — the localized tree
 * seeding a meadow tile gains along the edge it shares with the woods (the
 * grassland complementing the forest border). The spots are the fine cells
 * closest to that shared edge (meadowIngressSpots), so the ingress stays a
 * thin fringe, never a full stand.
 */
export const MEADOW_INGRESS_CARDINAL = 8;

/**
 * Meadow tree ingress per diagonal forest neighbor — the corner fringe.
 * Raised 2 → 3 for the resource-density fix (T2): thin woodland borders
 * read as bare meadow; the fuller corner fringe keeps the woods' edges
 * continuous (a meadow sharing 1 cardinal + 1 diagonal forest edge now
 * ingresses 8 + 3 = 11 spots, not 8).
 */
export const MEADOW_INGRESS_DIAGONAL = 3;

// ── The river carving (R4) ───────────────────────────────────────────────────
//
// The R4 fix for the straight/flat island: meandering fresh-water courses
// carved from the interior down to the sea. The four constants steer the
// greedy downhill walk documented at the carve site (generateIsland); the
// shore tests pin them as the documented tuning, and the river-shape tests
// re-derive the courses from the same numbers.

/**
 * How many rivers the generator attempts per island. The second course
 * only starts when a source cell clear of the first channel exists (see
 * RIVER_SOURCE_GAP) — small/degenerate boards may carry fewer.
 */
export const RIVER_COUNT = 2;

/**
 * The meander amplitude — the per-cell keyed jitter added to every step
 * score, comparable to a one-voxel height step: the descent still wins on
 * real slopes, but on the height plateaus the jitter steers the course, so
 * the river CURVES instead of dropping in straight staircase lines.
 */
export const RIVER_JITTER = 0.6;

/**
 * The persistence bonus for keeping the previous step's direction — the
 * jitter bends stay gentle sweeps, never per-cell zigzags.
 */
export const RIVER_PERSIST = 0.4;

/**
 * The minimum Chebyshev distance between a second river's source and every
 * already-carved cell — the two courses never stack into one channel.
 */
export const RIVER_SOURCE_GAP = 5;

/**
 * The river's canvas color — EXPORTED for the scenario palette integration
 * (scenario/island.ts joins it into GRASS_TILE_PALETTE as the 'river'
 * surface key, beside the lake/pond water blues: a flowing course reads a
 * shade brighter than the still lake). The terrain package owns the hue so
 * generation and palette never drift.
 */
export const RIVER_TILE_COLOR = '#4a90d9';

/**
 * The BASE standing-tree count of a forest tile: FOREST_COVERAGE of the
 * sub-grid's fine cells, half-up rounded (Math.round — 255.0 → 255 on the
 * 425-cell default island at the 0.6 base; 21.0 → 21 on the 35-cell 7×5
 * board). The neighborhood model starts here and moves with the 8 neighbors
 * (forestCoverageOf); the exact per-tile count is what generation writes
 * into the tile's `tree` deposit.
 */
export const forestTreeCount = (width: number, height: number): number =>
    Math.round(FOREST_COVERAGE * width * height);

// ── The neighborhood resource model (pure helpers) ───────────────────────────
//
// All four helpers below are PURE and deterministic: they read the finished
// biome map and the fixed NEIGHBOR_OFFSETS order — no random draws anywhere,
// which is what keeps the noise-lattice stream order untouched (the per-cell
// loop draws nothing; generation pass 2 neither).

/** One neighbor direction ({ dx, dy } — the NEIGHBOR_OFFSETS element shape). */
type Offset = { dx: number; dy: number };

/** The biome classes of a tile's eight IN-GRID neighbors. */
export type Neighborhood = {
    /** Neighbors carrying woods (biome 'forest') — coverage gain. */
    forest: Offset[];
    /** Neighbors carrying rock (biome 'highland') — penalty + spillover. */
    rock: Offset[];
    /** Neighbors carrying open grass (biome 'meadow') — feed the forest
     * coverage (R1 grassland complement) AND earn the tile's own ingress. */
    meadow: Offset[];
};

/**
 * Classifies a tile's eight in-grid neighbors by biome. Out-of-grid
 * positions are not neighbors (the canvas rim is always open sea —
 * generateIsland's edge rule). Reads the ACTUAL biome names ('meadow' —
 * never a 'grassland' alias), in NEIGHBOR_OFFSETS' fixed clockwise order,
 * so the classification is deterministic per board.
 */
export const neighborhoodOf = (
    canvas: Pick<Canvas, 'width' | 'height' | 'cells'>,
    x: number,
    y: number,
): Neighborhood => {
    const neighborhood: Neighborhood = { forest: [], rock: [], meadow: [] };
    const halfX = (canvas.width - 1) / 2;
    const halfY = (canvas.height - 1) / 2;
    arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
        const nx = x + offset.dx;
        const ny = y + offset.dy;
        if (ny < -halfY || ny > halfY || nx < -halfX || nx > halfX) {
            return;
        }
        const neighbor = canvas.cells[(ny + halfY) * canvas.width + (nx + halfX)];
        if (neighbor.biome === 'forest') {
            neighborhood.forest.push(offset);
        } else if (neighbor.biome === 'highland') {
            neighborhood.rock.push(offset);
        } else if (neighbor.biome === 'meadow') {
            neighborhood.meadow.push(offset);
        }
    });
    return neighborhood;
};

/** Sums a neighbor class's directional weight: cardinals full, diagonals half. */
const directionalSum = (offsets: Offset[], cardinal: number, diagonal: number): number => {
    let sum = 0;
    arrayEach(offsets, ({ value: offset }) => {
        sum = sum + (offset.dx !== 0 && offset.dy !== 0 ? diagonal : cardinal);
    });
    return sum;
};

/**
 * The tree coverage fraction of a forest tile from its neighbor classes:
 * the base (FOREST_COVERAGE) plus the FOREST-ADJACENCY GAIN — every forest
 * neighbor AND every MEADOW (grassland) neighbor feeding the woods at the
 * identical cardinal/diagonal weights (R1: the grassland is the woods'
 * complement, so a meadow edge prices the coverage exactly like a forest
 * edge; the meadow's own localized tree ingress is a separate, additive
 * fringe — meadowIngressSpots). Minus every highland neighbor's penalty,
 * clamped to [0, 1]. Beach/water neighbors contribute nothing (sand and sea
 * feed no trees). Pure — the exact number the tile's tree deposit rounds to.
 */
export const forestCoverageOf = (forest: Offset[], rock: Offset[], meadow: Offset[] = []): number => {
    // The gain side sums the forest AND meadow edges alike (forest-adjacency
    // equivalence); the penalty side (the rock crowd-out) is unchanged
    const coverage =
        FOREST_COVERAGE +
        directionalSum(forest, FOREST_NEIGHBOR_CARDINAL, FOREST_NEIGHBOR_DIAGONAL) +
        directionalSum(meadow, FOREST_NEIGHBOR_CARDINAL, FOREST_NEIGHBOR_DIAGONAL) -
        directionalSum(rock, ROCK_NEIGHBOR_CARDINAL, ROCK_NEIGHBOR_DIAGONAL);
    return Math.max(0, Math.min(1, coverage));
};

/**
 * The rock-spillover band of a forest tile: the fine spots ("x,y" keys,
 * row-major order) a rocky neighbor's boulders spill onto. A cardinal
 * highland spills one full fine ROW/COLUMN deep along the shared edge; a
 * diagonal highland spills the corner wedge (the corner fine cell + its two
 * edge flanks). The checkerboard parity ((x + y) even — normalized for the
 * centered negative coordinates) halves the band, so scree scatters along
 * the edge instead of walling it. The zoomed interior crowns each spot's
 * column with a boulder voxel (generateSubCanvas) and the stand seeding
 * refuses them (no tree stands on a boulder). Pure — no draws, row-major
 * output order stamped into the sub-grid fingerprint.
 */
export const rockSpillSpots = (width: number, height: number, rock: Offset[]): string[] => {
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    // The checkerboard: (x + y) even. The centered coordinates go negative,
    // and JavaScript's % keeps the sign — normalize before the even test.
    const bouldered = (x: number, y: number): boolean => ((x + y) % 2 + 2) % 2 === 0;
    const spots = new Set<string>();
    arrayEach(rock, ({ value: offset }) => {
        if (offset.dx === 0) {
            // Cardinal north/south — the first fine row on that edge
            const y = offset.dy < 0 ? -halfY : halfY;
            for (let x = -halfX; x <= halfX; x++) {
                if (bouldered(x, y)) {
                    spots.add(`${x},${y}`);
                }
            }
        } else if (offset.dy === 0) {
            // Cardinal west/east — the first fine column on that edge
            const x = offset.dx < 0 ? -halfX : halfX;
            for (let y = -halfY; y <= halfY; y++) {
                if (bouldered(x, y)) {
                    spots.add(`${x},${y}`);
                }
            }
        } else {
            // Diagonal — the corner wedge: the corner fine cell plus its two
            // flanks (one along each edge sharing the corner)
            const cornerX = offset.dx < 0 ? -halfX : halfX;
            const cornerY = offset.dy < 0 ? -halfY : halfY;
            arrayEach(
                [
                    { x: cornerX, y: cornerY },
                    { x: cornerX - offset.dx, y: cornerY },
                    { x: cornerX, y: cornerY - offset.dy },
                ],
                ({ value: spot }) => {
                    if (bouldered(spot.x, spot.y)) {
                        spots.add(`${spot.x},${spot.y}`);
                    }
                },
            );
        }
    });
    // Row-major output order — the stable layout the fingerprint stamps
    return Array.from(spots).sort((left, right) => {
        const [lx, ly] = left.split(',').map(Number);
        const [rx, ry] = right.split(',').map(Number);
        return ly - ry || lx - rx;
    });
};

/**
 * The meadow TREE INGRESS spots: the fine cells ("x,y" keys) a meadow tile
 * gains trees on, LOCALIZED along the edges it shares with the woods. Each
 * forest-facing edge claims its own fringe — MEADOW_INGRESS_CARDINAL spots
 * along a cardinal edge, MEADOW_INGRESS_DIAGONAL at a shared corner — taken
 * in the edges' NEIGHBOR_OFFSETS order, each edge ranking its fine cells by
 * distance to THAT edge (cardinal: the perpendicular distance; diagonal: the
 * Chebyshev distance to the shared corner), ties breaking row-major. A spot
 * an earlier edge claimed is skipped (shared corners belong to the first
 * edge that reaches them), so EVERY shared edge gains its fringe — the
 * ingress stays a thin tree border hugging the woods, never crowding one
 * edge while starving another. The same selection the generation pass and
 * the stand seeding both read (one source of truth — the deposit count IS
 * this list's length). Pure — no draws.
 */
export const meadowIngressSpots = (width: number, height: number, forest: Offset[]): string[] => {
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    if (forest.length === 0) {
        return [];
    }
    // Distance from a fine spot to one forest-facing edge (cardinal: the
    // perpendicular; diagonal: the Chebyshev distance to the shared corner —
    // the max over the axes the offset actually crosses)
    const edgeDistance = (x: number, y: number, offset: Offset): number => {
        let distance = 0;
        if (offset.dx !== 0) {
            distance = Math.max(distance, offset.dx > 0 ? halfX - x : x + halfX);
        }
        if (offset.dy !== 0) {
            distance = Math.max(distance, offset.dy > 0 ? halfY - y : y + halfY);
        }
        return distance;
    };
    // Per-edge allocation in the fixed NEIGHBOR_OFFSETS order — each shared
    // edge fills its own quota from its closest unclaimed spots
    const taken = new Set<string>();
    arrayEach(forest, ({ value: offset }) => {
        const quota = offset.dx !== 0 && offset.dy !== 0 ? MEADOW_INGRESS_DIAGONAL : MEADOW_INGRESS_CARDINAL;
        const ranked: Array<{ key: string; distance: number; order: number }> = [];
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const x = col - halfX;
                const y = row - halfY;
                ranked.push({ key: `${x},${y}`, distance: edgeDistance(x, y, offset), order: ranked.length });
            }
        }
        ranked.sort((left, right) => left.distance - right.distance || left.order - right.order);
        // The closest unclaimed spots fill the quota (clamped to the grid —
        // a tiny board fully ringed by woods ingresses every cell it has)
        let claimed = 0;
        for (let index = 0; index < ranked.length && claimed < quota; index++) {
            const spot = ranked[index];
            if (taken.has(spot.key)) {
                continue;
            }
            taken.add(spot.key);
            claimed = claimed + 1;
        }
    });
    // Row-major output order — the stable layout the deposit and the stand
    // seeding both read
    return Array.from(taken).sort((left, right) => {
        const [lx, ly] = left.split(',').map(Number);
        const [rx, ry] = right.split(',').map(Number);
        return ly - ry || lx - rx;
    });
};

// ── The scale-0 SHORE MASK (R1 — the realistic partial shore) ────────────────
//
// A BEACH tile's zoomed interior is no longer a solid sand block: the
// interior carries a deterministic WATERLINE hugging every edge that faces a
// water neighbor (the sea the tile actually sits against at scale 1), so the
// scale-0 shore reads as a shore — partial sand, shaped water — instead of
// an inland sand flat. The design rules (all deterministic, no speckle):
//
//   ORIENTATION — the mask orients toward the parent tile's WATER neighbors
//     on its own grid (the in-grid 8-neighborhood): a CARDINAL water
//     neighbor opens a full fine ROW/COLUMN waterline along that shared
//     edge (the beach meets its sea along the whole shared border — no
//     dips, the waterline is contiguous); a DIAGONAL water neighbor carves
//     a 3-spot corner wedge (the corner fine cell + one flank along each
//     edge sharing the corner). A beach tile with NO water neighbor (an
//     inland sand flat — e.g. the 7×5 board's stone-heap beach) shapes
//     nothing: without a visible sea there is no shore to shape.
//   DEPTH BY THE SEA ITSELF — a shallows/basin neighbor is shallow water:
//     its waterline is ONE voxel of water over the lowered seabed (the
//     exact column shape the sea's own shallows columns carry). An ocean
//     neighbor is deep water: its waterline is TWO voxels (the ocean column
//     shape) AND its band may reach one further inland layer, gated by a
//     smooth low-frequency wave over the edge's own keyed stream
//     (`shore:<pathKey>:<edge>` — an INDEPENDENT stream namespace, the
//     existing resource scatter streams are untouched) — a bay of
//     contiguous deep/shallows runs, never speckle.
//   MAJORITY LAND — the water spots never exceed SHORE_WATER_CAP of the
//     interior's cells (the shore stays land-majority, so the scale-1 tile
//     keeps its recognizable sand surface: the coarse majority fold still
//     reads sand). Edges and wedges fill in the FIXED NEIGHBOR_OFFSETS
//     order; each edge takes its full band only if it fits under the cap,
//     else waterline-only, else nothing — truncation by layer keeps every
//     kept band contiguous.
//   CORRECTNESS — the fine water cells are REAL water (fineWaterColumn
//     below): impassable, deposit-free (the submerged-supplies-nothing
//     rule — subPrep's scatter refuses water spots), the lowered seabed +
//     water column shape the sea columns get, with fresh-basin neighbors
//     lending their own basin biome.
//
// The mask is a PURE function of the parent cell, its in-grid neighbors,
// the seed and the tile address — generateSubCanvas (the materializer) and
// surfaceKeyCounts (the histogram) both read the SAME mask, so the zoomed
// board and the coarse majority fold always agree cell-for-cell. It is
// stable for the tile's life: only WATER neighbors shape it and water never
// changes after generation (the ecology converts dry land only), so the
// sub-grid fingerprint (parent deposits/height/water line/biome/voxels/
// carve) needs no extension — the mask rides the parent's own stamp.

/** The share of a shore tile's interior that may drown — the land-majority cap. */
export const SHORE_WATER_CAP = 0.4;

/**
 * The inland reach of a DEEP (ocean-abutting) waterline: the waterline layer
 * itself (the shared edge's first fine row/column) plus one wave-gated
 * shallows layer further inland — the shore→shallows→ocean transition.
 */
export const SHORE_DEEP_LAYERS = 2;

/** One masked water spot of a shore tile's interior. */
export type ShoreWater = {
    /** Water voxels above the lowered seabed: 1 = shallows rim, 2 = ocean-deep. */
    depth: number;
    /** The fresh-basin biome a BASIN neighbor lends (undefined: sea water). */
    basin?: 'lake' | 'pond';
};

/** The shore mask of one tile's interior: fine spot "x,y" → its water. */
export type ShoreMask = Map<string, ShoreWater>;

/** The water class a neighbor lends the shore mask (undefined: not water). */
type ShoreNeighbor = 'shallow' | 'deep' | 'lake' | 'pond';

/**
 * Classifies one neighbor cell as the water it lends the shore mask: the
 * open ocean is deep water, the shallows rim shallow, the interior fresh
 * basins their own (fresh) water. Dry or missing cells lend nothing.
 */
const shoreNeighborOf = (cell: TerrainCell | undefined): ShoreNeighbor | undefined => {
    if (!cell || cell.passable) {
        return undefined;
    }
    if (cell.biome === 'ocean') {
        return 'deep';
    }
    if (cell.biome === 'shallows') {
        return 'shallow';
    }
    return cell.biome === 'lake' ? 'lake' : cell.biome === 'pond' ? 'pond' : undefined;
};

/** The mask's edge name for one NEIGHBOR_OFFSETS direction — the stream key part. */
const shoreEdgeName = (offset: Offset): string =>
    (offset.dy < 0 ? 'N' : offset.dy > 0 ? 'S' : '') + (offset.dx < 0 ? 'W' : offset.dx > 0 ? 'E' : '');

/**
 * The shore mask of one beach tile's zoomed interior (see the rule block
 * above). `parentCanvas` is the grid the parent sits in (the root canvas at
 * scale 1, a sub-grid deeper) — the mask reads the parent's in-grid
 * neighbors off it, exactly the neighbors the parent tile shares borders
 * with. `pathKey` keys the deep-edge wave streams per tile address.
 */
export const shoreMask = (
    parent: TerrainCell,
    pathKey: string,
    parentCanvas: Pick<Canvas, 'width' | 'height' | 'cells'>,
    seed: number,
): ShoreMask => {
    const mask: ShoreMask = new Map();
    // Only DRY SAND shores shape — the beach ring. An inland sand flat with
    // no water neighbor shapes nothing (no visible sea, no shore to shape).
    if (parent.biome !== 'beach' || !parent.passable) {
        return mask;
    }
    const width = parentCanvas.width;
    const height = parentCanvas.height;
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    const cap = Math.floor(SHORE_WATER_CAP * width * height);
    // The parent's own grid cell lookup — the same centered read cellOn does
    const neighborAt = (dx: number, dy: number): TerrainCell | undefined => {
        const nx = parent.x + dx;
        const ny = parent.y + dy;
        if (ny < -halfY || ny > halfY || nx < -halfX || nx > halfX) {
            return undefined;
        }
        return parentCanvas.cells[(ny + halfY) * width + (nx + halfX)];
    };
    // Deeper water wins a shared spot (a deep waterline keeps the deeper
    // column where a wedge flank would lay a shallower one)
    const put = (x: number, y: number, depth: number, basin: ShoreWater['basin']): void => {
        const key = `${x},${y}`;
        const standing = mask.get(key);
        if (standing && standing.depth >= depth) {
            return;
        }
        mask.set(key, basin ? { depth, basin } : { depth });
    };
    // The running water count the land-majority cap truncates against
    let used = 0;
    // Edges + wedges in the FIXED NEIGHBOR_OFFSETS order (clockwise from
    // north) — the deterministic fill order
    arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
        const water = shoreNeighborOf(neighborAt(offset.dx, offset.dy));
        if (!water) {
            return;
        }
        const basin: ShoreWater['basin'] = water === 'lake' ? 'lake' : water === 'pond' ? 'pond' : undefined;
        if (offset.dx !== 0 && offset.dy !== 0) {
            // Diagonal water — the corner wedge: the corner fine cell plus
            // one flank along each edge sharing the corner (contiguous, no
            // checkerboard — unlike the boulder band a shore wedge is real
            // water, it does not scatter)
            const cornerX = offset.dx < 0 ? -halfX : halfX;
            const cornerY = offset.dy < 0 ? -halfY : halfY;
            const cornerDepth = water === 'deep' ? 2 : 1;
            const spots: Array<{ x: number; y: number; depth: number }> = [
                { x: cornerX, y: cornerY, depth: cornerDepth },
                { x: cornerX - offset.dx, y: cornerY, depth: 1 },
                { x: cornerX, y: cornerY - offset.dy, depth: 1 },
            ];
            // The whole wedge or nothing — a truncated wedge would orphan
            // its flanks from the corner (contiguity)
            if (used + spots.length <= cap) {
                spots.forEach((spot) => {
                    put(spot.x, spot.y, spot.depth, basin);
                });
                used = used + spots.length;
            }
            return;
        }
        // Cardinal water — the fine ROW/COLUMN along the shared edge. The
        // waterline (the first layer) is always FULL: one contiguous line
        // of water along the whole shared border
        const line: Array<{ x: number; y: number }> = [];
        if (offset.dx === 0) {
            const y = offset.dy < 0 ? -halfY : halfY;
            for (let x = -halfX; x <= halfX; x++) {
                line.push({ x, y });
            }
        } else {
            const x = offset.dx < 0 ? -halfX : halfX;
            for (let y = -halfY; y <= halfY; y++) {
                line.push({ x, y });
            }
        }
        // The waterline's VOXEL depth: shallow seas/basins lap one voxel
        // deep, the open ocean two (the sea columns' own shapes)
        const lineDepth = water === 'deep' ? 2 : 1;
        // The deep sea's extra INLAND layer — a smooth low-frequency wave
        // over the edge's own keyed stream gates where the shallows tongue
        // reaches one cell further (contiguous runs, never speckle)
        const extension: Array<{ x: number; y: number }> = [];
        if (water === 'deep') {
            const stream = randomKeyed(seed, `shore:${pathKey}:${shoreEdgeName(offset)}`);
            const phase = stream() * Math.PI * 2;
            const cycles = 1 + Math.floor(stream() * 2);
            if (offset.dx === 0) {
                const y = offset.dy < 0 ? -halfY + 1 : halfY - 1;
                for (let x = -halfX; x <= halfX; x++) {
                    const wave = Math.sin(phase + (2 * Math.PI * cycles * (x + halfX)) / width);
                    if (wave > 0) {
                        extension.push({ x, y });
                    }
                }
            } else {
                const x = offset.dx < 0 ? -halfX + 1 : halfX - 1;
                for (let y = -halfY; y <= halfY; y++) {
                    const wave = Math.sin(phase + (2 * Math.PI * cycles * (y + halfY)) / height);
                    if (wave > 0) {
                        extension.push({ x, y });
                    }
                }
            }
        }
        // The land-majority cap: the full band (waterline + extension) if it
        // fits, else the waterline alone, else nothing — layer truncation
        // keeps every kept band contiguous
        if (used + line.length + extension.length <= cap) {
            line.forEach((spot) => {
                put(spot.x, spot.y, lineDepth, basin);
            });
            extension.forEach((spot) => {
                put(spot.x, spot.y, 1, basin);
            });
            used = used + line.length + extension.length;
        } else if (used + line.length <= cap) {
            line.forEach((spot) => {
                put(spot.x, spot.y, lineDepth, basin);
            });
            used = used + line.length;
        }
    });
    return mask;
};

/**
 * The fine water column of one masked shore spot — the lowered seabed + water
 * shape the sea's own columns carry (the beach slopes into its sea): gravel
 * bedrock ×(ground−2), a dirt underlayer at ground ≥ 2, the sand seabed, then
 * `depth` water voxels. Fresh-basin spots keep ONE water voxel and lend the
 * basin's own biome; sea spots read shallows at one voxel and ocean beyond
 * (deriveBiome's depth ladder). Impassable and deposit-free — underwater
 * cells carry nothing (the submerged-supplies-nothing rule).
 */
export const fineWaterColumn = (
    waterLevel: number,
    water: ShoreWater,
): { voxels: VoxelKind[]; height: number; biome: Biome } => {
    const ground = Math.max(0, waterLevel - water.depth);
    const stack: VoxelKind[] = [];
    if (ground >= 3) {
        for (let bedrock = 0; bedrock < ground - 2; bedrock++) {
            stack.push('gravel');
        }
    }
    if (ground >= 2) {
        stack.push('dirt');
    }
    stack.push('sand');
    for (let voxel = 0; voxel < water.depth; voxel++) {
        stack.push('water');
    }
    return {
        voxels: stack,
        height: ground,
        biome: water.basin ?? deriveBiome('sand', true, water.depth, false),
    };
};

// ── The persistent forest stands ─────────────────────────────────────────────
//
// The fine-scale tree record of ONE parent tile. The terrain plugin owns the
// registry (its sub-grid generation is what consumes the positions — see
// generateSubCanvas); the plugins/forest ecology reads and mutates the stands
// through this plugin's `forestOf` / `forestPlant` API. Seeding happens in
// `generateIsland`'s wake (regenerate → seedStands): every forested tile gets
// its NEIGHBORHOOD-COUNTED positions (the tile's own keyed stream; forest
// tiles even when the count is 0 — the seed bank) and every meadow beside
// woods its ingress fringe, each carrying a VIRGIN record the ecology ages
// lazily (see plugins/forest poolOf).

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

/**
 * The persistent fine-scale tree record of one tile — a forest's stand, or
 * the localized edge ingress a meadow tile carries beside the woods (both
 * seed and mirror exactly alike; see seedStands).
 */
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
    // The rock terrain reads as the gravel surface (the 'stone'-to-'gravel'
    // rename: stone is a finite DEPOSIT now, gravel the voxel it stands on)
    if (surface === 'gravel') {
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

    // ── Pass 1 — the height field (per-cell geometry, no surface yet) ──────
    // THE COASTAL SAND RULE (R3) needs the island's whole SEA MASK before any
    // surface is assigned: a dry cell's sand-ness is measured by its distance
    // to the nearest sea cell (not its elevation), so every cell's submerged
    // state must be known first. This pass computes each column's ground
    // height + submerged state; the BFS below measures the coastal distance;
    // the cell-building loop that follows finalizes the surfaces.
    const coast: Array<{ groundHeight: number; submerged: boolean }> = new Array(height * width);
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
            // A column exactly at the water line is a dry sandbar (walkable);
            // only columns strictly below it are submerged.
            const submerged = groundHeight < seaLevel;
            coast[row * width + col] = { groundHeight, submerged };
        }
    }

    // ── THE COASTAL DISTANCE (R3) ───────────────────────────────────────────
    // Multi-source BFS from every SEA (submerged) cell over the 8-neighborhood
    // (`seaDistance[i]` = the fewest 8-neighbour steps from cell i to open
    // water; 0 on the sea itself). A dry cell within COASTAL_SAND_DISTANCE of
    // the sea is the BEACH/SAND ring; beyond it the ground reads as grass
    // meadow (or stone highland). Sand now hugs the coastline — it no longer
    // follows the old elevation band (groundHeight <= seaLevel + 1), so an
    // inland lowland more than a couple of tiles from water is meadow, not
    // beach. The band is the LITERAL 2-tile rule on any board at least 7
    // tiles across (a real island keeps its 1–2-tile coastal ring); on the
    // compact reference boards (7×5, 5×5 — where every cell is within 2 of
    // the sea's rim) it gracefully degenerates to a 1-tile ring so the island
    // keeps a non-coastal interior (a fully coastal board would erase the
    // fixture woods these boards stand on).
    const COASTAL_SAND_DISTANCE = Math.max(
        1,
        Math.min(2, Math.floor(Math.min(width, height) / 3)),
    );
    const seaDistance: number[] = new Array<number>(height * width).fill(-1);
    const queue: number[] = [];
    for (let index = 0; index < height * width; index++) {
        if (coast[index].submerged) {
            seaDistance[index] = 0;
            queue.push(index);
        }
    }
    // The 8-neighborhood (the directions the neighborhood model also reads)
    const BFS_OFFSETS: Array<[number, number]> = [
        [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    for (let head = 0; head < queue.length; head++) {
        const index = queue[head];
        const r = Math.floor(index / width);
        const c = index % width;
        for (const [dx, dy] of BFS_OFFSETS) {
            const ny = r + dy;
            const nx = c + dx;
            if (ny < 0 || ny >= height || nx < 0 || nx >= width) {
                continue;
            }
            const nindex = ny * width + nx;
            if (seaDistance[nindex] !== -1) {
                continue;
            }
            seaDistance[nindex] = seaDistance[index] + 1;
            queue.push(nindex);
        }
    }

    const cells: TerrainCell[] = [];
    const stats: IslandStats = { land: 0, water: 0, forest: 0, iron: 0, stone: 0 };

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const index = row * width + col;
            // Centered world coordinates: 0,0 is the island center
            const x = col - halfX;
            const y = row - halfY;
            // The pass-1 geometry + the coastal distance for this cell
            const { groundHeight, submerged } = coast[index];
            // THE COASTAL SURFACE LADDER (R3): seabed sand → gravel highland
            // at the peaks (the rock terrain — formerly 'stone': stone is a
            // finite DEPOSIT now, gravel the voxel the highland is built of)
            // → the distance-based beach ring (a dry cell within
            // COASTAL_SAND_DISTANCE of the sea) → grass meadow inland
            const beach = !submerged && seaDistance[index] <= COASTAL_SAND_DISTANCE;
            const surface: VoxelKind = submerged
                ? 'sand'
                : groundHeight >= seaLevel + 4
                  ? 'gravel'
                  : beach
                    ? 'sand'
                    : 'grass';
            // Forests only grow on grass wet enough — the moisture map
            // decides where the woods stand on the meadows
            const forested = surface === 'grass' && moisture(col, row) > FOREST_MOISTURE_THRESHOLD;

            // Build the voxel stack, bottom → top:
            //   gravel × (ground-2), dirt × 1, surface × 1,
            //   then water up to the sea level (submerged columns),
            //   then a forest voxel when wooded
            // The bedrock is GRAVEL (the old 'stone' voxels): ordinary gravel
            // supplies NO stone (the finite-stone rule — see the header)
            const stack: VoxelKind[] = [];
            if (groundHeight >= 3) {
                for (let bedrock = 0; bedrock < groundHeight - 2; bedrock++) {
                    stack.push('gravel');
                }
            }
            if (groundHeight >= 2) {
                stack.push('dirt');
            }
            stack.push(surface);
            const depth = submerged ? seaLevel - groundHeight : 0;
            for (let water = 0; water < depth; water++) {
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
            // appearance from the tile (see below). Three seeding rules:
            //
            //   GROUND SUPPLY — every ground voxel material the DRY column
            //   is built from (dirt/grass/sand — GRAVEL EXCLUDED: it is
            //   terrain, not a resource token), at the symbolic count of 1:
            //   unlimited, never depleted by takes (UNLIMITED_TILE_RESOURCES),
            //   mirrored onto every fine cell at the zoom. Submerged columns
            //   supply nothing (no habitat, no access — the sea keeps its
            //   look).
            //
            //   FINITE STONE — a gravel-SURFACE tile (the highland) carries
            //   its localized rock stock (STONE_PER_HIGHLAND, below).
            //   Non-highland tiles carry NONE, no matter how much gravel
            //   bedrock underlies them (the old "stone under everything
            //   supplies stone forever" is what made stone infinite — the
            //   finite-stone rule kills it). The stone guarantee pass
            //   (after the iron guarantee) tops the island total up to the
            //   floor; the canvas icon ('rock' decoration + the 'stone'
            //   surface key) reads the LIVE deposit, so the marker drops
            //   when the stock is mined away.
            //
            //   THE TREE STAND — its COUNT comes from the NEIGHBORHOOD MODEL
            //   (pass 2 below — all 8 neighbors weigh in), not from a flat
            //   constant; the persistent fine-scale record is seeded from
            //   the deposit (seedStands after generation). Felling/
            //   recruitment move the mirror with the stand (plugins/forest).
            const resources: TileResources = {};
            if (!submerged) {
                if (surface === 'gravel') {
                    // THE HIGHLAND ROCK SITE — the localized finite stone
                    // (the mine gate's quarry; the 🪨 marker stands while
                    // its stock does)
                    resources.stone = STONE_PER_HIGHLAND;
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
                if (surface === 'gravel' && veins(col, row) > IRON_LODE_THRESHOLD) {
                    // Iron lodes hide in the gravel highlands — the vein
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
                // The stone census counts UNITS (the gatherable stock — the
                // highland's STONE_PER_HIGHLAND), not cells, so the board's
                // rock supply reads in the campaign's currency
                stats.stone = stats.stone + (resources.stone ?? 0);
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

    // ── Generation pass 2 — the neighborhood resource model ─────────────────
    // Runs over the FINISHED biome map (pass 1 built every cell — the
    // neighbors exist to classify). PURE: no random draws (the tile's own
    // keyed stand stream is the only randomness, consumed later in
    // seedStands), so the noise-lattice stream order stays untouched and
    // the pinned seed-7 biome maps stay byte-identical.
    //
    //   FOREST tiles — the coverage count from forestCoverageOf (all 8
    //     neighbors weigh in; 8 forest neighbors clamp to the FULL 100%)
    //     lands in the `tree` deposit, and a rocky neighborhood carves its
    //     spillover band onto the cell (TileCarving — the zoomed interior
    //     reads it, the fingerprint stamps it).
    //   MEADOW tiles beside woods — the localized edge ingress (the
    //     meadowIngressSpots fringe) lands in the `tree` deposit; the
    //     meadow keeps its biome.
    const canvas: Canvas = { width, height, cells };
    arrayEach(cells, ({ value: cell }) => {
        if (cell.biome !== 'forest' && cell.biome !== 'meadow') {
            // Trees stand only on the woods and their meadow borders
            return;
        }
        const neighborhood = neighborhoodOf(canvas, cell.x, cell.y);
        if (cell.biome === 'forest') {
            // The neighborhood coverage — the count the tile's tree deposit
            // carries (the stand seeds from the mirror in seedStands). R1:
            // the meadow (grassland) edges feed the woods on the gain side,
            // so the coverage prices forest + meadow neighbors alike.
            const coverage = forestCoverageOf(
                neighborhood.forest,
                neighborhood.rock,
                neighborhood.meadow,
            );
            cell.resources.tree = Math.round(coverage * width * height);
            // The rock-spillover carve — only rocky neighborhoods carve
            const rock = rockSpillSpots(width, height, neighborhood.rock);
            if (rock.length > 0) {
                // The TileCarving (engine/types.ts) — the neighbor-derived
                // data the zoomed interior reads and the fingerprint stamps
                const carve: TileCarving = { rock };
                cell.carving = carve;
            }
        } else if (neighborhood.forest.length > 0) {
            // The meadow's localized ingress — the deposit IS the fringe's
            // size (meadowIngressSpots' length), so seeding and mirror agree
            const ingress = meadowIngressSpots(width, height, neighborhood.forest);
            if (ingress.length > 0) {
                cell.resources.tree = ingress.length;
            }
        }
    });

    // ── THE INTERIOR FRESH-WATER BASINS (R2, impassable since R4) ───────────
    // lakes and ponds. The candidate mask is R2's: an inset lowland (the low
    // dry tier the coastal-sand rule R3 just pulled inland) where the local
    // bump map runs high — a wet hollow. R4 made the hollow REAL water: the
    // drowned tier is lowered just under the global water line and flooded
    // (the seabed-sand + water column shape the sea columns get), so a basin
    // is IMPASSABLE like the sea — nothing walks, stands, builds or fishes
    // ON it. Land actors reach its water from the DRY SHORE ring beside it
    // (the inventory's fresh-water seeding + the behavior plugin's fishing
    // shore). Component sizing splits the two names: a connected wetland of
    // LAKE_MIN_CELLS (8-neighborhood, row-major components) is a 'lake', a
    // smaller pocket a 'pond'. Deterministic: the candidate read reuses the
    // existing moisture map (no new random draws — the noise stream above is
    // untouched) and the components are a pure flood of the finished
    // candidate mask.
    // A basin pockets where the LOCAL BUMP map (`fine` — already sampled, so
    // the coarse/moisture streams above are untouched) runs high on an inset
    // lowland: high local moisture = a wet hollow. The 0.8 fine-threshold
    // keeps the basins RARE (a handful of pockets, not the meadow) — the
    // lakes and ponds are landmarks, not the ground.
    const LAKE_FINE_THRESHOLD = 0.8;
    const LAKE_MAX_GROUND = seaLevel + 2;
    const LAKE_MIN_CELLS = 4;
    const candidate = new Array<boolean>(height * width).fill(false);
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const index = row * width + col;
            const ground = coast[index];
            const inset = !ground.submerged
                && ground.groundHeight <= LAKE_MAX_GROUND
                && seaDistance[index] > COASTAL_SAND_DISTANCE
                && fine(col, row) > LAKE_FINE_THRESHOLD;
            candidate[index] = inset;
        }
    }
    // Connected-component sizing (8-neighborhood, row-major flood) — the
    // wetland's extent decides the lake vs pond name
    const component = new Array<number>(height * width).fill(-1);
    const sizes: number[] = [];
    for (let index = 0; index < height * width; index++) {
        if (!candidate[index] || component[index] !== -1) {
            continue;
        }
        const id = sizes.length;
        sizes.push(0);
        const flood: number[] = [index];
        component[index] = id;
        for (let head = 0; head < flood.length; head++) {
            const cur = flood[head];
            sizes[id] = sizes[id] + 1;
            const r = Math.floor(cur / width);
            const c = cur % width;
            for (const [dx, dy] of BFS_OFFSETS) {
                const ny = r + dy;
                const nx = c + dx;
                if (ny < 0 || ny >= height || nx < 0 || nx >= width) {
                    continue;
                }
                const nindex = ny * width + nx;
                if (candidate[nindex] && component[nindex] === -1) {
                    component[nindex] = id;
                    flood.push(nindex);
                }
            }
        }
    }
    cells.forEach((cell, index) => {
        if (!candidate[index]) {
            return;
        }
        const isLake = (sizes[component[index]] ?? 0) >= LAKE_MIN_CELLS;
        cell.biome = isLake ? 'lake' : 'pond';
        // R4 — the basin is REAL water now: impassable, like the sea. The
        // drowned wetland tier is rebuilt as a shallow water column — the
        // seabed-sand shape the sea columns get, ground lowered one voxel
        // under the water line with the water filling up to it — and its
        // ground supply, tree stand and rock carve are washed away (the
        // submerged-supplies-nothing rule: no habitat and no landmark on
        // open water; the forest ecology can never spread onto it either —
        // its gate wants PASSABLE meadow ground, plugins/forest). The
        // census moves the cell from land to water (and off the forest
        // count when the drowned tile was wooded — the census above ran
        // before this pass). The basin's fresh water + fish stock is the
        // inventory plugin's job (plugins/inventory).
        const wasForested = cell.voxels.includes('forest');
        const ground = seaLevel - 1;
        const stack: VoxelKind[] = [];
        if (ground >= 3) {
            for (let bedrock = 0; bedrock < ground - 2; bedrock++) {
                stack.push('gravel');
            }
        }
        if (ground >= 2) {
            stack.push('dirt');
        }
        stack.push('sand');
        for (let water = 0; water < seaLevel - ground; water++) {
            stack.push('water');
        }
        cell.voxels = stack;
        cell.height = ground;
        cell.passable = false;
        cell.resources = {};
        delete cell.carving;
        stats.land = stats.land - 1;
        stats.water = stats.water + 1;
        if (wasForested) {
            stats.forest = stats.forest - 1;
        }
    });

    // ── THE RIVERS (R4) ──────────────────────────────────────────────────────
    // Meandering fresh-water courses from the island's interior to the sea —
    // the R4 answer to the straight/flat island. Each river is ONE CARDINALLY
    // CONNECTED path (no diagonal-only links, no disconnected scatter): a
    // greedy walk from an interior source toward the open sea, scored by three
    // deterministic terms —
    //   GROUND HEIGHT — the walk prefers the lowest neighbor (water seeks the
    //     sea; the descent bias is what makes the course flow interior → coast
    //     instead of wandering the highlands);
    //   KEYED JITTER  — one draw per cell address from the `river:<col>,<row>`
    //     stream namespace (independent of every other stream, so the coarse/
    //     fine/moisture/vein lattices and the shore waves stay untouched),
    //     RIVER_JITTER-tall: on the quantized height plateaus the jitter
    //     steers, so the course MEANDERS instead of dropping in straight
    //     staircase runs;
    //   PERSISTENCE   — RIVER_PERSIST off the score for keeping the previous
    //     step's direction, so the jitter bends stay gentle sweeps.
    // The walk ENDS the moment its current cell CARDINALLY touches open sea
    // (pass-1 submerged geometry — a drowned basin is not the sea): the
    // coastal ring cell becomes the river's last cell, so the course visibly
    // crosses the beach into the water. A stalled walk (every candidate
    // claimed) falls back to a BFS corridor through the remaining dry cells to
    // the nearest sea-adjacent cell — connectivity is guaranteed, never
    // diagonal-only, never scattered.
    // THE SOURCES — the highest dry cells (pass-1 height, row-major tie),
    // skipping cells that already touch the sea (an INTERIOR origin) and, for
    // the second course, anything within RIVER_SOURCE_GAP of the first (two
    // distinct channels).
    // THE CARVE — every path cell is rebuilt as a shallow fresh column: the
    // basin's drowned shape (ground one voxel under the water line, sand bed +
    // one water voxel) but PASSABLE — the river is a FORD, not a drowning
    // (engine/types.ts Biome 'river'). Its deposits and neighborhood carve
    // wash away (no trees or rock stand in the channel; the inventory seeds
    // the cell's INEXHAUSTIBLE drinking water from the biome — plugins/
    // inventory). A course crossing a lake/pond basin DRAINS it (the river
    // overwrites the drowned cell — the census moves that cell back to land);
    // a course over a wood takes the tile off the forest census. The
    // outermost ring stays open sea (the walk only ever steps on dry cells —
    // the island never touches the border). Deterministic: the source
    // ranking is row-major and the jitter reads the keyed per-cell stream —
    // same seed, byte-identical rivers.
    {
        const inGrid = (col: number, row: number): boolean =>
            col >= 0 && col < width && row >= 0 && row < height;
        const indexAt = (col: number, row: number): number => row * width + col;
        // The four CARDINAL steps — the river's connectivity vocabulary (a
        // diagonal step would let two cells touch without a real crossing)
        const RIVER_STEPS: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        // Whether a cell cardinally borders OPEN SEA (pass-1 submerged
        // geometry — basins drowned after pass 1 are not the sea)
        const touchesSea = (index: number): boolean => {
            const col = index % width;
            const row = Math.floor(index / width);
            return RIVER_STEPS.some(
                ([dx, dy]) =>
                    inGrid(col + dx, row + dy) && coast[indexAt(col + dx, row + dy)].submerged,
            );
        };
        // The per-cell meander draw — one keyed stream value per address,
        // stable regardless of walk order (the `river:` namespace is its own)
        const jitterAt = (col: number, row: number): number =>
            randomKeyed(options.seed ?? 1, `river:${col},${row}`)();
        // Every cell claimed by any course so far (walk + corridor) — the
        // channels never merge, never self-cross, and the second source is
        // measured against it
        const carved = new Set<number>();
        // Source ranking: dry cells by pass-1 ground height DESCENDING,
        // row-major tie — the interior highlands first (the same peak rule
        // the stone guarantee's fallback reads)
        const ranked: number[] = [];
        for (let index = 0; index < height * width; index++) {
            if (!coast[index].submerged) {
                ranked.push(index);
            }
        }
        ranked.sort((left, right) => coast[right].groundHeight - coast[left].groundHeight || left - right);
        for (let river = 0; river < RIVER_COUNT; river++) {
            // The next valid source: unclaimed, interior (no sea touch), and
            // clear of every carved cell by the source gap
            const source = ranked.find((index) => {
                if (carved.has(index) || touchesSea(index)) {
                    return false;
                }
                const col = index % width;
                const row = Math.floor(index / width);
                for (const claim of carved) {
                    const dx = Math.abs((claim % width) - col);
                    const dy = Math.abs(Math.floor(claim / width) - row);
                    if (Math.max(dx, dy) < RIVER_SOURCE_GAP) {
                        return false;
                    }
                }
                return true;
            });
            if (source === undefined) {
                // No room for another course on this board — the island keeps
                // the rivers it has (small/degenerate boards carry fewer)
                break;
            }
            // ── the greedy downhill meander ───────────────────────────────
            const path: number[] = [source];
            carved.add(source);
            let current = source;
            let lastStep: [number, number] | undefined;
            // A cell never repeats, so the walk terminates inside the cell
            // count; the guard is the belt to the visited set
            let guard = width * height;
            while (guard-- > 0 && !touchesSea(current)) {
                const col = current % width;
                const row = Math.floor(current / width);
                let best = -1;
                let bestScore = 0;
                let bestStep: [number, number] | undefined;
                for (const step of RIVER_STEPS) {
                    const ncol = col + step[0];
                    const nrow = row + step[1];
                    if (!inGrid(ncol, nrow)) {
                        continue;
                    }
                    const nindex = indexAt(ncol, nrow);
                    // Only DRY, UNCLAIMED cells — the rim ring is sea (never
                    // stepped) and the channel never crosses itself
                    if (coast[nindex].submerged || carved.has(nindex)) {
                        continue;
                    }
                    // Height descent dominates, the jitter meanders the
                    // plateaus, persistence keeps the bends gentle
                    let score = coast[nindex].groundHeight + jitterAt(ncol, nrow);
                    if (lastStep && step[0] === lastStep[0] && step[1] === lastStep[1]) {
                        score = score - RIVER_PERSIST;
                    }
                    // Strict improvement in the fixed step order — the first
                    // best wins ties (deterministic, no stream involved)
                    if (best === -1 || score < bestScore) {
                        best = nindex;
                        bestScore = score;
                        bestStep = step;
                    }
                }
                if (best === -1) {
                    // Stalled (every candidate claimed) — the BFS corridor
                    // below finishes the course
                    break;
                }
                path.push(best);
                carved.add(best);
                current = best;
                lastStep = bestStep;
            }
            // ── the stall fallback: a BFS corridor to the nearest mouth ────
            if (!touchesSea(current)) {
                const cameFrom = new Map<number, number>();
                const seen = new Set<number>([current]);
                const frontier: number[] = [current];
                let mouth = -1;
                for (let head = 0; head < frontier.length; head++) {
                    const cell = frontier[head];
                    if (touchesSea(cell)) {
                        mouth = cell;
                        break;
                    }
                    const col = cell % width;
                    const row = Math.floor(cell / width);
                    for (const [dx, dy] of RIVER_STEPS) {
                        const ncol = col + dx;
                        const nrow = row + dy;
                        if (!inGrid(ncol, nrow)) {
                            continue;
                        }
                        const nindex = indexAt(ncol, nrow);
                        // The corridor walks DRY unclaimed cells only — it
                        // joins the sea adjacency without re-crossing the
                        // channel or stepping into the water
                        if (coast[nindex].submerged || seen.has(nindex)) {
                            continue;
                        }
                        seen.add(nindex);
                        cameFrom.set(nindex, cell);
                        frontier.push(nindex);
                    }
                }
                // Trace the corridor back and append it — the tail joins the
                // channel cardinally (the BFS walked cardinal steps too)
                if (mouth !== -1 && mouth !== current) {
                    const corridor: number[] = [];
                    for (let cell = mouth; cell !== current; cell = cameFrom.get(cell) as number) {
                        corridor.push(cell);
                    }
                    corridor.reverse();
                    for (const cell of corridor) {
                        path.push(cell);
                        carved.add(cell);
                    }
                }
            }
            // ── the carve: rebuild every path cell as a passable shallow ford
            path.forEach((index) => {
                const cell = cells[index];
                // A drained basin cell moves back from the water census; a
                // drowned wood leaves the forest census (the basin pass's
                // census rules, mirrored for the river)
                const wasWater = !cell.passable;
                const wasForested = cell.voxels.includes('forest');
                // The basin's drowned column shape — ground one voxel under
                // the water line, sand bed, one water voxel up to the line
                const ground = seaLevel - 1;
                const stack: VoxelKind[] = [];
                if (ground >= 3) {
                    for (let bedrock = 0; bedrock < ground - 2; bedrock++) {
                        stack.push('gravel');
                    }
                }
                if (ground >= 2) {
                    stack.push('dirt');
                }
                stack.push('sand');
                for (let water = 0; water < seaLevel - ground; water++) {
                    stack.push('water');
                }
                cell.voxels = stack;
                cell.height = ground;
                cell.biome = 'river';
                // THE FORD — the river is the one water the land crosses
                // (passable true; the basins and the sea stay impassable)
                cell.passable = true;
                // The submerged-shape rule: the channel carries no deposits
                // and no carve (the inventory seeds its inexhaustible water
                // from the biome, not from the tile resources). R4 — the
                // FINITE stocks a carved rock site/lode carried leave the
                // census with the cell (stats must match the cells: a
                // highland's stone or a vein's iron washed into the channel
                // is gone; a zeroed iron census lets the R5 guarantee
                // re-stamp the lode on a surviving highland)
                const washedStone = cell.resources.stone ?? 0;
                const washedIron = cell.resources.iron ?? 0;
                if (washedStone > 0) {
                    stats.stone = stats.stone - washedStone;
                }
                if (washedIron > 0) {
                    stats.iron = stats.iron - washedIron;
                }
                cell.resources = {};
                delete cell.carving;
                if (wasWater) {
                    stats.water = stats.water - 1;
                    stats.land = stats.land + 1;
                }
                if (wasForested) {
                    stats.forest = stats.forest - 1;
                }
            });
        }
    }

    // ── THE IRON GUARANTEE (R5) ─────────────────────────────────────────────
    // The vein noise keeps lodes a rare landmark, which leaves the DEFAULT
    // 25×17 seed-7 island with ZERO lodes (every vein sample lands under
    // IRON_LODE_THRESHOLD) — an island with no mineable iron at all. The
    // guarantee stamps the FIRST (row-major) dry HIGHLAND cell with a single
    // lode whenever the vein noise left the island lode-less, so every
    // playable island carries at least one finite, visible (the tile's
    // surface key reads it as 'iron'), mineable (the mine gate) deposit.
    // The stamp is deterministic (the cells array is row-major) and only
    // fires when `stats.iron` is 0 — boards the vein noise already lode'd
    // (the 37×25 reference keeps its 3) and boards with no highland at all
    // (tiny/degenerate) are left exactly as generated.
    if (stats.iron === 0) {
        const highland = cells.find((cell) => cell.biome === 'highland');
        if (highland) {
            highland.resources.iron = 1;
            stats.iron = stats.iron + 1;
        }
    }

    // ── THE FINITE STONE GUARANTEE (T2) ─────────────────────────────────────
    // The campaign's early tools are stone-gated (the 1-stone axe + the
    // 8-stone fort), so an island that seeds too little finite rock would
    // starve its first build. The guarantee floors the island-wide STONE
    // TOTAL at STONE_GUARANTEE_MIN stones (the census above counts the
    // per-highland base stock):
    //   STONE-RICH boards (highlands × STONE_PER_HIGHLAND already at/above
    //     the floor) are left exactly as generated (determinism: the pass
    //     fires only when short — same as the iron guarantee's zero-only
    //     rule);
    //   PARTIAL boards top up their highlands cyclically (row-major, +1 per
    //     lap — the extra stones ride the existing rock sites, so every
    //     mined stone still comes off a visible, 'stone'-surfaced tile);
    //   HIGHLAND-LESS boards stamp the whole shortfall on their PEAK — the
    //     highest dry cell (row-major tie-break; a forested peak yields to
    //     the highest NON-FORESTED dry cell so the stone heap never hides
    //     under a canopy) — a visible stone heap the island view can point
    //     the crew at.
    // PURE: row-major indices + the constants only (no random draws — the
    // noise stream and the biome map are untouched).
    // `stats.stone` already sums the units (the per-cell census above added
    // every highland's STONE_PER_HIGHLAND stock) — the floor test reads it
    let stoneTotal = stats.stone;
    const highlandCells = cells.filter((cell) => cell.biome === 'highland');
    if (stoneTotal < STONE_GUARANTEE_MIN) {
        if (highlandCells.length > 0) {
            // The cyclic row-major top-up: +1 stone per highland per lap
            let lap = 0;
            while (stoneTotal < STONE_GUARANTEE_MIN) {
                const target = highlandCells[lap % highlandCells.length];
                target.resources.stone = (target.resources.stone ?? 0) + 1;
                stoneTotal = stoneTotal + 1;
                stats.stone = stats.stone + 1;
                lap = lap + 1;
            }
        } else {
            // The peak fallback: the highest dry cell (row-major tie) carries
            // the whole shortfall. Rank the dry cells by height descending,
            // ties by the row-major index; prefer a NON-forested, NON-RIVER
            // peak so the stone heap shows its own 🪨 marker instead of a
            // tree canopy or a ford (R4 — the river pass ran before the
            // guarantees; a heap stamped in the channel would sit on water).
            // A FULLY DROWNED board (a public seaLevel above every column)
            // has no dry cell at all — the optional reads below resolve the
            // fallback to undefined and the guarantee simply CANNOT floor the
            // stock: the map stays drowned (no forced land — the layout is
            // the caller's) and stats.stone discloses the shortfall (0).
            const shortfall = STONE_GUARANTEE_MIN - stoneTotal;
            const ranked = cells
                .map((cell, index) => ({ cell, index }))
                .filter(({ cell }) => cell.passable)
                .sort((left, right) => right.cell.height - left.cell.height || left.index - right.index);
            const fallbackCell =
                ranked.find(({ cell }) => cell.biome !== 'forest' && cell.biome !== 'river')?.cell ??
                ranked[0]?.cell;
            if (fallbackCell) {
                fallbackCell.resources.stone = (fallbackCell.resources.stone ?? 0) + shortfall;
                stoneTotal = stoneTotal + shortfall;
                // The whole shortfall rides the heap — the unit census takes
                // the full amount (the per-lap top-up above adds 1 per stone)
                stats.stone = stats.stone + shortfall;
            }
        }
    }

    return { width, height, cells, stats };
};

// ── Tile appearance ──────────────────────────────────────────────────────────
// The tile's DEPOSITS + ACTUAL VOXELS decide what it appears as on the
// canvas: landmarks first (an iron lode, standing trees, the stock-bearing
// rock surface), then the tile's own GROUND material (the topmost voxel that
// maps to a resource — gravel is excluded: ordinary bedrock never repaints
// a tile as rock), falling back to the plain biome. The underlayer supplies
// (the dirt under a meadow — the gravel bedrock under everything supplies
// nothing) appear in the Resources lists but never repaint the tile — the
// tile reads as what its SURFACE is (or as the rock it stands, while the
// rock stock stands).

/** The minimal cell slice the surface derivation reads. */
export type TileSurfaceCell = {
    biome?: string;
    resources?: TileResources;
    voxels?: VoxelKind[];
};

/**
 * The canvas surface key of a tile:
 *   iron lode → 'iron'; standing trees → 'tree' — the landmarks stand out;
 *   a GRAVEL-topped column carrying a LIVE STONE STOCK → 'stone': the
 *   highland peak (its gravel surface) and the BOULDER-crowned fine cells
 *   (the rock spillover's gravel voxel stacked ON TOP of the column) read
 *   as rock while their stock stands — and the exhausted site FALLS THROUGH
 *   to its ground/canopy look (an exhausted highland reads dirt, an
 *   exhausted boulder cell reads its parent's forest/ground) — the R4 rule
 *   that the rock identity disappears with the stock (the 🪨 decoration
 *   follows the same live-stock read, scenario/island.ts decorationOfCell);
 *   a forest voxel (the standing canopy — a clearcut wood keeps the look) →
 *   'forest'; else the topmost ground voxel that maps to a carried resource
 *   ('grass' | 'sand' | 'dirt' — GRAVEL DELIBERATELY ABSENT: ordinary gravel
 *   is terrain, not a carried resource) — the tile reads as its ground;
 *   else the plain biome (sea columns, or the deposit-less fallback shapes).
 */
export const tileSurfaceKey = (cell: TileSurfaceCell): string | undefined => {
    const resources = cell.resources ?? {};
    // R2 — an interior fresh-water basin reads as its WATER, and water wins
    // over EVERY decoration (a standing tree landmark and the highland iron
    // that never co-locates with a lowland wetland). Since R4 the drowned
    // basin carries no deposits at all (the basin pass washes them away), so
    // this is the belt to the pass's braces: a basin is its water surface,
    // never a canopy or a mine over it.
    if (isFreshBasin(cell.biome)) {
        return cell.biome;
    }
    if ((resources.iron ?? 0) > 0) {
        return 'iron';
    }
    if ((resources.tree ?? 0) > 0) {
        return 'tree';
    }
    const voxels = cell.voxels;
    if (voxels && voxels.length > 0) {
        // THE ROCK SURFACE — a gravel top carrying a live stone stock reads
        // as rock (the highland's own surface, or the spillover band's
        // boulder crown — the crown's gravel sits ON TOP of the column,
        // above even the forest canopy). The stock check is what makes the
        // surface DEPRECATE with depletion: an exhausted site falls through
        // to the forest/ground look below (no stock → no rock identity, the
        // way an exhausted iron lode reads its ground). Deposit-less shapes
        // (test fixtures) with a bare gravel top stay on their biome.
        const top = voxels[voxels.length - 1];
        if (top === 'gravel' && (resources.stone ?? 0) > 0) {
            return 'stone';
        }
        // The standing canopy outranks the ground — a clearcut wood keeps
        // its forest look (the forest voxel still stands)
        if (voxels.includes('forest')) {
            return 'forest';
        }
        // The tile's GROUND: the topmost voxel whose material is carried as
        // a resource (the resource-backed check keeps deposit-less shapes —
        // sea columns, test fixtures — on their plain biome). Gravel is not
        // in the ladder: the bedrock under every column would otherwise
        // repaint barren tiles as rock (the finite-stone rule).
        for (let index = voxels.length - 1; index >= 0; index--) {
            const kind = voxels[index];
            if ((kind === 'grass' || kind === 'sand' || kind === 'dirt') &&
                (resources[kind] ?? 0) > 0) {
                return kind;
            }
        }
    }
    return cell.biome;
};

/**
 * One surface key's census inside a generated grid — the histogram entry
 * the terrain plugin's surfaceKeyCounts returns. `first`/`last` are the
 * row-major indices of the key's first and last child cell (the coarse
 * majority fold resolves ties by the key that REACHED its winning count
 * first — the row-major strict-`>` scan semantics — and that is exactly
 * the winner with the EARLIEST last occurrence among the max-count keys,
 * so `last` alone carries the tie-break).
 */
export type SurfaceKeyCount = { key: string; count: number; first: number; last: number };

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
 * adds one tree (recruitment + spread conversions plant through it) —
 * a plant onto the tile's rock-spillover boulders is refused.
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
    /**
     * The EXACT surface-key histogram of the grid at a tile address without
     * materializing it (the coarse majority fold's fast path). Undefined
     * when no grid exists at the address (empty path, beyond the depth).
     */
    surfaceKeyCounts(path: TilePath): SurfaceKeyCount[] | undefined;
    /** One tile at a tile address (the parent path resolves its grid). */
    cellFor(path: TilePath): TerrainCell | undefined;
    /** The persistent forest stand of a parent tile (undefined: none). */
    forestOf(x: number, y: number): ForestStand | undefined;
    /**
     * Adds one tree to a tile's stand (creating it), and returns the stand.
     * A plant onto the tile's rock-spillover band is refused (no tree stands
     * on a boulder — the returned stand is unchanged).
     */
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
        // forested tile gets its NEIGHBORHOOD-COUNTED fine positions, every
        // meadow beside woods its ingress fringe, with virgin records the
        // ecology ages lazily — plugins/forest poolOf)
        seedStands();
    };

    /**
     * Seeds the persistent forest stands from the fresh canvas. The tile's
     * `tree` deposit — written by generation pass 2's neighborhood model —
     * seeds the stand (the mirror is the source at birth; afterwards the
     * stand is authoritative and plugins/forest's syncMirror keeps the
     * mirror true):
     *
     *   FOREST tiles — every forested tile seeds a stand, EVEN a treeless
     *     one (a wood crushed under rock clamps to 0 trees; the EMPTY stand
     *     keeps the seed-bank recruitment alive — plugins/forest
     *     applyRecruit refuses a stand-less tile). The tree count is the
     *     deposit's mirror; the positions come off a SEEDED SHUFFLE
     *     (Fisher-Yates over the NON-ROCK fine spots — the spillover
     *     band's boulders hold no trees) so the density is EXACT — no
     *     collision-re-roll can under-fill a near-full stand. Each
     *     position carries a VIRGIN record (born 0 / baseMinute 0 /
     *     base 1) plus its pre-drawn age fraction — the ecology's lazy
     *     aging (plugins/forest poolOf) turns the fraction into a negative
     *     birth minute on first read, so the seeded woods hold mixed ages
     *     and wood immediately.
     *   INGRESS MEADOWS — a meadow tile beside woods (biome stays
     *     'meadow') carries its localized edge ingress as a REAL PERSISTENT
     *     STAND: the same meadowIngressSpots selection generation pass 2
     *     wrote the deposit from (one source of truth — the stand exactly
     *     matches the mirror), seeded with virgin records like any stand.
     *     The meadow's stand never recruits (the ecology gates on biome
     *     'forest'); its trees thin when cut and refill only if the woods
     *     spread onto the tile — the ingress IS the spread's beachhead.
     */
    const seedStands = () => {
        forestStands.clear();
        const canvas = bound?.world.canvas;
        if (!canvas) {
            return;
        }
        const halfX = (dims.width - 1) / 2;
        const halfY = (dims.height - 1) / 2;
        canvas.cells.forEach((cell) => {
            const count = cell.resources.tree ?? 0;
            const forested = cell.biome === 'forest';
            // A stand for every forest tile (even treeless — the seed bank)
            // and every tile carrying a tree deposit (the ingress meadows)
            if (!forested && count <= 0) {
                return;
            }
            const stream = randomKeyed(resolvedSeed, `forest:${cell.x},${cell.y}`);
            let spots: Array<{ x: number; y: number }>;
            if (forested) {
                // The rock-spillover band holds boulders, not trees — the
                // stand's pool excludes it (the deposit count already priced
                // the rock in via the coverage penalty)
                const rocks = new Set(cell.carving?.rock ?? []);
                spots = [];
                for (let row = 0; row < dims.height; row++) {
                    for (let col = 0; col < dims.width; col++) {
                        const spot = { x: col - halfX, y: row - halfY };
                        if (!rocks.has(`${spot.x},${spot.y}`)) {
                            spots.push(spot);
                        }
                    }
                }
                // Seeded shuffle — the first `count` positions hold trees
                for (let index = spots.length - 1; index > 0; index--) {
                    const swap = Math.floor(stream() * (index + 1));
                    const held = spots[index];
                    spots[index] = spots[swap];
                    spots[swap] = held;
                }
            } else {
                // The ingress meadow's edge-ranked spots — the SAME pure
                // selection the deposit was written from (generation pass 2)
                const edges = neighborhoodOf(canvas, cell.x, cell.y).forest;
                spots = meadowIngressSpots(dims.width, dims.height, edges)
                    .slice(0, Math.max(0, count))
                    .map((key) => {
                        const [x, y] = key.split(',').map(Number);
                        return { x, y };
                    });
            }
            const stand: ForestStand = { trees: new Map() };
            // The fill clamps to the pool (a pathological carve could price
            // the deposit above the band-free spots — the mirror re-reads
            // the stand below so it holds EXACTLY from birth)
            const fill = Math.min(count, spots.length);
            for (let unit = 0; unit < fill; unit++) {
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
            if (fill !== count) {
                // Mirror exactness — the deposit follows the seeded stand
                cell.resources.tree = fill;
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
    // + biome + voxel stack + NEIGHBORHOOD CARVE. The forest ecology now
    // DOES reshape columns after generation (the spread conversion stacks a
    // forest voxel onto a converted meadow and re-biomes it), so the stamp
    // carries the voxels and biome too — a stamp change invalidates the
    // cached sub-grid exactly when the parent tile changed (gathering, tree
    // work, spread). The carve rides the stamp as well: it is the
    // NEIGHBOR-DERIVED sub-canvas data (the spillover band), so a cached
    // grid must never outlive the carve it was generated from — the stamp
    // covers it (the cache-correctness rule for neighbor-derived data:
    // generation pass 2 computes the carve, generateSubCanvas consumes it,
    // and the stamp serializes it).
    const fingerprintOf = (cell: TerrainCell): string =>
        `${TILE_RESOURCES.map((resource) => cell.resources[resource] ?? 0).join(',')}|${cell.height}|${cell.waterLevel}|${cell.biome}|${cell.voxels.join('+')}|${cell.carving ? cell.carving.rock.join(';') : 'none'}`;

    /**
     * The scatter PREPARATION of one tile's sub-grid — the single source of
     * truth shared by generateSubCanvas (which materializes the cells) and
     * surfaceKeyCounts (which histograms the children's surface keys without
     * materializing). Both readers MUST scatter identically — the histogram
     * is exact only while it mirrors the materializer's distribution
     * position-for-position (the R6 depth-2 performance fix; the
     * surfaceKeyCounts test pins the agreement).
     *
     * The scatter rules — how one tile's sub-grid forms from its parent
     * cell, the microscopic zoom. The sub-grid has the ROOT grid's
     * dimensions (the recursion rule: zooming in never changes the board
     * shape), and every subtile inherits the parent column (voxels, height,
     * water line, passability, biome): the tile's interior ground IS the
     * tile's ground. The parent's deposits distribute across the subtiles —
     * the zoom reveals WHERE they stand:
     *   the INFINITE ground supply (dirt/grass/sand — NOT stone: gravel is
     *     terrain, and the finite-stone rule keeps it a non-supplier) IS
     *     the ground — every subtile carries the symbolic deposit so the
     *     zoom preserves the tile's look;
     *   the STONE stock is CROWN-FIRST (the finite rock sites): the
     *     boulder-crowned fine cells (parent.carving's spillover band, a
     *     GRAVEL voxel stacked ON TOP of the inherited column — the
     *     boulder's visible surface) each carry one stone unit while the
     *     parent's standing stock covers them (the first crowns in
     *     row-major order — the visible ones), and the LEFTOVER stock
     *     scatters onto ordinary fine cells as standing piles (one unit per
     *     seeded subtile, never on a boulder or under a standing tree).
     *     The distribution is a pure read of the parent's LIVE stock: the
     *     fingerprint stamps the stock count, so a mined-down parent
     *     invalidates the cached grid and re-derives the (fewer) units —
     *     the fine icons can never outlive the stock they mark (no stone
     *     from a stale sub-grid cache, no stone from ordinary gravel).
     *   the TREE stand is PERSISTENT — the forest record's fine positions
     *     put one tree unit each on their exact subtile; felling and
     *     recruitment never reshuffle the other positions (the stand is
     *     authoritative, the parent count mirrors it — the fingerprint
     *     still invalidates the cache when the mirror moves, and the
     *     regenerated grid re-reads the SAME positions);
     *   the NEIGHBORHOOD CARVE (the rock spillover band — parent.carving)
     *     crowns its fine cells with a boulder. The carve applies at the
     *     FIRST zoom only: deeper grids inherit the boulder through this
     *     very column copy (and no carving field — re-applying would
     *     double-stack the boulder).
     *   remaining finite deposits (an iron lode) scatter one unit per
     *     seeded subtile.
     */
    type SubPrep = {
        /** The parent's persistent stand (undefined: seeded scatter fallback). */
        stand: ForestStand | undefined;
        /** The spillover band's fine spots (the boulder crowns). */
        rocks: Set<string>;
        /** The crowns whose stone unit the parent's live stock still covers. */
        visibleCrowns: Set<string>;
        /** The pre-scattered finite deposits, keyed by "x,y". */
        deposits: Map<string, TileResources>;
    };

    const subPrep = (parent: TerrainCell, pathKey: string, water: ShoreMask): SubPrep => {
        const width = dims.width;
        const height = dims.height;
        const halfX = (width - 1) / 2;
        const halfY = (height - 1) / 2;

        // The parent's persistent stand — its positions author the tree
        // mirror (a stand-less forest tile falls back to the seeded scatter
        // below, the pre-ecology shape)
        const stand = forestOf(parent.x, parent.y);

        // The parent's spillover band — the fine spots that crown with a
        // boulder (rockSpillSpots wrote it at generation in ROW-MAJOR order;
        // the fingerprint stamps it so a cached grid never outlives its
        // carve)
        const crownSpots = parent.carving?.rock ?? [];
        const rocks = new Set(crownSpots);

        // THE CROWN-FIRST STONE SPLIT — the parent's LIVE finite stone stock
        // (the live deposit the inventory draws down as the mine gate works
        // it): the boulders own one unit each, the FIRST crowns in the
        // recorded row-major order, up to the standing stock; the leftover
        // scatters. A mined-down parent (stock < crowns) shrinks the visible
        // crowns — the boulders stay, their icons drop one by one.
        const stoneStock = parent.resources.stone ?? 0;
        const visibleCrownCount = Math.min(stoneStock, crownSpots.length);
        const visibleCrowns = new Set(crownSpots.slice(0, visibleCrownCount));

        // Pre-scatter the remaining finite deposits (the stone's LEFTOVER
        // after the crowns, an iron lode — and the legacy tree scatter when
        // no stand exists): each unit lands on its own seeded subtile
        // position (a bounded re-roll keeps units from stacking when the
        // grid has room to spread them)
        const deposits = new Map<string, TileResources>();
        TILE_RESOURCES.forEach((resource) => {
            if (UNLIMITED_TILE_RESOURCES.includes(resource)) {
                return;
            }
            // The tree mirror is stand-authored — no scatter when a stand exists
            if (resource === 'tree' && stand) {
                return;
            }
            // Stone scatters its LEFTOVER (the crowns carry their units in
            // the cell loop below — pre-scattering them too would double the
            // pile on a boulder)
            const count =
                resource === 'stone' ? stoneStock - visibleCrownCount : (parent.resources[resource] ?? 0);
            if (count <= 0) {
                return;
            }
            const stream = randomKeyed(resolvedSeed, `sub:${pathKey}:${resource}`);
            const taken = new Set<string>();
            // R1 — the shore's water spots refuse every deposit: underwater
            // fine cells carry nothing (the submerged-supplies-nothing rule,
            // the same rule the sea columns obey). The scatter's bounded
            // re-roll skips them like it skips boulders and trees.
            water.forEach((_spot, key) => {
                taken.add(key);
            });
            if (resource === 'stone') {
                // No loose pile on a boulder (every crown spot — visible or
                // bare, rock is not a pile) and none under a standing tree
                // (the canopy icon would hide it — one visible unit per fine
                // cell)
                crownSpots.forEach((spot) => taken.add(spot));
                stand?.trees.forEach((_record, spot) => taken.add(spot));
            }
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

        return { stand, rocks, visibleCrowns, deposits };
    };

    /**
     * Generates one tile's sub-grid — the materializer half of the scatter
     * (the preparation is the shared subPrep above; the long rule comment
     * lives there). `parentCanvas` is the grid the parent sits in — the
     * R1 shore mask reads the parent's water neighbors off it.
     */
    const generateSubCanvas = (parent: TerrainCell, pathKey: string, parentCanvas: Canvas): Canvas => {
        const width = dims.width;
        const height = dims.height;
        const halfX = (width - 1) / 2;
        const halfY = (height - 1) / 2;
        // R1 — the shore mask: the fine waterline this parent's interior
        // carries toward its water neighbors (empty for every non-beach
        // parent — see shoreMask's rule block)
        const shore = shoreMask(parent, pathKey, parentCanvas, resolvedSeed);
        const { stand, rocks, visibleCrowns, deposits } = subPrep(parent, pathKey, shore);

        const cells: TerrainCell[] = [];
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const x = col - halfX;
                const y = row - halfY;
                // R1 — the shore's water fine cells: REAL water — the
                // lowered seabed + water column the sea columns get,
                // impassable and deposit-free (the scatter refuses them).
                // The spot keeps the parent's water line; its biome reads
                // the water it borders (shallows rim, ocean-deep coves,
                // fresh-basin inlets).
                const shoreWater = shore.get(`${x},${y}`);
                if (shoreWater) {
                    const column = fineWaterColumn(parent.waterLevel, shoreWater);
                    cells.push({
                        x,
                        y,
                        voxels: column.voxels,
                        height: column.height,
                        waterLevel: parent.waterLevel,
                        biome: column.biome,
                        passable: false,
                        resources: {},
                    });
                    continue;
                }
                const resources: TileResources = { ...(deposits.get(`${x},${y}`) ?? {}) };
                // The persistent tree: the stand's exact fine position puts
                // ONE tree unit here (a fine cell holds at most one tree)
                if (stand?.trees.has(`${x},${y}`)) {
                    resources.tree = 1;
                }
                // The boulder's own STONE UNIT — the crown-first allocation:
                // the visible crowns carry the parent stock's first units
                // (the 🪨 icon + the 'stone' surface key read this live
                // per-fine-cell stock; it drops as the parent is mined)
                if (visibleCrowns.has(`${x},${y}`)) {
                    resources.stone = 1;
                }
                // The inherited column — and the spillover band's boulder:
                // a GRAVEL voxel stacked ON TOP (the visible rock surface —
                // reads as the 'stone' surface key only while the crown
                // carries the stock above; tree positions and boulders never
                // share a spot — seedStands refuses the band)
                const stack = [...parent.voxels];
                if (rocks.has(`${x},${y}`)) {
                    stack.push('gravel');
                }
                // Unlimited deposits are the ground itself — every subtile
                // carries the symbolic deposit so the zoomed tile keeps the
                // look its parent paints with (the microscopic-zoom rule).
                // Stone is NOT in the unlimited ladder anymore — the crown/
                // pile units above are its only fine-scale presence.
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
                    voxels: stack,
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
            canvas = generateSubCanvas(parentCell, key, canvas);
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

    /**
     * The EXACT surface-key histogram of the grid at `path` — the children's
     * visible keys counted WITHOUT materializing the sub-grid (the R6
     * depth-2 performance fix: the coarse majority fold asks this instead
     * of generating 425 cell objects per parent, which at depth 2 meant
     * ~180k cells per root and thrashed the FIFO sub-grid cache).
     *
     * Exactness: the scan reproduces generateSubCanvas position-for-position
     * from the SAME subPrep — an ordinary cell carries only the inherited
     * column + the unlimited ground supply (one base key computed once),
     * and only the SPECIAL fine cells (deposit landing, stand tree, visible
     * crown, boulder gravel) re-derive a key through tileSurfaceKey, memoized
     * per distinct shape signature (identical deposits + flags ⇒ identical
     * key). Undefined when no grid exists at `path` (empty path, beyond the
     * configured depth, unresolvable parent, unbound plugin).
     */
    const surfaceKeyCounts = (path: TilePath): SurfaceKeyCount[] | undefined => {
        if (!bound || path.length === 0 || path.length > subtileDepth) {
            return undefined;
        }
        // The parent cell whose scatter authors the grid at `path` — its own
        // grid resolves through the cache (the caller's fold just walked it)
        const parentCanvas = canvasAtPath(path.slice(0, -1));
        const tail = path[path.length - 1];
        const parent = parentCanvas ? cellOn(parentCanvas, tail.x, tail.y) : undefined;
        // The GUARD narrows BOTH reads: the shore mask and the scatter read
        // the parent's grid, so an unresolved canvas (and its missing parent
        // with it) answers undefined before either runs
        if (!parentCanvas || !parent) {
            return undefined;
        }
        // R1 — the shore mask this parent's interior carries (the SAME mask
        // generateSubCanvas materializes — one source of truth, the histogram
        // is exact only while it mirrors the materializer position-for-position)
        const shoreWaterMask = shoreMask(parent, tilePathKey(path), parentCanvas, resolvedSeed);
        const prep = subPrep(parent, tilePathKey(path), shoreWaterMask);
        const width = dims.width;
        const height = dims.height;
        const halfX = (width - 1) / 2;
        const halfY = (height - 1) / 2;
        const total = width * height;
        // Index the special fine cells by row-major cell index (the "x,y"
        // keys parse ONCE; the 425-cell scan below stays string-free)
        const depositAt: Array<TileResources | undefined> = new Array(total);
        prep.deposits.forEach((record, spot) => {
            const [x, y] = spot.split(',').map(Number);
            depositAt[(y + halfY) * width + (x + halfX)] = record;
        });
        const treeAt = new Uint8Array(total);
        prep.stand?.trees.forEach((_record, spot) => {
            const [x, y] = spot.split(',').map(Number);
            treeAt[(y + halfY) * width + (x + halfX)] = 1;
        });
        const crownAt = new Uint8Array(total);
        prep.visibleCrowns.forEach((spot) => {
            const [x, y] = spot.split(',').map(Number);
            crownAt[(y + halfY) * width + (x + halfX)] = 1;
        });
        const rockAt = new Uint8Array(total);
        prep.rocks.forEach((spot) => {
            const [x, y] = spot.split(',').map(Number);
            rockAt[(y + halfY) * width + (x + halfX)] = 1;
        });
        // R1 — the shore mask indexed by row-major cell: the water fine
        // cells (voxel depth + the lending basin) the materializer rebuilds
        // as sea-shaped columns
        const waterAt = new Uint8Array(total);
        const basinAt: Array<ShoreWater['basin']> = new Array(total);
        shoreWaterMask.forEach((spot, key) => {
            const [x, y] = key.split(',').map(Number);
            const index = (y + halfY) * width + (x + halfX);
            waterAt[index] = spot.depth;
            basinAt[index] = spot.basin;
        });
        // The ORDINARY cell's key — the inherited column carrying only the
        // unlimited ground supply (the materializer's per-cell loop sets
        // exactly these on a special-less cell): computed once per grid
        const baseResources: TileResources = {};
        TILE_RESOURCES.forEach((resource) => {
            if (UNLIMITED_TILE_RESOURCES.includes(resource) && (parent.resources[resource] ?? 0) > 0) {
                baseResources[resource] = 1;
            }
        });
        const baseKey = tileSurfaceKey({
            biome: parent.biome,
            resources: baseResources,
            voxels: parent.voxels,
        });
        // Special cells share keys by SHAPE (same deposit record + tree/
        // crown/gravel flags ⇒ same surface key) — tileSurfaceKey runs once
        // per distinct signature, not once per cell
        const specialKeys = new Map<string, string | undefined>();
        // R1 — the shore's water fine cells share keys by COLUMN SHAPE (the
        // same water depth + lending basin ⇒ the same sea-shaped column) —
        // the materializer's fineWaterColumn + tileSurfaceKey run once per
        // distinct signature, mirroring specialKeys above
        const waterKeys = new Map<string, string | undefined>();
        const counts = new Map<string, SurfaceKeyCount>();
        const bump = (key: string | undefined, index: number): void => {
            if (key === undefined) {
                return;
            }
            const record = counts.get(key);
            if (record) {
                record.count = record.count + 1;
                record.last = index;
                return;
            }
            counts.set(key, { key, count: 1, first: index, last: index });
        };
        for (let index = 0; index < total; index++) {
            // R1 — THE SHORE WATER first: a masked water fine cell is REAL
            // water (the materializer rebuilds it as the sea-shaped column of
            // fineWaterColumn — impassable, deposit-free), so its surface key
            // is its resolved water biome ('shallows' | 'ocean' | the basin's
            // own name), never the parent's land key. Checked before every
            // land flag: the scatter refuses water spots for deposits, and
            // beach parents carry no stands or carves, but the ordering makes
            // the agreement with generateSubCanvas structural, not lucky.
            const waterDepth = waterAt[index];
            if (waterDepth > 0) {
                const signature = `${waterDepth}|${basinAt[index] ?? ''}`;
                if (!waterKeys.has(signature)) {
                    // The materializer's EXACT column slice for this shape —
                    // the same fineWaterColumn call generateSubCanvas makes
                    const column = fineWaterColumn(parent.waterLevel, {
                        depth: waterDepth,
                        basin: basinAt[index],
                    });
                    waterKeys.set(
                        signature,
                        tileSurfaceKey({ biome: column.biome, resources: {}, voxels: column.voxels }),
                    );
                }
                bump(waterKeys.get(signature), index);
                continue;
            }
            const deposit = depositAt[index];
            const tree = treeAt[index] === 1;
            const crown = crownAt[index] === 1;
            const rock = rockAt[index] === 1;
            if (!deposit && !tree && !crown && !rock) {
                bump(baseKey, index);
                continue;
            }
            // The shape signature — deposit counts + the three flags
            const signature = `${TILE_RESOURCES.map((resource) => deposit?.[resource] ?? 0).join(
                ',',
            )}|${tree ? 1 : 0}${crown ? 1 : 0}${rock ? 1 : 0}`;
            if (!specialKeys.has(signature)) {
                // Rebuild the materializer's exact cell slice for this shape:
                // deposit spread, then the tree/crown units, then the
                // unlimited ground, then the boulder's gravel stack (the
                // same order generateSubCanvas's loop applies)
                const resources: TileResources = { ...(deposit ?? {}) };
                if (tree) {
                    resources.tree = 1;
                }
                if (crown) {
                    resources.stone = 1;
                }
                TILE_RESOURCES.forEach((resource) => {
                    if (UNLIMITED_TILE_RESOURCES.includes(resource) && (parent.resources[resource] ?? 0) > 0) {
                        resources[resource] = 1;
                    }
                });
                const voxels = rock ? [...parent.voxels, 'gravel' as VoxelKind] : parent.voxels;
                specialKeys.set(
                    signature,
                    tileSurfaceKey({ biome: parent.biome, resources, voxels }),
                );
            }
            bump(specialKeys.get(signature), index);
        }
        return [...counts.values()];
    };

    // ── The persistent forest stand registry ─────────────────────────────────    // The terrain plugin OWNS the stands (its sub-grid generation mirrors
    // them); the plugins/forest ecology mutates them through this pair.

    /** A tile's persistent stand (undefined: the tile holds no forest). */
    const forestOf = (x: number, y: number): ForestStand | undefined =>
        forestStands.get(`${x},${y}`);

    /**
     * Adds one tree to a tile's stand, creating the stand when absent.
     * THE BOULDER BOUNDARY — a plant onto the tile's rock-spillover band
     * (carving.rock — a boulder holds no tree, the neighborhood model's
     * invariant) is REFUSED: the stand is returned unchanged. The ecology's
     * recruitment and spread never target a boulder (recruitment excludes
     * the band; spread converts carve-less meadows), so this guard closes
     * the boundary for any future caller — it never fires on the mounted
     * paths. Conservative lookup: an unbound plugin (pre-setup) or an
     * out-of-grid tile allows the plant (nothing to refuse against).
     */
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
        // The boulder refusal — the tile's own carve decides (the real
        // recorded band; a fine spot ON it never gains a tree)
        const cell = bound ? cellOn(bound.world.canvas, x, y) : undefined;
        if (cell?.carving?.rock.includes(`${fine.x},${fine.y}`)) {
            return stand;
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
        // The children's EXACT surface-key histogram at `path` (no cell
        // materialization) — the coarse majority fold's fast path; undefined
        // when no grid exists there (see surfaceKeyCounts above)
        surfaceKeyCounts: (path) => surfaceKeyCounts(path),
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
