// Tests for the NEIGHBORHOOD RESOURCE MODEL (plugins/terrain/islandTerrain.ts
// generation passes 2–3) — the focused controlled-neighborhood regression pins.
//
// The model: resources generated within a tile depend on ALL EIGHT of its
// neighbors (NEIGHBOR_OFFSETS — 4 cardinals + 4 diagonals), cardinals
// weighing DOUBLE the diagonals:
//   forest neighbor   — coverage gain (FOREST_NEIGHBOR_CARDINAL 0.1 /
//                       FOREST_NEIGHBOR_DIAGONAL 0.05) on the FOREST side;
//                       a wood ringed by 8 forests clamps to the FULL 100%
//                       stand, fewer forest neighbors land lower;
//   meadow neighbor   — R1's GRASSLAND≡FOREST EQUIVALENCE: a meadow edge
//                       feeds the FOREST on the gain side at the identical
//                       0.1 / 0.05 ladder (forestCoverageOf's 3rd argument);
//                       MEADOW tiles beside woods ALSO gain their own
//                       LOCALIZED TREE INGRESS along each shared forest edge
//                       (meadowIngressSpots — R1's EDGE WEAVE: the MEADOW
//                       side of the shared SEAM's seeded meander — the wood
//                       grows clearings exactly where the meadow does not
//                       grow trees — coherent, never a fixed strip);
//   highland neighbor — coverage penalty (ROCK_NEIGHBOR_* — the same 0.1 /
//                       0.05 ladder) AND a rock-spillover band carved along
//                       the shared edge (rockSpillSpots — R1's EDGE WEAVE:
//                       the forest side of the shared SEAM's meander, no
//                       longer a checkerboard); the zoomed interior crowns
//                       the band's fine cells with a boulder and no tree
//                       stands on one;
//   beach / water     — contribute nothing to the coverage (the waterline
//                       seams are the edge weave's own treatment).
//
// The pure helpers (neighborhoodOf / forestCoverageOf / rockSpillSpots /
// meadowIngressSpots / seamSpots) are pinned on SYNTHETIC canvases with
// hand-placed biomes — fully controlled neighborhoods; the generateIsland
// integration pins sweep the whole seed-7 reference board (every forest and
// meadow) against the same pure math, plus the stand/subgrid/carve/cache
// fallout. Every expected value below was captured from a reference run.

import { describe, it, expect } from 'vitest';
import {
    generateIsland,
    islandTerrainPlugin,
    neighborhoodOf,
    forestCoverageOf,
    rockSpillSpots,
    meadowIngressSpots,
    seamSpots,
    edgeMask,
    FOREST_COVERAGE,
    FOREST_NEIGHBOR_CARDINAL,
    FOREST_NEIGHBOR_DIAGONAL,
    ROCK_NEIGHBOR_CARDINAL,
    ROCK_NEIGHBOR_DIAGONAL,
    type Neighborhood,
    type Offset,
} from './islandTerrain';
import { createWorld } from '../../engine/world';
import { NEIGHBOR_OFFSETS, randomKeyed, tilePathKey } from '@godspace/core';
import type { Biome, Canvas, TerrainCell } from '../../engine/types';

// ── Synthetic canvas helper — hand-placed biomes, fully controlled ──────────

/** Single-letter biome layout ('b' beach, 'f' forest, 'h' highland,
 * 'm' meadow, 'o' ocean, 's' shallows) → a centered Canvas. */
const BIOME_OF: Record<string, Biome> = {
    b: 'beach',
    f: 'forest',
    h: 'highland',
    m: 'meadow',
    o: 'ocean',
    s: 'shallows',
};
const syntheticCanvas = (layout: string[]): Canvas => {
    const width = layout[0].length;
    const height = layout.length;
    const cells: TerrainCell[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            cells.push({
                x: col - (width - 1) / 2,
                y: row - (height - 1) / 2,
                biome: BIOME_OF[layout[row][col]],
                voxels: [],
                height: 1,
                waterLevel: 3,
                passable: true,
                resources: {},
            });
        }
    }
    return { width, height, cells };
};

/** The eight NEIGHBOR_OFFSETS in their fixed clockwise order — the pin the
 * classification order asserts against. */
const OFFSETS = NEIGHBOR_OFFSETS as ReadonlyArray<Offset>;

describe('the neighborhood weights (constants)', () => {
    it('cardinals weigh double the diagonals, on both the gain and the penalty side', () => {
        // T2 densified the resources: the isolated base rose to 60% — the
        // neighbor weights themselves are untouched. R1 retired the fixed
        // ingress quotas (the fringe is the seam meander now)
        expect(FOREST_COVERAGE).toBe(0.6);
        expect(FOREST_NEIGHBOR_CARDINAL).toBe(0.1);
        expect(FOREST_NEIGHBOR_DIAGONAL).toBe(0.05);
        expect(ROCK_NEIGHBOR_CARDINAL).toBe(0.1);
        expect(ROCK_NEIGHBOR_DIAGONAL).toBe(0.05);
    });
});

