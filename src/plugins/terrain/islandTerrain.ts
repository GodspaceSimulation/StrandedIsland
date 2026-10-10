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

// (R1 — the fixed meadow ingress quotas MEADOW_INGRESS_CARDINAL/DIAGONAL
//  retired: the ingress fringe is the meadow side of the shared forest SEAM
//  now — seamSpots' meander sets its shape and size per edge, no quota.)

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

// ── The scale-0 EDGE WEAVE (R1 — natural neighbor blending) ──────────────────
//
// The zoomed interior of a tile used to end at its borders the way it began:
// every fine cell inherited the parent column, so two neighboring tiles of
// different terrain met along a perfectly straight world line, and the only
// edge treatments were FIXED GEOMETRY — the checkerboard rock spill
// (rockSpillSpots) and the distance-ranked meadow ingress strip
// (meadowIngressSpots). The god's complaint: the scale-0 edges read as
// script, not as country.
//
// The EDGE WEAVE replaces the fixed geometry with ONE shared, deterministic
// seam mechanism. Every shared border of two adjacent tiles is a SEAM keyed
// by BOTH tile addresses (`seam:<low>~<high>` — a stable spatial key in an
// independent stream namespace); ONE keyed stream derives a smooth meander
// (a low-frequency sine quantized to a boundary offset o(t) in
// [−BLEND_MAX_PUSH, +BLEND_MAX_PUSH] along the edge) that BOTH tiles read,
// so the two zoomed interiors agree on where the boundary wanders: the side
// the offset pushes into converts its outermost fine cells toward the
// NEIGHBOR's terrain — the meadow grows into the wood, the wood into the
// meadow — one meandering ecotone instead of a walled line. Sparse FEATHER
// wisps (BLEND_FEATHER_CHANCE per edge position) put the occasional lone
// cell one step beyond the band — irregularity without speckle.
//
//   WHAT CONVERTS — the pair table below (lendSurface): the blend cell keeps
//     its parent column and gains the neighbor's SURFACE (a grass patch in
//     the wood, a canopy patch on the slope, a sand tongue on the grass, a
//     gravel scree at the rock's foot — the rock look carries NO stock: the
//     finite stone never clones into a neighboring-biome cell, R2). The two
//     richer pairs keep their treatments: forest→highland blends as the
//     STONE-CROWNED boulder carve (generation pass 3 below), meadow→forest
//     as the REAL TREE INGRESS (the stand the lumber chop works).
//   WATER — a land tile beside water (the sea, a basin, or a river ford)
//     waves a WATERLINE along the shared edge (the same sea-shaped columns
//     the shore mask lays): reach |o(t)| fine cells, one voxel deep (two on
//     ocean), fresh basins and rivers lending their own biome. Water flows
//     onto the LAND side only — R2: a WATER PARENT (ocean, shallows, lake,
//     pond) blends NOTHING, so no land surface, decoration or deposit ever
//     creeps into standing water. T3 CARVES THE RIVER OUT of that rule: the
//     passable ford zooms into the living riverbank (riverFineMask below) —
//     the organic fresh-water body ringed by SYNTHESIZED dry banks carried
//     in EdgeMask.bank, a representation DISTINCT from the borrowed land
//     looks (a bank is raised new ground, not a surface swap onto the
//     parent's water column). The river's water stays the INHERITED parent
//     column — never a ShoreMask spot — so the ford's passability survives
//     untouched (fineCellDraft's water branch would hard-impassable it);
//     the basins and the sea still zoom 100% pure.
//   MAJORITY — the conversions are edge bands (≤ BLEND_MAX_PUSH cells deep)
//     on a minority of each edge's positions, so the parent's own look keeps
//     the dominant majority the coarse fold reads (R3: scale 1 barely moves).
//   AGREEMENT — edgeMask below is the SINGLE source of truth: the
//     materializer (generateSubCanvas), the fast histogram (surfaceKeyCounts)
//     and generation pass 3 (the carve/ingress records) all read the SAME
//     mask, so the zoomed board, the coarse fold and the recorded deposits
//     agree cell-for-cell.
//   CACHE — the mask reads the tile's EIGHT NEIGHBORS (biome + passable), so
//     the sub-grid fingerprint stamps them (fingerprintOf / the tileDetails
//     dominantStamp mirror): a cached grid never outlives the neighborhood it
//     blended toward (the forest ecology's spread conversions mutate neighbor
//     biomes — the cache-correctness rule for neighbor-derived data, the same
//     rule the carve already follows).

/** Max fine cells one seam may push into a tile per edge position. */
export const BLEND_MAX_PUSH = 2;

/** Feather chance per edge position — the sparse lone wisps beyond the band. */
export const BLEND_FEATHER_CHANCE = 0.05;

/** The land look a blend spot lends the tile (the neighbor's surface). */
export type BlendLook = 'grass' | 'forest' | 'sand' | 'rock';

/** The per-tile blend plan: the water spots, the land-look spots and the river banks. */
export type EdgeMask = {
    /** Fine "x,y" → the water the spot materializes as (shore ∪ seams). */
    water: ShoreMask;
    /** Fine "x,y" → the neighbor's surface the spot lends (plain swaps). */
    land: Map<string, BlendLook>;
    /**
     * T3 — fine "x,y" → the synthesized dry riverbank the spot materializes
     * as (river parents only — riverFineMask below; everything the bank plan
     * does not claim is the river's inherited ford water). Empty for every
     * non-river parent.
     */
    bank: Map<string, RiverBank>;
};

/**
 * The plain surface one neighbor's terrain lends THIS tile at a blended spot
 * (undefined: the pair is governed by a richer treatment — the forest→highland
 * carve, the meadow→forest tree ingress — or the neighbor is water, whose
 * waterline seams are handled separately). Same-biome pairs never seam.
 */
const lendSurface = (self: Biome, other: Biome): BlendLook | undefined => {
    if (other === 'meadow') {
        return self === 'meadow' ? undefined : 'grass';
    }
    if (other === 'forest') {
        // The meadow side of a meadow↔forest seam is the TREE INGRESS's —
        // not a plain surface swap
        return self === 'forest' || self === 'meadow' ? undefined : 'forest';
    }
    if (other === 'highland') {
        // The forest side of a forest↔highland seam is the BOULDER CARVE's
        return self === 'highland' || self === 'forest' ? undefined : 'rock';
    }
    if (other === 'beach') {
        return self === 'beach' ? undefined : 'sand';
    }
    // Water neighbors — the waterline seams govern (edgeMask)
    return undefined;
};

/**
 * The shared seam of two adjacent tiles: THIS side's blend spots ("x,y" →
 * intrusion depth 1..2). Both tiles of the seam call it with their own key
 * and the neighbor's — the canonical `seam:<low>~<high>` stream derives ONE
 * meander (the quantized sine o(t)) both sides read, so the composite
 * boundary is a single wavy line, not two independent scars. The stream
 * draws in a FIXED order (the wave's three parameters, then one roll per
 * edge position — never conditionally), so the two tiles' derivations stay
 * bit-aligned. Cardinal edges convert |o(t)| cells deep; a diagonal seam is
 * the shared corner (a wedge: the corner cell, its two flanks joining when
 * the push runs deep and the flank roll agrees). Pure, no allocation leaks.
 */
export const seamSpots = (
    width: number,
    height: number,
    seed: number,
    selfKey: string,
    otherKey: string,
    offset: Offset,
): Map<string, number> => {
    const spots = new Map<string, number>();
    if (offset.dx === 0 && offset.dy === 0) {
        return spots;
    }
    // The canonical pair — the low address key sorts first; a tile converts
    // when the meander pushes INTO it (o(t) negative pushes the canonical-A
    // side, positive the canonical-B side)
    const [keyA, keyB] = selfKey <= otherKey ? [selfKey, otherKey] : [otherKey, selfKey];
    const selfFirst = selfKey === keyA;
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    const diagonal = offset.dx !== 0 && offset.dy !== 0;
    const stream = randomKeyed(seed, `seam:${keyA}~${keyB}`);
    const phase = stream() * Math.PI * 2;
    const cycles = 1 + Math.floor(stream() * 2);
    const maxPush = 1 + Math.floor(stream() * 2);
    // The edge's traversal: a cardinal edge runs its axis' full length in
    // grid-global order (t indexes y for vertical seams, x for horizontal —
    // identical for both tiles); a diagonal seam is the shared corner (t = 0)
    const length = diagonal ? 1 : offset.dx !== 0 ? height : width;
    // The quantized boundary offset o(t) ∈ [−maxPush, maxPush] — the ONE
    // meander both tiles read (round keeps the runs contiguous: adjacent
    // positions differ by at most the sine's step)
    const pushAt = (t: number): number => {
        const wave = Math.sin(phase + (2 * Math.PI * cycles * t) / length);
        return Math.round(((wave + 1) / 2 - 0.5) * 2 * maxPush);
    };
    // This side's fine spot for a depth-d conversion at edge position t —
    // the cells step INTO the tile from the shared edge (depth 1 is the
    // outermost fine row/column)
    const spotAt = (t: number, depth: number): string => {
        if (diagonal) {
            const cornerX = offset.dx < 0 ? -halfX : halfX;
            const cornerY = offset.dy < 0 ? -halfY : halfY;
            return `${cornerX},${cornerY}`;
        }
        if (offset.dx !== 0) {
            const edgeX = offset.dx < 0 ? -halfX : halfX;
            return `${edgeX - offset.dx * (depth - 1)},${t - halfY}`;
        }
        const edgeY = offset.dy < 0 ? -halfY : halfY;
        return `${t - halfX},${edgeY - offset.dy * (depth - 1)}`;
    };
    // The diagonal wedge's two flanks (one along each edge sharing the corner)
    const flankAt = (): string[] => {
        const cornerX = offset.dx < 0 ? -halfX : halfX;
        const cornerY = offset.dy < 0 ? -halfY : halfY;
        return [`${cornerX - offset.dx},${cornerY}`, `${cornerX},${cornerY - offset.dy}`];
    };
    for (let t = 0; t < length; t++) {
        const o = pushAt(t);
        const depth = Math.abs(o);
        // Only the tile the push runs into converts (o < 0 pushes canonical-A)
        const mine = selfFirst ? o < 0 : o > 0;
        if (diagonal) {
            // The flank roll draws EVERY position (both tiles' streams stay
            // aligned — no conditional draws on a shared stream)
            const flankRoll = stream();
            if (mine && depth > 0) {
                spots.set(spotAt(t, 1), 1);
                if (depth >= 2 && flankRoll < 0.5) {
                    flankAt().forEach((key) => spots.set(key, 1));
                }
            }
        } else {
            if (mine && depth > 0) {
                for (let d = 1; d <= depth; d++) {
                    spots.set(spotAt(t, d), d);
                }
            }
            // THE FEATHER — a sparse lone wisp: at a quiet position either
            // side may grow a single cell (the side roll picks, both tiles
            // agree); at a shallow band position the wisp runs one deeper.
            // The rolls draw every position — aligned streams
            const roll = stream();
            if (roll < BLEND_FEATHER_CHANCE && depth <= 1) {
                if (o === 0) {
                    if (stream() < 0.5 ? selfFirst : !selfFirst) {
                        spots.set(spotAt(t, 1), 1);
                    }
                } else if (mine) {
                    spots.set(spotAt(t, 2), 2);
                }
            }
        }
    }
    return spots;
};

