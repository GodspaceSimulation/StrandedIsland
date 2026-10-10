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
//   resources — the tile's resource deposits: the voxel-derived INFINITE
//               ground supply (grass/dirt/sand/stone — symbolic counts,
//               mirrored onto every fine cell), the FINITE biological tree
//               stand (its count mirrors the persistent fine-scale forest
//               records), and the finite iron lodes. At the island view
//               these are the tile's own; deeper they are the PARENT's
//               deposits distributed onto the subtiles — the zoom reveals
//               where they stand (trees at their persistent positions).
//   forest    — the tree WOOD stats (plugins/forest): at the island view
//               the tile's stand summary (trees + total standing wood);
//               at the scale-0 view the tree card standing exactly on the
//               inspected fine spot (wood pool, age, maturity) when one
//               stands there.
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
// Tile-resource items (tree/stone/iron/sand/dirt/grass) are skipped from
// every DEEPER list and scatter: their gatherable stock IS their deposit,
// and the deposit units stand as the subtile surfaces the terrain
// distributed (the trees at their persistent stand positions) — drawing
// them again would double every tree. The island view's category
// aggregation INCLUDES them (their gatherable stock is still "on the
// ground" at the island view — Sand reads as a Material).

import type { CoordinateEntry, TilePath } from '@godspace/core';
import { NEIGHBOR_OFFSETS, randomKeyed, tilePathKey, tilePathParent, tilePathTail } from '@godspace/core';
import type { Canvas, TerrainCell, TileResource, TileResources, VoxelKind } from '../engine/types';
import { TILE_RESOURCES, UNLIMITED_TILE_RESOURCES } from '../engine/types';
import type { IslandHandle } from '../scenario/island';
import type { ForestTreeInfo } from '../plugins/forest/forestPlugin';
import { inventoryEntries } from '../plugins/inventory/inventory';
import {
    inventoryCategories,
    itemDef,
    type ItemCategoryStack,
} from '../plugins/inventory/items';
import { tileSurfaceKey, type SurfaceKeyCount } from '../plugins/terrain/islandTerrain';
import type { SiteCell, SiteState } from '@godspace/blueprint';
import type { SectionView } from '../plugins/construction/constructionPlugin';
// R5 — the farm plot card (type-only: the farming plugin's public view
// shape; the scenario handle carries the plugin instance)
import type { FarmPlotView } from '../plugins/farming/farmingPlugin';
// T4 — the standing bush's fruit card + the fishing net's catch card
// (type-only: the inventory plugin's and the fishing plugin's public view
// shapes; the scenario handle carries the plugin instances)
import type { BushView } from '../plugins/inventory/inventoryPlugin';
import type { FishingNetView } from '../plugins/fishing/fishingPlugin';

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
 * The tile's resource deposits, in TILE_RESOURCES order (tree, stone, iron,
 * sand, dirt). Deposits are what the tile APPEARS as on the canvas and what
 * its gatherable cell stock hangs off.
 */
export const tileResources = (resources?: TileResources): TileResourceStack[] =>
    TILE_RESOURCES.filter((resource) => (resources?.[resource] ?? 0) > 0).map((resource) => ({
        resource,
        count: resources?.[resource] ?? 0,
        unlimited: (UNLIMITED_TILE_RESOURCES as readonly string[]).includes(resource),
    }));

// ── Forest — the tree wood stats ─────────────────────────────────────────────

/**
 * The FOREST layer of an inspected tile — the tree wood stats the
 * plugins/forest ecology carries (plugins/forest/forestPlugin.ts). Two
 * shapes:
 *   the stand summary (island view) — standing trees + total wood, no card;
 *   the tree card (scale 0) — the tree standing exactly on the inspected
 *     fine spot: wood pool, age, maturity — the "selectable tree" stats
 *     (the tile-forest-tree test id marks the card).
 */
export type TileForest = {
    /** Standing trees in view (the tile's stand, or the one carded tree). */
    trees: number;
    /** Total standing wood in view. */
    wood: number;
    /** The tree card — present only at the scale-0 view of a treed spot. */
    tree?: ForestTreeInfo;
};

/** Reads the forest layer of an inspected tile (undefined: no forest view). */
export const tileForest = (island: IslandHandle, path: TilePath): TileForest | undefined => {
    const forest = island.forest;
    const parent = path[0];
    if (!forest || !parent) {
        return undefined;
    }
    if (path.length === 1) {
        // The island view: the tile's stand summary (trees + total wood)
        const stand = forest.standOf(parent);
        return stand ? { trees: stand.trees, wood: stand.wood } : undefined;
    }
    if (path.length === 2) {
        // Scale 0: the tree standing exactly on the inspected fine spot
        const tail = tilePathTail(path) as { x: number; y: number };
        const tree = forest.treeAt(parent, tail);
        return tree ? { trees: 1, wood: tree.wood, tree } : undefined;
    }
    return undefined;
};

// ── Forest display lines — the human reads (tilePanel.tsx renders them) ─────

/**
 * One island year in world minutes — the tree card's age reads in years
 * (the ecology's biological time unit, plugins/forest: 1440-minute days ×
 * 365). One decimal keeps a young stand readable without float noise.
 */
export const YEAR_MINUTES = 1440 * 365;