describe('neighborhoodOf (the 8-neighbor classification)', () => {
    it('classifies the eight in-grid neighbors by biome in NEIGHBOR_OFFSETS order', () => {
        // Center forest; N + NE forest; W + SW highland; E + S meadow;
        // NW + SE beach. The classes come back in NEIGHBOR_OFFSETS' fixed
        // clockwise order (N, NE, E, SE, S, SW, W, NW):
        //   forest  → N (0,−1) then NE (1,−1)
        //   rock    → SW (−1,1) then W (−1,0) — SW sits earlier in the order
        //   meadow  → E (1,0) then S (0,1)
        const canvas = syntheticCanvas([
            'bbffb',
            'bbffb',
            'bhfmb',
            'bhmbb',
            'bbbbb',
        ]);
        expect(neighborhoodOf(canvas, 0, 0)).toEqual({
            forest: [{ dx: 0, dy: -1 }, { dx: 1, dy: -1 }],
            rock: [{ dx: -1, dy: 1 }, { dx: -1, dy: 0 }],
            meadow: [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }],
        });
        // The offset objects ARE the NEIGHBOR_OFFSETS elements (the same
        // identities the directional sum reads) — order pinned explicitly
        const neighborhood = neighborhoodOf(canvas, 0, 0) as Neighborhood;
        expect(neighborhood.forest.map((offset) => OFFSETS.indexOf(offset))).toEqual([0, 1]);
        expect(neighborhood.rock.map((offset) => OFFSETS.indexOf(offset))).toEqual([5, 6]);
        expect(neighborhood.meadow.map((offset) => OFFSETS.indexOf(offset))).toEqual([2, 4]);
    });

    it('reads the ACTUAL biome names — meadows classify as meadow (R1: they feed the gain side)', () => {
        // A wood ringed by meadows on every side: the eight neighbors land in
        // the MEADOW class (not forest, not rock) — R1 prices them on the
        // gain side at the forest ladder (see the forestCoverageOf meadow pin
        // below), and MEADOW tiles beside woods gain their own ingress
        const canvas = syntheticCanvas([
            'mmmmm',
            'mmmmm',
            'mmfmm',
            'mmmmm',
            'mmmmm',
        ]);
        const neighborhood = neighborhoodOf(canvas, 0, 0);
        expect(neighborhood.forest).toEqual([]);
        expect(neighborhood.rock).toEqual([]);
        expect(neighborhood.meadow.map((offset) => OFFSETS.indexOf(offset))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        // …and a beach ring contributes nothing either
        const beachRing = syntheticCanvas([
            'bbbbb',
            'bbbbb',
            'bbfbb',
            'bbbbb',
            'bbbbb',
        ]);
        expect(neighborhoodOf(beachRing, 0, 0).meadow).toEqual([]);
        expect(neighborhoodOf(beachRing, 0, 0).rock).toEqual([]);
    });

    it('out-of-grid positions are not neighbors (the rim is always open sea)', () => {
        const canvas = syntheticCanvas([
            'fbbbb',
            'bbbbb',
            'bbbbb',
            'bbbbb',
            'bbbbb',
        ]);
        // The corner tile (−2,−2) has only three in-grid neighbors — all
        // beach, so every class comes back empty (the out-of-grid rim
        // positions contributed nothing)
        expect(neighborhoodOf(canvas, -2, -2)).toEqual({ forest: [], rock: [], meadow: [] });
        // A 1×1 canvas has no neighbors at all
        expect(neighborhoodOf(syntheticCanvas(['f']), 0, 0)).toEqual({ forest: [], rock: [], meadow: [] });
    });
});

describe('forestCoverageOf (cardinal vs diagonal arithmetic)', () => {
    it('the isolated base stands alone; each cardinal adds 0.1, each diagonal 0.05', () => {
        // The exact IEEE doubles the generator's arithmetic produces off the
        // T2-densified 60% base — pinned as the literals the runtime rounds
        // back to
        expect(forestCoverageOf([], [])).toBe(0.6);
        expect(forestCoverageOf([{ dx: 1, dy: 0 }], [])).toBe(0.7);
        expect(forestCoverageOf([{ dx: 1, dy: -1 }], [])).toBe(0.65);
        // Direction does not matter — only cardinal vs diagonal
        expect(forestCoverageOf([{ dx: 0, dy: 1 }], [])).toBe(0.7);
        expect(forestCoverageOf([{ dx: -1, dy: 1 }], [])).toBe(0.65);
    });

    it('rocky neighbors subtract the same ladder; the total clamps to [0, 1]', () => {
        expect(forestCoverageOf([], [{ dx: 1, dy: 0 }])).toBe(0.5);
        // The exact double off the 60% base (0.6 − 0.05 does not land on the
        // literal 0.55)
        expect(forestCoverageOf([], [{ dx: 1, dy: 1 }])).toBe(0.5499999999999999);
        // Four cardinal forests: 0.6 + 0.4 — T2's densified base lands the
        // exact clamp (the accumulated double lands on 1.0, the FULL stand)
        expect(
            forestCoverageOf([{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }], []),
        ).toBe(1);
        // Four diagonal forests only: 0.6 + 0.2 = 0.8 — strictly below the
        // same COUNT of cardinals (the cardinal-double rule)
        expect(
            forestCoverageOf([{ dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: -1 }], []),
        ).toBe(0.8);
        // A wood ringed by 8 forests clamps to the FULL 100% stand
        expect(forestCoverageOf(OFFSETS.slice(), [])).toBe(1);
        // A wood crushed under 8 rocky neighbors clamps at 0 — the empty
        // stand keeps the seed bank alive (seedStands seeds forest tiles
        // even at 0)
        expect(forestCoverageOf([], OFFSETS.slice())).toBe(0);
        // The mixed neighborhood the synthetic classification test built:
        // 0.6 + (0.1 + 0.05) − (0.05 + 0.1) — the gains and penalties cancel
        // onto the exact base double (0.6)
        expect(forestCoverageOf([{ dx: 0, dy: -1 }, { dx: 1, dy: -1 }], [{ dx: -1, dy: 1 }, { dx: -1, dy: 0 }]))
            .toBe(0.6);
    });

    it('R1: meadow neighbors feed the gain side at the EXACT forest weights (grassland≡forest equivalence)', () => {
        // A cardinal meadow is a cardinal forest, a diagonal meadow a diagonal
        // forest — the third argument prices edges identically to the first
        expect(forestCoverageOf([], [], [{ dx: 1, dy: 0 }])).toBe(0.7);
        expect(forestCoverageOf([], [], [{ dx: 1, dy: -1 }])).toBe(0.65);
        // The gain side is literally interchangeable: a forest edge and a
        // meadow edge at the SAME offset produce the SAME coverage
        expect(forestCoverageOf([{ dx: 1, dy: 0 }], [])).toBe(forestCoverageOf([], [], [{ dx: 1, dy: 0 }]));
        expect(forestCoverageOf([{ dx: 1, dy: 1 }], [])).toBe(forestCoverageOf([], [], [{ dx: 1, dy: 1 }]));
        // A wood ringed by 8 MEADOWS clamps to the FULL 100% stand, exactly
        // like 8 forests (the grassland's complement feeds the woods in full)
        expect(forestCoverageOf([], [], OFFSETS.slice())).toBe(1);
        // The two gain classes accumulate together: 2 forest + 2 meadow
        // cardinals → 0.6 + (0.1+0.1) + (0.1+0.1) — T2's densified base
        // accumulates straight onto the FULL stand (the exact accumulated
        // double lands on 1.0, the clamp)
        expect(
            forestCoverageOf([{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }], [], [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }]),
        ).toBe(1);
    });
});