/** Row-major "x,y" sort — the stable layout the recorded treatments stamp. */
const rowMajorSort = (keys: Iterable<string>): string[] =>
    Array.from(keys).sort((left, right) => {
        const [lx, ly] = left.split(',').map(Number);
        const [rx, ry] = right.split(',').map(Number);
        return ly - ry || lx - rx;
    });

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
 * row-major order) a rocky neighbor's boulders spill onto. R1's EDGE WEAVE —
 * the band is the FOREST side of each shared highland SEAM (seamSpots: the
 * seeded meander both tiles read), no longer a checkerboard: the boulders
 * follow the same wavy boundary the highland's own grass patches do. Spots
 * falling on the tile's WATER spots are refused (no boulder stands in water
 * — R2). The zoomed interior crowns each spot's column with a boulder voxel
 * (generateSubCanvas) and the stand seeding refuses them (no tree stands on
 * a boulder). Pure — the streams are keyed, row-major output order stamped
 * into the sub-grid fingerprint.
 */
export const rockSpillSpots = (
    width: number,
    height: number,
    seed: number,
    origin: { x: number; y: number },
    rock: Offset[],
    refuse?: { has: (key: string) => boolean },
): string[] => {
    const selfKey = tilePathKey([{ x: origin.x, y: origin.y }]);
    const spots = new Set<string>();
    arrayEach(rock, ({ value: offset }) => {
        const otherKey = tilePathKey([{ x: origin.x + offset.dx, y: origin.y + offset.dy }]);
        seamSpots(width, height, seed, selfKey, otherKey, offset).forEach((_reach, key) => {
            if (!refuse?.has(key)) {
                spots.add(key);
            }
        });
    });
    return rowMajorSort(spots);
};

/**
 * The meadow TREE INGRESS spots: the fine cells ("x,y" keys, row-major
 * order) a meadow tile gains trees on, LOCALIZED along the edges it shares
 * with the woods. R1's EDGE WEAVE — the fringe is the MEADOW side of each
 * shared forest SEAM (seamSpots: the seeded meander both tiles read; the
 * wood grows clearings exactly where the meadow does not grow trees), no
 * longer a fixed distance-ranked strip. Spots falling on the tile's WATER
 * spots are refused (`refuse` — the tile's own waterline: no tree stands on
 * water, R2) and the deposit IS the filtered list's length, so generation
 * pass 3 and the stand seeding agree (one source of truth). Pure — no
 * unordered draws.
 */
export const meadowIngressSpots = (
    width: number,
    height: number,
    seed: number,
    origin: { x: number; y: number },
    forest: Offset[],
    refuse?: { has: (key: string) => boolean },
): string[] => {
    const selfKey = tilePathKey([{ x: origin.x, y: origin.y }]);
    const spots = new Set<string>();
    arrayEach(forest, ({ value: offset }) => {
        const otherKey = tilePathKey([{ x: origin.x + offset.dx, y: origin.y + offset.dy }]);
        seamSpots(width, height, seed, selfKey, otherKey, offset).forEach((_reach, key) => {
            if (!refuse?.has(key)) {
                spots.add(key);
            }
        });
    });
    return rowMajorSort(spots);
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
    /** The fresh-basin biome a BASIN or RIVER neighbor lends (undefined: sea water). */
    basin?: 'lake' | 'pond' | 'river';
};

/** The shore mask of one tile's interior: fine spot "x,y" → its water. */
export type ShoreMask = Map<string, ShoreWater>;

/** The water class a neighbor lends the shore mask (undefined: not water). */
type ShoreNeighbor = 'shallow' | 'deep' | 'lake' | 'pond' | 'river';

/**
 * Classifies one neighbor cell as the water it lends the shore mask: the
 * open ocean is deep water, the shallows rim shallow, the interior fresh
 * basins their own (fresh) water — and R1's EDGE WEAVE joins the river
 * ford: the channel is PASSABLE (the ford's semantics untouched) but it is
 * WATER, so the shore lays its one-voxel fresh waterline against it and the
 * river's mouth reads as a river at the zoomed scale. Dry or missing cells
 * lend nothing.
 */
