// Tests for procedural island generation (plugins/terrain/islandTerrain.ts).
// Determinism is the contract — the exact biome maps below were captured from
// a reference run and must never drift.
//
// The world coordinate system is CENTERED: (0, 0) is the dead center of the
// canvas, so grid sizes must be ODD (even input is nudged up one cell). The
// canvas edge is always open sea — the island never touches the border.
//
// Every column also carries RESOURCE DEPOSITS (TileResources) under three
// rules: the INFINITE GROUND SUPPLY — every ground voxel material a dry
// column is built from, at the symbolic count of 1 (grass/dirt/sand — never
// depleted, mirrored onto every fine cell; GRAVEL is the rock terrain
// itself, not a deposit — see the FINITE STONE rule); the FINITE biological
// TREE STAND under the NEIGHBORHOOD MODEL — every forested tile seeds the
// 8-neighbor coverage (isolated base FOREST_COVERAGE 60% + forest
// cardinal/diagonal gains − rocky penalties, clamped to [0,1]) with one
// persistent tree per covered fine cell, and every MEADOW beside woods
// gains its localized edge ingress (meadowIngressSpots); and the FINITE
// STONE STOCK — the rock terrain (VoxelKind 'gravel') no longer supplies
// stone: stone stands only on the localized rock sites (the highland
// peaks' STONE_PER_HIGHLAND base + the generator's finite-stone guarantee
// floor), drawn down by mining. The exact per-tile counts below were
// captured from a reference run of the seed-7 default island (see the
// neighboring islandTerrainNeighbors.test.ts for the controlled-neighborhood
// model pins). Iron lodes stay finite vein landmarks. Wood is NOT a
// deposit — it is the product of cutting a tree's wood pool (the lumber
// behaviour's chop → inventory.harvest → plugins/forest).

import { describe, it, expect } from 'vitest';
import {
    generateIsland,
    islandTerrainPlugin,
    oddSize,
    tileDepositSummary,
    tileSurfaceKey,
    forestTreeCount,
    edgeMask,
    FOREST_COVERAGE,
    IRON_LODE_THRESHOLD,
    FOREST_MOISTURE_THRESHOLD,
    STONE_PER_HIGHLAND,
    STONE_GUARANTEE_MIN,
} from './islandTerrain';
import { createWorld } from '../../engine/world';
// R4 — the river predicate the ford contract pins (engine/types)
import { isFreshBasin } from '../../engine/types';

// The R3 coastal-band geometry, verified against the generator's own rules
// WITHOUT reaching into its internals: the band formula (boards ≤5 across run
// a 1-tile ring, ≥7 a 2-tile ring) and the multi-source BFS distance from
// every dry cell to the nearest sea cell (8-neighbourhood). A dry cell is a
// BEACH/sand when its distance is within the band — so the invariants below
// re-derive the coast independently of the generator.
const coastalBand = (width: number, height: number): number =>
    Math.max(1, Math.min(2, Math.floor(Math.min(width, height) / 3)));

const seaDistanceOf = (island: { width: number; height: number; cells: Array<{ passable: boolean }> }): number[] => {
    const { width, height, cells } = island;
    const dist = new Array<number>(cells.length).fill(-1);
    const queue: number[] = [];
    for (let index = 0; index < cells.length; index++) {
        if (!cells[index].passable) {
            dist[index] = 0;
            queue.push(index);
        }
    }
    const offsets: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let head = 0; head < queue.length; head++) {
        const index = queue[head];
        const row = Math.floor(index / width);
        const col = index % width;
        for (const [dx, dy] of offsets) {
            const ny = row + dy;
            const nx = col + dx;
            if (ny < 0 || ny >= height || nx < 0 || nx >= width) {
                continue;
            }
            const nindex = ny * width + nx;
            if (dist[nindex] !== -1) {
                continue;
            }
            dist[nindex] = dist[index] + 1;
            queue.push(nindex);
        }
    }
    return dist;
};

/** A board keeps a non-coastal interior: some dry cell is beyond the band AND not sand. */
const interiorSurvives = (island: ReturnType<typeof generateIsland>): boolean => {
    const dist = seaDistanceOf(island);
    const b = coastalBand(island.width, island.height);
    return island.cells.some((cell, i) => cell.passable && dist[i] > b && !cell.resources.sand);
};

describe('oddSize', () => {
    it('nudges even sizes up to the next odd size, odd sizes pass through', () => {
        // (0, 0) must be the exact canvas center — even widths have no middle
        expect(oddSize(36)).toBe(37);
        expect(oddSize(24)).toBe(25);
        expect(oddSize(37)).toBe(37);
        expect(oddSize(13)).toBe(13);
        expect(oddSize(85)).toBe(85);
        expect(oddSize(53)).toBe(53);
    });
});

