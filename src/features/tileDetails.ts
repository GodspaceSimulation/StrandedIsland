// Tile inspection logic — the pure, framework-free half of the Tile
// Inspector feature (tilePanel.tsx renders it).
//
// Clicking ANY canvas tile shows four layers of detail for its column:
//   terrain   — the voxel column itself (biome, height, walkability, stack)
//               plus the surface key the canvas paints it with (derived
//               from the tile's resource deposits — see
//               plugins/terrain/islandTerrain.ts tileSurfaceKey)
//   resources — the tile's resource DEPOSITS (wood, stone, iron and the
//               unlimited sand/dirt), the truth the canvas appearance and
//               the gatherable cell stock both hang off
//   ground    — what lies on the terrain (the inventory plugin's cell stock;
//               sea cells stock fish, so "what is on the terrain" covers
//               water tiles too)
//   occupants — who is there: EVERY living thing in the coordinate column
//               (world.coordinates), not just castaways. Actors are living
//               things in the broad sense — people, animals (birds), and
//               anything a future plugin coins (fish shoals, monsters) —
//               they all live in the same 3D spatial record with the
//               kind/type taxonomy facets ('sentient'/'human',
//               'creature'/'bird', …), so one column() query lists them all.
//               Grounded residents list before flyers (column() sorts by
//               ascending Z).

import type { TileResource, TileResources, VoxelKind } from '../engine/types';
import { TILE_RESOURCES, UNLIMITED_TILE_RESOURCES } from '../engine/types';
import type { IslandHandle } from '../scenario/island';
import type { CoordinateEntry } from '@godspace/core';
import { inventoryEntries } from '../plugins/inventory/inventory';
import { tileSurfaceKey } from '../plugins/terrain/islandTerrain';

// ── Voxel stack ──────────────────────────────────────────────────────────────

/** One run of identical voxels inside a column, bottom → top. */
export type VoxelRun = { kind: VoxelKind; count: number };

/**
 * Run-length groups the voxel stack so "stone, stone, stone, soil, grass"
 * reads as "stone ×3, soil, grass". Order stays bottom → top.
 */
export const voxelRuns = (voxels: VoxelKind[]): VoxelRun[] => {
    const runs: VoxelRun[] = [];
    // Walk the stack once, merging each voxel into the last run when equal
    voxels.forEach((kind) => {
        const last = runs[runs.length - 1];
        if (last && last.kind === kind) {
            last.count = last.count + 1;
        } else {
            runs.push({ kind, count: 1 });
        }
    });
    return runs;
};

/** Human readable voxel stack, bottom → top: "stone ×3, soil, grass". */
export const voxelSummary = (voxels: VoxelKind[]): string =>
    voxelRuns(voxels)
        .map((run) => (run.count > 1 ? `${run.kind} ×${run.count}` : run.kind))
        .join(', ');

// ── Occupants (all living things) ────────────────────────────────────────────

/** One resident of the inspected column, shaped for display. */
export type TileOccupant = {
    id: string;
    name: string;
    /** WHAT the resident is — kind facet from the coordinate record: 'sentient', 'creature', … */
    kind: string;
    /** WHICH the resident is — type facet (species/race): 'human', 'bird', … */
    type: string;
    /** Display state — condition for castaways, flying/perched for birds. */
    state: string;
    /** Z altitude — 0 = standing on the tile, >0 = above it (flyers). */
    z: number;
    /**
     * Actor registry id when this resident is a castaway (openable in the
     * full actor inspector). Birds and other non-registry residents stay
     * undefined — they are view-only here.
     */
    actorId: string | undefined;
};

/**
 * Every living thing in the vertical column (x, y), grounded first.
 * Reads straight from the world's coordinate space — the single position
 * registry ALL actors live in (castaways via world.spawn, birds and any
 * future creature via coordinates.place).
 */