const shoreNeighborOf = (cell: TerrainCell | undefined): ShoreNeighbor | undefined => {
    if (!cell) {
        return undefined;
    }
    if (cell.biome === 'river') {
        return 'river';
    }
    if (cell.passable) {
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
 * with. `pathKey` keys the deep-edge wave streams per tile address. R1's
 * EDGE WEAVE joins the RIVER ford to the shore's water vocabulary: the
 * passable channel is still water, so a beach tile at a river mouth lays
 * its one-voxel fresh (basin 'river') waterline against the channel and the
 * ford's banks stop reading as dry sand flush against dry sand.
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
        const basin: ShoreWater['basin'] =
            water === 'lake' ? 'lake' : water === 'pond' ? 'pond' : water === 'river' ? 'river' : undefined;
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
        // The waterline's VOXEL depth: shallow seas/basins/rivers lap one
        // voxel deep, the open ocean two (the sea columns' own shapes)
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

// ── The scale-0 RIVER FINE MASK (T4 — the true river course, shape-first) ────
//
// A RIVER tile's zoomed interior IS THE CHANNEL: one continuous, spatially
// coherent fresh-water course that runs the tile the way the coarse course
// runs the board — WIDE at the sea mouth, narrowing to a uniform channel
// inland, meandering smoothly turn by turn, ringed by narrow SAND banks on
// both sides with dry grass beyond. The T3 flood (a spine plus a seeded
// frontier flood to a fixed 65% of every tile) drew blotchy bars, seeded
// islands and full-width water endpoints — a mosaic, not a river; the T4
// floodplain top-up (a share dial flooding behind every seam) drew abrupt
// neck/pool jumps and re-seeded enclosed dry patches. The SHAPE-FIRST
// revision drops the share dial entirely — THE GEOMETRY IS THE WATER: the
// tile's water is the dial's channel band and nothing else, so the width
// the border interval opens is the width the interior keeps, the taper is
// visible at every longitude, and the coarse identity is carried by the
// river SEMANTIC (the dominantVisibleType river rule — a ford tile reads
// 'river' because it IS the river, not because a fine census says so).
// Everything stays deterministic and a pure function of the parent cell,
// its in-grid CARDINAL neighbors' biomes, the seed and the tile address:
//
//   THE LONGITUDE — every river cell of the parent canvas carries its
//     DISTANCE TO THE MOUTH (riverCourseDistances below: a multi-source BFS
//     over the canvas' river cells, seeded at every course cell that
//     cardinally touches open sea or a fresh basin; a canvas with no mouth —
//     the deep zooms — reads every cell INLAND). The distance drives the
//     CHANNEL WIDTH dial (RIVER_CHANNEL_MOUTH tapering by
//     RIVER_CHANNEL_TAPER per step to the uniform RIVER_CHANNEL_MIN — big at
//     the mouth, smaller and uniform as it travels inland).
//
//   THE CROSSINGS — the channel enters and leaves a tile through its WATER
//     edges (cardinal neighbors that are river, sea or basin). Each shared
//     edge carries ONE canonical crossing drawn from the PAIR stream
//     `rivercross:<low>~<high>` (both tile addresses sorted — the same
//     two-sided discipline the seams use): a keyed position along the edge
//     (margin 2 off the corners) and a keyed ±1 width jitter over the
//     UPSTREAM side's profile (the border reads as wide as the channel's
//     narrower end). Both tiles of a border derive the SAME stream, so the
//     channel endpoints agree position-for-position and width-for-width —
//     the seam continuity is structural, not lucky. A SEA or BASIN edge
//     needs no interval discipline (the other side zooms 100% water): its
//     FULL fine row is forced water — the mouth fans onto the sea, a course
//     debouches into a basin.
//
//   THE CENTERLINE — a sampled cubic Bézier through the tile. The curve
//     leaves every crossing PERPENDICULAR to the shared edge (its first
//     control sits on the edge normal), so consecutive tiles' curves meet
//     tangent-smooth — no kink at any seam — and the two crossings'
//     independent pair positions meander the composite course. A tile with
//     one water edge (a spring) curves to a keyed interior end, tapering to
//     RIVER_CHANNEL_SOURCE; three or more edges (a course meeting a basin
//     and the sea, or adjacent fixture courses) fall back to straight hub
//     spokes. The tile's water reads the curve's SIGNED DISTANCE FIELD
//     against the half-width the two crossings lerp along it, wobbled by the
//     INDEPENDENT `riverfine:<pathKey>` lattice (RIVER_FINE_NOISE_SCALE —
//     the T3 namespace; sampled in GRID coordinates: the T3 mask sampled
//     centered coordinates and every negative position degenerated to NaN —
//     236 of 425 cells on the default board — so its noise ordering never
//     actually shaped three quarters of the grid) with the bounded
//     RIVER_BANK_WOBBLE amplitude HARD-QUIETED within a crossing's
//     half-width + RIVER_BANK_QUIET: the seam region stays pure shared
//     geometry, so the two tiles of a border can never disagree on a
//     wobble-flipped cell.
//
//   THE ASSEMBLY — the raw field then:
//     1. bows to the BORDER FORCES: sea/basin edges' full rows and river
//        edges' crossing intervals are water; land edges' rows and river
//        edges' non-interval stretches are bank (water wins a corner two
//        edges claim — the shore contract's own allowance);
//     2. prunes to the LARGEST 4-connected water component (the wobble can
//        bead a detached droplet off the bank — it dries; the channel stays
//        ONE connected body by construction);
//     3. fills every ENCLOSED DRY COMPONENT — the no-islands guarantee,
//        structural: the DRY 4-connected components that touch NO rim cell
//        of the fine grid are fully surrounded by water (every external
//        4-neighbor of such a component is water — a dry one would be in
//        the component, a dry rim one would make it rim-touching), so the
//        fill 4-connects the whole component to the channel and NO dry
//        component that fails border-connection survives: the diagonal dry
//        pairs and the enclosed sand pockets the old lone-cell sweep
//        missed drown into the water, and the bank strips re-derive around
//        the merged body. One pass: the fill only adds water, so no new
//        enclosure can appear and the prune never needs a re-run;
//     and every remaining dry cell banks: WET SAND hugging the water (8-
//     adjacent — the narrow contiguous strips on BOTH sides of the channel),
//     dry GRASS beyond. The bank column is SYNTHESIZED (raised dry ground at
//     the water line — never the inherited ford column, which carries the
//     water): riverBankColumn below.
//
//   PARITY + CACHE — the same discipline as T3: the mask reads ONLY inputs
//     the sub-grid fingerprint already stamps (the parent's own fields + the
//     in-grid cardinal neighbors' biomes — tileDetails' dominantStamp mirrors
//     the same stamp, so no fingerprint extension and no tileDetails edit).
//     The longitude BFS reads the canvas' river/sea geometry, which
//     generation fixes and no ecology mutates (the forest spread converts
//     meadows only — plugins/forest), so the BFS needs no stamp either.
//     generateSubCanvas (the materializer) and surfaceKeyCounts (the fast
//     histogram) both read the SAME mask, so the zoomed board and the coarse
//     majority fold agree cell-for-cell; and the deposit scatter refuses
//     bank spots (no finite stock stands on synthesized ground — subPrep).

/**
 * The CHANNEL's full width at the mouth (fine cells before the board scale)
 * — the fan that meets the sea.
 */
export const RIVER_CHANNEL_MOUTH = 13;

/** The channel width taper per course step inland (fine cells). */
export const RIVER_CHANNEL_TAPER = 2.5;

/**
 * The uniform inland channel width floor (fine cells) — "smaller and
 * uniform as it travels inland": past the first few steps the channel holds
 * this width for the rest of the course.
 */
export const RIVER_CHANNEL_MIN = 6.5;

/** The channel width at a course's spring end (the source stub's far end). */
export const RIVER_CHANNEL_SOURCE = 3;

/**
 * The bank wobble amplitude (fine cells) — the coherent bounded bank noise
 * that keeps the channel from reading as ruled geometry.
 */
export const RIVER_BANK_WOBBLE = 1;

/**
 * The quiet margin beyond a crossing's half-width where the bank wobble is
 * silenced: the seam region stays pure shared geometry, so the two tiles of
 * a border can never disagree on a wobble-flipped cell (the widest
 * still-flippable cell sits at halfWidth + RIVER_BANK_WOBBLE of the
 * crossing; the quiet reach covers it with margin).
 */
export const RIVER_BANK_QUIET = 4;

/** The lattice scale of the bank noise — the organic blob size in fine cells. */
export const RIVER_FINE_NOISE_SCALE = 3;

/** The bank material one dry river fine cell materializes as. */
export type RiverBank = {
    /** 'sand' — the wet beach ring hugging the water; 'grass' — the dry meadow bank. */
    surface: 'sand' | 'grass';
};

/**
 * The SYNTHESIZED raised dry column of one river fine bank cell — the ground
 * the land creeps onto the river as. The column stands AT the water line (the
 * dry sandbar elevation generateIsland gives shore columns — a column exactly
 * at the water line is dry): gravel bedrock ×(ground−2), a dirt underlayer at
 * ground ≥ 2, the bank's surface voxel — and NO water voxel under the
 * synthetic bank. Its resources are the GROUND SUPPLY of its own voxels (the
 * dry-column rule: dirt and the surface material supply their resource at the
 * symbolic ×1, never depleted; the gravel bedrock supplies nothing) — NO
 * finite stock and no tree stands on synthesized ground.
 */
export const riverBankColumn = (
    waterLevel: number,
    bank: RiverBank,
): { voxels: VoxelKind[]; height: number; biome: Biome; resources: TileResources } => {
    const ground = Math.max(1, waterLevel);
    const stack: VoxelKind[] = [];
    if (ground >= 3) {
        for (let bedrock = 0; bedrock < ground - 2; bedrock++) {
            stack.push('gravel');
        }
    }
    if (ground >= 2) {
        stack.push('dirt');
    }
    stack.push(bank.surface);
    const resources: TileResources = {};
    if (stack.includes('dirt')) {
        resources.dirt = 1;
    }
    resources[bank.surface] = 1;
    return {
        voxels: stack,
        height: ground,
        biome: bank.surface === 'sand' ? 'beach' : 'meadow',
        resources,
    };
};

/** The longitude read for a course-less or unreachable river cell — the
 * inland profile (the uniform narrow channel). */
const RIVER_INLAND_DISTANCE = 99;

/**
 * The board scale of the river profile: the fine grids always carry the ROOT
 * board's dimensions, so a small board shrinks every channel amplitude with
 * it (a 7×5 board runs a brook, not a 13-wide torrent). The default 25×17
 * board reads exactly 1.
 */
const riverProfileScale = (width: number, height: number): number =>
    Math.min(1, Math.min(width, height) / 17);

/**
 * The channel's full width (fine cells) at `distance` course steps inland
 * from the mouth — the longitudinal profile: the mouth's fan tapers by
 * RIVER_CHANNEL_TAPER per step to the uniform RIVER_CHANNEL_MIN, scaled to
 * the board.
 */
const riverChannelWidth = (distance: number, scale: number): number =>
    Math.max(RIVER_CHANNEL_MIN, RIVER_CHANNEL_MOUTH - distance * RIVER_CHANNEL_TAPER) * scale;

/**
 * The course-longitude map of one canvas: every river cell (biome 'river' —
 * the same biome-only classes the edge plan reads) keyed by its row-major
 * index → the BFS distance in cardinal river steps to the nearest MOUTH (a
 * river cell cardinally touching open sea or a fresh basin — the course's
 * mouth). An EMPTY map: the canvas carries no mouth at all (the deep zooms)
 * — every river cell reads the inland profile. Pure and generation-stable:
 * only the river/sea geometry is read, which generation fixes and no
 * post-generation system mutates (the forest ecology converts meadows only —
 * plugins/forest), so the sub-grid fingerprint needs no extension for it.
 */
const riverCourseDistances = (
    canvas: Pick<Canvas, 'width' | 'height' | 'cells'>,
): Map<number, number> => {
    const width = canvas.width;
    const height = canvas.height;
    const total = width * height;
    const STEPS: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const isMouthWater = (index: number): boolean => {
        const biome = canvas.cells[index].biome;
        return biome === 'ocean' || biome === 'shallows' || biome === 'lake' || biome === 'pond';
    };
    const distances = new Map<number, number>();
    const queue: number[] = [];
    for (let index = 0; index < total; index++) {
        if (canvas.cells[index].biome !== 'river') {
            continue;
        }
        const col = index % width;
        const row = Math.floor(index / width);
        const mouth = STEPS.some(([dx, dy]) => {
            const ncol = col + dx;
            const nrow = row + dy;
            if (ncol < 0 || ncol >= width || nrow < 0 || nrow >= height) {
                return false;
            }
            return isMouthWater(nrow * width + ncol);
        });
        if (mouth) {
            distances.set(index, 0);
            queue.push(index);
        }
    }
    for (let head = 0; head < queue.length; head++) {
        const index = queue[head];
        const level = distances.get(index) ?? 0;
        const col = index % width;
        const row = Math.floor(index / width);
        for (const [dx, dy] of STEPS) {
            const ncol = col + dx;
            const nrow = row + dy;
            if (ncol < 0 || ncol >= width || nrow < 0 || nrow >= height) {
                continue;
            }
            const nindex = nrow * width + ncol;
            if (canvas.cells[nindex].biome !== 'river' || distances.has(nindex)) {
                continue;
            }
            distances.set(nindex, level + 1);
            queue.push(nindex);
        }
    }
    return distances;
};

/**
 * The dry-bank plan of one RIVER tile's zoomed interior (see the rule block
 * above): fine spot "x,y" → its synthesized bank. Everything the plan does
 * NOT bank is the river's inherited ford water. `pathKey` keys the bank
 * noise and the source-bend streams per tile address (the `riverfine:` and
 * `riverbend:` namespaces); `parentCanvas` is the grid the parent sits in —
 * the edge plan, the crossings and the longitude read the parent's in-grid
 * cardinal neighbors off it. Pure: same inputs → the identical plan.
 *
 * THE MASK CACHE — the plan is memoized per (parentCanvas OBJECT, pathKey,
 * seed). Sound because every input the plan reads is generation-fixed: the
 * river/sea geometry the longitude BFS walks and the neighbors' WATER
 * classes never change after generateIsland (the forest ecology converts
 * meadows only — plugins/forest; the river parent's own biome/passable/
 * waterLevel are just as fixed), and a regenerated world builds a FRESH
 * canvas object that orphans the old WeakMap entry. The materializer, the
 * fast histogram and repeated zoom walks share one plan — no per-call BFS
 * or distance-field re-derivation.
 */
const riverMaskCache = new WeakMap<
    object,
    Map<string, Map<string, RiverBank>>
>();

export const riverFineMask = (
    parent: TerrainCell,
    pathKey: string,
    parentCanvas: Pick<Canvas, 'width' | 'height' | 'cells'>,
    seed: number,
): Map<string, RiverBank> => {
    const cacheKey = `${pathKey}|${seed}`;
    const cached = riverMaskCache.get(parentCanvas)?.get(cacheKey);
    if (cached) {
        return cached;
    }
    const width = parentCanvas.width;
    const height = parentCanvas.height;
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    const total = width * height;
    const banks = new Map<string, RiverBank>();
    // The parent's own grid cell lookup — the same centered read cellOn does
    const neighborAt = (dx: number, dy: number): TerrainCell | undefined => {
        const nx = parent.x + dx;
        const ny = parent.y + dy;
        if (ny < -halfY || ny > halfY || nx < -halfX || nx > halfX) {
            return undefined;
        }
        return parentCanvas.cells[(ny + halfY) * width + (nx + halfX)];
    };
    // THE EDGE PLAN — the four cardinal neighbors decide where the channel
    // enters/exits and where the banks hold the border
    const CARDINALS: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const isChannelWater = (biome: Biome): boolean =>
        biome === 'river' || biome === 'ocean' || biome === 'shallows' ||
        biome === 'lake' || biome === 'pond';
    const edgeWater = CARDINALS.map(([dx, dy]) => {
        const neighbor = neighborAt(dx, dy);
        return !!neighbor && isChannelWater(neighbor.biome);
    });
    // A river tile with no channel edge keeps the old pure zoom (defensive:
    // the carve always leaves a channel neighbor; hand-built fixtures may not)
    if (!edgeWater.some(Boolean)) {
        return banks;
    }
    // The outermost fine line along one cardinal edge (the shared border)
    const edgeLine = (dx: number, dy: number): Array<{ x: number; y: number }> => {
        const line: Array<{ x: number; y: number }> = [];
        if (dx === 0) {
            const y = dy < 0 ? -halfY : halfY;
            for (let x = -halfX; x <= halfX; x++) {
                line.push({ x, y });
            }
        } else {
            const x = dx < 0 ? -halfX : halfX;
            for (let y = -halfY; y <= halfY; y++) {
                line.push({ x, y });
            }
        }
        return line;
    };
    const indexAt = (x: number, y: number): number => (y + halfY) * width + (x + halfX);

    // ── THE LONGITUDE — the tile's distance to its course mouth ─────────────
    // A course-less canvas (the deep zooms) or an unreachable course reads
    // the INLAND profile: the uniform narrow channel, the majority share
    const distances = riverCourseDistances(parentCanvas);
    const longitudeOf = (cell: { x: number; y: number }): number =>
        distances.size === 0
            ? RIVER_INLAND_DISTANCE
            : (distances.get(indexAt(cell.x, cell.y)) ?? RIVER_INLAND_DISTANCE);
    const distance = longitudeOf(parent);
    // The board scale — the fine grids always carry the root board's
    // dimensions, so a small board shrinks the channel with it
    const scale = riverProfileScale(width, height);

    // ── THE CROSSINGS — one canonical seam crossing per channel edge ────────
    type Crossing = {
        /** The neighbor direction (the edge's cardinal offset). */
        dx: number;
        dy: number;
        /** The crossing position along the edge, centered fine coordinates. */
        pos: number;
        /** The shared channel width at the crossing (fine cells). */
        width: number;
        /** The crossing point ON the shared border (fine coordinates). */
        px: number;
        py: number;
    };
    const crossings: Crossing[] = [];
    CARDINALS.forEach(([dx, dy], direction) => {
        if (!edgeWater[direction]) {
            return;
        }
        const neighbor = neighborAt(dx, dy)!;
        const len = dx === 0 ? width : height;
        const half = (len - 1) / 2;
        // THE CANONICAL PAIR STREAM — both tiles of the border derive the
        // same crossing position and width (the seams' two-sided discipline;
        // the low address sorts first so the key is order-stable)
        const selfSpot = `${parent.x},${parent.y}`;
        const otherSpot = `${neighbor.x},${neighbor.y}`;
        const [keyA, keyB] = selfSpot <= otherSpot ? [selfSpot, otherSpot] : [otherSpot, selfSpot];
        const stream = randomKeyed(seed, `rivercross:${keyA}~${keyB}`);
        // THE KEYED WIDTH — over the UPSTREAM side's profile: a river border
        // reads as wide as the channel's narrower end (the mouth tile fans
        // against the sea at its own profile width; mid-course borders stay
        // uniform), ±1 of pair jitter, clamped to the edge's fit. Drawn
        // FIRST so the width-aware margin below knows its reach.
        const neighborLongitude = neighbor.biome === 'river' ? longitudeOf(neighbor) : -1;
        const profileWidth = riverChannelWidth(Math.max(distance, neighborLongitude), scale);
        const jitterRoll = stream();
        const channelWidth = Math.max(2, Math.min(len - 2, profileWidth + (jitterRoll - 0.5) * 2));
        // THE WIDTH-AWARE MARGIN — the crossing sits far enough from both
        // corners that its FULL interval fits inside the edge (no clipped
        // seams, no fans hugging a corner): the margin is at least the
        // interval's own reach, at least 2, never past the edge middle
        const reach = Math.sqrt(Math.max(0, (channelWidth * channelWidth) / 4 - 0.25));
        const margin = Math.min(Math.max(2, Math.ceil(reach)), Math.floor((len - 1) / 2));
        // THE KEYED POSITION — drawn after the width so the margin knows it
        const pos = margin + Math.floor(stream() * Math.max(1, len - 2 * margin)) - half;
        crossings.push({
            dx,
            dy,
            pos,
            width: channelWidth,
            // The crossing point sits ON the shared border (half a cell
            // outside the outermost fine row's centers)
            px: dx === 0 ? pos : (dx < 0 ? -halfX : halfX) + dx * 0.5,
            py: dx === 0 ? (dy < 0 ? -halfY : halfY) + dy * 0.5 : pos,
        });
    });
    // ── THE CENTERLINE — the sampled curve(s) the water field distance-reads ─
    // Each segment carries the two full widths at its ends; the field reads
    // (distance to segment − half-width at the foot). The curve leaves every
    // crossing PERPENDICULAR to the shared edge (the first control sits on
    // the edge normal), so consecutive tiles' curves meet tangent-smooth and
    // the seam stays the shared crossing's pure geometry.
    type FieldSegment = {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        w0: number;
        w1: number;
    };
    const segments: FieldSegment[] = [];
    const pushCurve = (
        ax: number,
        ay: number,
        c1x: number,
        c1y: number,
        c2x: number,
        c2y: number,
        bx: number,
        by: number,
        widthStart: number,
        widthEnd: number,
    ): void => {
        const SAMPLES = 40;
        let prevX = ax;
        let prevY = ay;
        for (let step = 1; step <= SAMPLES; step++) {
            const t = step / SAMPLES;
            const mt = 1 - t;
            // The cubic Bézier point at t
            const x =
                mt * mt * mt * ax + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * bx;
            const y =
                mt * mt * mt * ay + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * by;
            segments.push({
                x0: prevX,
                y0: prevY,
                x1: x,
                y1: y,
                w0: widthStart + (widthEnd - widthStart) * ((step - 1) / SAMPLES),
                w1: widthStart + (widthEnd - widthStart) * (step / SAMPLES),
            });
            prevX = x;
            prevY = y;
        }
    };
    // The perpendicular exit depth of one crossing — deep enough to read as
    // a smooth run, never past the tile's interior
    const exitDepth = (crossing: Crossing): number =>
        Math.min(6, (crossing.dx === 0 ? halfY : halfX) - 0.5);
    if (crossings.length === 1) {
        // THE SOURCE STUB — one water edge (a spring, or a defensive
        // single-mouth fixture): the channel enters and rises to a keyed
        // interior end, tapering to RIVER_CHANNEL_SOURCE
        const crossing = crossings[0];
        const c1x = crossing.px - crossing.dx * exitDepth(crossing);
        const c1y = crossing.py - crossing.dy * exitDepth(crossing);
        // The tile's own keyed bend — the spring end swings inside the tile
        // (this stream needs no sharing: a bend belongs to one tile alone)
        const bend = randomKeyed(seed, `riverbend:${pathKey}`);
        const endX = (bend() - 0.5) * 4 * scale;
        const endY = (bend() - 0.5) * 4 * scale;
        // The second control — between the exit control and the end, swung
        // lateral for a gentle S into the spring
        const swing = (bend() - 0.5) * 3 * scale;
        const segX = endX - c1x;
        const segY = endY - c1y;
        const segLen = Math.hypot(segX, segY) || 1;
        pushCurve(
            crossing.px,
            crossing.py,
            c1x,
            c1y,
            (c1x + endX) / 2 - (segY / segLen) * swing,
            (c1y + endY) / 2 + (segX / segLen) * swing,
            endX,
            endY,
            crossing.width,
            Math.max(2, RIVER_CHANNEL_SOURCE * scale),
        );
    } else if (crossings.length === 2) {
        // THE THROUGH FLOW — the course crosses the tile from one water edge
        // to another: perpendicular exits at both ends, the interior shape
        // set by the two crossings' independent pair positions (the
        // composite course meanders tile by tile)
        const a = crossings[0];
        const b = crossings[1];
        pushCurve(
            a.px,
            a.py,
            a.px - a.dx * exitDepth(a),
            a.py - a.dy * exitDepth(a),
            b.px - b.dx * exitDepth(b),
            b.py - b.dy * exitDepth(b),
            b.px,
            b.py,
            a.width,
            b.width,
        );
    } else {
        // THE HUB (three or more water edges — a course meeting a basin and
        // the sea, or adjacent fixture courses): straight spokes from every
        // crossing to the center, each its own ramp. Rare, deterministic.
        crossings.forEach((crossing) => {
            pushCurve(
                crossing.px,
                crossing.py,
                (crossing.px * 2) / 3,
                (crossing.py * 2) / 3,
                crossing.px / 3,
                crossing.py / 3,
                0,
                0,
                crossing.width,
                Math.max(2, crossing.width * 0.75),
            );
        });
    }

    // ── THE WATER FIELD — the signed distance read of every fine cell ───────
    // The bank noise comes from the INDEPENDENT `riverfine:<pathKey>` lattice
    // (the coarse `river:` jitter, the seams and the shore waves untouched;
    // latticeNoise is declared further down the module — the reference
    // resolves lazily, the mask only ever runs at zoom time), sampled in GRID
    // coordinates: the T3 mask sampled centered coordinates and every
    // negative position degenerated to NaN (236 of 425 cells on the default
    // board) — the noise now shapes the whole grid.
    const random = randomKeyed(seed, `riverfine:${pathKey}`);
    const noise = latticeNoise(random, width, height, RIVER_FINE_NOISE_SCALE);
    const water = new Array<boolean>(total).fill(false);
    const signed = new Float64Array(total);
    const quiet = new Float64Array(total);
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const x = col - halfX;
            const y = row - halfY;
            const index = row * width + col;
            let best = Infinity;
            for (const segment of segments) {
                // The point-to-segment foot + the lerped half-width there
                const segX = segment.x1 - segment.x0;
                const segY = segment.y1 - segment.y0;
                const lenSq = segX * segX + segY * segY;
                let foot = lenSq === 0 ? 0 : ((x - segment.x0) * segX + (y - segment.y0) * segY) / lenSq;
                foot = Math.max(0, Math.min(1, foot));
                const footX = segment.x0 + segX * foot;
                const footY = segment.y0 + segY * foot;
                const value =
                    Math.hypot(x - footX, y - footY) -
                    (segment.w0 + (segment.w1 - segment.w0) * foot) / 2;
                if (value < best) {
                    best = value;
                }
            }
            signed[index] = best;
            // THE QUIET ZONE — within a crossing's half-width plus the quiet
            // margin the bank wobble is silenced (a hard step: both tiles of
            // a border compute the SAME zone from the SAME shared crossing,
            // so a wobble can never flip a mirrored seam cell; the
            // still-flippable cells — signed within ±2× the amplitude of
            // zero — all sit inside the zone)
            let silenced = false;
            for (const crossing of crossings) {
                const d = Math.hypot(x - crossing.px, y - crossing.py);
                if (d <= crossing.width / 2 + RIVER_BANK_QUIET) {
                    silenced = true;
                    break;
                }
            }
            quiet[index] = silenced ? 0 : 1;
        }
    }

    // ── THE BORDER FORCES ───────────────────────────────────────────────────
    const forcedWater = new Uint8Array(total);
    const forcedDry = new Uint8Array(total);
    CARDINALS.forEach(([dx, dy], direction) => {
        if (!edgeWater[direction]) {
            // THE LAND BOUNDARY — the full row along every land edge is bank
            edgeLine(dx, dy).forEach(({ x, y }) => {
                forcedDry[indexAt(x, y)] = 1;
            });
            return;
        }
        const neighbor = neighborAt(dx, dy)!;
        const line = edgeLine(dx, dy);
        if (neighbor.biome !== 'river') {
            // THE SEA/BASIN MOUTH — the full row is water: the river fans
            // onto the open water (whose own zoom is 100% pure, so the
            // border agrees by construction)
            line.forEach(({ x, y }) => {
                forcedWater[indexAt(x, y)] = 1;
            });
            return;
        }
        // THE RIVER SEAM — the crossing interval is water (the edge cells
        // whose centers sit within the crossing's disc: the same test both
        // tiles run on mirrored coordinates), the rest of the row is bank on
        // BOTH sides: no full-width endpoint rows, no half-matched
        // floodplain at a seam
        const crossing = crossings.find((entry) => entry.dx === dx && entry.dy === dy)!;
        const reach = Math.sqrt(Math.max(0, (crossing.width * crossing.width) / 4 - 0.25));
        line.forEach(({ x, y }) => {
            const index = indexAt(x, y);
            const position = dx === 0 ? x : y;
            if (Math.abs(position - crossing.pos) <= reach) {
                forcedWater[index] = 1;
            } else {
                forcedDry[index] = 1;
            }
        });
    });
    // THE CORNERS — a corner cell serves two edges; water claims outrank the
    // land boundary's dry row (the shore contract's "the corners may go to a
    // perpendicular water edge")
    for (let index = 0; index < total; index++) {
        if (forcedWater[index] && forcedDry[index]) {
            forcedDry[index] = 0;
        }
    }

    // ── THE ASSEMBLY ────────────────────────────────────────────────────────
    // 1. THE BAND — the curve's signed distance, wobbled where the seam
    //    quiet zone allows it
    for (let index = 0; index < total; index++) {
        if (forcedWater[index]) {
            water[index] = true;
        } else if (forcedDry[index]) {
            water[index] = false;
        } else {
            const col = index % width;
            const row = Math.floor(index / width);
            const wobble = quiet[index] * RIVER_BANK_WOBBLE * (noise(col, row) - 0.5) * 2;
            water[index] = signed[index] + wobble < 0;
        }
    }
    // 2. THE PRUNE — keep the LARGEST 4-connected water component (the
    //    earliest on ties — row-major deterministic): the wobble can bead a
    //    detached droplet off the bank; the channel is the big body and
    //    stays ONE connected piece by construction
    const label = new Int32Array(total).fill(-1);
    const sizes: number[] = [];
    let keepLabel = -1;
    let keepSize = 0;
    for (let index = 0; index < total; index++) {
        if (!water[index] || label[index] !== -1) {
            continue;
        }
        const id = sizes.length;
        sizes.push(0);
        label[index] = id;
        const queue: number[] = [index];
        for (let head = 0; head < queue.length; head++) {
            const current = queue[head];
            sizes[id] = sizes[id] + 1;
            const col = current % width;
            const row = Math.floor(current / width);
            for (const [dx, dy] of CARDINALS) {
                const ncol = col + dx;
                const nrow = row + dy;
                if (ncol < 0 || ncol >= width || nrow < 0 || nrow >= height) {
                    continue;
                }
                const nindex = nrow * width + ncol;
                if (water[nindex] && label[nindex] === -1) {
                    label[nindex] = id;
                    queue.push(nindex);
                }
            }
        }
        if (sizes[id] > keepSize) {
            keepSize = sizes[id];
            keepLabel = id;
        }
    }
    for (let index = 0; index < total; index++) {
        if (water[index] && label[index] !== keepLabel) {
            water[index] = false;
        }
    }
    // 3. THE ENCLOSED-DRY FILL — the no-islands guarantee, structural. The
    //    DRY 4-connected components that touch NO rim cell of the fine grid
    //    are fully surrounded by water (every external 4-neighbor of such a
    //    component is water — a dry one would be in the component, a dry rim
    //    one would make it rim-touching), so the fill 4-connects the whole
    //    component to the post-prune channel body: the diagonal dry pairs
    //    and the enclosed sand pockets the old lone-cell sweep missed drown
    //    into the water, and the bank strips re-derive around the merged
    //    body. ONE pass: the fill only adds water, so no new enclosure can
    //    appear, the prune never needs a re-run, and the water stays ONE
    //    4-connected body (each filled component is internally 4-connected
    //    and meets the body 4-adjacently at its perimeter).
    {
        const component = new Int32Array(total).fill(-1);
        const compRim: boolean[] = [];
        for (let index = 0; index < total; index++) {
            if (water[index] || component[index] !== -1) {
                continue;
            }
            const id = compRim.length;
            compRim.push(false);
            component[index] = id;
            const queue: number[] = [index];
            for (let head = 0; head < queue.length; head++) {
                const current = queue[head];
                const col = current % width;
                const row = Math.floor(current / width);
                if (col === 0 || col === width - 1 || row === 0 || row === height - 1) {
                    compRim[id] = true;
                }
                for (const [dx, dy] of CARDINALS) {
                    const ncol = col + dx;
                    const nrow = row + dy;
                    if (ncol < 0 || ncol >= width || nrow < 0 || nrow >= height) {
                        continue;
                    }
                    const nindex = nrow * width + ncol;
                    if (!water[nindex] && component[nindex] === -1) {
                        component[nindex] = id;
                        queue.push(nindex);
                    }
                }
            }
        }
        compRim.forEach((rim, id) => {
            if (rim) {
                return;
            }
            for (let index = 0; index < total; index++) {
                if (component[index] === id) {
                    water[index] = true;
                }
            }
        });
    }
    // 4. THE BANK SURFACES — wet sand hugging the water, dry grass deeper in
    for (let index = 0; index < total; index++) {
        if (water[index]) {
            continue;
        }
        const x = (index % width) - halfX;
        const y = Math.floor(index / width) - halfY;
        const wet = NEIGHBOR_OFFSETS.some((offset) => {
            const nx = x + offset.dx;
            const ny = y + offset.dy;
            return nx >= -halfX && nx <= halfX && ny >= -halfY && ny <= halfY &&
                water[indexAt(nx, ny)];
        });
        banks.set(`${x},${y}`, { surface: wet ? 'sand' : 'grass' });
    }
    // Memoize the pure plan (see the cache rule above)
    let byCanvas = riverMaskCache.get(parentCanvas);
    if (!byCanvas) {
        byCanvas = new Map();
        riverMaskCache.set(parentCanvas, byCanvas);
    }
    byCanvas.set(cacheKey, banks);
    return banks;
};

