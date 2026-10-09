// Unit tests for the fine siting helpers (plugins/construction/fineSiting.ts)
// — the Scale-0 half of the construction plugin's placement scan. The
// helpers are PURE (the terrain resolver is injected), so every pin here is
// a hand-built fine map: no world, no scheduler, exact expected values.
//
// The three contracts:
//   spiralAnchors — the deterministic center-out search order (ring 0 the
//     legacy center first, then each square ring clockwise from its top-left
//     corner, trimmed to the grid's half dims);
//   footprintIsDry — every footprint cell dry fine terrain (an
//     unresolvable cell reads dry — the pre-fine behavior, never a veto on
//     ignorance);
//   footprintTouchesSeaWater — at least one footprint cell stands directly
//     beside NAVIGABLE fine sea water (isSeaWater: ocean/shallows — a lake
//     or pond fine cell is water but never a mooring), with a fine step off
//     the tile's edge wrapping the COARSE boundary into the adjacent tile's
//     own sub-grid (the subtile continuity rule applied to terrain).

import { describe, it, expect } from 'vitest';
import {
    footprintIsDry,
    footprintTouchesSeaWater,
    spiralAnchors,
    type FineTerrainResolver,
} from './fineSiting';
import type { TerrainCell } from '../../engine/types';

/**
 * A hand-built fine world: the resolver reads terrain from a map keyed
 * "tileX,tileY:fineX,fineY". Unlisted addresses resolve to undefined (the
 * no-terrain case) unless a default is given.
 */
const fineWorld = (
    cells: Record<string, TerrainCell | undefined>,
    fallback?: TerrainCell,
): FineTerrainResolver => (tileX, tileY, fx, fy) => {
    const key = `${tileX},${tileY}:${fx},${fy}`;
    if (Object.prototype.hasOwnProperty.call(cells, key)) {
        return cells[key];
    }
    return fallback;
};

/** A dry land fine cell. */
const dryCell = (): TerrainCell => ({
    x: 0,
    y: 0,
    voxels: ['grass'],
    height: 4,
    waterLevel: 3,
    biome: 'meadow',
    passable: true,
    resources: {},
});

/** A water fine cell of the given biome (impassable — water never walks). */
const waterCell = (biome: 'ocean' | 'shallows' | 'lake' | 'pond'): TerrainCell => ({
    x: 0,
    y: 0,
    voxels: ['sand', 'water'],
    height: 2,
    waterLevel: 3,
    biome,
    passable: false,
    resources: {},
});

/** A one-cell footprint resolved at tile (0,0) fine (0,0). */
const at = (x: number, y: number): Array<{ parent: { x: number; y: number }; x: number; y: number }> => [
    { parent: { x: 0, y: 0 }, x, y },
];