/** Count with its singular/plural noun: "1 tree", "3 trees". */
const countNoun = (count: number, noun: string): string =>
    `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The stand summary line: "425 trees · 1688 wood standing". The tree
 * count singularizes at exactly one — a single tree in view reads
 * "1 tree" (scale 0, or a stand thinned to one) — while plural stands
 * keep "trees" untouched (the whole-stand summary behavior).
 */
export const forestStandLine = (forest: TileForest): string =>
    `${countNoun(forest.trees, 'tree')} · ${forest.wood} wood standing`;

/**
 * The tree card line (scale 0 only): " · age 3.2 y · growing". The card's
 * wood pool is NOT repeated here — tileForest (above) sets the view's wood
 * to the card's pool at scale 0, so the stand line already reads it
 * ("1 tree · 3 wood standing"); repeating "wood N" after "N wood standing"
 * was the duplication. The card adds only what the stand line lacks: the
 * age in years and the maturity state. Island views carry no card and read
 * as the empty string.
 */
export const forestTreeLine = (forest: TileForest): string => {
    const card = forest.tree;
    if (!card) {
        return '';
    }
    // Years to one decimal (deterministic rounding — the card is inspectable)
    const years = Math.round((card.ageMinutes / YEAR_MINUTES) * 10) / 10;
    return ` · age ${years} y · ${card.mature ? 'mature' : 'growing'}`;
};

// ── Structures — the construction sites' footprints ──────────────────────────

/**
 * One construction site touching the inspected address (the construction
 * plugin's sites, plugins/construction). NOT a living entity: structures
 * never enter the needs sweep or the roster — they are the tile's built
 * vocabulary, listed here and drawn on the boards (see scaleView).
 */
export type TileStructure = {
    /** The site's registry id ("s-1", …). */
    siteId: string;
    /** The blueprint the site builds. */
    blueprintId: string;
    /** Display label ("Shelter"). */
    label: string;
    /** The site's lifecycle state. */
    state: SiteState;
    /** Whether the inspected address IS the site's walkable gate cell. */
    gate: boolean;
    /** Construction minutes accrued. */
    workDone: number;
    /** The blueprint's total work cost. */
    workTotal: number;
    /** The staging ledger per requirement line (requirement order). */
    staged: Array<{ item: string; have: number; need: number }>;
    /**
     * R3/R4 — the material anatomy of a BUILT structure: its tier sections
     * with LIVE health (the wear clock applied), in definition order.
     * Undefined until the site completes (an unbuilt site has no sections
     * to inspect — the staging ledger above is its anatomy meanwhile).
     */
    sections?: SectionView[];
};

/**
 * Whether a footprint covers the inspected address — the TILE (a length-1
 * path: any cell of the footprint standing on the tile) or the exact FINE
 * SPOT (a length-2 path: parent tile + fine coordinates). Cancelled sites
 * free their cells and keep no footprint; deeper paths (length 3+) hold no
 * scale-0 sites.
 */
const siteCoversPath = (cells: SiteCell[] | undefined, path: TilePath): boolean => {
    if (!cells || cells.length === 0) {
        return false;
    }
    if (path.length === 1) {
        // The island view: the footprint touches the tile
        return cells.some(
            (cell) => cell.parent.length === 1 && cell.parent[0].x === path[0].x && cell.parent[0].y === path[0].y,
        );
    }
    if (path.length === 2) {
        // The interior view: the footprint covers the exact fine spot
        const upper = path[0];
        const tail = path[1];
        return cells.some(
            (cell) =>
                cell.parent.length === 1 &&
                cell.parent[0].x === upper.x &&
                cell.parent[0].y === upper.y &&
                cell.x === tail.x &&
                cell.y === tail.y,
        );
    }
    // Scale-0 sites live one parent level deep — nothing deeper
    return false;
};

/**
 * The construction sites at the inspected address, in placement order, with
 * their staging ledger and work progress read through the construction
 * plugin's shared @godspace/blueprint site registry. Empty before the
 * plugin mounts (no construction plugin, no structures).
 */
export const tileStructures = (island: IslandHandle, path: TilePath): TileStructure[] => {
    const sites = island.construction.sites;
    if (!sites) {
        return [];
    }
    const structures: TileStructure[] = [];
    sites.sites().forEach((site) => {
        if (site.state === 'cancelled') {
            return;
        }
        const cells = sites.cellsOf(site.id);
        if (!siteCoversPath(cells, path)) {
            return;
        }
        // The DISPLAY label reads the live definition (a removed definition
        // falls back to the blueprint id) — but the STAGING LEDGER and the
        // work total read the SITE's snapshots (`site.required` /
        // `site.cost`, taken at placement): a blueprint removed or redefined
        // mid-build never rewrites what an existing site was charged
        const definition = island.construction.blueprints.definitionOf(site.blueprintId);
        // The gate: the resolved FIRST definition cell — the walkable one
        // (the doorway/adjacency rule, plugins/construction)
        const gateCell = cells?.[0];
        const gate =
            !!gateCell &&
            (path.length === 1
                ? gateCell.parent.length === 1 &&
                  gateCell.parent[0].x === path[0].x &&
                  gateCell.parent[0].y === path[0].y
                : path.length === 2 &&
                  gateCell.parent.length === 1 &&
                  gateCell.parent[0].x === path[0].x &&
                  gateCell.parent[0].y === path[0].y &&
                  gateCell.x === path[1].x &&
                  gateCell.y === path[1].y);
        structures.push({
            siteId: site.id,
            blueprintId: site.blueprintId,
            label: definition?.label ?? site.blueprintId,
            state: site.state,
            gate,
            workDone: site.work,
            // THE SNAPSHOT COST — the site completes against what it was
            // charged at placement, not the live definition's work
            workTotal: site.cost,
            // THE SNAPSHOT REQUIREMENTS — the staging ledger an existing
            // site was placed with
            staged: site.required.map((line) => ({
                item: line.item,
                have: site.delivered[line.item] ?? 0,
                need: line.count,
            })),
            // R3/R4 — a BUILT structure's material anatomy (tiers + live
            // health, the construction plugin's section records); undefined
            // while the site is still staged/building
            sections: site.state === 'built' ? island.construction.sectionsOf(site.id) : undefined,
        });
    });
    return structures;
};

/**
 * Human readable structure line: "Shelter · building · wood 2/2 · work 3/10".
 * A BUILT structure reads its material ANATOMY instead of the spent staging
 * ledger: "Shelter · built · sections wood 100/100 + thatch 60/60 · work
 * 240/240" (R3/R4 — tier + live health per section).
 */
export const structureLine = (structure: TileStructure): string => {
    const parts = [structure.label, structure.state];
    if (structure.gate) {
        parts.push('gate');
    }
    if (structure.sections && structure.sections.length > 0) {
        // The sections carry the built structure's state — the staging
        // ledger below is history once the walls stand
        parts.push(
            `sections ${structure.sections
                .map((section) => `${section.tier} ${section.health}/${section.maxHealth}`)
                .join(' + ')}`,
        );
    } else {
        const staging = structure.staged
            .map((line) => `${line.item} ${line.have}/${line.need}`)
            .join(' · ');
        if (staging.length > 0) {
            parts.push(staging);
        }
    }
    parts.push(`work ${structure.workDone}/${structure.workTotal}`);
    return parts.join(' · ');
};

// ── Tile progress — the standing work bars (R6) ──────────────────────────────

/**
 * One standing job on a tile, shaped for the progress bars the boards and
 * the Tile Inspector draw (features/worldGrid.tsx, tilePanel.tsx):
 *   • the SHARED TILE WORK jobs — the tasks plugin's tile-work ledger
 *     (@godspace/core src/work): the chop/fell labor several entities
 *     contribute to, keyed `tileWorkKey(x, y, kind)`;
 *   • the construction SITES on the tile — their build work (`site.work`
 *     against the placement `site.cost` snapshot), skipped once 'built'
 *     (a finished structure wears its glyph, not a bar).
 * Deterministic: ledger insertion order first, then site placement order.
 */
export type TileProgress = {
    /** Display label — the work kind ('chop') or the blueprint id. */
    label: string;
    /** Work-minutes done. */
    done: number;
    /** Work-minutes required (always > 0). */
    total: number;
};

/**
 * Every standing job on the tile addressed by `path` — the labor the world
 * remembers. Empty when nothing is being worked (no ledger unit, no live
 * site footprint on the tile).
 *
 * R1 — THE ADDRESS DISCIPLINE (the bars must sit on the tile that owns the
 * work, at EVERY zoom level):
 *   • the tile-work LEDGER is keyed by the tile's ROOT coordinates — the
 *     plugins compose `tileWorkKey(actor.position.x, actor.position.y, kind)`
 *     and actor.position is the root (island) coordinate space. So the
 *     ledger read ALWAYS rides `path[0]`, the same rule tileSummary applies
 *     (a deeper view reads its parent tile's standing jobs — a fine-cell
 *     address is NOT a ledger key, and reading the ledger with fine
 *     coordinates once painted a root tile's bar onto whichever interior
 *     cell happened to share its numbers);
 *   • the construction SITES resolve through the FULL path — at the island
 *     view (length 1) any footprint cell on the tile, at the interior view
 *     (length 2) the exact fine spot the footprint covers (siteCoversPath).
 *
 * `read.tileJobs` (default true) gates the LEDGER half: the Tile Inspector
 * reads the tile's standing jobs at every zoom (the inspector's contract),
 * while the zoomed INTERIOR board passes false — a ledger job belongs to
 * the whole tile, and stamping it onto every fine cell of the interior view
 * would claim per-cell work the ledger never tracks there.
 */
export const tileProgress = (
    island: IslandHandle,
    path: TilePath,
    read?: { tileJobs?: boolean },
): TileProgress[] => {
    const progress: TileProgress[] = [];
    // The shared tile-work jobs — keyed by the ROOT tile (path[0]), never
    // by the view-local tail. The ledger keys are `tile:x,y:kind`, so the
    // tile's own units are exactly the ones whose key matches the composed
    // prefix (the same tileWorkKey the plugins open with)
    if ((read?.tileJobs ?? true) && path.length > 0) {
        const root = path[0];
        const prefix = `tile:${root.x},${root.y}:`;
        island.tasks.tileWork.all().forEach((unit) => {
            // Re-derive the tile part of the key — a unit belongs to this
            // tile iff stripping its kind suffix lands on `tile:x,y:`
            if (unit.key.startsWith(prefix) && unit.key.length > prefix.length) {
                progress.push({ label: unit.kind, done: unit.progress, total: unit.units });
            }
        });
    }
    // The construction sites covering the addressed spot — their build work
    // (the same snapshot structureLine renders; the FULL path resolves the
    // footprint, so the interior view reads only the sites standing on the
    // exact fine cell)
    tileStructures(island, path).forEach((structure) => {
        if (structure.state !== 'built' && structure.workTotal > 0) {
            progress.push({
                label: structure.blueprintId,
                done: structure.workDone,
                total: structure.workTotal,
            });
        }
    });
    return progress;
};

/** Human readable progress line: "chop 7/15", "shelter 120/240". */
export const progressLine = (progress: TileProgress): string =>
    `${progress.label} ${progress.done}/${progress.total}`;

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
     * The surface key the canvas paints the tile with — at a tile WITH
     * generated children that is the MAJORITY visible type of those
     * children (dominantVisibleType, see the rule above the helper); at a
     * leaf tile the tile's own key (deposits → ground → plain biome, see
     * plugins/terrain/islandTerrain.ts tileSurfaceKey). The inspector and
     * the board always agree.
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
    /** The tile's resource deposits (tree/stone/iron/sand/dirt/grass). */
    resources: TileResourceStack[];
    /**
     * The tree WOOD stats at the inspected view (plugins/forest): the
     * stand summary (trees + total standing wood) at the island view, the
     * inspected fine spot's tree card (wood pool, age, maturity) at scale
     * 0. Undefined when the tile holds no forest (or the ecology is
     * unmounted).
     */
    forest?: TileForest;
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
    /**
     * The construction sites at the addressed tile (plugins/construction —
     * the shared @godspace/blueprint site registry): site id, blueprint,
     * state, the walkable gate flag, the staging ledger and the work
     * progress. NOT living entities — structures never enter the needs
     * sweep; this is the tile's built vocabulary.
     */
    structures: TileStructure[];
    /**
     * The standing jobs on the tile (R6): the shared tile-work ledger units
     * (chop/fell labor several entities contribute to) plus the live site
     * build work — the progress bars' data (see tileProgress above).
     */
    work: TileProgress[];
    /**
     * R5 — the cultivated berry plot on this tile (plugins/farming): the
     * clock-derived stage, the fruiting minute, the harvest history and the
     * next yield. Plots are keyed to ROOT tile addresses, so the read rides
     * the path's first step — every zoom level of the same ground shows the
     * same plot. Undefined when no plot stands here (or farming unmounted).
     */
    farm?: FarmPlotView;
    /**
     * T4 — the standing BERRY BUSH on this tile (plugins/inventory): the
     * lazy fruit batch (berries ripe, the ceiling, the next-ripen minute).
     * Bushes are keyed to ROOT tile addresses (the plant registry), so the
     * read rides the path's first step — every zoom level of the same
     * ground shows the same plant, FULL OR PLUCKED BARE (the plant never
     * depletes — R4: the bush stays visible when its berries are gone).
     * Undefined when no bush stands here.
     */
    bush?: BushView;
    /**
     * T4 — the constructed FISHING NET on this tile (plugins/fishing): the
     * banked catch (stored against its cap) and the minutes to the next
     * banked fish. Nets are keyed to ROOT tile addresses, so the read rides
     * the path's first step — every zoom level agrees. Undefined when no
     * net stands here.
     */
    net?: FishingNetView;
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
        // R6 — the coarse view reads the children's majority (the leaf
        // tiles fall back to their own key inside the helper — the same
        // read the canvas adapters make, board and inspector agreeing)
        surface: dominantVisibleType(island, path) ?? tileSurfaceKey(cell) ?? cell.biome,
        height: cell.height,
        waterLevel: cell.waterLevel,
        passable: cell.passable,
        voxels: cell.voxels,
        resources: tileResources(cell.resources),
        forest: tileForest(island, path),
        ground: tileGround(island, path),
        occupants: tileOccupants(island, path),
        structures: tileStructures(island, path),
        // R6/R1 — the standing jobs: the tile-work ledger rides the ROOT
        // tile (path[0] — the ledger's key space), the site build work the
        // FULL path (the footprint resolves at the inspected granularity —
        // the same read the structures section above makes, so the Work
        // section and the Structures section agree on every zoom level)
        work: tileProgress(island, path),
        // R5 — the standing berry plot (the farming plugin's clock-derived
        // card): plots are keyed to ROOT tile addresses, so the read rides
        // path[0] — every zoom level of the same ground agrees with the
        // board's farm decoration (the scenario's decorationOfCell reads
        // the very same plotAt)
        farm: island.farming.plotAt(path[0].x, path[0].y),
        // T4 — the standing berry bush + the constructed fishing net (the
        // same root-addressed reads the boards/behavior use; the inspector
        // card exposes the bush's lazy fruit batch and the net's banked
        // catch at every zoom level)
        bush: island.inventory.bushView(path[0].x, path[0].y),
        net: island.fishing.netAt(path[0].x, path[0].y),
    };
};

/**
 * R5 — the farm plot's inspector line: the stage, the fruiting clock and
 * the harvest history. `now` is the elapsed world minute the read runs at
 * (the panel passes the live ticker), so the line never goes stale between
 * renders. Immature plots count the minutes off the fruiting line; a ripe
 * plot invites the pick and names the regrowth the next harvest starts.
 */
export const farmLine = (farm: FarmPlotView, now: number): string => {
    const stage =
        farm.stage === 'ripe'
            ? `ripe · pick now (+${farm.yieldPerHarvest} berries)`
            : `immature · fruits in ${Math.max(0, farm.matureAt - now)} min`;
    return `berry plot · ${stage} · ${farm.cycles} harvest${farm.cycles === 1 ? '' : 's'}`;
};

/**
 * T4 — the berry bush's inspector line: the standing plant's fruit batch
 * (the lazy count advanced at the read) and the ripening clock. A plucked
 * BARE bush still reads as the plant it is — "0/3 berries ripe" with the
 * minutes to the next berry — never as a vanished feature (R4: the bush
 * stays visible when depleted). A FULL bush reads "full" (no countdown —
 * the next pluck restarts the clock).
 */
export const bushLine = (bush: BushView, now: number): string => {
    const ripe = `${bush.fruits}/${bush.cap} ${bush.fruits === 1 ? 'berry' : 'berries'} ripe`;
    if (bush.fruits >= bush.cap) {
        return `berry bush · ${ripe} · full`;
    }
    return `berry bush · ${ripe} · next in ${Math.max(0, bush.nextRipeAt - now)} min`;
};

/**
 * T4 — the fishing net's inspector line: the banked catch against its
 * storage ceiling and the minutes to the next banked fish (the net view
 * carries the countdown already computed against the plugin's own read
 * clock, so no `now` argument is needed). An EMPTY net reads "0/3 fish
 * caught" with the banking countdown (the weir is working); a FULL net
 * reads "haul it" (the storage is finite — the source is not).
 */
export const netLine = (net: FishingNetView): string => {
    const banked = `${net.stored}/${net.cap} fish caught`;
    if (net.stored >= net.cap) {
        return `fishing net · ${banked} · haul it`;
    }
    return `fishing net · ${banked} · next in ${Math.max(0, net.minutesToNext)} min`;
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
    // The view's RESIDENT entries: at the island view (the root, an empty
    // path) the live world coordinate space itself; deeper, the entities
    // rooted at the view's parent tile drawn at their fine spots. The
    // structure entries (below) append onto this base.
    const parent = viewPath.length > 0 ? viewPath[viewPath.length - 1] : null;
    // Deeper views (two+ levels) hold their residents at the subtile's
    // heart — deeper fine refinement is an engine extension (the island's
    // ladder currently reaches depth 1)
    const deep = viewPath.length >= 2;
    const entries: CoordinateEntry[] =
        viewPath.length === 0
            ? // The island view: the LIVE world slice — the same entries the
              // canvas plugins captured at setup (copied onto the stack so
              // the structure entries can join it without touching the space)
              [...island.world.coordinates.all()]
            : island.world.coordinates
                  .all()
                  .filter((entry) => entry.position.x === parent!.x && entry.position.y === parent!.y)
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
    // the root slice carries no ground entries.
    if (viewPath.length > 0) {
        boardGroundUnits(island, viewPath).forEach((unit, index) => {
            entries.push({
                id: `ground:${unit.item}:${index}`,
                position: { x: unit.x, y: unit.y, z: 0 },
                // A ground item is a thing of its own kind ('item' — engines
                // may coin kinds beyond creature/sentient) typed with the
                // item id; the canvases resolve its emoji through the type
                // map the scenario extends with ITEM_TYPE_GLYPHS
                kind: 'item',
                type: unit.item,
                name: itemDef(unit.item).name,
            });
        });
    }
    // The construction sites join the board too — the STRUCTURE footprint
    // entries (plugins/construction). At the island view (the root, an
    // empty path) each live site draws ONE entry per tile it covers, at
    // the tile position; in the interior views (length 1) every live
    // site's fine cell ON the inspected parent tile draws at its exact
    // spot. Structures sit at z −1 — BENEATH the ground plane, so any
    // living body at the same spot draws on top of it (the glyph stack
    // sorts highest Z first). The canvases resolve the entries' TYPE (the
    // blueprint id) through the STRUCTURE_TYPE_GLYPHS palette the scenario
    // extends them with.
    const sites = island.construction.sites;
    if (sites && viewPath.length <= 1) {
        sites.sites().forEach((site) => {
            if (site.state === 'cancelled') {
                return;
            }
            const definition = island.construction.blueprints.definitionOf(site.blueprintId);
            const cells = (sites.cellsOf(site.id) ?? []).filter((cell) =>
                viewPath.length === 0
                    ? // The island view: every covered tile draws the site once
                      true
                    : // The interior view: the fine cells of the inspected tile
                      cell.parent.length === 1 &&
                      cell.parent[0].x === viewPath[0].x &&
                      cell.parent[0].y === viewPath[0].y,
            );
            const drawn = new Set<string>();
            cells.forEach((cell) => {
                const tileX = cell.parent[0]?.x ?? 0;
                const tileY = cell.parent[0]?.y ?? 0;
                const position =
                    viewPath.length === 0
                        ? { x: tileX, y: tileY, z: -1 }
                        : { x: cell.x, y: cell.y, z: -1 };
                const id =
                    viewPath.length === 0
                        ? `structure:${site.id}:${tileX},${tileY}`
                        : `structure:${site.id}:${cell.x},${cell.y}`;
                if (drawn.has(id)) {
                    return;
                }
                drawn.add(id);
                entries.push({
                    id,
                    position,
                    kind: 'structure',
                    type: site.blueprintId,
                    name: definition?.label ?? site.blueprintId,
                });
            });
        });
    }
    return { canvas, coordinates: { all: () => entries } };
};

// ── Tree icon opacity — the scale-1 readability rule ─────────────────────────

// At the ISLAND view (scale 1 — the ladder's top) the canvases decorate a
// tile with its standing tree icon whenever the tile carries ANY tree stock,
// regardless of how many subtles of the tile's sub-grid actually hold a
// tree. A tile with one tree among forty cells would read as fully wooded —
// the icon OVERSTATES the coverage. The scale-1 tree icon's opacity is
// therefore derived from the tile's TRUE scale-0 tree coverage: the ratio of
// the tile's standing tree UNITS (the fine cells a sub-grid would scatter
// them onto — its `resources.tree` deposit) to the tile's sub-grid CELL
// COUNT, clamped so the icon stays legible yet honest:
//
//   coverage  = treeUnits / subGridCells            (the true occupancy at
//                                                    scale 0 — 0.01 when
//                                                    1 of 100 cells woods)
//   opacity   = clamp(coverage / FULL_COVERAGE, MIN_OPACITY, 1)
//
//   • FULL_COVERAGE (0.9) — the coverage at which the icon reads as a FULL
//     forest (opacity 1). A sub-grid that woods 90 % of its cells is, for
//     the tile's color, indistinguishable from a full canopy; below it the
//     icon fades proportionally, so a sparse woodland shows a faint icon.
//   • MIN_OPACITY (0.5) — a floor: even a single tree among a hundred
//     cells still VISIBLY marks the tile (R2 — the woods must be findable
//     and a stocked tile must never read as bare grass), so the icon never
//     vanishes while trees stand.
//   • ZERO trees → no icon at all: the resolver returns undefined and the
//     view draws nothing (a clear-cut tile is bare — the same no-flood rule
//     the decorations carry).
//
// The SCALE-0 view (the tile interior) always draws its tree icons at FULL
// opacity: there every drawn sub-grid cell is a tree by construction (the
// sub-grid scatters exactly the deposited units onto one cell each), so
// the true coverage of what is on screen is 100 % — the fade would be a
// lie. features/worldGrid.tsx wires this into BOTH the Unicode (emoji
// opacity) and the SVG (group opacity) views at the island view only.
//
// The helper is PURE (two numbers in, an opacity out) so the rule — and
// its anchors — is testable without a world:
//   treeIconOpacity(1, 100)   → 0.5     (one tree / 100 cells → the floor)
//   treeIconOpacity(45, 100)  → 0.5     (45 % woods → half cover)
//   treeIconOpacity(90, 100)  → 1       (90 % woods → full cover)
//   treeIconOpacity(100, 100) → 1       (clamps at 1 — coverage > full)
//   treeIconOpacity(0, 100)   → undefined (no trees → no icon)

/** The tree coverage at which the scale-1 icon reads as a full forest (opacity 1). */
export const TREE_ICON_FULL_COVERAGE = 0.9;

/** The minimum scale-1 tree icon opacity — a stocked tile is ALWAYS visibly
 * marked. R2: the old 0.1 floor left a sparse stand (the meadow-ingress
 * fringe — a handful of trees among 425 cells) effectively invisible while
 * the lumber rung happily chopped it ("chop on grass with no tree"). Half
 * strength keeps the density fade honest (a lone tree reads fainter than a
 * full canopy) while staying clearly visible; the icon itself remains
 * stock-driven, so a treeless tile still draws NOTHING — the fade only ever
 * marks trees that actually stand (no blanket forest appearance). */
export const TREE_ICON_MIN_OPACITY = 0.5;

/**
 * The opacity the ISLAND view (scale 1) draws a tile's standing tree icon
 * at, from the tile's TRUE scale-0 tree coverage (its tree-units deposit
 * against its sub-grid cell count). See the rule above the constants.
 *
 * @returns the clamped opacity (TREE_ICON_MIN_OPACITY … 1), or `undefined`
 *          when the tile carries no tree stock (the caller draws no icon).
 */
export const treeIconOpacity = (treeUnits: number, subGridCells: number): number | undefined => {
    // No tree stock (or a degenerate zero-cell sub-grid) — no icon at all
    if (treeUnits <= 0 || subGridCells <= 0) {
        return undefined;
    }
    // The true coverage, normalized to the full-forest mark and clamped onto
    // the [MIN_OPACITY, 1] legibility window (coverage above full clamps to
    // 1 — the icon fades DOWN with sparseness, never up)
    const coverage = treeUnits / subGridCells;
    const opacity = coverage / TREE_ICON_FULL_COVERAGE;
    return Math.min(1, Math.max(TREE_ICON_MIN_OPACITY, opacity));
};

// ── Dominant visible type — the coarse-scale majority rule ───────────────────

/**
 * A tile's visible identity at a COARSE scale is what its children LOOK
 * like: the Scale-1 tile shows the MAJORITY visible type of its Scale-0
 * children (a mostly-wooded tile reads 'tree', a mostly-water tile reads
 * 'lake', a rock site whose crowns are a handful among dirt floors reads
 * 'dirt' — the 🪨 decoration keeps it findable), and a Scale-2 tile shows
 * the majority of its Scale-1 children — recursively down the generated
 * ladder. The rule:
 *
 *   dominantVisibleType(path) = the majority `tileSurfaceKey` over the
 *     IMMEDIATE CHILDREN of the tile at `path` — each child read as its
 *     OWN dominant type (recursive; a child with no generated sub-grid
 *     falls back to its own tileSurfaceKey), counted in CHILD CELLS (every
 *     child cell counts exactly once — resource units never outvote cells),
 *     ties resolved to the key that REACHED its winning count first in the
 *     row-major scan (the canvas scan order — deterministic; the strict
 *     `>` in the fold and the histogram's `last` index encode one rule).
 *
 * A pure RENDER-side read: the simulation keeps the parent's own identity
 * (deposits, stocks, surface key untouched) — only the canvas adapters and
 * the Tile Inspector consult this (scenario/island.ts surfaceOfCell applies
 * it to ROOT cells only — the identity check tells a root cell from a
 * zoomed subtile — and the zoomed views already show the true children
 * cell-for-cell, so they never need the majority).
 *
 * MEMOIZED per cell object against the cell's generation fingerprint — the
 * same stamp the terrain plugin caches its sub-grids with (fingerprintOf,
 * plugins/terrain/islandTerrain.ts: deposits + height + water line + biome
 * + voxels + carve; the sub-canvas is a deterministic function of exactly
 * that, the forest stands riding along through the tree-deposit mirror).
 * A frame re-reads every tile cheaply: unchanged cells answer from the
 * memo, changed ones (gathering, felling, spread) rebuild once.
 *
 * The fold itself is CACHED and SHORTCUTTED (the R6 depth-2 performance
 * fix — at configured depth 2 a naive recursive fold materialized 425
 * sub-grids per root and thrashed the FIFO grid cache):
 *   • the deepest generated level never materializes its grids — the
 *     children of a cell AT the generated depth are leaves, and their keys
 *     come from the terrain plugin's exact surfaceKeyCounts histogram
 *     (identical scatter, no cell objects — see plugins/terrain);
 *   • every intermediate node's answer rides a per-terrain-instance cache
 *     keyed by grid size + path + fingerprint stamp — the same
 *     invalidation contract as the memo above (the instance scoping keeps
 *     two worlds from sharing entries; the size catches a resize).
 * The result is bit-identical to the naive fold — the cache and histogram
 * only skip work the naive fold would redo.
 */
const dominantMemo = new WeakMap<object, { stamp: string; key: string | undefined }>();

/** The memo stamp — the fingerprintOf mirror (keep in step with
 * plugins/terrain/islandTerrain.ts fingerprintOf: same fields, same order —
 * R1's EDGE WEAVE added the EIGHT NEIGHBORS' water-class fragments last,
 * because the blend reads them and a cached fold must never outlive the
 * neighborhood it read). */
const dominantStamp = (cell: TerrainCell, canvas: Pick<Canvas, 'width' | 'height' | 'cells'>): string =>
    `${TILE_RESOURCES.map((resource) => cell.resources[resource] ?? 0).join(',')}|${cell.height}|${cell.waterLevel}|${cell.biome}|${cell.voxels.join('+')}|${cell.carving ? cell.carving.rock.join(';') : 'none'}|nb(${NEIGHBOR_OFFSETS.map((offset) => {
        const halfX = (canvas.width - 1) / 2;
        const halfY = (canvas.height - 1) / 2;
        const nx = cell.x + offset.dx;
        const ny = cell.y + offset.dy;
        if (ny < -halfY || ny > halfY || nx < -halfX || nx > halfX) {
            return 'rim';
        }
        const neighbor = canvas.cells[(ny + halfY) * canvas.width + (nx + halfX)];
        return neighbor ? `${neighbor.biome}${neighbor.passable ? 1 : 0}` : 'rim';
    }).join(',')})`;

/**
 * The intermediate-node cache, one Map per terrain plugin INSTANCE (a
 * WeakMap — the cache dies with the world). Keyed by
 * `size|pathKey|fingerprint`: the seed and stands ride the instance, the
 * grid shape rides the size, the parent's state rides the stamp — the same
 * determinism contract the terrain plugin caches its sub-grids with. A
 * `null` value caches a computed `undefined` (a leaf-less unresolvable
 * node) so misses are never recomputed either.
 */
const DOMINANT_PATH_CACHE = 4096;
const dominantPathCaches = new WeakMap<object, Map<string, string | null>>();

const dominantCacheFor = (terrain: object): Map<string, string | null> => {
    let cache = dominantPathCaches.get(terrain);
    if (!cache) {
        cache = new Map();
        dominantPathCaches.set(terrain, cache);
    }
    return cache;
};

/**
 * The majority of an exact histogram — reproducing the row-major strict-`>`
 * scan fold EXACTLY: the winner is the key with the highest count, ties
 * going to the key that REACHED that count first, i.e. the earliest LAST
 * occurrence in row-major order (a key hits its final count exactly at its
 * last cell — the scan's strict `>` keeps whoever got there first).
 */
const majorityFromCounts = (counts: SurfaceKeyCount[]): string | undefined => {
    let best: string | undefined;
    let bestCount = 0;
    let bestLast = Number.POSITIVE_INFINITY;
    counts.forEach((entry) => {
        if (entry.count > bestCount || (entry.count === bestCount && entry.last < bestLast)) {
            best = entry.key;
            bestCount = entry.count;
            bestLast = entry.last;
        }
    });
    return best;
};

/** The fold over one cell's children (the recursive majority — see the rule). */
const foldDominant = (
    island: Pick<IslandHandle, 'terrain'>,
    path: TilePath,
    cell: TerrainCell,
    cache: Map<string, string | null>,
    sizeKey: string,
    // The grid the cell sits in (its parent's grid) — the stamp reads the
    // cell's EIGHT in-grid neighbors off it (R1's blend inputs)
    canvas: Pick<Canvas, 'width' | 'height' | 'cells'>,
): string | undefined => {
    // The children of a cell AT the generated depth are leaves — their
    // surface keys histogram EXACTLY without materializing the grid (the
    // fold's fast path; beyond the depth no grid exists and the cell's own
    // key IS its visible type)
    if (path.length >= island.terrain.depth()) {
        const counts = island.terrain.surfaceKeyCounts(path);
        if (counts) {
            return majorityFromCounts(counts);
        }
        return tileSurfaceKey(cell);
    }
    // The immediate children's grid — beyond the generated depth there are
    // no children: the tile's own surface key IS its visible type
    const children = island.terrain.canvasFor(path);
    if (!children || children.cells.length === 0) {
        return tileSurfaceKey(cell);
    }
    // Majority over the children's visible types, counted in cells; the
    // strict `>` keeps the FIRST key on ties (row-major scan order)
    const counts = new Map<string, number>();
    let best: string | undefined;
    let bestCount = 0;
    children.cells.forEach((child) => {
        const key =
            dominantChild(island, [...path, { x: child.x, y: child.y }], child, cache, sizeKey, children) ??
            tileSurfaceKey(child);
        if (key === undefined) {
            return;
        }
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count > bestCount) {
            best = key;
            bestCount = count;
        }
    });
    return best;
};

/**
 * The cached dominant of a CHILD cell (an intermediate fold node). A child
 * deeper than the generated depth has no grid — the caller falls back to
 * the child's own surface key (the leaf rule).
 */
const dominantChild = (
    island: Pick<IslandHandle, 'terrain'>,
    childPath: TilePath,
    child: TerrainCell,
    cache: Map<string, string | null>,
    sizeKey: string,
    // The grid the child sits in (the caller's fold iterates it)
    canvas: Pick<Canvas, 'width' | 'height' | 'cells'>,
): string | undefined => {
    if (childPath.length > island.terrain.depth()) {
        return undefined;
    }
    const cacheKey = `${sizeKey}|${tilePathKey(childPath)}|${dominantStamp(child, canvas)}`;
    const hit = cache.get(cacheKey);
    if (hit !== undefined) {
        return hit ?? undefined;
    }
    const key = foldDominant(island, childPath, child, cache, sizeKey, canvas);
    cache.set(cacheKey, key ?? null);
    // FIFO eviction — the freshly inserted entry sorts last, the oldest
    // answers drop first (bounded memory; a miss only recomputes)
    while (cache.size > DOMINANT_PATH_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        cache.delete(oldest);
    }
    return key;
};

/**
 * The visible type the coarse view paints the tile at `path` with — the
 * majority of its children's visible types, recursively (see the rule
 * above). Undefined for empty paths and unresolvable addresses (the caller
 * falls back to the tile's own surface key).
 */
export const dominantVisibleType = (
    island: Pick<IslandHandle, 'terrain'>,
    path: TilePath,
): string | undefined => {
    if (path.length === 0) {
        return undefined;
    }
    const cell = island.terrain.cellFor(path);
    if (!cell) {
        return undefined;
    }
    // The stamp reads the cell's EIGHT in-grid neighbors off the grid the
    // cell sits in (its parent's grid — the root canvas for a length-1
    // path); R1's blend inputs ride it exactly as the terrain plugin's own
    // fingerprint does (the mirror rule)
    const canvas = island.terrain.canvasFor(path.slice(0, -1));
    if (!canvas) {
        return tileSurfaceKey(cell);
    }
    const stamp = dominantStamp(cell, canvas);
    const cached = dominantMemo.get(cell);
    if (cached && cached.stamp === stamp) {
        return cached.key;
    }
    // The grid size rides the intermediate cache key — a resize reshapes
    // every grid, so no cached answer may outlive the board it was folded
    // from (the terrain plugin clears its own grid cache on resize)
    const size = island.terrain.size();
    const key = foldDominant(
        island,
        path,
        cell,
        dominantCacheFor(island.terrain),
        `${size.width}x${size.height}`,
        canvas,
    );
    dominantMemo.set(cell, { stamp, key });
    return key;
};