// ── The blend cell builder + the per-tile blend plan ─────────────────────────

/**
 * The draft fields of one fine cell of a parent's sub-grid — exactly what
 * generateSubCanvas materializes and surfaceKeyCounts keys. Built by
 * fineCellDraft below (the SINGLE builder both readers run — the
 * materializer/histogram agreement is structural, not lucky).
 */
type FineFlags = {
    /** A scattered finite deposit record landing on the spot. */
    deposit?: TileResources;
    /** The persistent stand's tree standing on the spot. */
    tree?: boolean;
    /** A visible stone crown (the carve's stock-backed boulder). */
    crown?: boolean;
    /** A boulder crown (the carve band's gravel stack). */
    rock?: boolean;
    /** A blend spot: the neighbor's surface the cell lends (plain swaps). */
    look?: BlendLook;
    /** A water spot: the sea-shaped column the cell materializes as. */
    water?: ShoreWater;
    /**
     * T3 — a river parent's synthesized dry bank: the raised column the spot
     * materializes as (disjoint from `water` — the river's ford water is the
     * inherited column, never a water spot).
     */
    bank?: RiverBank;
};

/**
 * Applies one blend look to a fine cell's draft — the transformation the
 * materializer and the histogram both run. The cell keeps its parent column
 * and gains the neighbor's SURFACE (voxel + biome + the borrowed ground
 * supply); a canopy never stands under a borrowed surface (only the forest
 * patch keeps one); the rock look strips the ground supply (bare scree
 * gathers nothing) and carries NO stock — the finite stone never clones into
 * a neighboring-biome cell (R2). Mutates the passed stack/resources.
 */
