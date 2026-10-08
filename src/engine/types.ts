// Shared type vocabulary for the Stranded Island simulation.
//
// Terminology (kept stable across the whole codebase):
//   canvas   — the island itself: a grid of voxel columns (see TerrainCell)
//   actor    — one living resident of the canvas (see Actor): a two-level
//              taxonomy classifies every actor — `kind` is WHAT it is
//              ('creature' | 'sentient'), `type` is WHICH species/race it
//              is ('bird', 'dog', 'human', 'orc', 'elf', …)
//   position — a 3D coordinate record from @godspace/core (see Position3D):
//              the engine keeps every position in X, Y, Z space. Castaways
//              cannot fly or dig, so their Z is always GROUND_LEVEL (0);
//              seabirds (plugins/birds) travel the Z axis freely.
//   tick     — one beat of the world clock (engine/ticker.ts); each tick
//              represents a configurable amount of world time (minutes)

import type { Position3D } from '@godspace/core';

export { GROUND_LEVEL } from '@godspace/core';

// ── Voxel model ──────────────────────────────────────────────────────────────
// Each grid cell is a vertical column of voxels. `voxels[0]` is bedrock,
// the last entry is the surface voxel. Water columns fill up to `waterLevel`.

/**
 * All voxel materials the terrain generator can stack into a column.
 * `dirt` is the ground voxel (formerly named 'soil') — renamed so the voxel
 * name carries its resource identity: a column BUILT FROM dirt supplies the
 * dirt resource (the voxel-name → infinite-resource rule, see
 * plugins/terrain/islandTerrain.ts deposit seeding). The name contains the
 * resource token, which is what the supply rule matches on.
 *
 * `gravel` (formerly 'stone') is the ROCK TERRAIN — the highland's surface
 * and every column's bedrock underlayer. It is intentionally NOT a resource
 * token: ordinary gravel supplies NO stone (the finite-stone rule — the
 * stone resource comes only from the localized rock deposits the terrain
 * generator stamps on highland tiles and boulder-crowned fine cells,
 * plugins/terrain/islandTerrain.ts). A bare gravel column is ground, not ore.
 */
export type VoxelKind = 'air' | 'water' | 'sand' | 'dirt' | 'grass' | 'forest' | 'gravel';

/**
 * Biomes are derived from the surface voxel of a column.
 * ocean/shallows — column top is below the water line (the open sea)
 * beach          — surface is sand
 * meadow         — surface is grass
 * forest         — surface is grass with forest voxels on top
 * highland       — surface is gravel (the rock terrain — formerly 'stone')
 * lake/pond      — IMPASSABLE INTERIOR FRESH-WATER BASINS (R4): inset
 *                  lowland wetlands the generator drowns below the water
 *                  line (the seabed-sand + water column shape the sea
 *                  columns get). A basin is WATER — nothing walks, stands
 *                  or builds on it; land actors drink and fish from its DRY
 *                  SHORE ring (the behavior plugin's cardinal-adjacent
 *                  fishing shore), never by crossing the water. The sea
 *                  stays the only SALT water (the vessels' element — see
 *                  isSeaWater).
 */
export type Biome = 'ocean' | 'shallows' | 'beach' | 'meadow' | 'forest' | 'highland' | 'lake' | 'pond';
// (biome vocabulary note: 'highland' now derives from the 'gravel' surface
//  — formerly 'stone'; see the VoxelKind note above)

/**
 * Whether a biome is the open SALT sea — the vessels' element. The fresh
 * basins (lake/pond) are water too, but a hull built beside a landlocked
 * lake has no sea to launch into (the construction plugin's mooring +
 * launch read this, plugins/construction). Widened to string so cell
 * slices typed with a loose biome can consult it too.
 */
export const isSeaWater = (biome: string | undefined): boolean =>
    biome === 'ocean' || biome === 'shallows';

/**
 * Whether a biome is an interior fresh-water basin (the lake/pond family).
 * Widened to string like isSeaWater.
 */
export const isFreshBasin = (biome: string | undefined): boolean =>
    biome === 'lake' || biome === 'pond';

