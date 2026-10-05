// Shared type vocabulary for the Stranded Island simulation.
//
// Terminology (kept stable across the whole codebase):
//   canvas   — the island itself: a grid of voxel columns (see TerrainCell)
//   actor    — one stranded person living on the canvas
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
    /** Solid ground height in voxel units (dry land part of the stack). */
    height: number;
    /** Absolute water line for the whole canvas (voxel units). */
    waterLevel: number;
    /** Derived biome (from the topmost solid/liquid voxel). */
    biome: Biome;
    /** Whether an actor can stand on this cell (dry land only). */
    passable: boolean;
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

/** One stranded person. Position is a 3D coordinate — Z stays at ground level. */
export type Actor = {
    id: string;
    name: string;
    /** X, Y, Z position (Position3D from @godspace/core). Z is always 0. */
    position: Position3D;
    /** Short grid marker (1–2 letters) shown in the god-view. */
    marker: string;
    condition: ActorCondition;
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