const applyBlendLook = (stack: VoxelKind[], resources: TileResources, look: BlendLook): Biome => {
    if (look !== 'forest') {
        // The borrowed surface replaces the canopy — the wood's clearing,
        // the sand tongue and the scree carry no standing woods of their own
        const canopy = stack.indexOf('forest');
        if (canopy !== -1) {
            stack.splice(canopy, 1);
        }
    }
    if (look === 'grass') {
        if (stack[stack.length - 1] !== 'grass') {
            stack.push('grass');
        }
        resources.grass = Math.max(resources.grass ?? 0, 1);
        return 'meadow';
    }
    if (look === 'forest') {
        if (stack[stack.length - 1] !== 'forest') {
            stack.push('forest');
        }
        return 'forest';
    }
    if (look === 'sand') {
        if (stack[stack.length - 1] !== 'sand') {
            stack.push('sand');
        }
        resources.sand = Math.max(resources.sand ?? 0, 1);
        return 'beach';
    }
    // THE ROCK — bare scree: the gravel crown, the ground supply stripped
    if (stack[stack.length - 1] !== 'gravel') {
        stack.push('gravel');
    }
    delete resources.dirt;
    delete resources.grass;
    delete resources.sand;
    return 'highland';
};

/**
 * Builds the EXACT fine cell draft for one spot of a parent's sub-grid — the
 * shared builder generateSubCanvas materializes with and surfaceKeyCounts
 * keys with, position-for-position (the three-reader agreement). The build
 * order is the materializer's: water spots are REAL water (impassable,
 * deposit-free — the submerged-supplies-nothing rule), then a river parent's
 * SYNTHESIZED BANK (the raised dry column — riverBankColumn), then the
 * scattered deposits, the stand tree, the crown stone, the inherited column
 * (+ the boulder's gravel stack), the unlimited ground supply, and finally
 * the blend look's borrowed surface.
 */
