// THE FINE SITING HELPERS (T5 R2) — the Scale-0 half of the construction
// plugin's placement scan. The shared site registry resolves a footprint
// from a parent TILE + an ANCHOR fine cell; the island used to hardcode the
// anchor at (0,0) (every structure sat on the exact same fine center of its
// tile). These helpers let the scan SEARCH the tile's whole fine grid for a
// valid anchor instead:
//
//   spiralAnchors — the deterministic center-out search order (ring 0 first,
//     then each square ring clockwise from its top-left corner). Row-major
//     corner order would pin every structure to a tile corner; the spiral
//     keeps the legacy center when it is valid (stable placements the rest
//     of the campaign pins read) and moves OFF it the moment terrain,
//     occupancy or the vessel mooring demands — never a hardcoded center.
//
//   fineCellTerrain — resolves ONE fine cell's terrain through the terrain
//     plugin's existing cellFor path API ([{tile},{fine}], depth-1 grids).
//     The resolver is INJECTED (a pure function), so the helpers unit-test
//     against hand-built fine maps — including the mixed shores the terrain
//     worker will introduce (a land tile's fine cells partly turned to
//     water) — without standing a world up.
//
//   footprintIsDry / footprintIsClear / footprintTouchesSeaWater — the
//     fine-scale gates the scan applies to a candidate anchor's resolved
//     footprint: every cell dry land (mixed-shore safe, and NEVER water of
//     any kind — the river fine cell is passable but still water, the engine
//     vocabulary isWaterBiome), every cell free of a standing natural
//     obstruction (a tree, a boulder — footprintIsClear / fineCellObstructed),
//     and for VESSELS at least one cell directly beside NAVIGABLE fine water
//     (biome shallows/ocean — isSeaWater, the same salt rule the launch
//     rechecks; a lake/pond fine cell is water but never a mooring). A fine
//     step OFF the tile's edge (the odd centered sub-grids run −half … +half)
//     crosses the COARSE boundary and resolves through the ADJACENT tile's
//     fine cell — the wrap the shared subtile continuity rule (subTileStep)
//     already defines, applied to terrain.
//
// R1 (build validity) — THE FULL-FOOTPRINT CONTRACT: a structure may only
// stand on solid, UNOBSTRUCTED ground. The gates below are the single
// definition both placement paths share (the autonomous scan in
// constructionPlugin's placeOrAdvance AND the site registry's clearance
// hook, so a god-issued sites.place() is validated exactly like a planned
// one):
//   • DRY — the cell is walkable ground (engine/types isWalkableCell:
//     passable AND not a water biome). The river is the case that matters:
//     engine/types keeps `passable` TRUE on rivers (resource generation and
//     the thirst ladder still treat the course as open ground), so a bare
//     passable read would let a shelter be built in midstream. Building
//     reads the SHARED predicate, never its own water list.
//   • UNOBSTRUCTED — no standing TREE on the fine cell (resources.tree > 0:
//     the forest stand mirror, so a FELLED cell frees up — whole forests are
//     never banned, only the exact standing trunks), and no physical BOULDER
//     (the parent tile's carving.rock band at this fine spot). The band IS
//     the boulder: its gravel stack stands while the entry is listed, so a
//     mined crown still obstructs. A depleted rock TILE with no band entry
//     (the gravel bedrock alone) obstructs nothing, and a loose stone pile
//     is never in the band — neither blocks.
//   • REGISTRY — other buildings/sites are the site registry's own
//     occupancy/overlap rule (createSiteRegistry), plus the fine spot must
//     be free of grounded bodies (fineMovement.fineSpotTaken). Those checks
//     stay where they are; the helpers here only add the terrain/obstacle
//     half.

import { subTileStep, type TileCoord } from '@godspace/core';
import type { TerrainCell } from '../../engine/types';
import { isSeaWater, isWalkableCell } from '../../engine/types';

