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

/** All voxel materials the terrain generator can stack into a column. */
export type VoxelKind = 'air' | 'water' | 'sand' | 'soil' | 'grass' | 'forest' | 'stone';

/**
 * Biomes are derived from the surface voxel of a column.
 * ocean/shallows — column top is below the water line
 * beach          — surface is sand
 * meadow         — surface is grass
 * forest         — surface is grass with forest voxels on top
 * highland       — surface is stone
 */
export type Biome = 'ocean' | 'shallows' | 'beach' | 'meadow' | 'forest' | 'highland';

// ── Tile resources ───────────────────────────────────────────────────────────
// Every tile carries RESOURCE DEPOSITS — the natural features standing on it
// (trees in the forests, ore veins in the highlands, sand on the beaches).
// Deposits are a property of the tile itself (written by the terrain
// generator, kept in sync with the inventory plugin's gatherable cell stocks)
// and they drive the tile's canvas appearance: a tile shows up as the
// resource it holds (see plugins/terrain/islandTerrain.ts tileSurfaceKey).
//
// WOOD IS NOT A NATURAL RESOURCE — the standing deposit is the TREE (the
// greenery the canvas paints). Wood is a PRODUCT: cutting a tree down
// (the lumber behaviour's chop task → inventory.harvest) yields wood into
// the actor's bag, and the felled tree leaves the tile until it regrows.

/** The resource kinds a tile can carry as a deposit. */
export type TileResource = 'tree' | 'stone' | 'iron' | 'sand' | 'dirt';

/** All tile resource kinds, in deposit-priority order (see tileSurfaceKey). */
export const TILE_RESOURCES: readonly TileResource[] = ['tree', 'stone', 'iron', 'sand', 'dirt'];

/**
 * Unlimited resources — deposits that can never be exhausted (you cannot
 * dig the beach empty). Gathering them never decrements the tile's deposit,
 * so their tiles always appear as the resource they are made of.
 */
export const UNLIMITED_TILE_RESOURCES: readonly TileResource[] = ['sand', 'dirt'];

/** Deposit counts per resource kind on one tile (absent = no deposit). */
export type TileResources = Partial<Record<TileResource, number>>;

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
     * Resource deposits standing on this tile (see TileResources). Empty for
     * water columns; seeded by the terrain generator, drawn down by
     * gathering (except unlimited resources — never depleted).
     */
    resources: TileResources;
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