describe('rockSpillSpots (the spillover band — R1 EDGE WEAVE)', () => {
    // The band is the FOREST side of each shared highland SEAM: the seeded
    // meander (seamSpots) decides where the scree runs — captured lists. The
    // canonical stream is `seam:<low>~<high>`; the fixture tile sits at the
    // origin (0,0), the highland neighbor one step over.
    const origin = { x: 0, y: 0 };
    const seed = 7;

    it('a cardinal highland spills a WAVY band along the shared edge — contiguous runs, no checkerboard', () => {
        // 7×5 board (half 3/2), forest at (0,0): the north seam's meander
        // pushes into the tile for five of the seven positions, two of them
        // TWO cells deep (the second row y=−1) — a coherent run, never the
        // old even-parity half of the edge row
        expect(rockSpillSpots(7, 5, seed, origin, [{ dx: 0, dy: -1 }])).toEqual([
            '-2,-2', '-1,-2', '0,-2', '-1,-1', '0,-1',
        ]);
        // The south seam pushed the OTHER way (the highland keeps its own
        // side): two shallow spots on the south edge
        expect(rockSpillSpots(7, 5, seed, origin, [{ dx: 0, dy: 1 }])).toEqual(['-2,2', '-1,2']);
        // The east seam: two lone spots on the east column
        expect(rockSpillSpots(7, 5, seed, origin, [{ dx: 1, dy: 0 }])).toEqual(['3,-2', '3,2']);
        // The west seam: two spots on the west column
        expect(rockSpillSpots(7, 5, seed, origin, [{ dx: -1, dy: 0 }])).toEqual(['-3,-1', '-3,0']);
        // Both north+south combined — the union, row-major
        expect(rockSpillSpots(7, 5, seed, origin, [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }])).toEqual([
            '-2,-2', '-1,-2', '0,-2', '-1,-1', '0,-1', '-2,2', '-1,2',
        ]);
    });

    it('a diagonal highland spills the corner wedge (the corner cell, flanks when the push runs deep)', () => {
        // SE corner (3,2): the meander pushed INTO the tile — the corner
        // alone (the flank roll held the flanks back)
        expect(rockSpillSpots(7, 5, seed, origin, [{ dx: 1, dy: 1 }])).toEqual(['3,2']);
        // NW corner: the push favored the HIGHLAND side — the tile keeps
        // bare woods at that corner
        expect(rockSpillSpots(7, 5, seed, origin, [{ dx: -1, dy: -1 }])).toEqual([]);
    });

    it('the 25×17 board carves the exact bands generation stamps (the reference carves)', () => {
        // The seed-7 default island's carved tiles — captured; (2,0)'s west
        // highland band is one contiguous wavy run of six (the old
        // checkerboard's nine scattered spots are gone)
        expect(rockSpillSpots(25, 17, 7, { x: 2, y: 0 }, [{ dx: -1, dy: 0 }])).toEqual([
            '-12,-3', '-12,-2', '-12,-1', '-12,0', '-12,1', '-12,2',
        ]);
        // The diagonal corners of (2,0): both pushes favored the highland
        expect(rockSpillSpots(25, 17, 7, { x: 2, y: 0 }, [{ dx: -1, dy: -1 }])).toEqual([]);
        expect(rockSpillSpots(25, 17, 7, { x: 2, y: 0 }, [{ dx: -1, dy: 1 }])).toEqual([]);
    });

    it('the band is seeded and spatially coherent — reproducible, seed-varying, never a fixed parity stripe', () => {
        // Reproducible: the same inputs return an equal (fresh) list
        const first = rockSpillSpots(7, 5, seed, origin, [{ dx: 1, dy: 1 }]);
        expect(rockSpillSpots(7, 5, seed, origin, [{ dx: 1, dy: 1 }])).toEqual(first);
        expect(first).not.toBe(rockSpillSpots(7, 5, seed, origin, [{ dx: 1, dy: 1 }]));
        // Seed-varying: a different seed draws a different band somewhere
        // across the four cardinal edges (the meander's phase/cycles/push
        // all re-derive)
        const varied = [1, 2, 3, 4, 5].some((other) =>
            [0, 1, 2, 3].some((direction) => {
                const offset = [
                    { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 },
                ][direction];
                return JSON.stringify(rockSpillSpots(25, 17, other, origin, [offset]))
                    !== JSON.stringify(rockSpillSpots(25, 17, seed, origin, [offset]));
            }),
        );
        expect(varied).toBe(true);
        // SPATIALLY COHERENT — the band is a run, never the checkerboard's
        // alternating stripe: the checkerboard's parity rule never puts two
        // EDGE-ADJACENT fine cells in the band, while the meander's runs
        // always touch somewhere on every band of two or more spots
        [1, 2, 3, 4, 5, 7].forEach((bandSeed) => {
            const band = rockSpillSpots(25, 17, bandSeed, { x: 0, y: 0 }, [{ dx: -1, dy: 0 }]);
            if (band.length < 2) {
                return;
            }
            const edgeYs = band
                .filter((key) => Number(key.split(',')[0]) === -12)
                .map((key) => Number(key.split(',')[1]))
                .sort((left, right) => left - right);
            const touches = edgeYs.some((y, index) => index > 0 && y - edgeYs[index - 1] === 1);
            expect(touches, `seed ${bandSeed} band ${JSON.stringify(band)} must run, not alternate`).toBe(true);
        });
    });

    it('no rocky neighbors carve nothing; the output is row-major and pure', () => {
        expect(rockSpillSpots(7, 5, seed, origin, [])).toEqual([]);
    });

    it('the seam both tiles derive is the SAME meander (the composite boundary is one curve)', () => {
        // The forest (selfKey A) and the highland (otherKey B) derive the
        // identical stream — neither side may claim the same fine cell, and
        // both sides convert somewhere (captured seed-7 east seam)
        const forestKey = tilePathKey([{ x: 0, y: 0 }]);
        const highlandKey = tilePathKey([{ x: 1, y: 0 }]);
        const forestSide = seamSpots(7, 5, seed, forestKey, highlandKey, { dx: 1, dy: 0 });
        const highlandSide = seamSpots(7, 5, seed, highlandKey, forestKey, { dx: -1, dy: 0 });
        forestSide.forEach((_reach, key) => {
            expect(highlandSide.has(key)).toBe(false);
        });
        expect([...forestSide.entries()]).toEqual([['3,-2', 1], ['3,2', 1]]);
        expect([...highlandSide.entries()]).toEqual([['-3,0', 1]]);
    });
});