describe('fineSiting — spiralAnchors, the deterministic center-out order', () => {
    it('starts at the legacy center and walks each square ring clockwise from its top-left corner', () => {
        // The full 3×3 grid (half 1,1): ring 0 the center; ring 1 its
        // perimeter — top edge west→east, right edge north→south, bottom
        // edge east→west, left edge south→north
        expect(spiralAnchors(1, 1)).toEqual([
            { x: 0, y: 0 },
            { x: -1, y: -1 },
            { x: 0, y: -1 },
            { x: 1, y: -1 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
            { x: -1, y: 1 },
            { x: -1, y: 0 },
        ]);
    });

    it('trims the square rings to a rectangular grid (halfX 2, halfY 1)', () => {
        // The 5×3 grid: ring 2's top/bottom edges (y = ±2) fall outside
        // halfY 1 — only the east/west columns' in-bounds cells survive
        expect(spiralAnchors(2, 1)).toEqual([
            { x: 0, y: 0 },
            { x: -1, y: -1 },
            { x: 0, y: -1 },
            { x: 1, y: -1 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
            { x: -1, y: 1 },
            { x: -1, y: 0 },
            { x: 2, y: -1 },
            { x: 2, y: 0 },
            { x: 2, y: 1 },
            { x: -2, y: 1 },
            { x: -2, y: 0 },
            { x: -2, y: -1 },
        ]);
    });

    it('is deterministic — the same dims give the same order', () => {
        expect(spiralAnchors(3, 2)).toEqual(spiralAnchors(3, 2));
    });
});

describe('fineSiting — footprintIsDry, the mixed-shore gate', () => {
    it('accepts a footprint standing entirely on dry fine terrain', () => {
        const resolve = fineWorld({ '0,0:0,0': dryCell(), '0,0:1,0': dryCell() });
        expect(
            footprintIsDry(
                [
                    { parent: { x: 0, y: 0 }, x: 0, y: 0 },
                    { parent: { x: 0, y: 0 }, x: 1, y: 0 },
                ],
                resolve,
            ),
        ).toBe(true);
    });

    it('vetoes a footprint with any fine water cell (the mixed shore)', () => {
        // The scale-0 shore mask turns land tiles' edge fine cells into REAL
        // water — a footprint over one is never valid
        const resolve = fineWorld({ '0,0:0,0': dryCell(), '0,0:1,0': waterCell('shallows') });
        expect(
            footprintIsDry(
                [
                    { parent: { x: 0, y: 0 }, x: 0, y: 0 },
                    { parent: { x: 0, y: 0 }, x: 1, y: 0 },
                ],
                resolve,
            ),
        ).toBe(false);
    });

    it('reads an unresolvable fine cell as dry — never a veto on ignorance', () => {
        // No terrain resolves anything: the pre-fine behavior keeps the
        // legacy coarse-only gates authoritative
        expect(footprintIsDry(at(0, 0), fineWorld({}))).toBe(true);
        // A resolver that answers undefined for ONE cell stays dry for the
        // rest and dry for the hole
        const resolve = fineWorld({ '0,0:1,0': waterCell('ocean') }, dryCell());
        expect(
            footprintIsDry(
                [
                    { parent: { x: 0, y: 0 }, x: 0, y: 0 },
                    { parent: { x: 0, y: 0 }, x: 1, y: 0 },
                ],
                resolve,
            ),
        ).toBe(false);
    });
});

describe('fineSiting — footprintTouchesSeaWater, the vessel mooring gate', () => {
    it('accepts a cell standing directly beside fine sea water', () => {
        // Sea WEST of the cell (the scan's first offset): navigable salt
        const resolve = fineWorld({ '0,0:-1,0': waterCell('shallows') });
        expect(footprintTouchesSeaWater(at(0, 0), resolve, { width: 5, height: 3 }, () => true)).toBe(true);
        // Deep water moors too
        const deep = fineWorld({ '0,0:0,-1': waterCell('ocean') });
        expect(footprintTouchesSeaWater(at(0, 0), deep, { width: 5, height: 3 }, () => true)).toBe(true);
    });

    it('refuses a lake or pond mooring — fresh water is never the sea', () => {
        const resolve = fineWorld({
            '0,0:-1,0': waterCell('lake'),
            '0,0:1,0': waterCell('pond'),
            '0,0:0,-1': waterCell('lake'),
            '0,0:0,1': waterCell('pond'),
        });
        expect(footprintTouchesSeaWater(at(0, 0), resolve, { width: 5, height: 3 }, () => true)).toBe(false);
    });

    it('needs the water BESIDE a footprint cell — a distant sea is no mooring', () => {
        // The sea stands two fine cells west: cardinal adjacency fails
        const resolve = fineWorld({ '0,0:-2,0': waterCell('ocean') });
        expect(footprintTouchesSeaWater(at(0, 0), resolve, { width: 5, height: 3 }, () => true)).toBe(false);
    });

    it('wraps a fine step off the tile edge into the ADJACENT tile sub-grid', () => {
        // The footprint cell sits on the tile's east rim (fine +2 on a
        // 5-wide grid): its EAST neighbor crosses the coarse boundary and
        // resolves tile (1,0)'s own west rim fine cell (-2,0)
        const resolve = fineWorld({ '1,0:-2,0': waterCell('shallows') });
        expect(footprintTouchesSeaWater(at(2, 0), resolve, { width: 5, height: 3 }, () => true)).toBe(true);
        // The same water beside the UNWRAPPED address (tile (1,0), fine
        // (+2,0)) is NOT the mooring — the wrap is what reads it
        const wrongSide = fineWorld({ '1,0:2,0': waterCell('shallows') });
        expect(footprintTouchesSeaWater(at(2, 0), wrongSide, { width: 5, height: 3 }, () => true)).toBe(false);
    });

    it('skips neighbors outside the world bounds (the inBounds veto)', () => {
        // The footprint cell sits on the tile's west rim (fine -2 on a
        // 5-wide grid): its WEST neighbor wraps to tile (-1,0)'s own east
        // rim fine cell (+2,0) — and that tile lies outside the island, so
        // the mooring must not count it
        const resolve = fineWorld({ '-1,0:2,0': waterCell('shallows') });
        expect(
            footprintTouchesSeaWater(
                [{ parent: { x: 0, y: 0 }, x: -2, y: 0 }],
                resolve,
                { width: 5, height: 3 },
                (x) => x >= 0,
            ),
        ).toBe(false);
        // The SAME layout with the tile in bounds moors
        expect(
            footprintTouchesSeaWater(
                [{ parent: { x: 0, y: 0 }, x: -2, y: 0 }],
                resolve,
                { width: 5, height: 3 },
                () => true,
            ),
        ).toBe(true);
    });

    it('scans every footprint cell (a two-cell hull moors on its far cell)', () => {
        // The sea sits beside the SECOND cell only — the gate still holds
        const resolve = fineWorld({ '0,0:2,-1': waterCell('ocean') });
        expect(
            footprintTouchesSeaWater(
                [
                    { parent: { x: 0, y: 0 }, x: 0, y: 0 },
                    { parent: { x: 0, y: 0 }, x: 2, y: 0 },
                ],
                resolve,
                { width: 5, height: 3 },
                () => true,
            ),
        ).toBe(true);
    });

    it('is deterministic — the same inputs answer the same boolean', () => {
        const resolve = fineWorld({ '0,0:-1,0': waterCell('shallows') });
        expect(footprintTouchesSeaWater(at(0, 0), resolve, { width: 5, height: 3 }, () => true)).toBe(
            footprintTouchesSeaWater(at(0, 0), resolve, { width: 5, height: 3 }, () => true),
        );
    });
});
