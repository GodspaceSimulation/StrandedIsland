// Tile inspection logic — the pure, framework-free half of the Tile
// Inspector feature (tilePanel.tsx renders it), generalized over the
// RECURSIVE TILE LADDER.
//
// An inspected tile is addressed by a TilePath (@godspace/core src/subtile):
// path[0] is an island tile (a cell of the island grid — the scale-1 view,
// the default), path[1] the subtile within it (a cell of that tile's
// sub-grid — the scale-0 view, the simulation ground where the entities
// move), and so on, arbitrarily deep. The tiling is recursive and a sub-grid
// has the SAME dimensions as its parent grid, so every zoom level is the
// same kind of board and every level's tiles are inspectable exactly like
// the root's — the same four layers of detail, resolved at any depth:
//   terrain   — the voxel column itself (biome, height, walkability, stack)
//               plus the surface key the canvas paints it with (derived
//               from the tile's resource deposits — see
//               plugins/terrain/islandTerrain.ts tileSurfaceKey). Cells at
//               any depth resolve through the terrain plugin's
//               canvasFor/cellFor (sub-grids generate deterministically
//               from their parent).
//   resources — the tile's resource DEPOSITS (wood, stone, iron and the
//               unlimited sand/dirt). At the island view these are the
//               tile's own; deeper they are the PARENT's deposits
//               distributed onto the subtiles (wood ×2 → two tree subtiles)
//               — the zoom reveals where the deposits stand.
//   ground    — what lies on the terrain. At the island view the inventory
//               plugin's cell stock; deeper, the parent's stock scatters
//               across the parent's sub-grid (one seeded spot per unit) and
//               the inspected subtile counts what landed on it —
//               recursively down the whole path.
//   occupants — who is there: EVERY living thing in the coordinate column
//               (world.coordinates), not just castaways. Deeper scales
//               filter by the entity's FINE position (world.subOf — where
//               it stands inside its parent tile's sub-grid), so castaways
//               and birds alike are inspectable inside the zoomed view.
// Grounded residents list before flyers (column() sorts by ascending Z).

// ── Ground stock — the granularity ladder ────────────────────────────────────
//
// Ground items carry a CATEGORY (plugins/inventory/items.ts), and the zoom
// scale reads the ground at ever-finer granularity down the ladder (the
// ladder counts UP from the interior ground — scale 0 the simulation
// ground, higher scales wider):
//   island view (a length-1 path; scale 1 on this engine) — the tile's
//             stock generalizes into its CATEGORIES ("Foods"), listed in
//             the Tile Inspector; the items themselves are not canvas
//             objects here. Every wider view above the island stays at
//             this coarsest level — the category is the top of the item
//             ladder.
//   scale 0  — the items list by NAME ("1 Berry") in the subtile's inspector
//             AND draw as canvas objects at their subtile positions
//             (scaleView below scatters them with the same seeded streams).
//   deeper   — each unit shows WHERE it stands (canvas objects at exact
//             spots); the parent subtile lists them by name.
// Tile-resource items (wood/stone/iron/sand/dirt) are skipped from every
// DEEPER list and scatter: their gatherable stock IS their deposit, and the
// deposit units stand as the subtile surfaces the terrain generator
// distributed — drawing them again would double every tree. The island
// view's category aggregation INCLUDES them (their gatherable stock is
// still "on the ground" at the island view — Sand reads as a Material).

import type { CoordinateEntry, TilePath } from '@godspace/core';
import { randomKeyed, tilePathKey, tilePathParent, tilePathTail } from '@godspace/core';
import type { Canvas, TileResource, TileResources, VoxelKind } from '../engine/types';
import { TILE_RESOURCES, UNLIMITED_TILE_RESOURCES } from '../engine/types';
import type { IslandHandle } from '../scenario/island';
import { inventoryEntries } from '../plugins/inventory/inventory';
import {
    inventoryCategories,
    itemDef,
    type ItemCategoryStack,
} from '../plugins/inventory/items';
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