describe('generateIsland', () => {
    it('produces the exact biome map for seed 7 (7×5)', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Full biome names per cell, row-major
        const map = Array.from({ length: island.height }, (_, row) =>
            Array.from({ length: island.width }, (_, col) => island.cells[row * island.width + col].biome).join(' '),
        );
        expect(map).toEqual([
            'shallows shallows shallows shallows shallows shallows ocean',
            'shallows shallows river beach beach shallows ocean',
            'shallows beach river forest beach beach shallows',
            'ocean beach beach beach beach beach shallows',
            'ocean ocean ocean ocean ocean ocean shallows',
        ]);
        // R1/R3 shifted the 7×5: the lone forest now sits on the center
        // (0,0) and the coastal sand band trimmed the beaches; R4's river
        // pass fords the two beach cells (−1,0)/(−1,−1) as the one-cell
        // course (source (−1,0) → downhill ford (−1,−1) → mouth onto the
        // (−1,−2) shallows); the finite-stone guarantee stamps the 7×5's
        // highland-less board with its full 12-stone heap on the dry peak
        // (0,1) — the old (−1,0) peak was forded (stats counts UNITS)
        expect(island.stats).toEqual({ land: 13, water: 22, forest: 1, iron: 0, stone: 12 });
    });

    it('produces the exact biome map for seed 7 at default size (25×17)', () => {
        const island = generateIsland({ seed: 7 });
        expect(island.width).toBe(25);
        expect(island.height).toBe(17);
        // The map is grown at this moisture cutoff — lowering it regrows the
        // woods (the old inline 0.6 kept the meadows at 52 forests here)
        expect(FOREST_MOISTURE_THRESHOLD).toBe(0.5);
        // Two-letter biome codes per cell, row-major
        const map = Array.from({ length: island.height }, (_, row) =>
            Array.from({ length: island.width }, (_, col) => island.cells[row * island.width + col].biome.slice(0, 2)).join(''),
        );
        // R1 meadow-feed re-grew the woods, R3 shrank the coastal sand to a
        // 2-tile band (138 sand), and R2 seeded the interior fresh-water
        // basins at the 0.8 fine cutoff: 5 LAKES ('la' — the connected
        // wetlands ≥ LAKE_MIN_CELLS) + 8 PONDS ('po' — smaller pockets), a
        // connected wetland on the north coast and scattered on the lowlands
        expect(map).toEqual([
            "shshshshshshococococococococococococshshshshshshsh",
            "shocshococshshbebebebebeberibebebebebeshshshshshsh",
            "shshshshshbebebebebebebeberibebebebebebeshshbeshsh",
            "shshshbebebebebebemememeririlalafobebebebeshshshsh",
            "ocshshbebebebememememeririlalafofofoririririshshsh",
            "ocshbebebemememepomemerimemefofofofofobebebebeshsh",
            "shshbebebemememepopoforimemefofofofofofobebebeshsh",
            "shshbebefofomememefomerihimefofofofofofofobebeshsh",
            "shbebebefofopofofomehihihihifofofofofofofobebebesh",
            "shbebebebefofofofomemehihihifofofofomemefobebebesh",
            "shshbebebebefopomemememememefofofopopofobebebeshsh",
            "shocshbebebebemememememememememefofopofobebebeshsh",
            "shococshbebebemememememefomememefobebebebebeshshoc",
            "shocshshshbebememememefofofomemebebebebebebeshshsh",
            "shshbebeshbebebebebebebebebebebebebebeshshshshshsh",
            "ocshbebebebebebebebebebebebebebebebeshocococococsh",
            "ococococococococococococococococococshshshshshshsh",
        ]);
        // R5's finite mineable guarantee: the default island carries exactly
        // 1 iron lode (stamped on the first SURVIVING highland — R4's river
        // forded the old (−1,−1) peak, so the row-major stamp moved to
        // (0,−1)) — census iron 1; the finite-stone census reads 24 units
        // (the 8 surviving highlands × STONE_PER_HIGHLAND 3 — the carved
        // peak's 3 units washed into the channel and left the census with
        // the cell; still at/above the guarantee floor, untouched).
        // R4 — the 12 basin cells are WATER (the river drained the 13th
        // lake into its channel); the 13 river fords are PASSABLE, so the
        // census counts them land (269+1 = 270 land, 156−1 = 155 water);
        // none of the fords was forested on this board, forest holds 59.
        expect(island.stats).toEqual({ land: 270, water: 155, forest: 59, iron: 1, stone: 24 });
    });

    it('carries resource deposits: the voxel ground supply, the neighborhood tree stands, bare sea', () => {
        const island = generateIsland({ seed: 7 });
        // The density ladder: the ISOLATED wood seeds its FOREST_COVERAGE
        // base (60% — pinned below; T2 densified the resources), the
        // neighborhood model moves every forested tile from there
        // (forestTreeCount pins the exact rounding choice,
        // Math.round(0.6 × 425) = 255)
        expect(FOREST_COVERAGE).toBe(0.6);
        expect(forestTreeCount(25, 17)).toBe(255);
        expect(forestTreeCount(7, 5)).toBe(21);
        // (3,−6) is now a BEACH (R1/R3 re-grew the woods into the meadows):
        // the column is dirt/sand — the unlimited ground supply (the gravel
        // bedrock no longer mirrors a stone deposit — the finite-stone rule)
        expect(island.cells.find((cell) => cell.x === 3 && cell.y === -6)?.resources).toEqual({
            dirt: 1,
            sand: 1,
        });
        // THE NEIGHBORHOOD MODEL — every one of the island's 59 forest-biome
        // tiles carries the coverage its 8 neighbors price (the 0.8 basin
        // cutoff turned 4 more border woods into lakes), NOW INCLUDING every
        // meadow neighbor at the full forest-adjacency weights (R1's
        // grassland≡forest equivalence, forestCoverageOf's 3rd argument).
        // Woods ringed by woods+meadows clamp to the FULL 425, edge woods land
        // well below, rocky edges lose their spillover band's worth
        const forestCounts = island.cells
            .filter((cell) => cell.biome === 'forest')
            .map((cell) => `${cell.x},${cell.y}:${cell.resources.tree}`)
            .join(' ');
        // R1 meadow-feed re-grew the woods (68 census); the 59 forest-biome
        // tiles (0.8 cutoff) read the meadow neighbors at full weight (many
        // clamp 425); T2's densified base (60%) lifted the edge woods onto
        // the clamp — 45 of the 59 woods now stand FULL 425
        expect(forestCounts).toBe(
            '4,-5:383 3,-4:425 4,-4:425 5,-4:404 2,-3:425 3,-3:425 4,-3:425 ' +
            '5,-3:425 6,-3:404 -2,-2:425 2,-2:425 3,-2:425 4,-2:425 5,-2:425 6,-2:425 ' +
            '7,-2:404 -8,-1:383 -7,-1:425 -3,-1:425 2,-1:425 3,-1:425 4,-1:425 ' +
            '5,-1:425 6,-1:425 7,-1:425 8,-1:382 -8,0:382 -7,0:425 -5,0:425 -4,0:425 ' +
            '2,0:383 3,0:425 4,0:425 5,0:425 6,0:425 7,0:425 8,0:425 ' +
            '-7,1:404 -6,1:425 -5,1:425 -4,1:425 2,1:383 3,1:425 4,1:425 5,1:425 ' +
            '8,1:383 -6,2:404 2,2:425 3,2:425 4,2:425 7,2:425 4,3:425 5,3:425 ' +
            '7,3:361 0,4:425 4,4:404 -1,5:425 0,5:425 1,5:425',
        );
        // THE MEADOW INGRESS — every meadow beside woods carries its
        // localized edge fringe (T2: 8 spots per cardinal forest edge, 3
        // per diagonal — the denser grassland fringe); bare meadows carry
        // none (captured per tile)
        const meadowCounts = island.cells
            .filter((cell) => cell.biome === 'meadow')
            .map((cell) => `${cell.x},${cell.y}:${cell.resources.tree ?? 0}`)
            .join(' ');
        // R1 re-grew the meadow fringes (the meadows are now forest-adjacent
        // feeders); the 0.8 cutoff turned (1,−4)/(1,−5) into lakes; R1's
        // EDGE WEAVE prices the fringe off the shared forest SEAM's meander
        // (the meadow side of the weave, the tile's water spots refused —
        // no tree stands on water) — 26 meadows carry trees (captured per tile)
        expect(meadowCounts).toBe(
            '-3,-5:0 -2,-5:0 -1,-5:0 -5,-4:0 -4,-4:0 -3,-4:0 -2,-4:0 -7,-3:0 -6,-3:0 -5,-3:0 -3,-3:0 -2,-3:7 0,-3:0 1,-3:14 -7,-2:16 -6,-2:0 -5,-2:0 0,-2:0 1,-2:11 -6,-1:6 -5,-1:9 -4,-1:21 -2,-1:24 1,-1:12 -3,0:28 -3,1:6 -2,1:0 6,1:28 7,1:28 -4,2:9 -3,2:3 -2,2:0 -1,2:0 0,2:0 1,2:6 -5,3:0 -4,3:0 -3,3:0 -2,3:0 -1,3:0 0,3:8 1,3:3 2,3:17 3,3:29 -5,4:0 -4,4:0 -3,4:0 -2,4:1 -1,4:22 1,4:29 2,4:0 3,4:7 -5,5:0 -4,5:0 -3,5:0 -2,5:11 2,5:11 3,5:0',
        );
        // The treed-tile census: 59 woods + the 26 seam-meandered ingress
        // meadows — 85 (R4's river fords washed 2 treed meadow cells clean;
        // R1's weave gave 7 meadows' fringes entirely to the wood side)
        expect(island.cells.filter((cell) => (cell.resources.tree ?? 0) > 0).length).toBe(85);
        // Beach (−4,−7): the column is dirt/sand — the unlimited ground
        // supply (the gravel bedrock supplies no stone anymore)
        expect(island.cells.find((cell) => cell.x === -4 && cell.y === -7)?.resources).toEqual({
            dirt: 1,
            sand: 1,
        });
        // Lake (1,−4): the R4 fresh-water basin is DROWNED — impassable water
        // (the dirt+sand+water column) carrying NO deposits: the ground
        // supply, the meadow-ingress fringe and the carve are all washed
        // away (the submerged-supplies-nothing rule — the water surface is
        // all the tile is)
        const lake = island.cells.find((cell) => cell.x === 1 && cell.y === -4)!;
        expect(lake.passable).toBe(false);
        expect(lake.voxels).toEqual(['dirt', 'sand', 'water']);
        expect(lake.resources).toEqual({});
        // The ground-supply censuses: every dry land cell carries dirt;
        // grass covers meadows AND woods (122 = 59 forests + the
        // grass-tiled meadows; R4's 13 lake/pond basins lose their grass
        // — the drowned basin reads as water, not meadow); sand only the
        // beaches — R3's 2-tile coastal band shrank the sands from 160 to
        // 138 (the basins sit inland, so the sand census stands).
        // STONE is FINITE now: it blankets the 8 SURVIVING highland rock
        // sites (the localized rock terrain — 3 units each, 24 units in
        // all; R4's river forded the ninth, the (−1,−1) peak — its stock
        // washed into the channel and left the census with the cell), never
        // the 257-cell dry land (the old bedrock-stone mirror is gone — the
        // finite-stone rule)
        expect(island.cells.filter((cell) => (cell.resources.stone ?? 0) > 0).length).toBe(8);
        expect(
            island.cells
                .filter((cell) => (cell.resources.stone ?? 0) > 0)
                .map((cell) => [cell.x, cell.y, cell.resources.stone])
                .sort((a, b) => a[1] - b[1] || a[0] - b[0]),
        ).toEqual([
            [0, -1, 3], [-2, 0, 3], [-1, 0, 3], [0, 0, 3], [1, 0, 3],
            [-1, 1, 3], [0, 1, 3], [1, 1, 3],
        ]);
        expect(island.cells.reduce((sum, cell) => sum + (cell.resources.stone ?? 0), 0)).toBe(24);
        // R4's river fords cut 12 dry cells (the channel supplies nothing):
        // dirt 269−12 = 257, grass 122−5 = 117, sand 138−6 = 132
        expect(island.cells.filter((cell) => (cell.resources.dirt ?? 0) > 0).length).toBe(257);
        expect(island.cells.filter((cell) => (cell.resources.grass ?? 0) > 0).length).toBe(117);
        expect(island.cells.filter((cell) => (cell.resources.sand ?? 0) > 0).length).toBe(132);
        // Sea (−12,−8): no deposits — submerged columns supply nothing
        expect(island.cells.find((cell) => cell.x === -12 && cell.y === -8)?.resources).toEqual({});
    });

    it('hides iron lodes in the stone highlands (vein noise, seed 7)', () => {
        // The 37×25 reference board: exactly 3 of the 9 highland cells lode
        // at IRON_LODE_THRESHOLD = 0.5 (vein samples 0.0756 … 0.5158)
        const reference = generateIsland({ seed: 7, width: 37, height: 25 });
        expect(IRON_LODE_THRESHOLD).toBe(0.5);
        expect(reference.stats.iron).toBe(3);
        const lodes = reference.cells
            .filter((cell) => (cell.resources.iron ?? 0) > 0)
            .map((cell) => `${cell.x},${cell.y}`);
        expect(lodes).toEqual(['-7,1', '-5,2', '-5,3']);
        // A lode carries stone AND iron — the ore sits in the rock (the
        // column's dirt underlayer supplies beside them); T2's finite-stone
        // rule puts the full 3-unit rock supply (STONE_PER_HIGHLAND) on
        // every highland rock site, lode and plain alike
        expect(reference.cells.find((cell) => cell.x === -5 && cell.y === 3)?.resources).toEqual({
            stone: 3,
            dirt: 1,
            iron: 1,
        });
        // …while the plain highland beside the lode belt keeps its stone +
        // dirt supply (R4 — the (−7,0) site next door was forded by the
        // river: its stock washed into the channel, so the pin moved one
        // cell east to the surviving (−6,0))
        expect(reference.cells.find((cell) => cell.x === -6 && cell.y === 0)?.resources).toEqual({
            stone: 3,
            dirt: 1,
        });
        // R5's FINITE MINEABLE GUARANTEE: the smaller 25×17 default island
        // samples every vein below threshold, so the guarantee stamps exactly
        // one lode on its first highland (row-major) — census iron 1 at (−1,−1)
        const def = generateIsland({ seed: 7 });
        expect(def.stats.iron).toBe(1);
        expect(def.cells.find((cell) => (cell.resources.iron ?? 0) > 0)).not.toBeUndefined();
    });

    it('R3: the coastal sand hugs every coast in a 1–2 tile band with a surviving interior (multi-seed)', () => {
        // THE COASTAL BAND FORMULA: boards ≤5 across run a 1-tile ring,
        // boards ≥7 a 2-tile ring (the distance-to-sea rule — a real island
        // keeps a thin coastal ring, never an elevation band). The formula
        // is max(1, min(2, floor(min(w,h)/3)))
        expect(coastalBand(5, 5)).toBe(1);
        expect(coastalBand(7, 5)).toBe(1);
        expect(coastalBand(7, 7)).toBe(2);
        expect(coastalBand(25, 17)).toBe(2);
        // Across 8 seeds on the default 25×17 island TWO invariants hold:
        // (1) every dry SAND cell sits within the 2-tile band of the sea
        // (sand hugs the coast); (2) a non-coastal interior survives (a dry
        // non-sand cell farther than the band from the sea).
        for (let seed = 1; seed <= 8; seed++) {
            const island = generateIsland({ seed, width: 25, height: 17 });
            const dist = seaDistanceOf(island);
            const band = coastalBand(25, 17);
            island.cells.forEach((cell, i) => {
                if (cell.passable && cell.resources.sand) {
                    expect(dist[i]).toBeLessThanOrEqual(band);
                }
            });
            expect(interiorSurvives(island)).toBe(true);
        }
    });

    it('R3: a fully-coastal tiny board degrades gracefully — the band never forces an interior', () => {
        // On the compact 7×7 (band 2) some seeds are FULLY coastal — every
        // dry cell sits within 2 of the sea rim, so the coastal ring erases
        // the interior (a graceful degeneration: tiny boards keep a
        // non-coastal center only where there is room). The 5×5 / 7×5
        // (band 1) boards, by contrast, always keep a dry interior.
        expect(interiorSurvives(generateIsland({ seed: 7, width: 5, height: 5 }))).toBe(true);
        expect(interiorSurvives(generateIsland({ seed: 7, width: 7, height: 5 }))).toBe(true);
        expect(interiorSurvives(generateIsland({ seed: 1, width: 7, height: 7 }))).toBe(false);
        expect(interiorSurvives(generateIsland({ seed: 8, width: 7, height: 7 }))).toBe(false);
    });

    it('R5: every island that carries a highland guarantees a mineable lode (multi-seed)', () => {
        // THE FINITE MINEABLE GUARANTEE: after the vein-noise pass (which
        // keeps lodes a rare landmark), any board whose vein samples all
        // landed below the threshold carries ZERO lodes; the guarantee then
        // stamps one on its FIRST (row-major) highland. The net invariant
        // across seeds: a board holds a mineable iron lode (stats.iron ≥ 1)
        // EXACTLY when it has a highland to host it — a board with no
        // highland is left lode-less.
        for (let seed = 1; seed <= 8; seed++) {
            const island = generateIsland({ seed, width: 25, height: 17 });
            const hasHighland = island.cells.some((cell) => cell.biome === 'highland');
            expect(island.stats.iron >= 1).toBe(hasHighland);
        }
        // The exact stamp: the guarantee fires at the first (row-major)
        // highland when the vein noise left the board lode-less
        const lodeOf = (seed: number) => {
            const island = generateIsland({ seed, width: 25, height: 17 });
            const cell = island.cells.find((c) => (c.resources.iron ?? 0) > 0);
            return cell ? [cell.x, cell.y] : null;
        };
        expect(generateIsland({ seed: 7, width: 25, height: 17 }).stats.iron).toBe(1);
        // R4 — the river forded seed 7's first highland (−1,−1), so the
        // row-major stamp moved to the surviving (0,−1); seed 1's only
        // highland was forded too — the board is left lode-less (no host)
        expect(lodeOf(7)).toEqual([0, -1]);
        expect(lodeOf(1)).toBeNull();
    });

    it('T2: every island floors its finite stone at STONE_GUARANTEE_MIN (multi-seed)', () => {
        // THE FINITE STONE GUARANTEE: the campaign's early tools are
        // stone-gated (1-stone axe, 8-stone fort), so every playable island
        // carries at least STONE_GUARANTEE_MIN stone UNITS. The per-highland
        // base (STONE_PER_HIGHLAND each) supplies the stone-rich boards
        // untouched (25×17 seed-7: 8 surviving highlands × 3 = 24 ≥ 12 —
        // R4's river forded the ninth); short boards top up cyclically or
        // stamp the whole shortfall on their peak (highland-less 7×5: the
        // exact 12 on (0,1) — the voxel column reference pins the heap's
        // cell; R4's river forded the old (−1,0) peak). Net invariant.
        expect(STONE_GUARANTEE_MIN).toBe(12);
        expect(STONE_PER_HIGHLAND).toBe(3);
        for (let seed = 1; seed <= 12; seed++) {
            const island = generateIsland({ seed, width: 25, height: 17 });
            const hasHighland = island.cells.some((cell) => cell.biome === 'highland');
            expect(island.stats.stone).toBeGreaterThanOrEqual(STONE_GUARANTEE_MIN);
            if (hasHighland) {
                // The stone always rides visible rock — every stone-bearing
                // cell IS a highland: its stock is finite and its surface
                // reads 'stone' while the stock stands
                island.cells
                    .filter((cell) => (cell.resources.stone ?? 0) > 0)
                    .forEach((cell) => {
                        expect(cell.biome).toBe('highland');
                        // The lode highland's iron landmark outranks the
                        // rock look — every OTHER stone cell reads 'stone'
                        expect(tileSurfaceKey(cell)).toBe(
                            (cell.resources.iron ?? 0) > 0 ? 'iron' : 'stone',
                        );
                    });
            } else {
                // The highland-less board starts at zero stone (gravel never
                // supplies any) — the guarantee's heap is EXACTLY the floor
                // (the peak's own sand surface keeps the sandbar look — the
                // heap is stock, the look follows the surface)
                expect(island.stats.stone).toBe(STONE_GUARANTEE_MIN);
            }
        }
        // The default island is stone-RICH: the guarantee left it exactly as
        // generated — 8 surviving highlands × STONE_PER_HIGHLAND = 24 (the
        // river forded the ninth; the census pins the cell list)
        expect(generateIsland({ seed: 7 }).stats.stone).toBe(24);
        // The highland-less 7×5 and the highland-less 21×13 are exactly
        // floored — the whole guarantee rides their peak
        expect(generateIsland({ seed: 7, width: 7, height: 5 }).stats.stone).toBe(STONE_GUARANTEE_MIN);
        expect(generateIsland({ seed: 7, width: 21, height: 13 }).stats.stone).toBe(STONE_GUARANTEE_MIN);
    });

    it('survives a fully drowned board — the guarantee cannot stamp land that is not there', () => {
        // THE REVIEWER REPRO: a public-option map the sea swallows whole
        // (seaLevel 8 on the 9×9 seed-7 board leaves NO dry cell). The
        // guarantee's peak fallback used to read ranked[0].cell on the empty
        // dry-cell ranking and THREW. The rule: the guarantee never forces
        // land into the caller's layout — with nothing to stand on it simply
        // cannot floor the stock, and the census discloses the shortfall
        // (stone 0) on a board that stays exactly as drowned.
        const island = generateIsland({ seed: 7, width: 9, height: 9, seaLevel: 8 });
        expect(island.stats).toEqual({ land: 0, water: 81, forest: 0, iron: 0, stone: 0 });
        // Every column drowned — no forced passable cell, no hidden heap
        expect(island.cells.every((cell) => !cell.passable)).toBe(true);
        expect(island.cells.every((cell) => cell.resources.stone === undefined)).toBe(true);
    });

    it('derives the canvas surface from the tile deposits and its ground (tileSurfaceKey)', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Landmarks win: the 7×5 island surfaces as tree / sand (the
        // treed woods, the beaches) — the seabed keeps its biome
        // R1/R3 reshaped the 7×5: the single center tree + the trimmed sands;
        // R4's river fords surface as 'river' (the water top outranks the
        // sand ground — the ford reads as the fresh channel it is)
        expect(island.cells.map((cell) => tileSurfaceKey(cell))).toEqual([
            'shallows', 'shallows', 'shallows', 'shallows', 'shallows', 'shallows', 'ocean',
            'shallows', 'shallows', 'river', 'sand', 'sand', 'shallows', 'ocean',
            'shallows', 'sand', 'river', 'tree', 'sand', 'sand', 'shallows',
            'ocean', 'sand', 'sand', 'sand', 'sand', 'sand', 'shallows',
            'ocean', 'ocean', 'ocean', 'ocean', 'ocean', 'ocean', 'shallows',
        ]);
        // Deposit priority puts the rarest resource first: a stone tile with
        // an iron lode surfaces as iron (37×25 reference cell (−5,3))
        const reference = generateIsland({ seed: 7, width: 37, height: 25 });
        expect(tileSurfaceKey(reference.cells.find((cell) => cell.x === -5 && cell.y === 3)!)).toBe('iron');
        // The tile's GROUND reads the topmost resource-bearing voxel: a
        // meadow BESIDE woods surfaces as its localized tree ingress (the
        // fringe the meadow gained — the landmark outranks the ground), a
        // BARE meadow as its grass cover, a highland as its stone
        const current = generateIsland({ seed: 7 });
        // (1,−4): the R2 lake basin (its meadow-ingress tree stand stands
        // BENEATH the carved wetland) — the water surface now ranks above the
        // tree deposit, so the lake paints its water, not the canopy that
        // seeded under it (the canopy-on-water the R2 fix resolves)
        expect(tileSurfaceKey(current.cells.find((cell) => cell.x === 1 && cell.y === -4)!)).toBe('lake');
        // (0,−3): every neighbor is meadow/beach/water — no woods, no fringe
        expect(tileSurfaceKey(current.cells.find((cell) => cell.x === 0 && cell.y === -3)!)).toBe('grass');
        expect(tileSurfaceKey(current.cells.find((cell) => cell.x === 0 && cell.y === 0)!)).toBe('stone');
        // A clearcut wood keeps its forest look (the forest voxel stands —
        // the canopy branch reads the voxels directly)
        expect(tileSurfaceKey({ biome: 'meadow', resources: { stone: 1, dirt: 1, grass: 1 }, voxels: ['gravel', 'dirt', 'grass'] })).toBe('grass');
        expect(tileSurfaceKey({ biome: 'forest', resources: { grass: 1 }, voxels: ['gravel', 'dirt', 'grass', 'forest'] })).toBe('forest');
        // R4: the GRAVEL-topped rock. A live stone stock on a gravel surface
        // reads 'stone'; once the stock is spent the rock look deprecates to
        // the ground (no stone → no rock identity)
        expect(tileSurfaceKey({ biome: 'highland', resources: { stone: 3, dirt: 1, grass: 1 }, voxels: ['gravel', 'dirt', 'grass', 'gravel'] })).toBe('stone');
        expect(tileSurfaceKey({ biome: 'highland', resources: { dirt: 1, grass: 1 }, voxels: ['gravel', 'dirt', 'grass', 'gravel'] })).toBe('grass');
        // A deposit-less shape (sea column, test fixture) falls back to its
        // plain biome — the ground branch only keys resources the tile carries
        expect(tileSurfaceKey({ biome: 'meadow' })).toBe('meadow');
        expect(tileSurfaceKey({ biome: 'shallows', resources: {}, voxels: ['dirt', 'sand', 'water'] })).toBe('shallows');
    });

    it('summarizes deposits for hover titles and inspectors (tileDepositSummary)', () => {
        expect(tileDepositSummary({ tree: 383 })).toBe('tree ×383');
        // R4: stone is FINITE now — the mined rock renders its actual count,
        // never the infinity marker (dirt/iron-lode supplies stay ∞)
        expect(tileDepositSummary({ stone: 3, dirt: 1, iron: 1 })).toBe('stone ×3 · iron ×1 · dirt ×∞');
        // Unlimited deposits render the infinity marker, never a bare count
        expect(tileDepositSummary({ sand: 1 })).toBe('sand ×∞');
        expect(tileDepositSummary({ dirt: 1, berry: 2 } as never)).toBe('dirt ×∞');
        expect(tileDepositSummary({})).toBe('');
        expect(tileDepositSummary(undefined)).toBe('');
    });

    it('centers the world: coordinates run −half … +half with (0, 0) the middle', () => {
        const island = generateIsland({ seed: 7 });
        const xs = island.cells.map((cell) => cell.x);
        const ys = island.cells.map((cell) => cell.y);
        expect(Math.min(...xs)).toBe(-12);
        expect(Math.max(...xs)).toBe(12);
        expect(Math.min(...ys)).toBe(-8);
        expect(Math.max(...ys)).toBe(8);
        // The middle cell exists and is exactly (0, 0)
        expect(island.cells[8 * 25 + 12]).toMatchObject({ x: 0, y: 0 });
    });

    it('the canvas edge is always open sea — the island never touches the border', () => {
        const island = generateIsland({ seed: 7 });
        // Every outermost-ring cell is submerged water
        const edge = island.cells.filter(
            (cell) => Math.abs(cell.x) === 12 || Math.abs(cell.y) === 8,
        );
        expect(edge.length).toBe(2 * 25 + 2 * 15);
        expect(edge.every((cell) => !cell.passable)).toBe(true);
        expect(edge.every((cell) => cell.voxels[cell.voxels.length - 1] === 'water')).toBe(true);
        // Reference mix of shallows and ocean on the rim (coarse noise depth)
        expect(edge.filter((cell) => cell.biome === 'ocean').length).toBe(34);
        expect(edge.filter((cell) => cell.biome === 'shallows').length).toBe(46);
    });

    it('builds voxel columns bottom → top with dirt under the surface', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        // Forest cell (0,0) — the canvas middle (R1's lone 7×5 wood): GRAVEL
        // bedrock (R4: the stone mirror is gone — the 7×5 has no highland,
        // so the guarantee's 12-stone heap lands on the dry peak (0,1) —
        // R4's river forded the old (−1,0) — whose sand surface outranks
        // its stock in the surface derivation),
        // dirt, grass surface, forest on top, the 21-tree neighbor-priced
        // stand mirrored (T2's densified 7×5 base — the 7×5 island's woods
        // are still just (0,0); its meadow neighbors feed it at full R1
        // weight)
        expect(island.cells[2 * 7 + 3]).toEqual({
            x: 0,
            y: 0,
            voxels: ['gravel', 'gravel', 'gravel', 'dirt', 'grass', 'forest'],
            height: 5,
            waterLevel: 3,
            biome: 'forest',
            passable: true,
            resources: { dirt: 1, grass: 1, tree: 21 },
        });
        // The no-highland GUARANTEE HEAP: the 7×5's highest dry peak carries
        // the finite STONE_GUARANTEE_MIN of 12 (stats.stone 12). R4 — the
        // river forded the old (−1,0) peak (a heap cannot stand in the
        // channel), so the fallback stamped the next-highest dry cell (0,1);
        // its sand top keeps the sandbar look (the heap is stock, the look
        // follows the surface)
        expect(island.cells.find((cell) => cell.x === 0 && cell.y === 1)).toMatchObject({
            resources: { stone: 12 },
        });
        // Top-left corner (−3,−2): shallow seabed sand + water stacked to
        // the sea level — no deposits on a sea column
        expect(island.cells[0]).toEqual({
            x: -3,
            y: -2,
            voxels: ['dirt', 'sand', 'water'],
            height: 2,
            waterLevel: 3,
            biome: 'shallows',
            passable: false,
            resources: {},
        });
    });

    it('is deterministic: same seed → identical canvases', () => {
        const a = generateIsland({ seed: 42, width: 9, height: 7 });
        const b = generateIsland({ seed: 42, width: 9, height: 7 });
        expect(a.cells).toEqual(b.cells);
    });

    it('different seeds produce different canvases', () => {
        const a = generateIsland({ seed: 1, width: 9, height: 7 });
        const b = generateIsland({ seed: 2, width: 9, height: 7 });
        expect(a.cells).not.toEqual(b.cells);
    });

    it('even size input is nudged up to odd', () => {
        const island = generateIsland({ seed: 7, width: 12, height: 10 });
        expect(island.width).toBe(13);
        expect(island.height).toBe(11);
    });

    it('water columns are impassable with a water surface; sandbars are walkable', () => {
        const island = generateIsland({ seed: 7, width: 7, height: 5 });
        const waterCells = island.cells.filter((cell) => !cell.passable);
        const landCells = island.cells.filter((cell) => cell.passable);
        expect(waterCells.length).toBe(22);
        expect(landCells.length).toBe(13);
        // Every impassable column's surface voxel is water
        expect(waterCells.every((cell) => cell.voxels[cell.voxels.length - 1] === 'water')).toBe(true);
        // R4 — THE FORD EXCEPTION: the river is the one walkable water (the
        // land crosses it), so the no-water-surface rule holds for every
        // DRY walkable column; the two river fords are exactly the
        // passable-and-water-topped cells (the channel shape)
        const dryCells = landCells.filter((cell) => cell.biome !== 'river');
        expect(dryCells.every((cell) => cell.voxels[cell.voxels.length - 1] !== 'water')).toBe(true);
        const fords = landCells.filter((cell) => cell.biome === 'river');
        expect(fords.length).toBe(2);
        expect(fords.every((cell) => cell.voxels[cell.voxels.length - 1] === 'water')).toBe(true);
    });

    it('the fresh basins are drowned: impassable, water-topped, deposit-free (R4)', () => {
        const island = generateIsland({ seed: 7 });
        const basins = island.cells.filter((cell) => cell.biome === 'lake' || cell.biome === 'pond');
        // The seed-7 island's 4 lakes + 8 ponds (R4's river drained one
        // lake cell into its channel — the ford is passable, not a basin)
        expect(basins.length).toBe(12);
        basins.forEach((cell) => {
            // Impassable water columns — the ground sits a step under the
            // sea line and the column tops with water
            expect(cell.passable).toBe(false);
            expect(cell.voxels[cell.voxels.length - 1]).toBe('water');
            // The drowned column keeps NO deposits — no tree stand, no rock,
            // no ground supply (the basin pass clears them whole)
            expect(cell.resources).toEqual({});
            expect(cell.carving).toBeUndefined();
        });
        // The land set the spawn and build scans walk never carries a basin
        expect(
            island.cells
                .filter((cell) => cell.passable)
                .some((cell) => cell.biome === 'lake' || cell.biome === 'pond'),
        ).toBe(false);
    });

    // ── R4 — THE RIVERS ─────────────────────────────────────────────────────
    // The meandering fresh-water courses: reproducible downhill walks from
    // the interior high ground to the sea, carved as PASSABLE shallow fords
    // (the one water the land crosses — and the water the thirst trek drinks
    // from, inexhaustibly, through the inventory). The exact seed-7 courses
    // are the determinism contract; the multi-seed sweep pins the shape
    // invariants (cardinal connectivity, a sea mouth per course, the ford
    // column shape, the empty channel, the open-sea rim).

    it('R4: the seed-7 island carries two meandering rivers (exact courses)', () => {
        const island = generateIsland({ seed: 7 });
        const rivers = island.cells.filter((cell) => cell.biome === 'river');
        // THE EXACT CAPTURED COURSES (row-major): the 9-cell northern course
        // from the (−1,−1) highland source, meandering west-northwest then
        // northeast into the (1,−8) ocean mouth, and the 4-cell eastern
        // course (6,−4)→(9,−4) into the (10,−4) shallows — both span many
        // tiles and bend (never a straight line)
        expect(rivers.map((cell) => [cell.x, cell.y])).toEqual([
            [1, -7], [1, -6], [0, -5], [1, -5], [-1, -4], [0, -4],
            [6, -4], [7, -4], [8, -4], [9, -4], [-1, -3], [-1, -2], [-1, -1],
        ]);
        // Reproducibility: the same seed regenerates the exact same courses
        const again = generateIsland({ seed: 7 });
        expect(again.cells.filter((cell) => cell.biome === 'river').map((cell) => [cell.x, cell.y]))
            .toEqual(rivers.map((cell) => [cell.x, cell.y]));
        // THE FORD CONTRACT: every river cell is passable fresh water — the
        // drowned basin column shape (ground one under the sea line, sand
        // bed, water to the line) but walkable, deposit-free and carve-free
        rivers.forEach((cell) => {
            expect(cell.passable).toBe(true);
            expect(isFreshBasin(cell.biome)).toBe(true);
            expect(cell.voxels).toEqual(['dirt', 'sand', 'water']);
            expect(cell.resources).toEqual({});
            expect(cell.carving).toBeUndefined();
        });
        // The courses never touch the canvas rim (the edge stays open sea —
        // the rivers MOUTH onto it, they do not run along it)
        rivers.forEach((cell) => {
            expect(Math.abs(cell.x)).toBeLessThan(12);
            expect(Math.abs(cell.y)).toBeLessThan(8);
        });
    });

    it('R4: every river course is cardinal-connected and mouths on the sea (multi-seed)', () => {
        // Across 8 seeds on the default board: the river cells split into
        // cardinal-connected components (the walk only steps N/E/S/W), every
        // component HOLDS A MOUTH (a cell cardinally adjacent to an
        // impassable sea column — the course reaches the ocean, it never
        // dies inland), and the seed-7 board proves the MULTI-TILE span
        // (the longest course runs 9 cells).
        const indexAt = (island: ReturnType<typeof generateIsland>, x: number, y: number) =>
            island.cells.find((cell) => cell.x === x && cell.y === y);
        for (let seed = 1; seed <= 8; seed++) {
            const island = generateIsland({ seed });
            const rivers = island.cells.filter((cell) => cell.biome === 'river');
            const seen = new Set<string>();
            const key = (x: number, y: number) => `${x},${y}`;
            rivers.forEach((start) => {
                if (seen.has(key(start.x, start.y))) {
                    return;
                }
                // Flood the component over cardinal river steps
                const component: Array<{ x: number; y: number }> = [];
                const queue = [start];
                seen.add(key(start.x, start.y));
                let touchesSea = false;
                while (queue.length > 0) {
                    const cell = queue.shift()!;
                    component.push(cell);
                    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const neighbor = indexAt(island, cell.x + dx, cell.y + dy);
                        if (neighbor === undefined) {
                            continue;
                        }
                        if (!neighbor.passable) {
                            // A cardinally adjacent impassable column is the
                            // mouth — the course drains into the sea
                            touchesSea = true;
                        } else if (neighbor.biome === 'river' && !seen.has(key(neighbor.x, neighbor.y))) {
                            seen.add(key(neighbor.x, neighbor.y));
                            queue.push(neighbor);
                        }
                    }
                }
                expect(touchesSea, `seed ${seed} course at ${key(start.x, start.y)} must mouth on the sea`).toBe(true);
            });
            if (seed === 7) {
                // The northern course spans 9 cells — a real multi-tile river
                const northern = rivers.filter((cell) => cell.y <= -1 && cell.x <= 1);
                expect(northern.length).toBe(9);
            }
        }
    });
});