/** Resolves one COARSE tile's cell — the parent of a footprint's fine cells.
 * Injected by the caller (the construction plugin reads world.cellAt). Used
 * for the boulder band, which is a PARENT (carving) record, not a fine one. */
export type FineParentResolver = (tileX: number, tileY: number) => TerrainCell | undefined;

/** Resolves one fine cell's terrain — tile (tx,ty) fine (fx,fy) — or
 * undefined when the terrain cannot resolve it (no terrain plugin, a
 * depth-0 ladder, out of bounds). Injected by the caller. */
export type FineTerrainResolver = (
    tileX: number,
    tileY: number,
    fx: number,
    fy: number,
) => TerrainCell | undefined;

/**
 * The deterministic center-out anchor order over an odd centered grid:
 * ring 0 = (0,0); each ring r walks its perimeter clockwise starting at the
 * top-left corner (-r,-r) — top edge west→east, right edge north→south,
 * bottom edge east→west, left edge south→north. Anchors beyond the grid's
 * half dims drop out (a rectangular grid trims the square rings). The
 * search tries the whole fine grid — every anchor a candidate, none assumed.
 */
export const spiralAnchors = (halfX: number, halfY: number): TileCoord[] => {
    const anchors: TileCoord[] = [];
    anchors.push({ x: 0, y: 0 });
    const maxRing = Math.max(halfX, halfY);
    for (let ring = 1; ring <= maxRing; ring++) {
        // Top edge — y fixed at -ring, x walks west→east
        for (let x = -ring; x <= ring; x++) {
            if (Math.abs(x) <= halfX && ring <= halfY) {
                anchors.push({ x, y: -ring });
            }
        }
        // Right edge — x fixed at +ring, y walks north→south (top corner done)
        for (let y = -ring + 1; y <= ring; y++) {
            if (ring <= halfX && Math.abs(y) <= halfY) {
                anchors.push({ x: ring, y });
            }
        }
        // Bottom edge — y fixed at +ring, x walks east→west (corners done)
        for (let x = ring - 1; x >= -ring; x--) {
            if (Math.abs(x) <= halfX && ring <= halfY) {
                anchors.push({ x, y: ring });
            }
        }
        // Left edge — x fixed at -ring, y walks south→north (corners done)
        for (let y = ring - 1; y >= -ring + 1; y--) {
            if (ring <= halfX && Math.abs(y) <= halfY) {
                anchors.push({ x: -ring, y });
            }
        }
    }
    return anchors;
};

/**
 * Whether EVERY footprint cell stands on dry fine terrain. The cells are
 * the RESOLVED addresses (parent tile + fine coords — the site registry's
 * SiteCell shape). An unresolvable fine cell (no terrain plugin, depth-0
 * ladder) reads as dry — the pre-fine behavior, never a veto on ignorance.
 *
 * R1 — DRY MEANS DRY: a cell is valid only when engine/types' shared
 * isWalkableCell says so (passable AND not a water biome). The water half is
 * what closes the RIVER hole: engine/types keeps rivers passable (the
 * resource/thirst contract), so `passable` alone would build a shelter
 * midstream. A river fine cell is refused; a river tile's synthesized BANK
 * (dry beach/meadow ground) passes.
 */
export const footprintIsDry = (
    cells: Array<{ parent: { x: number; y: number }; x: number; y: number }>,
    resolve: FineTerrainResolver,
): boolean =>
    cells.every((cell) => {
        const terrain = resolve(cell.parent.x, cell.parent.y, cell.x, cell.y);
        // Ignorance never vetoes (the legacy terrainless world)
        return terrain === undefined || isWalkableCell(terrain);
    });