/** One resident of the inspected tile, shaped for display. */
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
 * Every living thing at the addressed tile, grounded first. At the island
 * view (a length-1 path) that is the whole coordinate column; deeper, the
 * column filters down to the entities whose FINE position (world.subOf —
 * where they stand inside the parent tile's sub-grid) matches the inspected
 * subtile. Reads straight from the world's coordinate space — the single
 * position registry ALL actors live in (castaways via world.spawn, birds
 * and any future creature via coordinates.place).
 */
export const tileOccupants = (island: IslandHandle, path: TilePath): TileOccupant[] => {
    const root = path[0];
    const tail = tilePathTail(path) as { x: number; y: number };
    return island.world.coordinates
        .column(root.x, root.y)
        .filter((entry: CoordinateEntry) => {
            if (path.length === 1) {
                return true;
            }
            // The inspected subtile holds only the residents standing at
            // that fine spot inside the parent tile's sub-grid
            const sub = island.world.subOf(entry.id);
            return !!sub && sub.x === tail.x && sub.y === tail.y;
        })
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
};

/** One occupant display line: "Ael — human · well", "Kiki — bird · flying · z 2". */
export const occupantLine = (occupant: TileOccupant): string => {
    // Altitude only matters when the resident is off the ground plane
    const altitude = occupant.z > 0 ? ` · z ${occupant.z}` : '';
    // The race/type is the identifying label — 'human', not the generic kind
    return `${occupant.name} — ${occupant.type} · ${occupant.state}${altitude}`;
};

// ── Ground stock ─────────────────────────────────────────────────────────────

/** One item stack of a ground stock ("1 Berry" — the item-level read). */
export type GroundStack = { item: string; count: number };

/**
 * What lies on the terrain at the addressed tile — AT THE INSPECTED
 * GRANULARITY. The island view (a length-1 path) generalizes the tile's
 * live stock into its item CATEGORIES ("Foods ×2" — the coarsest read;
 * every wider view above the island stays here); deeper scales list the
 * items by NAME: the parent's ground scatters across the parent's sub-grid
 * — one seeded spot per unit, per item — and the inspected subtile counts
 * what landed on it, recursing down the whole path so gathering at the
 * island view flows into every zoomed view.
 */
export const tileGround = (
    island: IslandHandle,
    path: TilePath,
): Array<ItemCategoryStack | GroundStack> => {
    if (path.length === 1) {
        // The island view: the generalization — categories, not items
        return inventoryCategories(island.inventory.cellStock(path[0].x, path[0].y));
    }
    return groundStacksAt(island, path);
};

/**
 * The item-name stacks of a ground stock (the finer read). The island tile
 * returns the live stock with the tile-resource mirrors REMOVED (their units
 * stand as the subtile deposits — the scatter and the canvas objects must
 * never double them); deeper paths recurse: the parent's stacks scatter
 * across the parent's sub-grid and the inspected subtile counts its
 * landings.
 */
const groundStacksAt = (island: IslandHandle, path: TilePath): GroundStack[] => {
    if (path.length === 1) {
        return inventoryEntries(island.inventory.cellStock(path[0].x, path[0].y)).filter(
            (stack) => !(TILE_RESOURCES as readonly string[]).includes(stack.item),
        );
    }
    const parentPath = tilePathParent(path);
    const tail = tilePathTail(path) as { x: number; y: number };
    const parentGround = groundStacksAt(island, parentPath);
    // The scatter range is the SUB-GRID's range — the parent grid's dims
    // (the recursion rule: every level has the root grid's dimensions)
    const grid = island.world.canvas;
    const halfX = (grid.width - 1) / 2;
    const halfY = (grid.height - 1) / 2;
    const counts: Record<string, number> = {};
    parentGround.forEach((stack) => {
        // One stream per (item, parent address): the same item always
        // scatters to the same spots, so the derived ground is stable
        const stream = randomKeyed(
            island.world.seed,
            `subground:${tilePathKey(parentPath)}:${stack.item}`,
        );
        for (let unit = 0; unit < stack.count; unit++) {
            const x = Math.floor(stream() * grid.width) - halfX;
            const y = Math.floor(stream() * grid.height) - halfY;
            if (x === tail.x && y === tail.y) {
                counts[stack.item] = (counts[stack.item] ?? 0) + 1;
            }
        }
    });
    return inventoryEntries(counts);
};

/**
 * The ground items VISIBLE in the board at `viewPath` — one record per unit
 * with its position ON THE BOARD. The scatter uses the same seeded streams
 * the groundStacksAt derivation reads, so the canvas objects and every Tile
 * Inspector list always agree: the unit landing at subtile S in the
 * inspector's derivation stands at exactly S on the board.
 */
const boardGroundUnits = (
    island: IslandHandle,
    viewPath: TilePath,
): Array<{ item: string; x: number; y: number }> => {
    const grid = island.world.canvas;
    const halfX = (grid.width - 1) / 2;
    const halfY = (grid.height - 1) / 2;
    const units: Array<{ item: string; x: number; y: number }> = [];
    groundStacksAt(island, viewPath).forEach((stack) => {
        const stream = randomKeyed(
            island.world.seed,
            `subground:${tilePathKey(viewPath)}:${stack.item}`,
        );
        for (let unit = 0; unit < stack.count; unit++) {
            units.push({
                item: stack.item,
                x: Math.floor(stream() * grid.width) - halfX,
                y: Math.floor(stream() * grid.height) - halfY,
            });
        }
    });
    return units;
};

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

/** Everything the Tile Inspector needs for one addressed tile, or null out of bounds. */
export type TileSummary = {
    /** The full tile address down the recursive ladder. */
    path: TilePath;
    /** The tile's own (tail) coordinates within its grid. */
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
    /**
     * The ground stock AT THE INSPECTED GRANULARITY: category aggregates
     * ("Foods ×2") at the island view (a length-1 path — every wider view
     * above it stays this coarse) — and item-name stacks ("1 Berry") in the
     * interior views. TilePanel renders the two shapes apart (categories as
     * "Label ×count", stacks via itemLabel).
     */
    ground: Array<ItemCategoryStack | GroundStack>;
    /** All living things in the column, grounded first. */
    occupants: TileOccupant[];
};

/**
 * Assembles the full summary of one addressed tile. Out-of-bounds addresses
 * resolve to null — the grid cannot produce them, but a stale selection
 * after a re-generated island could.
 */
export const tileSummary = (island: IslandHandle, path: TilePath): TileSummary | null => {
    if (path.length === 0) {
        return null;
    }
    // The terrain plugin resolves the tile through the recursive sub-grids
    // (the root cell for a length-1 path, the generated subtile deeper)
    const cell = island.terrain.cellFor(path);
    if (!cell) {
        return null;
    }
    return {
        path: [...path],
        x: cell.x,
        y: cell.y,
        biome: cell.biome,
        surface: tileSurfaceKey(cell) ?? cell.biome,
        height: cell.height,
        waterLevel: cell.waterLevel,
        passable: cell.passable,
        voxels: cell.voxels,
        resources: tileResources(cell.resources),
        ground: tileGround(island, path),
        occupants: tileOccupants(island, path),
    };
};

// ── The scale view slice ─────────────────────────────────────────────────────

/**
 * A structural world slice for ONE zoom level — what the @godspace/canvas
 * frame builders render for the view at `viewPath` (empty path = the root
 * island view, length 1 = the sub-grid of that tile, …). The canvas is the
 * terrain plugin's grid at that depth (same dimensions at every level —
 * the recursion rule); the coordinates are the view's residents: at the
 * root the live world coordinate space, deeper the entities rooted at the
 * view's parent tile positioned at their FINE spots (world.subOf), so the
 * zoomed board shows exactly who stands where.
 *
 * Fine positions exist one level deep (each entity carries one sub spot);
 * views of depth ≥ 2 hold their residents at the subtile's heart — deeper
 * fine refinement is an engine extension for when content needs it. The
 * island's ladder (scenario/island.ts) currently reaches depth 1.
 */
export type ViewSlice = {
    canvas: Canvas;
    coordinates: { all(): CoordinateEntry[] };
};

export const scaleView = (island: IslandHandle, viewPath: TilePath): ViewSlice | null => {
    const canvas = island.terrain.canvasFor(viewPath);
    if (!canvas) {
        return null;
    }
    if (viewPath.length === 0) {
        // The root view binds the LIVE world slice — the same slice the
        // canvas plugins captured at setup
        return { canvas, coordinates: island.world.coordinates };
    }
    const parent = viewPath[viewPath.length - 1];
    // Residents of the parent tile's sub-grid: every coordinate resident
    // rooted at the parent tile, drawn at its fine spot (or the subtile's
    // heart for views two+ levels down — see the note above)
    const deep = viewPath.length >= 2;
    const entries = island.world.coordinates
        .all()
        .filter((entry) => entry.position.x === parent.x && entry.position.y === parent.y)
        .filter((entry) => {
            if (!deep) {
                return true;
            }
            const sub = island.world.subOf(entry.id);
            const upper = viewPath[viewPath.length - 2];
            return !!sub && sub.x === upper.x && sub.y === upper.y;
        })
        .map((entry) => {
            const sub = island.world.subOf(entry.id);
            return {
                ...entry,
                position: {
                    x: deep || !sub ? 0 : sub.x,
                    y: deep || !sub ? 0 : sub.y,
                    z: entry.position.z,
                },
            };
        });
    // The ground items become CANVAS OBJECTS at every zoomed scale — each
    // unit stands at its scattered subtile (the same streams the Tile
    // Inspector's ground derivation reads, so lists and objects agree).
    // At the island view they stay list-only (the granularity ladder), so
    // the root slice above carries no ground entries.
    boardGroundUnits(island, viewPath).forEach((unit, index) => {
        entries.push({
            id: `ground:${unit.item}:${index}`,
            position: { x: unit.x, y: unit.y, z: 0 },
            // A ground item is a thing of its own kind ('item' — engines may
            // coin kinds beyond creature/sentient) typed with the item id;
            // the canvases resolve its emoji through the type map the
            // scenario extends with ITEM_TYPE_GLYPHS
            kind: 'item',
            type: unit.item,
            name: itemDef(unit.item).name,
        });
    });
    return { canvas, coordinates: { all: () => entries } };
};