describe('meadowIngressSpots (the localized tree ingress — R1 EDGE WEAVE)', () => {
    // The fringe is the MEADOW side of each shared forest SEAM: the seeded
    // meander decides where the trees stand — captured lists.
    const origin = { x: 0, y: 0 };
    const seed = 7;

    it('a cardinal forest edge grows its trees along the seam meander', () => {
        // 7×5 board, forest to the EAST: the meadow side kept two edge
        // cells (the wood side grew clearings elsewhere along the seam)
        expect(meadowIngressSpots(7, 5, seed, origin, [{ dx: 1, dy: 0 }])).toEqual(['3,-2', '3,2']);
        // Forest to the WEST — the mirrored seam's meadow side
        expect(meadowIngressSpots(7, 5, seed, origin, [{ dx: -1, dy: 0 }])).toEqual(['-3,-1', '-3,0']);
        // 25×17, forest to the NORTH: the meander's run along the top row
        // plus its one-deep second layer
        expect(meadowIngressSpots(25, 17, seed, origin, [{ dx: 0, dy: -1 }])).toEqual([
            '-9,-8', '-8,-8', '-7,-8', '-6,-8', '-5,-8', '-4,-8', '-3,-8', '-2,-8', '-1,-8', '0,-8', '1,-8',
            '-9,-7', '-6,-7', '-5,-7', '-4,-7', '-3,-7', '-2,-7', '-1,-7',
        ]);
    });

    it('a diagonal forest edge grows its corner wedge when the meander pushes the meadow side', () => {
        // SE corner (3,2) on the 7×5 board: the meadow side kept the corner
        expect(meadowIngressSpots(7, 5, seed, origin, [{ dx: 1, dy: 1 }])).toEqual(['3,2']);
        // 25×17 SW corner: the push favored the WOOD side — the meadow
        // corner stays bare (the meander, not a quota, decides)
        expect(meadowIngressSpots(25, 17, seed, origin, [{ dx: -1, dy: 1 }])).toEqual([]);
    });

    it('every shared edge is served by its own seam; the union is row-major', () => {
        // East cardinal edge + SE diagonal edge: the two seams' meadow
        // sides union (deduped), row-major
        expect(meadowIngressSpots(7, 5, seed, origin, [{ dx: 1, dy: 0 }, { dx: 1, dy: 1 }])).toEqual([
            '3,-2', '3,2',
        ]);
    });

    it('a meadow beside no woods gains nothing; the output is row-major and pure', () => {
        expect(meadowIngressSpots(7, 5, seed, origin, [])).toEqual([]);
        const first = meadowIngressSpots(7, 5, seed, origin, [{ dx: 1, dy: 0 }]);
        expect(meadowIngressSpots(7, 5, seed, origin, [{ dx: 1, dy: 0 }])).toEqual(first);
        expect(first).not.toBe(meadowIngressSpots(7, 5, seed, origin, [{ dx: 1, dy: 0 }]));
    });

    it('the refuse set holds the waterline spots out of the fringe (no tree stands on water, R2)', () => {
        // A refuse set containing the whole fringe empties it
        const all = meadowIngressSpots(7, 5, seed, origin, [{ dx: 1, dy: 0 }]);
        const refused = new Set(all);
        expect(meadowIngressSpots(7, 5, seed, origin, [{ dx: 1, dy: 0 }], refused)).toEqual([]);
        // A partial refuse removes exactly those spots
        const partial = new Set([all[0]]);
        expect(meadowIngressSpots(7, 5, seed, origin, [{ dx: 1, dy: 0 }], partial)).toEqual(all.slice(1));
    });
});