export const tileOccupants = (island: IslandHandle, x: number, y: number): TileOccupant[] =>
    island.world.coordinates
        .column(x, y)
        .map((entry: CoordinateEntry): TileOccupant => {
            // Castaways also live in the actor registry — link them so the
            // inspector can open their full card from the tile
            const actor = island.world.actors.get(entry.id);
            return {
                id: entry.id,
                name: entry.name ?? entry.id,
                kind: entry.kind ?? 'unknown',
                // The race reads more specifically than the kind; a record
                // without a type falls back to its kind label
                type: entry.type ?? entry.kind ?? 'unknown',
                state: entry.state ?? '—',
                z: entry.position.z,
                actorId: actor ? actor.id : undefined,
            };
        });

/** One occupant display line: "Ael — human · well", "Kiki — bird · flying · z 2". */
export const occupantLine = (occupant: TileOccupant): string => {
    // Altitude only matters when the resident is off the ground plane
    const altitude = occupant.z > 0 ? ` · z ${occupant.z}` : '';
    // The race/type is the identifying label — 'human', not the generic kind
    return `${occupant.name} — ${occupant.type} · ${occupant.state}${altitude}`;
};

// ── Ground stock ─────────────────────────────────────────────────────────────

/** What lies on the terrain — the cell stock, non-zero stacks only. */
export const tileGround = (island: IslandHandle, x: number, y: number) =>
    inventoryEntries(island.inventory.cellStock(x, y));

// ── Tile resource deposits ───────────────────────────────────────────────────

/** One deposit on the inspected tile, shaped for display. */
export type TileResourceStack = {
    resource: TileResource;
    /** Deposit count (unlimited deposits keep a symbolic count of 1). */
    count: number;
    /** Whether the deposit can never be exhausted (sand, dirt). */
    unlimited: boolean;
};

/**
 * The tile's resource deposits, in TILE_RESOURCES order (wood, stone, iron,
 * sand, dirt). Deposits are what the tile APPEARS as on the canvas and what
 * its gatherable cell stock hangs off.
 */
export const tileResources = (resources?: TileResources): TileResourceStack[] =>
    TILE_RESOURCES.filter((resource) => (resources?.[resource] ?? 0) > 0).map((resource) => ({
        resource,
        count: resources?.[resource] ?? 0,
        unlimited: (UNLIMITED_TILE_RESOURCES as readonly string[]).includes(resource),
    }));

// ── Whole-tile summary ───────────────────────────────────────────────────────

/** Everything the Tile Inspector needs for one column, or null out of bounds. */
export type TileSummary = {
    x: number;
    y: number;
    biome: string;
    /**
     * The surface key the canvas paints the tile with — the tile's
     * top-priority deposit, falling back to the plain biome
     * (plugins/terrain/islandTerrain.ts tileSurfaceKey).
     */
    surface: string;
    /** Dry ground height in voxels. */
    height: number;
    /** Absolute water line of the canvas. */
    waterLevel: number;
    /** Whether a castaway could stand here (dry land only). */
    passable: boolean;
    /** The full voxel stack, bottom → top. */
    voxels: VoxelKind[];
    /** The tile's resource deposits (wood/stone/iron/sand/dirt). */
    resources: TileResourceStack[];
    /** Non-zero ground stock stacks. */
    ground: Array<{ item: string; count: number }>;
    /** All living things in the column, grounded first. */
    occupants: TileOccupant[];
};

/**
 * Assembles the full summary of one canvas tile. Out-of-bounds coordinates
 * resolve to null — the grid cannot produce them, but a stale selection
 * after a re-generated island could.
 */
export const tileSummary = (island: IslandHandle, x: number, y: number): TileSummary | null => {
    const cell = island.world.cellAt(x, y);
    if (!cell) {
        return null;
    }
    return {
        x: cell.x,
        y: cell.y,
        biome: cell.biome,
        surface: tileSurfaceKey(cell) ?? cell.biome,
        height: cell.height,
        waterLevel: cell.waterLevel,
        passable: cell.passable,
        voxels: cell.voxels,
        resources: tileResources(cell.resources),
        ground: tileGround(island, x, y),
        occupants: tileOccupants(island, x, y),
    };
};