// ── Tile resources ───────────────────────────────────────────────────────────
// Every tile carries RESOURCE DEPOSITS — the natural features standing on it
// (trees in the forests, finite stone on the rock sites, iron lodes) PLUS
// the INFINITE GROUND SUPPLY derived from the tile's actual voxel column
// (see the seeding rule in plugins/terrain/islandTerrain.ts):
//
//   GROUND SUPPLY — every ground voxel material a dry column is actually
//   built from supplies its resource forever, at a symbolic count of 1
//   mirrored onto every fine cell: dirt voxels → dirt ×∞, grass voxels →
//   grass ×∞, sand voxels → sand ×∞. The match is by voxel NAME (the
//   resource token inside the name), not by biome. GRAVEL VOXELS CARRY NO
//   SUPPLY — ordinary gravel (the bedrock under everything + the highland
//   terrain) is NOT a resource token: the stone resource is FINITE and
//   localized (the rock deposits the generator stamps on highland tiles and
//   boulder-crowned fine cells), so stones as a material can really run out.
//   Takes are capacity-gated; the 'mine' ability gate limits WHO may take
//   stone/iron (plugins/inventory MINED_ITEMS).
//
// WOOD IS NOT A NATURAL RESOURCE — the standing deposit is the TREE (the
// greenery the canvas paints), a FINITE BIOLOGICAL stock. Wood is a
// PRODUCT: cutting wood off a tree (the lumber behaviour's chop task →
// inventory.harvest) yields wood into the actor's bag while the tree
// stands; a tree whose wood pool is chopped to 0 is felled away (the
// forest ecology regrows and spreads — plugins/forest).
//
// STONE stays a finite deposit (the highland/boulder rock sites — the
// generator's FINITE STONE GUARANTEE keeps every playable island stocked
// past the campaign's needs: the 1-stone axe + the 8-stone fort).
// IRON stays a finite lode deposit (the vein noise's rare landmark).

/** The resource kinds a tile can carry as a deposit. */
export type TileResource = 'tree' | 'stone' | 'iron' | 'sand' | 'dirt' | 'grass';

/** All tile resource kinds, in deposit-priority order (see tileSurfaceKey). */
export const TILE_RESOURCES: readonly TileResource[] = ['tree', 'stone', 'iron', 'sand', 'dirt', 'grass'];

/**
 * Unlimited resources — ground-supplied deposits that can never be
 * exhausted (you cannot dig the beach empty, quarry the bedrock away, or
 * strip the grass cover). Gathering them never decrements the tile's
 * deposit, so their tiles always appear as the resource they are made of.
 * Tree stays finite (a biological stand), iron stays finite (a lode).
 */
export const UNLIMITED_TILE_RESOURCES: readonly TileResource[] = ['grass', 'sand', 'dirt'];

/** Deposit counts per resource kind on one tile (absent = no deposit). */
export type TileResources = Partial<Record<TileResource, number>>;

/**
 * The NEIGHBORHOOD CARVE — the extra generation state a tile inherits from
 * its 8 neighbors (plugins/terrain/islandTerrain.ts neighborhood model:
 * resources generated within a tile are affected by all eight neighbors,
 * cardinals weighing double the diagonals). Present only on tiles whose
 * neighborhood shapes their zoomed interior beyond the deposit counts.
 */
export type TileCarving = {
     /**
      * Rock-spillover band — the fine spots ("x,y", centered sub-grid
      * coordinates) along this tile's highland edges that generation crowned
      * with a boulder: the zoomed interior stacks a gravel voxel on them
      * (the fine cell's TOP SURFACE reads as rock — the boulder crown's
      * gravel top carries a live stone deposit in the sub-grid mirror, the
      * finite-stone rule — observable, unlike the plain bedrock gravel every
      * column carries beneath its ground), and the stand seeding refuses
      * them (no tree stands on a boulder). Row-major order, deterministic.
      * Rock-spilled tiles only (highland edges never change after
      * generation, so the carve is stable for the tile's life).
      */
    rock: string[];
};