// ── The generateIsland integration — the whole seed-7 reference board ───────

/** Row-major cell lookup on a centered canvas. */
const cellAt = (canvas: Canvas, x: number, y: number): TerrainCell => {
    const halfX = (canvas.width - 1) / 2;
    const halfY = (canvas.height - 1) / 2;
    return canvas.cells[(y + halfY) * canvas.width + (x + halfX)];
};

describe('the neighborhood model on the seed-7 reference island (25×17)', () => {
    const island = generateIsland({ seed: 7 });

    it('every stable forest carries exactly its neighborhood-counted coverage (R1 meadow feed)', () => {
        // The full sweep: every forest tile's tree deposit IS
        // Math.round(forestCoverageOf(forest, rock, MEADOW) × 425) — R1 prices
        // the meadow edges on the gain side, and the model is a pure function
        // of the PRE-BASIN biome map. R2's basin pass (after the resource
        // pass) swaps 7 meadows into interior ponds, so the 11 forests beside
        // a pond keep the pre-swap (meadow-fed) price: the sweep covers the
        // 52 forest tiles with NO lake/pond among their 8 neighbors
        const lakesPonds = new Set(
            island.cells.filter((cell) => cell.biome === 'lake' || cell.biome === 'pond').map((cell) => `${cell.x},${cell.y}`),
        );
        const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const;
        const stableForests = island.cells.filter(
            (cell) => cell.biome === 'forest' && !dirs.some(([dx, dy]) => lakesPonds.has(`${cell.x + dx},${cell.y + dy}`)),
        );
        // The 0.8 cutoff's 13 wetland tiles (5 lakes + 8 ponds) sit beside
        // 22 of the 59 woods, so the stable (water-basin-free) sweep covers 37
        expect(stableForests.length).toBe(37);
        stableForests.forEach((cell) => {
            const neighborhood = neighborhoodOf(island, cell.x, cell.y);
            const coverage = forestCoverageOf(neighborhood.forest, neighborhood.rock, neighborhood.meadow);
            expect(cell.resources.tree).toBe(Math.round(coverage * island.width * island.height));
        });
    });

    it('a wood ringed by woods stands FULL; fewer neighbors stand lower (R1 meadow feed)', () => {
        // FULL interior: (3,−3) has 7 forest neighbors (one edge is now a
        // meadow feeder) — the gain still clamps at the FULL 425
        expect(neighborhoodOf(island, 3, -3).forest.length).toBe(7);
        expect(cellAt(island, 3, -3).resources.tree).toBe(425);
        // The 425-full woods: T2's densified 60% base plus R1's grassland
        // feed pushes MOST woods to the clamp (captured census — 45 of the
        // 59 woods reach 425, up from 35)
        expect(island.cells.filter((cell) => cell.biome === 'forest' && cell.resources.tree === 425).length).toBe(45);
        // PARTIAL edges land strictly below the clamp — captured pairs
        // (R1: meadow edges feed the gain side too; T2's +0.15 densification
        // lifts every count by the same neighborhood arithmetic):
        //   (5,−4): the stable edge at 0.95 coverage → 404
        expect(cellAt(island, 5, -4).resources.tree).toBe(404);
        //   (4,−5): 3 forest neighbors (a north wood turned to a 0.8 lake
        //   basin — priced from the pre-basin map at 0.9) → 383
        expect(cellAt(island, 4, -5).resources.tree).toBe(383);
        //   (7,3): the isolated wood on the eastern fringes (priced from
        //   the pre-basin map at 0.85) → 361
        expect(cellAt(island, 7, 3).resources.tree).toBe(361);
        // MONOTONIC in the DEPOSIT — the FULL interior out-stands every edge
        // wood (the cardinals weigh double, so equal COUNTS can still differ)
        expect(cellAt(island, 3, -3).resources.tree).toBeGreaterThan(cellAt(island, 5, -4).resources.tree);
        expect(cellAt(island, 5, -4).resources.tree).toBeGreaterThan(cellAt(island, 4, -5).resources.tree);
        expect(cellAt(island, 4, -5).resources.tree).toBeGreaterThan(cellAt(island, 7, 3).resources.tree);
    });

    it('meadows beside woods carry their localized edge ingress; bare meadows carry none', () => {
        const meadows = island.cells.filter((cell) => cell.biome === 'meadow');
        // R4 — the river fords cut 5 meadow cells out of the census (63→58)
        expect(meadows.length).toBe(58);
        // The full sweep over STABLE meadows (none of the 8 neighbors is a
        // lake/pond — R2's basin pass priced the pond-adjacent meadows from
        // the pre-swap map): every stable meadow's tree deposit IS its
        // ingress fringe's size (meadowIngressSpots of its forest edges,
        // the tile's own water spots refused — R2: no tree stands on
        // water); bare meadows read 0
        const lakesPonds = new Set(
            island.cells.filter((cell) => cell.biome === 'lake' || cell.biome === 'pond').map((cell) => `${cell.x},${cell.y}`),
        );
        const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const;
        meadows
            .filter((cell) => !dirs.some(([dx, dy]) => lakesPonds.has(`${cell.x + dx},${cell.y + dy}`)))
            .forEach((cell) => {
                const edges = neighborhoodOf(island, cell.x, cell.y).forest;
                const refuse = edgeMask(cell, [{ x: cell.x, y: cell.y }], island, 7).water;
                expect(cell.resources.tree ?? 0).toBe(
                    meadowIngressSpots(island.width, island.height, 7, cell, edges, refuse).length,
                );
            });
        // The ingress rides the SEAM MEANDER now, not a fixed quota — the
        // captured per-tile counts (the meadow side of each shared forest
        // seam, the water spots refused):
        expect(neighborhoodOf(island, 0, 3).forest).toEqual([{ dx: 0, dy: 1 }]);
        expect(cellAt(island, 0, 3).resources.tree).toBe(8);
        // (−1,3)'s south-west corner: the meander favored the WOOD side, so
        // the meadow corner grew no trees at all (the wood's own side did)
        expect(neighborhoodOf(island, -1, 3).forest).toEqual([{ dx: 1, dy: 1 }]);
        expect(cellAt(island, -1, 3).resources.tree).toBeUndefined();
        // (1,3) and (1,2): the two seams' meadow sides
        expect(neighborhoodOf(island, 1, 3).forest).toEqual([{ dx: 1, dy: -1 }, { dx: -1, dy: 1 }]);
        expect(cellAt(island, 1, 3).resources.tree).toBe(3);
        expect(neighborhoodOf(island, 1, 2).forest).toEqual([{ dx: 1, dy: -1 }, { dx: 1, dy: 0 }]);
        expect(cellAt(island, 1, 2).resources.tree).toBe(6);
        // A fully walled-in meadow corner beside the eastern pond: (6,1) and
        // (7,1) — captured seam sides
        expect(cellAt(island, 6, 1).resources.tree).toBe(28);
        expect(cellAt(island, 7, 1).resources.tree).toBe(28);
        // BARE meadows (no forest neighbor at all): no deposit at all
        ['0,-3', '0,-2', '-2,1', '-2,2', '-1,2', '0,2', '-3,3', '-2,3'].forEach((key) => {
            const [x, y] = key.split(',').map(Number);
            expect(neighborhoodOf(island, x, y).forest).toEqual([]);
            expect(cellAt(island, x, y).resources.tree).toBeUndefined();
        });
        // THE INGRESS IS LOCALIZED — (1,−2)'s three forest seams (NE, E, SE)
        // meander their tree runs into the tile's east column; the exact
        // captured list (the deposit IS this list's length)
        const ingressCell = cellAt(island, 1, -2);
        expect(meadowIngressSpots(island.width, island.height, 7, ingressCell, neighborhoodOf(island, 1, -2).forest)).toEqual([
            '11,-8', '12,-8', '12,-7', '12,-1', '11,0', '12,0', '11,1', '12,1', '12,7', '11,8', '12,8',
        ]);
        expect(ingressCell.resources.tree).toBe(11);
    });

    it('rocky neighborhoods suppress the stand and carve the spillover band (captured carves)', () => {
        // The island's four carved tiles — the exact bands, row-major (the
        // seam meander's runs; the two diagonal-corner pushes favored the
        // highland side, so (−2,−2) and (2,2) carve nothing this seed)
        const carvings = island.cells
            .filter((cell) => cell.carving)
            .map((cell) => `${cell.x},${cell.y}:${cell.carving?.rock.join(',')}`);
        expect(carvings).toEqual([
            '-3,-1:12,7,11,8,12,8',
            '2,-1:-12,8',
            '2,0:-12,-3,-12,-2,-12,-1,-12,0,-12,1,-12,2',
            '2,1:-12,-8,-12,-1,-11,-1,-12,0,-12,1,-12,7,-12,8',
        ]);
        // THE ROCK SUPPRESSION — (2,0) sits beside the west highland column
        // (cardinal −0.1) and the highland corner (diagonal −0.05): 5 forest
        // + 1 meadow (R1 feeder) neighbors at T2's densified 60% base land
        // it at 0.9 → 383 trees (0.9×425 = 382.5 → 383), one full step
        // below its unpenalized 425-clamp peers
        const neighborhood = neighborhoodOf(island, 2, 0);
        expect(neighborhood.rock).toEqual([{ dx: -1, dy: 1 }, { dx: -1, dy: 0 }]);
        expect(forestCoverageOf(neighborhood.forest, neighborhood.rock, neighborhood.meadow)).toBe(0.9);
        expect(cellAt(island, 2, 0).resources.tree).toBe(383);
        // The band never eats the whole stand: the deposit stays within the
        // band-free pool (425 − the 6 band spots)
        expect(cellAt(island, 2, 0).resources.tree).toBeLessThanOrEqual(425 - 6);
    });

    it('is deterministic: the same seed regenerates the identical canvas, carves included', () => {
        const again = generateIsland({ seed: 7 });
        expect(again.cells).toEqual(island.cells);
        // A different seed draws a different island
        const other = generateIsland({ seed: 8 });
        expect(other.cells).not.toEqual(island.cells);
    });
});