describe('islandTerrainPlugin', () => {
    it('builds the world canvas from the world seed in setup', () => {
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 7, height: 5 })] });
        expect(world.canvas.width).toBe(7);
        expect(world.canvas.height).toBe(5);
        expect(world.canvas.cells.length).toBe(35);
        expect(world.cellAt(0, 0)?.biome).toBe('forest');
    });

    it('exposes generation stats', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [plugin] });
        // The no-highland 7×5 still carries its finite-stone guarantee heap
        // (12 units on the dry peak (0,1) — see the voxel column reference)
        expect(plugin.stats()).toEqual({ land: 13, water: 22, forest: 1, iron: 0, stone: 12 });
    });

    it('respects a seed override independent of the world seed', () => {
        const world = createWorld({
            seed: 99,
            plugins: [islandTerrainPlugin({ width: 7, height: 5, seed: 7 })],
        });
        expect(world.canvas.width).toBe(7);
        // Same seed 7 → same interior biome at the canvas middle
        expect(world.cellAt(0, 0)?.biome).toBe('forest');
    });

    it('size reports the configured grid size', () => {
        const plugin = islandTerrainPlugin({ width: 13, height: 9 });
        createWorld({ seed: 7, plugins: [plugin] });
        expect(plugin.size()).toEqual({ width: 13, height: 9 });
    });

    it('resize regenerates the canvas in place and logs the redraw', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const events = world.events.log().length;
        plugin.resize(21, 13);
        expect(world.canvas.width).toBe(21);
        expect(world.canvas.height).toBe(13);
        expect(world.canvas.cells.length).toBe(273);
        expect(plugin.size()).toEqual({ width: 21, height: 13 });
        // R1's meadow-feed re-grew the 21×13 woods slightly; R4's finite
        // stone adds the guarantee heap (21×13 has no highland → the floor
        // 12 lands on its peak — stats stone 12); R4's impassable basins
        // move 3 drowned cells from land to water (162−3 = 159 land, 111+3
        // = 114 water); R4's river forded 3 forested cells on this board —
        // the drowned woods leave the forest census (40−3 = 37)
        expect(plugin.stats()).toEqual({ land: 159, water: 114, forest: 37, iron: 0, stone: 12 });
        // The redraw is announced on the story feed (a world-scale
        // happening — the god reshaped the world)
        expect(world.events.log()[events]).toEqual({
            id: events + 1,
            tick: 0,
            time: 0,
            kind: 'world',
            message: 'The island is redrawn at 21×13.',
        });
        // The edge rule holds at the new size too
        const edge = world.canvas.cells.filter(
            (cell) => Math.abs(cell.x) === 10 || Math.abs(cell.y) === 6,
        );
        expect(edge.every((cell) => !cell.passable)).toBe(true);
        // The center rises above the water line on any size
        expect(world.cellAt(0, 0)?.passable).toBe(true);
    });

    it('resize keeps the seed: the same island, bigger or smaller', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const small = createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 7, height: 5 })] });
        // The reference 7×5 center column, regenerated at default size
        plugin.resize(25, 17);
        expect(small.cellAt(0, 0)?.biome).toBe('forest');
        expect(small.cellAt(0, 0)?.height).toBe(5);
    });

    it('resize normalizes even input to odd', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        plugin.resize(36, 24);
        expect(world.canvas.width).toBe(37);
        expect(world.canvas.height).toBe(25);
        expect(world.events.log().at(-1)?.message).toBe('The island is redrawn at 37×25.');
    });

    it('resize before setup defers to the next setup', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        plugin.resize(21, 13);
        expect(plugin.size()).toEqual({ width: 21, height: 13 });
        // The first setup regenerates at the deferred size
        const world = createWorld({ seed: 7, plugins: [plugin] });
        expect(world.canvas.width).toBe(21);
        expect(world.canvas.height).toBe(13);
    });

    // ── The recursive sub-grids (the tile ladder's content) ──────────────────

    it('configures one subtile level by default and counts the tiles per scale', () => {
        const plugin = islandTerrainPlugin();
        createWorld({ seed: 7, plugins: [plugin] });
        expect(plugin.depth()).toBe(1);
        // The ladder counts UP from the interior ground: scale 0 (the
        // simulation ground) multiplies the grid by itself, scale 1 (the
        // ladder's top) is the island root — a 25×17 world holds 425×425 =
        // 180,625 interior tiles and 425 root tiles (the sub-grid dims
        // equal the root dims)
        expect(plugin.tilesAt(0)).toBe(25 * 17 * 25 * 17);
        expect(plugin.tilesAt(1)).toBe(25 * 17);
        const tiny = islandTerrainPlugin({ width: 5, height: 5, subtiles: 2 });
        createWorld({ seed: 7, plugins: [tiny] });
        expect(tiny.depth()).toBe(2);
        // Two subtile levels: scale 0 the deepest interior (25⁴), scale 1
        // the first interior (25²), scale 2 the island root (25)
        expect(tiny.tilesAt(0)).toBe(15625);
        expect(tiny.tilesAt(1)).toBe(625);
        expect(tiny.tilesAt(2)).toBe(25);
    });

    it('generates a sub-grid with the ROOT grid dimensions from the parent cell', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        const sub = plugin.canvasFor([{ x: 0, y: 0 }]);
        expect(sub).toBeDefined();
        // The recursion rule: same dims, one tile per subtile
        expect(sub?.width).toBe(7);
        expect(sub?.height).toBe(5);
        expect(sub?.cells.length).toBe(35);
        // The interior ground IS the tile's ground (the center is a forest
        // at height 5) — every UNBLENDED subtile inherits the parent column
        // exactly; R1's EDGE WEAVE: the tile's differing neighbors (here the
        // two river cells west-north-west and the six beach ring tiles)
        // weave their looks into the edge band — the mask below is the same
        // plan the materializer ran
        const parent = world.cellAt(0, 0)!;
        const plan = edgeMask(parent, [{ x: 0, y: 0 }], world.canvas, 7);
        // The captured plan: the river ford lends a fresh waterline on the
        // west edge, the beach ring lends sand patches along the shared
        // seams — irregular, seeded, coherent
        expect([...plan.water.entries()]).toEqual([
            ['-3,-1', { depth: 1, basin: 'river' }],
            ['-3,0', { depth: 1, basin: 'river' }],
        ]);
        expect(new Set([...plan.land.entries()].map(([key, look]) => `${key}=${look}`))).toEqual(new Set([
            '-1,-1=sand', '-1,-2=sand', '-2,-2=sand',
            '-1,2=sand', '-2,2=sand',
            '0,-1=sand', '0,-2=sand',
            '3,-2=sand', '3,2=sand',
        ]));
        let inherited = 0;
        sub?.cells.forEach((cell) => {
            const spot = `${cell.x},${cell.y}`;
            if (plan.water.has(spot)) {
                // The water spot is REAL water — the ford's fresh column
                expect(cell.passable).toBe(false);
                expect(cell.biome).toBe('river');
                expect(cell.resources).toEqual({});
                return;
            }
            if (plan.land.has(spot)) {
                // The blend spot carries the neighbor's surface (the sand
                // tongue over the inherited column)
                expect(cell.biome).toBe('beach');
                expect(cell.voxels[cell.voxels.length - 1]).toBe('sand');
                expect(cell.passable).toBe(parent.passable);
                return;
            }
            inherited = inherited + 1;
            expect(cell.voxels).toEqual(parent.voxels);
            expect(cell.height).toBe(parent.height);
            expect(cell.waterLevel).toBe(parent.waterLevel);
            expect(cell.biome).toBe(parent.biome);
            expect(cell.passable).toBe(parent.passable);
        });
        // The bulk of the interior still inherits — the blend is an edge
        // band, never a repaint of the tile
        expect(inherited).toBe(35 - plan.water.size - plan.land.size);
        expect(inherited).toBeGreaterThan(20);
    });

    it('distributes the parent deposits onto the subtiles (the zoomed view)', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The forest center (R1's lone 7×5 wood) mirrors its 21-tree
        // neighbor-priced stand (T2's densified base) — those PERSISTENT
        // fine positions carry one tree unit each, and every subtile mirrors
        // the ground supply (the 7×5 wood carries NO stone — the finite-
        // stone rule stamps only highlands, and the 7×5 has none). R1's
        // weave: the stand's pool refuses the tile's waterline spots, so
        // the seeded shuffle lands the 21 trees on the remaining positions
        // (captured)
        const forest = plugin.canvasFor([{ x: 0, y: 0 }]);
        const treeTiles = forest?.cells.filter((cell) => (cell.resources.tree ?? 1) === 1 && cell.resources.tree === 1);
        expect(treeTiles?.map((cell) => [cell.x, cell.y])).toEqual([
            [-3, -2], [-1, -2], [0, -2], [1, -2], [2, -2],
            [-2, -1], [-1, -1], [0, -1], [3, -1],
            [-1, 0], [2, 0], [3, 0],
            [-3, 1], [0, 1], [3, 1],
            [-3, 2], [-2, 2], [-1, 2], [1, 2], [2, 2], [3, 2],
        ]);
        // Exactly fourteen bare fine cells remain (35 − 21) — the seeded gaps
        expect(forest?.cells.filter((cell) => cell.resources.tree === undefined).length).toBe(14);
        // A treed subtile carries its tree + the ground supply; a bare one
        // only the supply
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }])?.resources).toEqual({
            dirt: 1,
            grass: 1,
            tree: 1,
        });
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: -1, y: 0 }])?.resources).toEqual({
            dirt: 1,
            grass: 1,
            tree: 1,
        });
        // The unlimited ground supply IS the ground — every DRY subtile of
        // the beach carries the symbolic deposits (the zoom preserves the
        // look; R4: the beach column is dirt/sand only — the gravel bedrock
        // no longer mirrors a stone deposit). R1 — the shore's masked WATER
        // fine cells are exempt: the submerged-supplies-nothing rule makes
        // them deposit-free real water (the sea-shaped columns).
        const beach = world.cellAt(1, -1);
        expect(beach?.resources).toEqual({ dirt: 1, sand: 1 });
        const beachSub = plugin.canvasFor([{ x: 1, y: -1 }]);
        expect(
            beachSub?.cells.every(
                (cell) => !cell.passable || (cell.resources.sand === 1 && cell.resources.dirt === 1),
            ),
        ).toBe(true);
        // The masked water cells are REAL water (impassable, deposit-free)
        expect(beachSub?.cells.some((cell) => !cell.passable && Object.keys(cell.resources).length === 0)).toBe(true);
        // A sea column has no deposits — its sub-grid is bare too
        const seaSub = plugin.canvasFor([{ x: 3, y: 1 }]);
        expect(seaSub?.cells.every((cell) => Object.keys(cell.resources).length === 0)).toBe(true);
    });

    it('resolves tiles at depth (cellFor) and rejects beyond the configured depth', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // A length-1 path resolves the root canvas cell
        expect(plugin.cellFor([{ x: 0, y: 0 }])).toEqual(world.cellAt(0, 0));
        // A length-2 path resolves a subtile of the forest's sub-grid — one
        // of the 21 stand-authored tree subtiles (R1's lone 7×5 wood; T2's
        // densified stand)
        const subtile = plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }]);
        expect(subtile?.biome).toBe('forest');
        expect(subtile?.resources).toEqual({ dirt: 1, grass: 1, tree: 1 });
        // Depth 1: a length-2 path still resolves; length 3 is beyond the
        // generated content (the ladder bounds the reach)
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: 2, y: -2 }, { x: 0, y: 0 }])).toBeUndefined();
        expect(plugin.canvasFor([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }])).toBeUndefined();
        // Out-of-bounds tiles are undefined
        expect(plugin.cellFor([{ x: 99, y: 0 }])).toBeUndefined();
        // The empty path is the root grid itself
        expect(plugin.canvasFor([])).toBe(world.canvas);
    });

    it('mirrors the persistent stand: felling one tree moves exactly its subtile (no reshuffle)', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The stand's FIRST seeded positions (−3,−2), (−1,−2) carry trees;
        // felling them off the record (what two full chops do — the mirror
        // drops with the stand, plugins/forest syncMirror) leaves every
        // OTHER position byte-identical — the trees never reshuffle
        const before = plugin.canvasFor([{ x: 0, y: 0 }])!.cells.map((cell) => cell.resources.tree ?? 0);
        expect(before.filter((count) => count === 1).length).toBe(21);
        plugin.forestOf(0, 0)!.trees.delete('-3,-2');
        plugin.forestOf(0, 0)!.trees.delete('-1,-2');
        // Two full chops off the 21-tree densified stand → 19
        world.cellAt(0, 0)!.resources.tree = 19;
        const after = plugin.canvasFor([{ x: 0, y: 0 }])!.cells.map((cell) => cell.resources.tree ?? 0);
        expect(after.filter((count) => count === 1).length).toBe(19);
        // The surviving positions are byte-identical to the seeded layout
        after.forEach((count, index) => {
            if (before[index] === 0) {
                expect(count).toBe(0);
            }
        });
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: -3, y: -2 }])?.resources).toEqual({
            dirt: 1,
            grass: 1,
        });
    });

    it('regenerates sub-grids when the parent deposits change (fingerprint)', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The forest mirrors its 21-tree stand (T2's densified 7×5); the
        // fingerprint (deposits + voxels + biome) changes when a tree is
        // felled off the record — the cached sub-grid invalidates and the
        // mirror re-reads the stand
        const sub = plugin.canvasFor([{ x: 0, y: 0 }]);
        expect(sub?.cells.filter((cell) => (cell.resources.tree ?? 0) === 1).length).toBe(21);
        const firstPass = sub!.cells.map((cell) => cell.resources.tree ?? 0);
        // A regeneration with an UNCHANGED parent serves the cached grid
        expect(plugin.canvasFor([{ x: 0, y: 0 }])).toBe(sub);
        // Drop the standing-tree mirror by one (what a full fell does: 21 →
        // 20) — the sub-grid invalidates and re-mirrors
        world.cellAt(0, 0)!.resources.tree = 20;
        plugin.forestOf(0, 0)!.trees.delete('-3,-2');
        const second = plugin.canvasFor([{ x: 0, y: 0 }]);
        expect(second?.cells.filter((cell) => (cell.resources.tree ?? 0) === 1).length).toBe(20);
        // The reshape is exact: only the felled position went bare
        second!.cells.forEach((cell, index) => {
            const before = firstPass[index];
            const now = cell.resources.tree ?? 0;
            if (before === 0) {
                expect(now).toBe(0);
            }
        });
        expect(plugin.cellFor([{ x: 0, y: 0 }, { x: -3, y: -2 }])?.resources.tree).toBeUndefined();
    });

    it('R4: mirrors the finite stone stock onto fine cells — live, never resurrected', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The 7×5's rock site: the guarantee heap on the dry peak (0,1) —
        // 12 units on a sand-surfaced column (GRAVEL bedrock underneath:
        // the ground the piles stand on, itself no supplier; R4's river
        // forded the old (−1,0) peak, so the heap moved)
        const heap = world.cellAt(0, 1)!;
        expect(heap.resources.stone).toBe(12);
        const sub = plugin.canvasFor([{ x: 0, y: 1 }])!;
        // The stock scatters one unit per seeded subtile — 12 loose piles,
        // never stacked, each a single unit
        const piles = sub.cells.filter((cell) => (cell.resources.stone ?? 0) > 0);
        expect(piles.length).toBe(12);
        expect(piles.every((cell) => cell.resources.stone === 1)).toBe(true);
        // An UNCHANGED parent serves the cached grid (the fingerprint holds)
        expect(plugin.canvasFor([{ x: 0, y: 1 }])).toBe(sub);
        // Mine the parent down to 5 — the stock count rides the fingerprint,
        // so the cached grid invalidates and the mirror re-reads the LIVE
        // stock: five units stand, every one of them a pile the 12-unit
        // scatter already showed (mining draws units OFF the site — the
        // stale cache resurrects nothing)
        heap.resources.stone = 5;
        const after = plugin.canvasFor([{ x: 0, y: 1 }])!;
        const survivors = after.cells.filter((cell) => (cell.resources.stone ?? 0) > 0);
        expect(survivors.length).toBe(5);
        const pileSet = new Set(piles.map((cell) => `${cell.x},${cell.y}`));
        expect(survivors.every((cell) => pileSet.has(`${cell.x},${cell.y}`))).toBe(true);
        // The re-derivation is a PURE read of the live stock: a fresh world
        // whose site starts at 5 scatters the exact same five cells (the
        // seeded stream + the row-major grid, no history in the layout)
        const fresh = islandTerrainPlugin({ width: 7, height: 5 });
        const freshWorld = createWorld({ seed: 7, plugins: [fresh] });
        freshWorld.cellAt(0, 1)!.resources.stone = 5;
        expect(
            fresh
                .canvasFor([{ x: 0, y: 1 }])!
                .cells.filter((cell) => (cell.resources.stone ?? 0) > 0)
                .map((cell) => `${cell.x},${cell.y}`),
        ).toEqual(survivors.map((cell) => `${cell.x},${cell.y}`));
        // Work the site to nothing — NO fine cell carries stone anymore,
        // even though every subtile still inherits the gravel-bedrock
        // column (the ground is terrain, not a hidden infinite supply).
        // R1 — the shore's masked WATER cells are exempt from the gravel
        // read too: their column is the lowered seabed the sea columns get
        // (the beach slopes into its sea), not the parent's bedrock.
        heap.resources.stone = 0;
        const bare = plugin.canvasFor([{ x: 0, y: 1 }])!;
        expect(bare.cells.every((cell) => cell.resources.stone === undefined)).toBe(true);
        expect(bare.cells.every((cell) => !cell.passable || cell.voxels.includes('gravel'))).toBe(true);
    });

    it('crown-first: boulders carry the stock first, the leftover scatters, mining shrinks the crowns', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The default island's highland (0,0) — a 3-unit rock site
        const peak = world.cellAt(0, 0)!;
        expect(peak.resources.stone).toBe(3);
        // Crown FOUR fine spots — one more than the standing stock (the
        // last crown must stay a bare boulder: crowns own the FIRST units)
        peak.carving = { rock: ['-12,-8', '0,-8', '12,8', '5,5'] };
        const sub = plugin.canvasFor([{ x: 0, y: 0 }])!;
        const at = (x: number, y: number) => sub.cells.find((cell) => cell.x === x && cell.y === y)!;
        // The first three crowns (recorded row-major order) carry one unit
        // each; the fourth stays bare while the stock covers only three
        expect(at(-12, -8).resources.stone).toBe(1);
        expect(at(0, -8).resources.stone).toBe(1);
        expect(at(12, 8).resources.stone).toBe(1);
        expect(at(5, 5).resources.stone).toBeUndefined();
        // No double pile: the fine units total EXACTLY the parent stock (the
        // leftover after the crowns is zero — nothing scatters beside them)
        expect(sub.cells.filter((cell) => (cell.resources.stone ?? 0) > 0).length).toBe(3);
        // A crowned cell stacks the boulder — a GRAVEL voxel on top of the
        // inherited column (the visible rock surface)
        expect(at(-12, -8).voxels[at(-12, -8).voxels.length - 1]).toBe('gravel');
        // Mine down to ONE unit — the visible crowns shrink to the first
        // crown only; the boulders themselves stay (the gravel top is the
        // terrain — only the stock-driven icon drops)
        peak.resources.stone = 1;
        const after = plugin.canvasFor([{ x: 0, y: 0 }])!;
        const lit = after.cells.filter((cell) => (cell.resources.stone ?? 0) > 0);
        expect(lit.length).toBe(1);
        expect([lit[0].x, lit[0].y]).toEqual([-12, -8]);
        const spent = after.cells.find((cell) => cell.x === 0 && cell.y === -8)!;
        expect(spent.resources.stone).toBeUndefined();
        expect(spent.voxels[spent.voxels.length - 1]).toBe('gravel');
    });

    it('is deterministic: the same seed and address regenerate identically', () => {
        const first = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [first] });
        const second = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [second] });
        expect(second.canvasFor([{ x: 0, y: 0 }])).toEqual(first.canvasFor([{ x: 0, y: 0 }]));
    });
});