const fineCellDraft = (
    parent: TerrainCell,
    flags: FineFlags,
): { voxels: VoxelKind[]; height: number; biome: Biome; passable: boolean; resources: TileResources } => {
    if (flags.water) {
        const column = fineWaterColumn(parent.waterLevel, flags.water);
        return {
            voxels: column.voxels,
            height: column.height,
            biome: column.biome,
            passable: false,
            resources: {},
        };
    }
    if (flags.bank) {
        // THE RIVER BANK (T3) — the synthesized raised dry column: new ground
        // at the water line, NO water voxel under it, the bank's own ground
        // supply, no finite stock, no tree — passable dry land the ford's
        // water laps against
        const column = riverBankColumn(parent.waterLevel, flags.bank);
        return {
            voxels: column.voxels,
            height: column.height,
            biome: column.biome,
            passable: true,
            resources: column.resources,
        };
    }
    const resources: TileResources = { ...(flags.deposit ?? {}) };
    if (flags.tree) {
        resources.tree = 1;
    }
    if (flags.crown) {
        resources.stone = 1;
    }
    const stack = [...parent.voxels];
    if (flags.rock) {
        stack.push('gravel');
    }
    // Unlimited deposits are the ground itself — every subtile carries the
    // symbolic deposit so the zoomed tile keeps the look its parent paints
    // with (the microscopic-zoom rule). Stone is NOT in the ladder — the
    // crown/pile units are its only fine-scale presence.
    TILE_RESOURCES.forEach((resource) => {
        if (UNLIMITED_TILE_RESOURCES.includes(resource) && (parent.resources[resource] ?? 0) > 0) {
            resources[resource] = 1;
        }
    });
    let biome = parent.biome;
    if (flags.look) {
        biome = applyBlendLook(stack, resources, flags.look);
    }
    return {
        voxels: stack,
        height: parent.height,
        biome,
        passable: parent.passable,
        resources,
    };
};

/**
 * The blend plan of one tile's zoomed interior — the SINGLE source of truth
 * the materializer, the fast histogram and generation pass 3 all read (see
 * the EDGE WEAVE rule block). `path` is the tile's full address (its tail is
 * the tile inside `parentCanvas`); the seam streams key off both sides'
 * addresses, so two adjacent tiles derive ONE coherent meander.
 */