describe('the neighborhood fallout in the zoomed interior (sub-grids, stands, cache)', () => {
    const plugin = islandTerrainPlugin();
    const world = createWorld({ seed: 7, plugins: [plugin] });
    const canvas = world.canvas;
    const halfX = (canvas.width - 1) / 2;
    const halfY = (canvas.height - 1) / 2;
    const cellAt = (x: number, y: number): TerrainCell =>
        canvas.cells[(y + halfY) * canvas.width + (x + halfX)];

    it('the ingress meadow persists a REAL stand exactly matching its fringe (one source of truth)', () => {
        // The meadow (1,−2) carries a stand of its 11 ingress spots (R1's
        // EDGE WEAVE: the meadow side of its three forest seams — NE, E, SE
        // — meandered into the tile's east column); the stand's positions
        // ARE meadowIngressSpots' selection (the same pure list generation
        // pass 3 wrote the deposit from)
        const stand = plugin.forestOf(1, -2);
        expect(stand?.trees.size).toBe(11);
        const spotList = Array.from(stand?.trees.keys() ?? []).sort((left, right) => {
            const [lx, ly] = left.split(',').map(Number);
            const [rx, ry] = right.split(',').map(Number);
            return ly - ry || lx - rx;
        });
        expect(spotList).toEqual([
            '11,-8', '12,-8', '12,-7', '12,-1', '11,0', '12,0', '11,1', '12,1', '12,7', '11,8', '12,8',
        ]);
        // The zoom mirrors it: exactly those 11 subtiles carry one tree
        const sub = plugin.canvasFor([{ x: 1, y: -2 }]);
        const treed = sub?.cells.filter((cell) => (cell.resources.tree ?? 0) > 0).map((cell) => `${cell.x},${cell.y}`);
        expect(treed).toEqual(spotList);
        // A BARE meadow carries no stand and no zoomed trees
        expect(plugin.forestOf(0, -3)).toBeUndefined();
        const bareSub = plugin.canvasFor([{ x: 0, y: -3 }]);
        expect(bareSub?.cells.every((cell) => cell.resources.tree === undefined)).toBe(true);
    });

    it('no tree stands on a boulder: the spillover band and the stand never overlap', () => {
        // (2,0) carries the 6-spot west band; the zoomed interior crowns
        // EXACTLY those fine cells with a GRAVEL voxel (R4's boulder — the
        // rock-terrain material) stacked on top
        const carved = cellAt(2, 0);
        const band = carved.carving?.rock ?? [];
        expect(band.length).toBe(6);
        const sub = plugin.canvasFor([{ x: 2, y: 0 }])!;
        const bouldered = sub.cells
            .filter((cell) => cell.voxels.length === carved.voxels.length + 1 && cell.voxels[cell.voxels.length - 1] === 'gravel')
            .map((cell) => `${cell.x},${cell.y}`)
            .sort((left, right) => {
                const [lx, ly] = left.split(',').map(Number);
                const [rx, ry] = right.split(',').map(Number);
                return ly - ry || lx - rx;
            });
        expect(bouldered).toEqual(band);
        // NO tree stands on a boulder — the stand seeding refused the band
        const stand = plugin.forestOf(2, 0)!;
        const overlap = band.filter((spot) => stand.trees.has(spot));
        expect(overlap).toEqual([]);
        // The zoomed treed subtiles and the boulder spots are disjoint too
        const treedSubs = sub.cells
            .filter((cell) => (cell.resources.tree ?? 0) > 0)
            .map((cell) => `${cell.x},${cell.y}`);
        expect(treedSubs.filter((spot) => band.includes(spot))).toEqual([]);
        // The stand mirrors the deposit exactly (the coverage already
        // priced the rock penalty in)
        expect(stand.trees.size).toBe(carved.resources.tree ?? 0);
        // The exposed fine boulder IS the rock-terrain material (R4: gravel,
        // never a 'stone' voxel — the finite resource lives in the stock)
        const boulderCell = sub.cells.find((cell) => `${cell.x},${cell.y}` === band[0]);
        expect(boulderCell?.voxels[boulderCell.voxels.length - 1]).toBe('gravel');
    });

    it('the sub-grid fingerprint stamps the carve: a cached grid never outlives its carve', () => {
        // The cache serves the SAME grid while the parent is untouched
        const first = plugin.canvasFor([{ x: 2, y: 0 }]);
        expect(plugin.canvasFor([{ x: 2, y: 0 }])).toBe(first);
        // THE CARVE RIDES THE STAMP — move the band's carve on the parent
        // (what a neighborhood change would do): the cached grid
        // invalidates and the boulders move with the new carve
        const carved = cellAt(2, 0);
        const originalBand = (carved.carving?.rock ?? []).slice();
        carved.carving = { rock: ['0,0'] };
        const second = plugin.canvasFor([{ x: 2, y: 0 }]);
        expect(second).not.toBe(first);
        const bouldered = second?.cells
            .filter((cell) => cell.voxels.length === carved.voxels.length + 1 && cell.voxels[cell.voxels.length - 1] === 'gravel')
            .map((cell) => `${cell.x},${cell.y}`);
        expect(bouldered).toEqual(['0,0']);
        // Restoring the original carve re-stamps and re-crowns the band
        carved.carving = { rock: originalBand };
        const third = plugin.canvasFor([{ x: 2, y: 0 }]);
        expect(third).not.toBe(second);
        expect(third?.cells.filter((cell) => cell.voxels.length === carved.voxels.length + 1 && cell.voxels[cell.voxels.length - 1] === 'gravel').length).toBe(6);
        // A carve-less parent never grows boulders (no carving field → no
        // band → the fingerprint's 'none' stamp)
        expect(cellAt(3, -3).carving).toBeUndefined();
        const cleanSub = plugin.canvasFor([{ x: 3, y: -3 }]);
        expect(cleanSub?.cells.every((cell) => cell.voxels.length === cellAt(3, -3).voxels.length)).toBe(true);
    });

    it('stand, deposit and zoom agree on EVERY treed tile (forests and ingress meadows)', () => {
        // The whole-board consistency sweep: every tile carrying a tree
        // deposit holds a stand of exactly that size; the zoomed sub-grid
        // carries one tree unit on exactly the stand's positions
        const treedTiles = canvas.cells.filter((cell) => (cell.resources.tree ?? 0) > 0);
        // The plugin canvas (post seedStands) prices each stand from its
        // boulder-and-water-free pool: 85 carry a living stand (R4 washed
        // the 12 basin tiles clean — the pure generateIsland reads 92 —
        // R4's river fords cut 2 more treed meadow cells, R1's water seams
        // refused the fringes whose every spot fell on water, and seedStands
        // refuses the spots inside a spillover band)
        expect(treedTiles.length).toBe(85);
        treedTiles.forEach((tile) => {
            const stand = plugin.forestOf(tile.x, tile.y);
            expect(stand).toBeDefined();
            expect(stand?.trees.size).toBe(tile.resources.tree);
            const sub = plugin.canvasFor([{ x: tile.x, y: tile.y }]);
            const treedSubs = sub?.cells.filter((cell) => (cell.resources.tree ?? 0) > 0) ?? [];
            expect(treedSubs.length).toBe(stand?.trees.size);
            treedSubs.forEach((cell) => {
                expect(stand?.trees.has(`${cell.x},${cell.y}`)).toBe(true);
                // One tree per fine cell, beside the inherited ground supply
                expect(cell.resources.tree).toBe(1);
            });
        });
    });

    it('forestPlant refuses a carved spot — the boulder boundary holds for any caller', () => {
        // The terrain plugin's plant API is the last guard: a fine spot ON
        // the tile's recorded band (plugins/terrain islandTerrain.ts
        // forestPlant — conservative lookup against the live canvas) never
        // gains a tree, no matter who calls (the ecology's recruitment and
        // spread already avoid the band; this closes the boundary for any
        // future caller). This test plants records deliberately — it runs
        // AFTER the whole-board consistency sweep above, whose
        // stand-deposit invariant the raw plants (which the ecology owns
        // the mirroring for) would otherwise desync.
        const carved = cellAt(2, 0);
        const band = carved.carving!.rock;
        expect(band.length).toBe(6);
        const stand = plugin.forestOf(2, 0)!;
        const before = stand.trees.size;
        // THE REFUSAL — planting onto the band's first spot returns the
        // stand unchanged (same size, no record added)
        const refused = plugin.forestPlant(2, 0, { x: -12, y: -3 }, {
            born: 5,
            base: 3,
            baseMinute: 5,
            carry: 0,
        });
        expect(refused.trees.size).toBe(before);
        expect(refused.trees.has('-12,-3')).toBe(false);
        expect(plugin.forestOf(2, 0)?.trees.size).toBe(before);
        // A non-carved spot still plants (the guard refuses ONLY the band)
        const planted = plugin.forestPlant(2, 0, { x: 0, y: 0 }, {
            born: 5,
            base: 3,
            baseMinute: 5,
            carry: 0,
        });
        expect(planted.trees.size).toBe(before + 1);
        expect(planted.trees.has('0,0')).toBe(true);
        // A FULL clean stand (the 8-forest ring (3,−3), all 425 cells
        // wooded, no carve) plants too — the record OVERWRITES the existing
        // tree at its spot (one tree per fine cell holds, size unmoved)
        const full = cellAt(3, -3);
        expect(full.carving).toBeUndefined();
        expect(full.resources.tree).toBe(425);
        const overwritten = plugin.forestPlant(3, -3, { x: 0, y: 0 }, {
            born: 5,
            base: 3,
            baseMinute: 5,
            carry: 0,
        });
        expect(overwritten.trees.size).toBe(425);
        expect(overwritten.trees.has('0,0')).toBe(true);
    });
});
