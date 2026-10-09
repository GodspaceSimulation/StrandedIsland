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
//   footprintIsDry / footprintTouchesSeaWater — the two fine-scale gates the
//     scan applies to a candidate anchor's resolved footprint: every cell
//     dry land (mixed-shore safe), and for VESSELS at least one cell directly
//     beside NAVIGABLE fine water (biome shallows/ocean — isSeaWater, the
//     same salt rule the launch rechecks; a lake/pond fine cell is water but
//     never a mooring). A fine step OFF the tile's edge (the odd centered
//     sub-grids run −half … +half) crosses the COARSE boundary and resolves
//     through the ADJACENT tile's fine cell — the wrap the shared subtile
//     continuity rule (subTileStep) already defines, applied to terrain.

import { subTileStep, type TileCoord } from '@godspace/core';
import type { TerrainCell } from '../../engine/types';
import { isSeaWater } from '../../engine/types';

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
 */
export const footprintIsDry = (
    cells: Array<{ parent: { x: number; y: number }; x: number; y: number }>,
    resolve: FineTerrainResolver,
): boolean =>
    cells.every((cell) => {
        const terrain = resolve(cell.parent.x, cell.parent.y, cell.x, cell.y);
        return terrain === undefined || terrain.passable;
    });

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