export const edgeMask = (
    parent: TerrainCell,
    path: TilePath,
    parentCanvas: Pick<Canvas, 'width' | 'height' | 'cells'>,
    seed: number,
): EdgeMask => {
    const water: ShoreMask = new Map();
    const land = new Map<string, BlendLook>();
    const bank = new Map<string, RiverBank>();
    const width = parentCanvas.width;
    const height = parentCanvas.height;
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    // T3 — THE RIVER zooms into the living riverbank: the passable ford's
    // fine grid is the organic water body ringed by synthesized dry banks
    // (riverFineMask). The river's water is NOT a ShoreMask spot — it stays
    // the inherited parent column, so the ford's passability survives
    // untouched (the water branch below would hard-impassable it); only the
    // DRY banks are new surface. This branch must precede the water-parent
    // early return: isFreshBasin is true for 'river'.
    if (parent.biome === 'river' && parent.passable) {
        riverFineMask(parent, tilePathKey(path), parentCanvas, seed).forEach((spot, key) => {
            bank.set(key, spot);
        });
        return { water, land, bank };
    }
    // R2 — WATER PARENTS BLEND NOTHING: no land surface, no decoration, no
    // deposit ever creeps into standing water. An impassable column is water
    // alike. (The river branched above — T3's fine banks; the basins and the
    // sea still zoom 100% pure.)
    if (
        !parent.passable ||
        parent.biome === 'ocean' ||
        parent.biome === 'shallows' ||
        isFreshBasin(parent.biome)
    ) {
        return { water, land, bank };
    }
    // The parent's own grid cell lookup — the same centered read cellOn does
    const neighborAt = (dx: number, dy: number): TerrainCell | undefined => {
        const nx = parent.x + dx;
        const ny = parent.y + dy;
        if (ny < -halfY || ny > halfY || nx < -halfX || nx > halfX) {
            return undefined;
        }
        return parentCanvas.cells[(ny + halfY) * width + (nx + halfX)];
    };
    const selfKey = tilePathKey(path);
    const otherKeyOf = (offset: Offset): string =>
        tilePathKey([...path.slice(0, -1), { x: parent.x + offset.dx, y: parent.y + offset.dy }]);
    // Deeper water wins a shared spot (the shore's put rule — the two
    // readers stay consistent on corner overlaps). The sweep walks the
    // neighbors in the fixed NEIGHBOR_OFFSETS order, so a LAND seam can be
    // processed BEFORE the water seam claiming the same fine cell (a
    // highland north, the ocean east — both meanders reach the shared
    // corner): the land sweep's guard only skips water written SO FAR, so
    // putWater must clear the stale land entry here or the spot would sit
    // in BOTH masks — an order-dependent invariant (harmless to the readers
    // today, the draft and the histogram read water first, but the masks
    // themselves must not depend on the neighbor walk's order)
    const putWater = (key: string, spot: ShoreWater): void => {
        const standing = water.get(key);
        if (standing && standing.depth >= spot.depth) {
            return;
        }
        water.set(key, spot);
        // The early-return above cannot leave a stale pair behind: a
        // standing water spot was itself put through here (deleting the
        // land entry then), and the land sweep never writes under a water
        // spot that already exists
        land.delete(key);
    };
    // THE SHORE — the beach's impassable-water edges shape the pinned full
    // waterline (river fords included — shoreNeighborOf reads them as water)
    if (parent.biome === 'beach') {
        shoreMask(parent, tilePathKey(path), parentCanvas, seed).forEach((spot, key) => {
            water.set(key, spot);
        });
    }
    // The seam sweep in the fixed NEIGHBOR_OFFSETS order — water seams first
    // (water wins a shared corner), then the plain land looks
    arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
        const neighbor = neighborAt(offset.dx, offset.dy);
        if (!neighbor) {
            return;
        }
        if (neighbor.biome === parent.biome) {
            // Uniform ground — no seam across a same-biome border
            return;
        }
        const otherKey = otherKeyOf(offset);
        const otherBiome = neighbor.biome;
        if (otherBiome === 'ocean' || otherBiome === 'shallows' || isFreshBasin(otherBiome)) {
            if (parent.biome === 'beach') {
                // The shore's pinned lines govern every beach water edge —
                // rivers included (the mask above already laid them)
                return;
            }
            // THE WAVY WATERLINE — the seam's meander decides the reach;
            // the waterline layer carries the water type's voxel depth (two
            // on ocean), a reach-2 second layer shallows to one voxel
            const spots = seamSpots(width, height, seed, selfKey, otherKey, offset);
            spots.forEach((reach, key) => {
                const typeDepth = otherBiome === 'ocean' ? 2 : 1;
                const basin: ShoreWater['basin'] =
                    otherBiome === 'lake' ? 'lake' : otherBiome === 'pond' ? 'pond' : otherBiome === 'river' ? 'river' : undefined;
                putWater(key, { depth: reach === 1 ? typeDepth : 1, basin });
            });
            return;
        }
        const look = lendSurface(parent.biome, otherBiome);
        if (!look) {
            // The richer treatments govern this pair: the forest→highland
            // carve (the boulders), the meadow→forest tree ingress (the stand)
            return;
        }
        const spots = seamSpots(width, height, seed, selfKey, otherKey, offset);
        spots.forEach((_reach, key) => {
            if (water.has(key) || land.has(key)) {
                return;
            }
            land.set(key, look);
        });
    });
    return { water, land, bank };
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
            // (R1's EDGE WEAVE: the ROCK CARVE and the MEADOW INGRESS moved
            // to pass 3 below — they re-derive from the shared seam geometry
            // on the FINAL water map, this pass only prices the coverage.)
            const coverage = forestCoverageOf(
                neighborhood.forest,
                neighborhood.rock,
                neighborhood.meadow,
            );
            cell.resources.tree = Math.round(coverage * width * height);
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

    // ── pass 3 — THE EDGE WEAVE RECORDS (R1) ─────────────────────────────────
    // The RECORDED edge treatments re-derive from the SHARED seam geometry on
    // the FINAL water map (the basins and the rivers above are already
    // carved): every forest tile beside highlands records its boulder carve
    // (rockSpillSpots — the stone-crowned band the stock splits across, the
    // stand seeding refuses), every meadow beside woods records its tree
    // ingress (meadowIngressSpots — the fringe the stand seeds and the mirror
    // counts). Both REFUSE the tile's own water spots (edgeMask's waterline —
    // no boulder in water, no tree on water, R2). The tree COVERAGE pricing
    // (pass 2) stays the pre-basin map's pure neighborhood math untouched;
    // this pass only re-shapes WHERE the recorded treatments stand and how
    // many ingress spots survive the water. Deterministic: the seam streams
    // are keyed, the sweep is row-major.
    {
        const seed = options.seed ?? 1;
        canvas.cells.forEach((cell) => {
            const rockOffsets: Offset[] = [];
            const forestOffsets: Offset[] = [];
            arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
                const nx = cell.x + offset.dx;
                const ny = cell.y + offset.dy;
                if (ny < -halfY || ny > halfY || nx < -halfX || nx > halfX) {
                    return;
                }
                const neighbor = canvas.cells[(ny + halfY) * width + (nx + halfX)];
                if (neighbor.biome === 'highland') {
                    rockOffsets.push(offset);
                } else if (neighbor.biome === 'forest') {
                    forestOffsets.push(offset);
                }
            });
            if (cell.biome === 'forest' && rockOffsets.length > 0) {
                const refuse = edgeMask(cell, [{ x: cell.x, y: cell.y }], canvas, seed).water;
                const rocks = rockSpillSpots(width, height, seed, cell, rockOffsets, refuse);
                if (rocks.length > 0) {
                    // The TileCarving (engine/types.ts) — the neighbor-derived
                    // data the zoomed interior reads and the fingerprint stamps
                    cell.carving = { rock: rocks };
                }
            } else if (cell.biome === 'meadow' && forestOffsets.length > 0) {
                const refuse = edgeMask(cell, [{ x: cell.x, y: cell.y }], canvas, seed).water;
                const ingress = meadowIngressSpots(width, height, seed, cell, forestOffsets, refuse);
                if (ingress.length > 0) {
                    // The deposit IS the fringe's size — the same list the
                    // stand seeding reads (one source of truth)
                    cell.resources.tree = ingress.length;
                }
            }
        });
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
            // R1 — the tile's WATER spots (its own edge-weave waterline): no
            // tree stands on water, so the stand's pool refuses them beside
            // the boulder band (the mirror re-reads the stand below)
            const waterSpots = edgeMask(cell, [{ x: cell.x, y: cell.y }], canvas, resolvedSeed).water;
            let spots: Array<{ x: number; y: number }>;
            if (forested) {
                // The rock-spillover band holds boulders, not trees — the
                // stand's pool excludes it (the deposit count already priced
                // the rock in via the coverage penalty); the waterline spots
                // hold water, not trees either
                const rocks = new Set(cell.carving?.rock ?? []);
                spots = [];
                for (let row = 0; row < dims.height; row++) {
                    for (let col = 0; col < dims.width; col++) {
                        const spot = { x: col - halfX, y: row - halfY };
                        const key = `${spot.x},${spot.y}`;
                        if (!rocks.has(key) && !waterSpots.has(key)) {
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
                // The ingress meadow's seam-side spots — the SAME pure
                // selection the deposit was written from (generation pass 3,
                // the water spots refused identically)
                const edges = neighborhoodOf(canvas, cell.x, cell.y).forest;
                spots = meadowIngressSpots(dims.width, dims.height, resolvedSeed, cell, edges, waterSpots)
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
    // + biome + voxel stack + NEIGHBORHOOD CARVE + the EIGHT NEIGHBORS'
    // water-class fragments. The forest ecology now DOES reshape columns
    // after generation (the spread conversion stacks a forest voxel onto a
    // converted meadow and re-biomes it), so the stamp carries the voxels
    // and biome too — a stamp change invalidates the cached sub-grid exactly
    // when the parent tile changed (gathering, tree work, spread). The carve
    // rides the stamp as well: it is the NEIGHBOR-DERIVED sub-canvas data
    // (the spillover band), so a cached grid must never outlive the carve it
    // was generated from — the stamp covers it (the cache-correctness rule
    // for neighbor-derived data: generation pass 3 computes the carve,
    // generateSubCanvas consumes it, and the stamp serializes it). R1's EDGE
    // WEAVE extends the same rule to the mask's NEW neighbor inputs: the
    // blend reads each in-grid neighbor's biome and passability, so the
    // stamp serializes those too (`nb(...)` — `rim` beyond the grid) — a
    // neighbor's spread conversion moves the stamp of every tile that blends
    // toward it, and the cached grids re-derive their seams fresh.
    const fingerprintOf = (cell: TerrainCell, canvas: Pick<Canvas, 'width' | 'height' | 'cells'>): string =>
        `${TILE_RESOURCES.map((resource) => cell.resources[resource] ?? 0).join(',')}|${cell.height}|${cell.waterLevel}|${cell.biome}|${cell.voxels.join('+')}|${cell.carving ? cell.carving.rock.join(';') : 'none'}|nb(${NEIGHBOR_OFFSETS.map((offset) => {
            const neighbor = cellOn(canvas, cell.x + offset.dx, cell.y + offset.dy);
            return neighbor ? `${neighbor.biome}${neighbor.passable ? 1 : 0}` : 'rim';
        }).join(',')})`;

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

    const subPrep = (
        parent: TerrainCell,
        pathKey: string,
        water: ShoreMask,
        bank: Map<string, RiverBank>,
        root: boolean,
    ): SubPrep => {
        const width = dims.width;
        const height = dims.height;
        const halfX = (width - 1) / 2;
        const halfY = (height - 1) / 2;

        // The parent's persistent stand — its positions author the tree
        // mirror (a stand-less forest tile falls back to the seeded scatter
        // below, the pre-ecology shape). R2's zoom discipline: the stand
        // registry is keyed by ROOT tile coordinates, so only a ROOT-grid
        // parent may read it — a deeper parent's coords are fine coords of
        // its own grid, and reading the registry with them would materialize
        // an UNRELATED tile's stand inside this grid (trees materialized on
        // whatever the coordinates collided with — a river's or pond's
        // fine cell zoomed at depth 2 would grow the coincidental root
        // tile's whole stand: land standing in water, R2's exact ban).
        const stand = root ? forestOf(parent.x, parent.y) : undefined;

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
            // T3 — the river's dry banks refuse every deposit too: no finite
            // stock stands on synthesized ground (the bank columns carry
            // their own ground supply and nothing else — riverBankColumn)
            bank.forEach((_spot, key) => {
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
     * lives there). `path` is the tile's full address (its tail is the tile
     * inside `parentCanvas`) — the blend mask's seam streams key off it.
     * `parentCanvas` is the grid the parent sits in — the R1 shore mask and
     * the edge weave read the parent's in-grid neighbors off it. `root`
     * flags a ROOT-grid parent (the only parent the stand registry may
     * answer — see subPrep's zoom discipline).
     */
    const generateSubCanvas = (parent: TerrainCell, path: TilePath, parentCanvas: Canvas, root: boolean): Canvas => {
        const width = dims.width;
        const height = dims.height;
        const halfX = (width - 1) / 2;
        const halfY = (height - 1) / 2;
        const pathKey = tilePathKey(path);
        // R1 — the blend plan: the shore's waterline (beach parents) plus the
        // EDGE WEAVE — the wavy water seams and the neighbor-surface looks
        // this parent's interior carries toward its differing neighbors (the
        // SINGLE mask surfaceKeyCounts keys with — one source of truth)
        const mask = edgeMask(parent, path, parentCanvas, resolvedSeed);
        const { stand, rocks, visibleCrowns, deposits } = subPrep(
            parent,
            pathKey,
            mask.water,
            mask.bank,
            root,
        );

        const cells: TerrainCell[] = [];
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const x = col - halfX;
                const y = row - halfY;
                const spot = `${x},${y}`;
                // The SHARED fine cell builder — the exact draft both this
                // materializer and the fast histogram derive (structural
                // agreement: water spots real water, a river parent's
                // synthesized banks, deposits, the stand's tree, the crown
                // stone, the boulder's gravel stack, the unlimited ground
                // supply, then the blend look's surface)
                const draft = fineCellDraft(parent, {
                    water: mask.water.get(spot),
                    bank: mask.bank.get(spot),
                    look: mask.land.get(spot),
                    deposit: deposits.get(spot),
                    tree: stand?.trees.has(spot) ?? false,
                    crown: visibleCrowns.has(spot),
                    rock: rocks.has(spot),
                });
                cells.push({
                    x,
                    y,
                    voxels: draft.voxels,
                    height: draft.height,
                    waterLevel: parent.waterLevel,
                    biome: draft.biome,
                    passable: draft.passable,
                    resources: draft.resources,
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
            // The stamp reads the parent's OWN grid — its blend inputs (the
            // neighbors' water classes) ride it, so a cached grid never
            // outlives the neighborhood it blended toward
            const stamp = fingerprintOf(parentCell, canvas);
            const cached = subCanvases.get(key);
            if (cached && cached.stamp === stamp) {
                canvas = cached.canvas;
                continue;
            }
            canvas = generateSubCanvas(parentCell, path.slice(0, level + 1), canvas, level === 0);
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
     * from the SAME subPrep AND the SAME edgeMask (R1's blend plan — the
     * shore waterline, the water seams, the neighbor-surface looks) — an
     * ordinary cell carries only the inherited column + the unlimited ground
     * supply (one base key computed once through the shared fineCellDraft
     * builder), and only the SPECIAL fine cells (water spot, deposit
     * landing, stand tree, visible crown, boulder gravel, blend look)
     * re-derive a key through tileSurfaceKey, memoized per distinct shape
     * signature (identical deposits + flags + look ⇒ identical key).
     * Undefined when no grid exists at `path` (empty path, beyond the
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
        // The GUARD narrows BOTH reads: the blend mask and the scatter read
        // the parent's grid, so an unresolved canvas (and its missing parent
        // with it) answers undefined before either runs
        if (!parentCanvas || !parent) {
            return undefined;
        }
        // R1 — the SAME blend plan generateSubCanvas materializes (the
        // shore's waterline for beach parents + the EDGE WEAVE's water
        // seams and neighbor-surface looks) — one source of truth, the
        // histogram is exact only while it mirrors the materializer
        // position-for-position
        const mask = edgeMask(parent, path, parentCanvas, resolvedSeed);
        const prep = subPrep(parent, tilePathKey(path), mask.water, mask.bank, path.length === 1);
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
        // R1 — the water spots indexed by row-major cell: the water fine
        // cells (voxel depth + the lending basin) the materializer rebuilds
        // as sea-shaped columns
        const waterAt = new Uint8Array(total);
        const basinAt: Array<ShoreWater['basin']> = new Array(total);
        mask.water.forEach((spot, key) => {
            const [x, y] = key.split(',').map(Number);
            const index = (y + halfY) * width + (x + halfX);
            waterAt[index] = spot.depth;
            basinAt[index] = spot.basin;
        });
        // R1 — the blend's land-look spots indexed the same way (the
        // neighbor's surface each spot lends)
        const landAt: Array<BlendLook | undefined> = new Array(total);
        mask.land.forEach((look, key) => {
            const [x, y] = key.split(',').map(Number);
            landAt[(y + halfY) * width + (x + halfX)] = look;
        });
        // T3 — the river parent's dry bank spots indexed the same way (the
        // synthesized raised columns the materializer builds)
        const bankAt: Array<RiverBank | undefined> = new Array(total);
        mask.bank.forEach((spot, key) => {
            const [x, y] = key.split(',').map(Number);
            bankAt[(y + halfY) * width + (x + halfX)] = spot;
        });
        // The ORDINARY cell's key — the inherited column carrying only the
        // unlimited ground supply (the materializer's per-cell loop sets
        // exactly these on a special-less cell): computed once per grid,
        // through the SAME shared builder the materializer runs
        const baseDraft = fineCellDraft(parent, {});
        const baseKey = tileSurfaceKey({
            biome: baseDraft.biome,
            resources: baseDraft.resources,
            voxels: baseDraft.voxels,
        });
        // Special cells share keys by SHAPE (same deposit record + tree/
        // crown/gravel flags + blend look ⇒ same surface key) —
        // tileSurfaceKey runs once per distinct signature, not once per cell
        const specialKeys = new Map<string, string | undefined>();
        // R1 — the water fine cells share keys by COLUMN SHAPE (the
        // same water depth + lending basin ⇒ the same sea-shaped column) —
        // the materializer's fineWaterColumn + tileSurfaceKey run once per
        // distinct signature, mirroring specialKeys above
        const waterKeys = new Map<string, string | undefined>();
        // T3 — the synthesized banks share keys by SURFACE (the same sand or
        // grass bank ⇒ the same raised column) — the materializer's
        // riverBankColumn + tileSurfaceKey run once per distinct shape,
        // mirroring waterKeys above
        const bankKeys = new Map<string, string | undefined>();
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
            // R1 — THE WATER first: a masked water fine cell is REAL
            // water (the materializer rebuilds it as the sea-shaped column of
            // fineWaterColumn — impassable, deposit-free), so its surface key
            // is its resolved water biome ('shallows' | 'ocean' | the basin's
            // or the river's own name), never the parent's land key. Checked
            // before every land flag: the scatter refuses water spots for
            // deposits, and the ordering makes the agreement with
            // generateSubCanvas structural, not lucky.
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
            // T3 — THE SYNTHESIZED BANK second: a river parent's dry fine
            // cell materializes the raised column (riverBankColumn — no water
            // voxel, its own ground supply), never the inherited ford column.
            // Checked before every land flag, exactly like the water branch:
            // the scatter refuses bank spots, so no deposit can land there.
            const bank = bankAt[index];
            if (bank) {
                const signature = bank.surface;
                if (!bankKeys.has(signature)) {
                    // The materializer's EXACT column slice for this shape —
                    // the same riverBankColumn call generateSubCanvas makes
                    const column = riverBankColumn(parent.waterLevel, bank);
                    bankKeys.set(
                        signature,
                        tileSurfaceKey({
                            biome: column.biome,
                            resources: column.resources,
                            voxels: column.voxels,
                        }),
                    );
                }
                bump(bankKeys.get(signature), index);
                continue;
            }
            const deposit = depositAt[index];
            const tree = treeAt[index] === 1;
            const crown = crownAt[index] === 1;
            const rock = rockAt[index] === 1;
            const look = landAt[index];
            if (!deposit && !tree && !crown && !rock && !look) {
                bump(baseKey, index);
                continue;
            }
            // The shape signature — deposit counts + the flags + the look
            const signature = `${TILE_RESOURCES.map((resource) => deposit?.[resource] ?? 0).join(
                ',',
            )}|${tree ? 1 : 0}${crown ? 1 : 0}${rock ? 1 : 0}|${look ?? ''}`;
            if (!specialKeys.has(signature)) {
                // The materializer's EXACT cell slice for this shape — the
                // same shared builder generateSubCanvas runs (deposit
                // spread, tree/crown units, the inherited column + gravel,
                // the unlimited ground, then the blend look's surface)
                const draft = fineCellDraft(parent, { deposit, tree, crown, rock, look });
                specialKeys.set(
                    signature,
                    tileSurfaceKey({
                        biome: draft.biome,
                        resources: draft.resources,
                        voxels: draft.voxels,
                    }),
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