/** One voxel column of the canvas at grid position (x, y). */
export type TerrainCell = {
    /**
     * Column position in WORLD coordinates, centered: (0, 0) is the canvas
     * middle, values run −half … +half on both axes (odd grid sizes keep the
     * center exact). Storage is still row-major from the top-left corner.
     */
    x: number;
    y: number;
    /** Voxel stack, bottom → top. Length === height when dry; water fills above. */
    voxels: VoxelKind[];
    /** Solid ground height in voxel units (dry ground voxels). */
    height: number;
    /** Absolute water line for the whole canvas (voxel units). */
    waterLevel: number;
    /** Derived biome (from the topmost solid/liquid voxel). */
    biome: Biome;
    /** Whether an actor can stand on this cell (dry land only). */
    passable: boolean;
     /**
      * Resource deposits standing on this tile (see TileResources): the
      * voxel-derived INFINITE ground supply (grass/dirt/sand — symbolic
      * count 1, never depleted; gravel deliberately absent — it is the rock
      * terrain itself, not a carried resource), the FINITE biological tree
      * stand (its count mirrors the persistent fine-scale forest record,
      * plugins/forest), the FINITE stone stock (the localized rock sites —
      * the highland peaks + the generator's guarantee heap, drawn down by
      * mining; the 🪨 icon and the 'stone' surface key track it), and the
      * finite iron lodes. Empty for water columns; written by the terrain
      * generator, kept in sync by gathering + the forest ecology.
      */
    resources: TileResources;
    /**
     * The generator's NEIGHBORHOOD CARVE (see TileCarving) — the
     * 8-neighbor generation outcome that shapes this tile's zoomed interior
     * beyond its deposits. Optional: only rock-spilled tiles carry one.
     * Read by the terrain plugin's sub-grid generation and stamped into its
     * parent-change fingerprint (islandTerrain.ts fingerprintOf), so cached
     * sub-grids invalidate exactly when the carve is present or changes.
     */
    carving?: TileCarving;
};

/** The canvas: a width × height grid of voxel columns, row-major. */
export type Canvas = {
    /** Odd only — the centered coordinate system needs an exact (0, 0). */
    width: number;
    height: number;
    /**
     * Row-major storage: index = (y + halfHeight) * width + (x + halfWidth),
     * where half* = (dim − 1) / 2 — cell (x, y) carries CENTERED world
     * coordinates (see TerrainCell).
     */
    cells: TerrainCell[];
};

// ── Actors ───────────────────────────────────────────────────────────────────

/** Physical / life condition of an actor, derived from needs by the needs plugin. */
export type ActorCondition = 'well' | 'weak' | 'critical' | 'gone';

/**
 * WHAT an actor is — the top taxonomy level. 'creature' covers the
 * non-sentient fauna (seabirds, any animal a plugin coins); 'sentient'
 * covers the thinking races (humans, and any fantasy race — orc, elf, …).
 */
export type ActorKind = 'creature' | 'sentient';

/**
 * WHICH an actor is — the species/race within its kind. Creatures are
 * 'bird' | 'dog' | …; sentients are 'human' | 'orc' | 'elf' | …. Open on
 * purpose: 'human' is a race like any other ('person' would deny the
 * orcs and elves of a future plugin a name of their own).
 */
export type ActorType = string;

// ── Actor profile ────────────────────────────────────────────────────────────
// Stable personal facts carried beside the simulation state. The coordinate
// record's display facet carries the sex (engine/world.ts facetOf), so the
// representation plugins can draw it — the unicode canvas picks the gendered
// person emoji for humans.

/** Biological sex — the profile fact the god-view draws. */
export type Sex = 'male' | 'female';

/** The sex glyph badges — the inspector's profile line + future god-views. */
export const SEX_BADGES: Record<Sex, string> = {
    male: '♂', // U+2642 male sign
    female: '♀', // U+2640 female sign
};

/** Stable personal facts of one actor. */
export type ActorProfile = {
    sex: Sex;
};

/**
 * One living resident of the world. Position is a 3D coordinate — sentients
 * that cannot fly or dig keep Z at ground level (birds travel the Z axis).
 */
export type Actor = {
    id: string;
    name: string;
    /** WHAT the actor is — 'creature' | 'sentient' (see ActorKind). */
    kind: ActorKind;
    /** WHICH the actor is — species/race: 'human', 'bird', … (see ActorType). */
    type: ActorType;
    /** X, Y, Z position (Position3D from @godspace/core). Z is always 0. */
    position: Position3D;
    /** Short grid marker (1–2 letters) shown in the god-view. */
    marker: string;
    condition: ActorCondition;
    /** Stable personal facts (see ActorProfile) — the cast's sex, e.g. */
    profile: ActorProfile;
};

// ── World events ─────────────────────────────────────────────────────────────

/** One logged world happening (gathered berries, exchanged goods, moved, …). */
export type WorldEvent = {
    /** Monotonic sequence number assigned by the event bus. */
    id: number;
    /** Tick number the event happened on. */
    tick: number;
    /** Elapsed world minutes at the event. */
    time: number;
    /** Category tag, e.g. 'gather' | 'exchange' | 'move' | 'needs' | 'spawn'. */
    kind: string;
    /** Actor the event is about (when any). */
    actorId?: string;
    /** Human readable description for the god-view log. */
    message: string;
};