// ── surfaceKeyCounts — the exact histogram without materializing ─────────────
// The R6 depth-2 performance fix: the coarse majority fold reads the
// children's surface-key histogram straight from the parent cell instead of
// generating 425 cell objects per parent. The contract is EXACTNESS — the
// histogram must equal the naive census over the MATERIALIZED grid, cell for
// cell, including the row-major first/last indices that carry the majority
// tie-break. The naive census below is the independent reference: it walks
// canvasFor(path).cells and runs tileSurfaceKey on every real child.
describe('surfaceKeyCounts — the exact children histogram (R6 perf fix)', () => {
    /** The independent reference: census of the MATERIALIZED grid's keys. */
    const naiveCounts = (
        plugin: Pick<ReturnType<typeof islandTerrainPlugin>, 'canvasFor'>,
        path: Array<{ x: number; y: number }>,
    ) => {
        const grid = plugin.canvasFor(path);
        if (!grid) {
            return undefined;
        }
        const counts = new Map<string, { key: string; count: number; first: number; last: number }>();
        grid.cells.forEach((cell, index) => {
            const key = tileSurfaceKey(cell);
            if (key === undefined) {
                return;
            }
            const record = counts.get(key);
            if (record) {
                record.count = record.count + 1;
                record.last = index;
                return;
            }
            counts.set(key, { key, count: 1, first: index, last: index });
        });
        return [...counts.values()];
    };

    it('matches the materialized grid exactly on the default island (every landmark)', () => {
        const plugin = islandTerrainPlugin();
        createWorld({ seed: 7, plugins: [plugin] });
        // One address per landmark shape: the rock site (gravel column +
        // finite stock), the iron lode, the tree-fringed ingress meadow, the
        // full-canopy wood, the lake basin, the sand coast, the shallows rim
        // and a bare sea column
        const addresses = [
            { x: 0, y: 0 },
            { x: -1, y: -1 },
            { x: 1, y: -2 },
            { x: 4, y: -5 },
            { x: 1, y: -4 },
            { x: -5, y: -1 },
            { x: -12, y: -8 },
            { x: 12, y: 8 },
        ];
        addresses.forEach((address) => {
            const path = [address];
            expect(plugin.surfaceKeyCounts(path)).toEqual(naiveCounts(plugin, path));
        });
    });

    it('counts the crowns exactly — gravel tops and the live-stock split', () => {
        const plugin = islandTerrainPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin] });
        // The highland (0,0): a 3-unit stock, FOUR carved crowns — the
        // fourth stays a bare boulder (the crown-first rule), and every
        // crown stacks a gravel voxel on the inherited dirt column
        const peak = world.cellAt(0, 0)!;
        peak.carving = { rock: ['-12,-8', '0,-8', '12,8', '5,5'] };
        // The exact expected census (row-major 25×17 indices): the three
        // visible crowns read 'stone' (gravel top + stock), the fourth
        // crown and every ordinary cell read the highland's 'dirt' ground
        expect(plugin.surfaceKeyCounts([{ x: 0, y: 0 }])).toEqual([
            { key: 'stone', count: 3, first: 0, last: 424 },
            { key: 'dirt', count: 422, first: 1, last: 423 },
        ]);
        // …and the materialized grid agrees exactly
        expect(plugin.surfaceKeyCounts([{ x: 0, y: 0 }])).toEqual(
            naiveCounts(plugin, [{ x: 0, y: 0 }]),
        );
        // Mine to ONE unit — the census tracks the LIVE stock (the two
        // spent crowns fall through to their dirt ground)
        peak.resources.stone = 1;
        expect(plugin.surfaceKeyCounts([{ x: 0, y: 0 }])).toEqual([
            { key: 'stone', count: 1, first: 0, last: 0 },
            { key: 'dirt', count: 424, first: 1, last: 424 },
        ]);
        expect(plugin.surfaceKeyCounts([{ x: 0, y: 0 }])).toEqual(
            naiveCounts(plugin, [{ x: 0, y: 0 }]),
        );
    });

    it('matches the materialized grid at BOTH levels of a depth-2 world', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5, subtiles: 2, seed: 11 });
        createWorld({ seed: 11, plugins: [plugin] });
        // Level 1: the histogram of a root tile's children (the grid the
        // fold materializes to recurse through)
        const level1 = [{ x: 0, y: 0 }, { x: -3, y: -2 }, { x: 2, y: 2 }, { x: -3, y: 2 }];
        level1.forEach((address) => {
            const path = [address];
            expect(plugin.surfaceKeyCounts(path)).toEqual(naiveCounts(plugin, path));
        });
        // Level 2: the histogram of a SUBTILE's children — the deepest
        // generated level, the fold's fast path (never materialized before
        // the fix — this is where the 425-grids-per-root cost lived)
        level1.forEach((address) => {
            const inner = [
                { x: 0, y: 0 },
                { x: 1, y: -1 },
                { x: -3, y: 2 },
            ];
            inner.forEach((spot) => {
                const path = [address, spot];
                expect(plugin.surfaceKeyCounts(path)).toEqual(naiveCounts(plugin, path));
            });
        });
    });

    it('answers undefined where no grid exists', () => {
        const plugin = islandTerrainPlugin({ width: 7, height: 5 });
        createWorld({ seed: 7, plugins: [plugin] });
        // The empty path is the ROOT grid — its census is the trivial fold
        // over world.canvas, not this helper's job
        expect(plugin.surfaceKeyCounts([])).toBeUndefined();
        // Beyond the configured depth there is no grid to histogram
        expect(plugin.surfaceKeyCounts([{ x: 0, y: 0 }, { x: 0, y: 0 }])).toBeUndefined();
        // Unresolvable parents answer undefined too
        expect(plugin.surfaceKeyCounts([{ x: 99, y: 0 }])).toBeUndefined();
        // An UNBOUND plugin (never set up) has no grid to read
        expect(islandTerrainPlugin().surfaceKeyCounts([{ x: 0, y: 0 }])).toBeUndefined();
    });
});