/**
 * Whether ONE footprint fine cell carries a standing natural obstruction —
 * a TREE or a BOULDER. The reads are deliberately PRECISE (per fine cell,
 * never per tile) so an ordinary clear spot inside a forest stays buildable
 * and only the exact standing trunk vetoes:
 *
 *   • TREE — the fine cell's own `resources.tree` counter (the forest
 *     stand's mirror in terrain/islandTerrain.ts subPrep/generateSubCanvas:
 *     one unit per standing trunk, the legacy seeded scatter when no stand
 *     exists). A felled trunk drops the counter, so the cell frees itself
 *     the moment the wood is taken — no stale veto.
 *   • BOULDER — the PARENT tile's `carving.rock` band (the rock-spillover
 *     fine spots the generator stamped, "x,y" strings). The band is the
 *     PHYSICAL boulder: the mine draws the crown's stone UNIT down (the
 *     visibleCrowns split in subPrep), but the gravel stack itself stands
 *     while the band lists the spot, so a mined-down crown still obstructs
 *     until the boulder is genuinely gone (no band entry → no veto). Loose
 *     stone piles are NOT boulders — they never appear in the band.
 *
 * An unresolvable fine cell (no terrain plugin) reads UNOBSTRUCTED — the
 * same never-veto-on-ignorance rule footprintIsDry keeps.
 */
export const fineCellObstructed = (
    cell: { parent: { x: number; y: number }; x: number; y: number },
    resolve: FineTerrainResolver,
    resolveParent: FineParentResolver,
): boolean => {
    const terrain = resolve(cell.parent.x, cell.parent.y, cell.x, cell.y);
    if (terrain !== undefined && (terrain.resources.tree ?? 0) > 0) {
        return true;
    }
    // The boulder band is a PARENT record — resolved per tile, then matched
    // against this fine cell's own (wrapped) coordinates
    const parent = resolveParent(cell.parent.x, cell.parent.y);
    const band = parent?.carving?.rock ?? [];
    return band.includes(`${cell.x},${cell.y}`);
};

/**
 * Whether EVERY footprint cell is free of standing trees and boulders
 * (fineCellObstructed). Skipped entirely by a caller with no terrain
 * resolver — the legacy terrainless world has no fine obstacles to read.
 */
export const footprintIsClear = (
    cells: Array<{ parent: { x: number; y: number }; x: number; y: number }>,
    resolve: FineTerrainResolver,
    resolveParent: FineParentResolver,
): boolean => cells.every((cell) => !fineCellObstructed(cell, resolve, resolveParent));

/**
 * Whether at least one footprint cell stands DIRECTLY BESIDE navigable fine
 * sea water: each cell's four fine neighbors are checked in a fixed
 * west/east/north/south order (deterministic), each neighbor resolved
 * through its own tile — a neighbor off the tile's edge wraps across the
 * COARSE boundary (the subtile continuity rule) and reads the ADJACENT
 * tile's fine cell. Sea water only (isSeaWater — ocean/shallows): a lake or
 * pond fine cell is water but never a mooring (the landlocked-launch
 * rejection, kept at fine scale).
 */
export const footprintTouchesSeaWater = (
    cells: Array<{ parent: { x: number; y: number }; x: number; y: number }>,
    resolve: FineTerrainResolver,
    grid: { width: number; height: number },
    inBounds: (x: number, y: number) => boolean,
): boolean => {
    // The fine neighbor offsets in the launch scan's order: west, east,
    // north, south (the same scan order launch() reads its coarse mooring in)
    const offsets: Array<[number, number]> = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
    ];
    for (const cell of cells) {
        for (const [dx, dy] of offsets) {
            // The fine step with the wrap — the crossing neighbor's fine
            // coords land INSIDE the neighboring tile's own sub-grid
            const step = subTileStep(grid.width, grid.height, cell.x, cell.y, dx, dy);
            const tileX = cell.parent.x + step.parent.dx;
            const tileY = cell.parent.y + step.parent.dy;
            if (!inBounds(tileX, tileY)) {
                continue;
            }
            const neighbor = resolve(tileX, tileY, step.x, step.y);
            if (neighbor !== undefined && !neighbor.passable && isSeaWater(neighbor.biome)) {
                return true;
            }
        }
    }
    return false;
};
