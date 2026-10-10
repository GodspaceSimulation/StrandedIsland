// Tests for the R4 neighborhood-aware coast curves in the god-view canvas
// (features/worldGrid.tsx) — the render half of the river contract. The
// terrain half (meandering rivers, passable fresh channels) is pinned in
// plugins/terrain/islandTerrain.test.ts; these tests pin how the boards
// SHAPE their tiles from the neighborhood:
//
//   helper    — coastCornerRadii/coastRadiusCss exact per synthetic
//               neighborhood shape (interior base, straight-run soft sweep,
//               headland/cove big round, river banks on both sides, the
//               out-of-grid rim reading as open sea)
//   dom       — the unicode board's rendered border-radius rules AGREE with
//               the helper on the real seed-7 island, and pin the exact
//               strings for the river mouth (1,−7) and a forest interior
//               (3,−2)
//   svg       — the vector twin draws quarter-arc Q-path tabs at boundary
//               tiles (exact d, the tile's own fill) and NOTHING at region
//               interior
//   legend    — the surface ladder lists 'river' beside the basin keys
//
// The SVG fill is asserted against the tile rect's own fill (not a hex):
// the river→palette join lives in scenario/island.ts (another writer's
// file), so the color itself is not this suite's contract — the tab
// spilling the TILE'S OWN color is.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Dashboard } from './dashboard';
import { createIslandWorld, type IslandHandle } from '../scenario/island';
import {
    CURVE_BASE,
    CURVE_RADIUS,
    CURVE_RADIUS_SOFT,
    coastCornerRadii,
    coastRadiusCss,
} from './worldGrid';
import type { Canvas, TerrainCell } from '../engine/types';

// Emotion rule reader — every CSS block styling the element's classes,
// concatenated (the styled factory emits a base block plus the prop-driven
// block inside a @media wrapper; the App.test.tsx / lighting pattern)
const ruleFor = (className: string): string => {
    const all = Array.from(document.querySelectorAll('style'))
        .map((tag) => tag.textContent ?? '')
        .join('');
    let out = '';
    for (const single of className.split(/\s+/)) {
        const matcher = new RegExp(`\\.${single}\\b[^{]*\\{([^}]*)\\}`, 'g');
        let block = matcher.exec(all);
        while (block) {
            out += block[1];
            block = matcher.exec(all);
        }
    }
    return out;
};

// ── Synthetic canvas builder ────────────────────────────────────────────────
// regionOf only reads `biome` + `passable`, so the fixtures carry just those
// fields (cast — the unit tests never touch the voxel machinery)
const cell = (biome: string, passable: boolean): TerrainCell =>
    ({ biome, passable } as TerrainCell);

// Odd dims (the centered coordinate system); fill receives CENTERED (x, y)
// in row-major order (the canvas.cells layout)
const makeCanvas = (width: number, height: number, fill: (x: number, y: number) => TerrainCell): Canvas => {
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    const cells: TerrainCell[] = [];
    for (let y = -halfY; y <= halfY; y += 1) {
        for (let x = -halfX; x <= halfX; x += 1) {
            cells.push(fill(x, y));
        }
    }
    return { width, height, cells };
};

const LAND = (x: number, y: number): TerrainCell => cell('forest', true);
const SEA = (x: number, y: number): TerrainCell => cell('ocean', false);

describe('the coast curve helper (R4)', () => {
    it('the constants are the declared ladder', () => {
        expect(CURVE_RADIUS).toBe(12);
        expect(CURVE_RADIUS_SOFT).toBe(6);
        expect(CURVE_BASE).toBe(3);
    });

    it('region interior keeps the base look on every corner', () => {
        const canvas = makeCanvas(3, 3, LAND);
        // (0,0) has four land neighbors — no boundary edge at all
        expect(coastCornerRadii(canvas, 0, 0)).toEqual([3, 3, 3, 3]);
        expect(coastRadiusCss(canvas, 0, 0)).toBe('3px 3px 3px 3px');
    });

    it('a straight coast run soft-sweeps the two corners it passes through', () => {
        // The top row is ocean — the middle-row land cell (0,0) has water
        // ONLY across its north edge: the boundary sweeps through NW and NE
        const canvas = makeCanvas(3, 3, (x, y) => (y === -1 ? SEA(x, y) : LAND(x, y)));
        expect(coastCornerRadii(canvas, 0, 0)).toEqual([6, 6, 3, 3]);
        expect(coastRadiusCss(canvas, 0, 0)).toBe('6px 6px 3px 3px');
    });

    it('a headland corner rounds big where two boundary edges meet', () => {
        // All-land 3×3: the corner cell (−1,−1) sees open sea (out-of-grid)
        // across BOTH its north and west edges → the big round there; one
        // boundary edge at NE and SW; the inland SE corner stays base
        const canvas = makeCanvas(3, 3, LAND);
        expect(coastCornerRadii(canvas, -1, -1)).toEqual([12, 6, 3, 6]);
        expect(coastRadiusCss(canvas, -1, -1)).toBe('12px 6px 3px 6px');
    });

    it('a river banked by land on all sides rounds every corner', () => {
        // River reads as its OWN region — land differs from river across
        // every edge, so a lone river cell is a four-way headland
        const canvas = makeCanvas(3, 3, (x, y) => (x === 0 && y === 0 ? cell('river', true) : LAND(x, y)));
        expect(coastCornerRadii(canvas, 0, 0)).toEqual([12, 12, 12, 12]);
        // Its land neighbor (1,0) sees the river WEST and open sea (out-of-
        // grid rim) EAST — one boundary edge at every corner → all soft
        expect(coastCornerRadii(canvas, 1, 0)).toEqual([6, 6, 6, 6]);
    });

    it('a river run keeps its banks soft and its bends round', () => {
        // 5×3 land with an east-flowing river along y=0 from (−1,0) to (1,0):
        // the source cell (−1,0) has river east, land elsewhere
        const riverAt = (x: number, y: number) => y === 0 && x >= -1 && x <= 1;
        const canvas = makeCanvas(5, 3, (x, y) => (riverAt(x, y) ? cell('river', true) : LAND(x, y)));
        // (−1,0): boundary north+south+west, river east → NW/SW big, NE/SE soft
        expect(coastCornerRadii(canvas, -1, 0)).toEqual([12, 6, 6, 12]);
        // (0,0): river on both horizontal edges, land above/below → all soft
        expect(coastCornerRadii(canvas, 0, 0)).toEqual([6, 6, 6, 6]);
        // (1,0): the mouth-side mirror of the source
        expect(coastCornerRadii(canvas, 1, 0)).toEqual([6, 12, 12, 6]);
    });

    it('the out-of-grid rim always reads as open sea', () => {
        // A river cell ON the rim: its missing neighbors are water, not
        // land — the edge flags still differ, but the corner rule sees the
        // rim edges as boundary like any sea edge
        const canvas = makeCanvas(3, 3, (x, y) => (x === -1 && y === -1 ? cell('river', true) : LAND(x, y)));
        // (−1,−1) river: north/west out-of-grid (water), east/south land —
        // all four edges differ (water≠river, land≠river) → four big rounds
        expect(coastCornerRadii(canvas, -1, -1)).toEqual([12, 12, 12, 12]);
    });
});

// ── The rendered boards (the real seed-7 island) ────────────────────────────
const seedIsland = (): IslandHandle => createIslandWorld({ seed: 7 });
const renderBoard = (island: IslandHandle) =>
    render(<Dashboard island={island} onReroll={() => undefined} />);

describe('the unicode board curves with the neighborhood (R4)', () => {
    it('the river mouth (1,−7) banks hard and the forest interior (3,−2) stays square', () => {
        const island = seedIsland();
        renderBoard(island);
        // (1,−7): sea north, land east+west, river south — two big rounds
        // (NW, NE), two soft sweeps (SE, SW)
        const mouth = screen.getByTestId('unicode-tile-1--7');
        expect(ruleFor(mouth.className)).toContain('border-radius:12px 12px 6px 6px');
        // (3,−2): forest with forest on all four sides — the base look
        const interior = screen.getByTestId('unicode-tile-3--2');
        expect(ruleFor(interior.className)).toContain('border-radius:3px 3px 3px 3px');
    });

    it('every rendered rule agrees with the helper over the live canvas', () => {
        const island = seedIsland();
        renderBoard(island);
        // Spot the whole river course + its banks: the rendered border-
        // radius must equal coastRadiusCss(world.canvas, x, y) exactly
        const course: Array<[number, number]> = [
            [1, -7], [1, -6], [0, -5], [1, -5], [-1, -4], [0, -4],
            [-1, -3], [-1, -2], [-1, -1],
        ];
        for (const [x, y] of course) {
            const tile = screen.getByTestId(`unicode-tile-${x}-${y}`);
            expect(ruleFor(tile.className)).toContain(
                `border-radius:${coastRadiusCss(island.world.canvas, x, y)}`,
            );
        }
    });
});

describe('the svg board draws the vector twin (R4)', () => {
    it('boundary tiles carry quarter-arc tabs, interior tiles carry none', () => {
        const island = seedIsland();
        renderBoard(island);
        fireEvent.click(screen.getByTestId('canvas-tab-svg'));
        // The river mouth tab: cell box (column 13, row 1) at size 26 →
        // x=338 y=26 x1=364 y1=52, radii [12,12,6,6] — the exact d string
        const tab = screen.getByTestId('coast-curve-1--7');
        expect(tab.getAttribute('d')).toBe(
            'M 350 26 Q 338 26 338 38 L 338 26 Z ' +
            'M 352 26 Q 364 26 364 38 L 364 26 Z ' +
            'M 364 46 Q 364 52 358 52 L 364 52 Z ' +
            'M 338 46 Q 338 52 344 52 L 338 52 Z',
        );
        // The tab spills the TILE'S OWN color (the palette join itself is
        // the scenario suite's contract — compare against the rect here)
        const group = screen.getByTestId('svg-tile-1--7');
        const rect = group.querySelector('rect');
        expect(rect).not.toBeNull();
        expect(tab.getAttribute('fill')).toBe(rect!.getAttribute('fill'));
        // Region interior draws NOTHING — the base rect corner stands
        expect(screen.queryByTestId('coast-curve-3--2')).toBeNull();
    });
});

describe('the surface ladder lists the river (R4)', () => {
    it('the unicode legend carries the river key', () => {
        const island = seedIsland();
        renderBoard(island);
        expect(screen.getByTestId('grid-legend-unicode').textContent).toContain('river');
    });
});
