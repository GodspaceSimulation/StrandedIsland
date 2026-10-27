// R2 — GROUND NAVIGATION: water is never walked, and routes detour around it.
//
// The rules under test (engine/types + plugins/movement/fineMovement):
//   * isWaterBiome  — ocean/shallows/lake/pond/river are ALL water;
//   * isWalkableCell — passable AND not water (a river keeps `passable: true`
//     for resource compatibility, so passability alone is NOT dry ground);
//   * fineStep      — validates the RESOLVED FINE destination (a tile's zoomed
//     interior can be wet while the parent tile is dry), refuses diagonal
//     water corner-cutting, and allows a wet-footed body to step OUT;
//   * tilePathHop   — routes over walkable tiles only, with no route to a
//     water goal;
//   * fineRouteStep / fineRouteTowardTile — a real fine-scale detour around a
//     water body instead of a stuck rejection;
//   * settleDryFineSpot / dryFineSpotDelta — spawn never starts in water.
//
// The worlds here are HAND-BUILT (no terrain generator): a test canvas of
// explicit TerrainCells plus a stub terrain plugin that resolves each tile's
// zoomed interior from a literal fine map. That keeps every expected value
// exact and independent of generator tuning.

import { describe, expect, it } from 'vitest';
import type { PluginContext, WorldPlugin } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { createIslandWorld } from '../../scenario/island';
import {
    isWalkableCell,
    isWaterBiome,
    type Biome,
    type Canvas,
    type TerrainCell,
} from '../../engine/types';
import {
    dryFineSpotDelta,
    fineCellAt,
    fineCellWalkable,
    fineGlobalAddress,
    fineRouteStep,
    fineRouteTowardTile,
    fineStep,
    greedyFineStep,
    invalidSpotRecovery,
    moverStandsOnDryGround,
    nearestWalkableFineInTile,
    settleDryFineSpot,
    tilePathHop,
    type FineMover,
} from './fineMovement';

// ── the fixture ─────────────────────────────────────────────────────────────

/** One tile of the hand-built island. `fine` is a per-fine-cell override map
 * keyed "fx,fy" → biome; every unlisted fine cell is the tile's own biome. */
type TileSpec = {
    x: number;
    y: number;
    biome: Biome;
    passable: boolean;
    fine?: Record<string, Biome>;
};

const cellOf = (spec: TileSpec): TerrainCell => ({
    x: spec.x,
    y: spec.y,
    voxels: ['gravel', 'sand'],
    height: 2,
    waterLevel: 3,
    biome: spec.biome,
    passable: spec.passable,
    resources: {},
});

/** A 3×3 canvas (centered −1…1) whose tiles carry the given specs. */
const canvasOf = (specs: TileSpec[]): Canvas => {
    const width = 3;
    const height = 3;
    const cells: TerrainCell[] = [];
    for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
            const spec = specs.find((candidate) => candidate.x === x && candidate.y === y);
            cells.push(
                spec
                    ? cellOf(spec)
                    : cellOf({ x, y, biome: 'ocean', passable: false }),
            );
        }
    }
    return { width, height, cells };
};

/**
 * The stub terrain plugin: `cellFor([{tile},{fine}])` resolves the fine cell
 * from the spec's `fine` override map, and every other fine cell inherits the
 * parent's biome/passability. `depth()` is 1 (one interior level exists).
 * A tile whose spec is missing resolves to undefined (off-canvas).
 */
const terrainStub = (specs: TileSpec[]): WorldPlugin<ReturnType<typeof createWorld>> => ({
    id: 'island-terrain',
    label: 'Terrain Stub',
    setup: () => undefined,
    cellFor: (path: Array<{ x: number; y: number }>) => {
        if (path.length !== 2) {
            return undefined;
        }
        const tile = specs.find((candidate) => candidate.x === path[0].x && candidate.y === path[0].y);
        if (!tile) {
            return undefined;
        }
        const key = `${path[1].x},${path[1].y}`;
        const biome = tile.fine?.[key] ?? tile.biome;
        const passable = tile.fine?.[key] === undefined ? tile.passable : isWalkableBiome(biome);
        return {
            x: path[1].x,
            y: path[1].y,
            voxels: ['gravel'],
            height: 1,
            waterLevel: 3,
            biome,
            passable,
            resources: {},
        } as TerrainCell;
    },
    depth: () => 1,
}) as unknown as WorldPlugin<ReturnType<typeof createWorld>>;

/** Fine overrides are always WATER biomes in these tests, so the stub marks
 * them impassable (the generator's own fine water is impassable). */
const isWalkableBiome = (biome: Biome): boolean => !isWaterBiome(biome);

/** Builds a world with the hand-built canvas + terrain stub. */
const worldOf = (specs: TileSpec[]) => {
    const world = createWorld({ seed: 7, plugins: [] });
    world.canvas = canvasOf(specs);
    world.plugins.add(terrainStub(specs) as never);
    return world;
};

/** Places a mover at a tile + fine spot (the fine spot is stored explicitly
 * through relocateFine so `subOf` reads exactly what the test wants). */
const placeMover = (
    world: ReturnType<typeof createWorld>,
    id: string,
    tileX: number,
    tileY: number,
    fx: number,
    fy: number,
): FineMover => {
    const mover: FineMover = { id, position: { x: tileX, y: tileY, z: 0 } };
    world.coordinates.place({
        id,
        position: { x: tileX, y: tileY, z: 0 },
        kind: 'sentient',
        type: 'human',
    });
    // The engine derives a fine spot from the seed; relocateFine applies the
    // continuity wrap, so step from THAT derived spot to the wanted one
    const derived = world.subOf(id);
    if (derived) {
        world.relocateFine(id, fx - derived.x, fy - derived.y);
    }
    return mover;
};

// ── the water vocabulary ────────────────────────────────────────────────────

describe('R2 — the water vocabulary', () => {
    it('classifies every water biome, salt and fresh alike', () => {
        expect(isWaterBiome('ocean')).toBe(true);
        expect(isWaterBiome('shallows')).toBe(true);
        expect(isWaterBiome('lake')).toBe(true);
        expect(isWaterBiome('pond')).toBe(true);
        expect(isWaterBiome('river')).toBe(true);
        expect(isWaterBiome('beach')).toBe(false);
        expect(isWaterBiome('meadow')).toBe(false);
        expect(isWaterBiome('forest')).toBe(false);
        expect(isWaterBiome('highland')).toBe(false);
        expect(isWaterBiome(undefined)).toBe(false);
    });

    it('reads a river as water even though its raw passable flag survives', () => {
        // The generator keeps `passable: true` on river cells (resource
        // compatibility) — the walkable rule must subtract it anyway.
        expect(isWalkableCell({ passable: true, biome: 'river' })).toBe(false);
        expect(isWalkableCell({ passable: true, biome: 'meadow' })).toBe(true);
        expect(isWalkableCell({ passable: true, biome: 'beach' })).toBe(true);
        expect(isWalkableCell({ passable: true, biome: 'forest' })).toBe(true);
        expect(isWalkableCell({ passable: true, biome: 'highland' })).toBe(true);
        // Impassable is never walkable, whatever the biome
        expect(isWalkableCell({ passable: false, biome: 'meadow' })).toBe(false);
        expect(isWalkableCell({ passable: false, biome: 'ocean' })).toBe(false);
        // Unresolved terrain fails closed
        expect(isWalkableCell(undefined)).toBe(false);
    });
});

// ── the fine terrain read ───────────────────────────────────────────────────

describe('R2 — the resolved fine terrain', () => {
    it('maps a tile + fine address onto the contiguous global fine plane', () => {
        const grid = { width: 3, height: 3 };
        // Tile (1,-1) fine (1,1) → global (1·3+1, -1·3+1)
        expect(fineGlobalAddress(1, -1, 1, 1, grid)).toEqual({ x: 4, y: -2 });
        // Tile (0,0) fine (-1,-1) → global (-1,-1): the centre tile is exact
        expect(fineGlobalAddress(0, 0, -1, -1, grid)).toEqual({ x: -1, y: -1 });
    });

    it('resolves a tile interior cell, including the water inside a dry tile', () => {
        // Tile (0,0) is a dry MEADOW whose fine (1,0) is a river channel
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true, fine: { '1,0': 'river' } },
        ]);
        // Global fine (1,0) is tile (0,0) fine (1,0) — the channel
        expect(fineCellAt(world, 1, 0)?.biome).toBe('river');
        expect(fineCellWalkable(world, 1, 0)).toBe(false);
        // Global fine (0,0) is the same tile's dry centre
        expect(fineCellAt(world, 0, 0)?.biome).toBe('meadow');
        expect(fineCellWalkable(world, 0, 0)).toBe(true);
    });

    it('resolves a river tile as water and its synthesized bank as dry', () => {
        const world = worldOf([
            { x: 0, y: 0, biome: 'river', passable: true, fine: { '1,1': 'meadow' } },
        ]);
        // The inherited channel is water (passable flag notwithstanding)
        expect(fineCellAt(world, 0, 0)?.biome).toBe('river');
        expect(fineCellAt(world, 0, 0)?.passable).toBe(true);
        expect(fineCellWalkable(world, 0, 0)).toBe(false);
        // The synthesized bank is walkable ground
        expect(fineCellWalkable(world, 1, 1)).toBe(true);
    });

    it('reads off-canvas as unresolvable (never walkable)', () => {
        const world = worldOf([{ x: 0, y: 0, biome: 'meadow', passable: true }]);
        expect(fineCellAt(world, 99, 0)).toBeUndefined();
        expect(fineCellWalkable(world, 99, 0)).toBe(false);
    });
});

// ── stepping ────────────────────────────────────────────────────────────────

describe('R2 — fineStep never enters water', () => {
    it('refuses every water biome as a destination', () => {
        // Each cardinal neighbour tile is a DIFFERENT water biome. A body on
        // the centre tile only crosses into a neighbour by stepping off its
        // sub-grid edge (the continuity wrap), so the mover starts on the
        // matching edge fine cell for each probe.
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'ocean', passable: false },
            { x: -1, y: 0, biome: 'shallows', passable: false },
            { x: 0, y: 1, biome: 'lake', passable: false },
            { x: 0, y: -1, biome: 'pond', passable: false },
            { x: 1, y: 1, biome: 'river', passable: true },
        ]);
        const east = placeMover(world, 'east', 0, 0, 1, 0);
        expect(fineStep(world, east, 1, 0)).toBeUndefined();
        const west = placeMover(world, 'west', 0, 0, -1, 0);
        expect(fineStep(world, west, -1, 0)).toBeUndefined();
        const south = placeMover(world, 'south', 0, 0, 0, 1);
        expect(fineStep(world, south, 0, 1)).toBeUndefined();
        const north = placeMover(world, 'north', 0, 0, 0, -1);
        expect(fineStep(world, north, 0, -1)).toBeUndefined();
        // The diagonal river tile is refused too (from the south-east corner)
        const corner = placeMover(world, 'corner', 0, 0, 1, 1);
        expect(fineStep(world, corner, 1, 1)).toBeUndefined();
        // …and the dry interior steps stay legal
        expect(fineStep(world, east, -1, 0)).toEqual({ parent: { dx: 0, dy: 0 } });
    });

    it('refuses the fine water inside an otherwise dry tile', () => {
        // The tile is dry meadow; its fine (1,0) is a river channel. A step
        // that stays INSIDE the parent tile must still be validated.
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true, fine: { '1,0': 'river' } },
        ]);
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        expect(fineStep(world, mover, 1, 0)).toBeUndefined();
        expect(fineStep(world, mover, -1, 0)).toEqual({ parent: { dx: 0, dy: 0 } });
    });

    it('refuses to cut a diagonal water corner', () => {
        // Fine water sits east and south of the mover; the south-east cell is
        // DRY — a diagonal step would squeeze between the two wet cells
        const world = worldOf([
            {
                x: 0,
                y: 0,
                biome: 'meadow',
                passable: true,
                fine: { '1,0': 'river', '0,1': 'river' },
            },
        ]);
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        expect(fineCellWalkable(world, 1, 1)).toBe(true);
        expect(fineStep(world, mover, 1, 1)).toBeUndefined();
        // The cardinal routes are refused by the water itself
        expect(fineStep(world, mover, 1, 0)).toBeUndefined();
        expect(fineStep(world, mover, 0, 1)).toBeUndefined();
    });

    it('allows a wet-footed body to step OUT of the water it stands in', () => {
        // The mover's fine spot is a river channel cell inside a dry tile; the
        // north cell is dry. Escape validates the DESTINATION only, so the
        // body may leave — it can never be sealed in.
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true, fine: { '0,1': 'river' } },
        ]);
        const mover = placeMover(world, 'a', 0, 0, 0, 1);
        expect(moverStandsOnDryGround(world, mover)).toBe(false);
        expect(fineStep(world, mover, 0, -1)).toEqual({ parent: { dx: 0, dy: 0 } });
        // …but it still cannot step DEEPER into water
        expect(fineStep(world, mover, 1, 0)).toEqual({ parent: { dx: 0, dy: 0 } });
        expect(fineStep(world, mover, 0, 1)).toBeUndefined();
    });

    it('refuses the river tile a coarse passable flag would have allowed', () => {
        // Tile (1,0) is a river: passable true, biome river. Crossing into it
        // must be refused (this is the regression the R2 rule closes).
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'river', passable: true },
        ]);
        expect(world.cellAt(1, 0)?.passable).toBe(true);
        const mover = placeMover(world, 'a', 0, 0, 1, 0);
        expect(fineStep(world, mover, 1, 0)).toBeUndefined();
        // The tile west of it stays legal
        expect(fineStep(world, mover, -1, 0)).toEqual({ parent: { dx: 0, dy: 0 } });
    });
});

// ── routing ─────────────────────────────────────────────────────────────────

describe('R2 — tile routing', () => {
    it('has no route to a water goal', () => {
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'river', passable: true },
            { x: 0, y: 1, biome: 'ocean', passable: false },
            { x: -1, y: 0, biome: 'meadow', passable: true },
        ]);
        // A river goal and a sea goal are both unreachable by construction
        expect(tilePathHop(world, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeNull();
        expect(tilePathHop(world, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeNull();
        // A dry goal one step west is reachable in one hop
        expect(tilePathHop(world, { x: 0, y: 0 }, { x: -1, y: 0 })).toEqual({ x: -1, y: 0 });
    });

    it('detours around a river to reach the far side', () => {
        // A river wall splits the 3×3 board: (1,-1) and (1,0) are river, and
        // the dry goal (1,1) is behind them. The route must go around.
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'river', passable: true },
            { x: 1, y: -1, biome: 'river', passable: true },
            { x: 1, y: 1, biome: 'meadow', passable: true },
            { x: 0, y: 1, biome: 'meadow', passable: true },
        ]);
        // From the centre tile the goal is SOUTH-EAST; the direct east hop is
        // the river, so the route must first step south
        expect(tilePathHop(world, { x: 0, y: 0 }, { x: 1, y: 1 })).toEqual({ x: 0, y: 1 });
    });

    it('reports an unreachable goal when water rings the target', () => {
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'river', passable: true },
            { x: 1, y: -1, biome: 'river', passable: true },
            { x: 1, y: 1, biome: 'river', passable: true },
            { x: 0, y: 1, biome: 'ocean', passable: false },
        ]);
        expect(tilePathHop(world, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
    });
});

describe('R2 — fine routing detours around fine water', () => {
    it('finds the walkable cell of a tile that is partly water', () => {
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'meadow', passable: true, fine: { '1,0': 'river', '1,1': 'river' } },
        ]);
        // The goal tile's east edge is a river channel (fine x = 1). Nearest
        // walkable cell to global (0,0) is its fine (-1,-1) → global (2,-1):
        // Chebyshev 2, and the row-major tie-break takes fy = -1 first.
        expect(nearestWalkableFineInTile(world, 1, 0, 0, 0)).toEqual({ x: 2, y: -1 });
        // A pure water tile has no walkable cell at all
        const oceanWorld = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'ocean', passable: false },
        ]);
        expect(nearestWalkableFineInTile(oceanWorld, 1, 0, 0, 0)).toBeNull();
    });

    it('steps around a fine channel instead of stalling against it', () => {
        // A vertical river channel runs down global x = 0 for y = -1 and y = 0
        // (tile (0,0)'s fine (0,-1) and (0,0)); the row y = 1 is a DRY gap.
        // A body west of the channel aiming east must walk around it.
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true, fine: { '0,-1': 'river', '0,0': 'river' } },
        ]);
        const mover = placeMover(world, 'a', 0, 0, -1, 0);
        expect(fineCellWalkable(world, -1, 0)).toBe(true);
        expect(fineCellWalkable(world, 0, 0)).toBe(false);
        expect(fineCellWalkable(world, 1, 0)).toBe(true);
        // The direct east step is refused by the water…
        expect(fineStep(world, mover, 1, 0)).toBeUndefined();
        // …and the fine route heads around the channel (south, toward the gap)
        // instead of milling into the bank
        expect(fineRouteStep(world, mover, { x: 1, y: 0 })).toEqual([0, 1]);
    });

    it('returns null when no dry route exists at all', () => {
        // A closed water ring around the mover's cell
        const ring: Record<string, Biome> = {
            '1,0': 'river',
            '-1,0': 'river',
            '0,1': 'river',
            '0,-1': 'river',
            '1,1': 'river',
            '1,-1': 'river',
            '-1,1': 'river',
            '-1,-1': 'river',
        };
        const world = worldOf([{ x: 0, y: 0, biome: 'meadow', passable: true, fine: ring }]);
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        expect(fineRouteStep(world, mover, { x: 5, y: 5 })).toBeNull();
        expect(fineRouteTowardTile(world, mover, { x: 1, y: 0 })).toBeNull();
    });

    it('routes toward a tile goal through the nearest walkable cell', () => {
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'meadow', passable: true },
        ]);
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        // The goal tile is one east; the nearest walkable cell of it to global
        // (0,0) is fine (-1,-1) → global (2,-1), so the first hop is diagonal
        // north-east (the deterministic row-major tie-break)
        expect(fineRouteTowardTile(world, mover, { x: 1, y: 0 })).toEqual([1, -1]);
        // Already standing on the goal cell — no route needed
        const seated = placeMover(world, 'b', 1, 0, 0, 0);
        expect(fineRouteTowardTile(world, seated, { x: 1, y: 0 })).toBeNull();
    });

    it('makes the greedy walker take the detour instead of the mill', () => {
        // The mover is on the centre tile aiming at the tile EAST, whose fine
        // water blocks the direct line: greedyFineStep must not mill straight
        // into the bank — it returns a step that is legal AND non-zero.
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'meadow', passable: true, fine: { '-1,0': 'river', '-1,1': 'river' } },
        ]);
        const mover = placeMover(world, 'a', 0, 0, 1, 0);
        const step = greedyFineStep(world, mover, 1, 0);
        expect(step).not.toBeNull();
        // Whatever it picks is a legal step (never into the channel)
        expect(fineStep(world, mover, step?.[0] ?? 0, step?.[1] ?? 0)).toBeDefined();
    });
});

// ── invalid-spot recovery ───────────────────────────────────────────────────

describe('R2 — invalid-spot recovery never enters water', () => {
    it('settles a wet body onto the nearest dry cell of its tile', () => {
        // A three-cell-wide channel with the mover in the middle. R2 removed
        // the walk-through-water escape, so the body is SETTLED once onto the
        // nearest dry cell instead of wading to the shore.
        const world = worldOf([
            {
                x: 0,
                y: 0,
                biome: 'meadow',
                passable: true,
                fine: { '0,0': 'river', '1,0': 'river', '0,1': 'river', '1,1': 'river' },
            },
        ]);
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        expect(fineCellWalkable(world, 0, 0)).toBe(false);
        // The recovery is a dry destination — never the channel next door
        expect(invalidSpotRecovery(world, mover)).toEqual({
            delta: [-1, -1],
            destination: { x: -1, y: -1 },
        });
        // Applying it leaves the body on DRY ground
        settleDryFineSpot(world, mover);
        expect(moverStandsOnDryGround(world, mover)).toBe(true);
        expect(world.subOf('a')).toEqual({ x: -1, y: -1 });
    });

    it('never fires for a body already on dry ground', () => {
        // This is what makes the recovery incapable of ENTERING water: a dry
        // source returns null, so no water destination can ever be chosen.
        const world = worldOf([{ x: 0, y: 0, biome: 'meadow', passable: true }]);
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        expect(invalidSpotRecovery(world, mover)).toBeNull();
    });

    it('refuses a wet destination from a dry body (no wade path exists)', () => {
        // The removed escape let a planner return a step INTO water. Every
        // remaining move is fineStep-validated, so a wet destination from dry
        // ground is impossible.
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true },
            { x: 1, y: 0, biome: 'river', passable: true },
        ]);
        const mover = placeMover(world, 'a', 0, 0, 1, 0);
        expect(fineStep(world, mover, 1, 0)).toBeUndefined();
    });
});

// ── spawn ───────────────────────────────────────────────────────────────────

describe('R2 — spawn never starts in water', () => {    it('reports no delta for a dry fine spot', () => {
        const world = worldOf([{ x: 0, y: 0, biome: 'meadow', passable: true }]);
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        expect(dryFineSpotDelta(world, mover)).toEqual([0, 0]);
        expect(settleDryFineSpot(world, mover)).toBe(true);
    });

    it('moves a wet fine spot to the nearest dry cell of the same tile', () => {
        // The tile's fine centre is a river channel; the ring around it is dry
        const world = worldOf([
            { x: 0, y: 0, biome: 'meadow', passable: true, fine: { '0,0': 'river' } },
        ]);
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        // Ring order starts at (-1,-1) — the north-west corner
        expect(dryFineSpotDelta(world, mover)).toEqual([-1, -1]);
        expect(settleDryFineSpot(world, mover)).toBe(true);
        // The relocation landed on a dry cell
        expect(moverStandsOnDryGround(world, mover)).toBe(true);
        expect(world.subOf('a')).toEqual({ x: -1, y: -1 });
    });

    it('leaves an all-water interior alone and reports it', () => {
        // Every fine cell of the tile is water (a drowned shore interior)
        const drowned: Record<string, Biome> = {};
        for (let y = -1; y <= 1; y++) {
            for (let x = -1; x <= 1; x++) {
                drowned[`${x},${y}`] = 'lake';
            }
        }
        const world = worldOf([{ x: 0, y: 0, biome: 'meadow', passable: true, fine: drowned }]);
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        expect(dryFineSpotDelta(world, mover)).toBeNull();
        expect(settleDryFineSpot(world, mover)).toBe(false);
    });
});

// ── long walks (the T4 regression) ──────────────────────────────────────────

describe('R2 — a dry walk reaches its goal in a realistic bound', () => {
    /**
     * Walks the greedy planner + fineStep until arrival, mirroring the T4 walk
     * probe: relocate to the start tile, step to the tile centre, then plan and
     * apply until the goal tile is reached or the step budget runs out.
     */
    const walkTo = (
        world: ReturnType<typeof createWorld>,
        moverId: string,
        start: { x: number; y: number },
        goal: { x: number; y: number },
        budget: number,
    ): { arrived: boolean; steps: number } => {
        world.relocate(moverId, { x: start.x, y: start.y, z: 0 });
        const sub = world.subOf(moverId);
        world.relocateFine(moverId, 0 - (sub?.x ?? 0), 0 - (sub?.y ?? 0));
        const mover = world.actors.get(moverId)!;
        let steps = 0;
        while (steps < budget) {
            if (mover.position.x === goal.x && mover.position.y === goal.y) {
                return { arrived: true, steps };
            }
            const move = greedyFineStep(world, mover, goal.x, goal.y);
            if (!move || !fineStep(world, mover, move[0], move[1])) {
                return { arrived: false, steps };
            }
            world.relocateFine(moverId, move[0], move[1]);
            steps = steps + 1;
        }
        return { arrived: mover.position.x === goal.x && mover.position.y === goal.y, steps };
    };

    it('crosses the seed-7 river belt from the west shore (the 0/12 case)', () => {
        // T4 measured 0/12 arrivals here with the unbounded-goal route; the
        // pre-R2 tree needed 122-223 steps. The bound below is generous but
        // finite: the walk MUST arrive, which is what the defect violated.
        const handle = createIslandWorld({ seed: 7, plugins: { farming: false, sleep: false } });
        const moverId = [...handle.world.actors.values()][0].id;
        // Every start/goal pair T4 measured, all dry and all reachable
        const cases: Array<{ start: { x: number; y: number }; goal: { x: number; y: number } }> = [
            { start: { x: -7, y: 0 }, goal: { x: 0, y: 0 } },
            { start: { x: -6, y: -3 }, goal: { x: 0, y: 0 } },
            { start: { x: -5, y: -1 }, goal: { x: 1, y: 1 } },
        ];
        cases.forEach(({ start, goal }) => {
            const result = walkTo(handle.world, moverId, start, goal, 400);
            expect(result).toEqual({ arrived: true, steps: expect.any(Number) });
            // A realistic bound — no 600-step mill, and no absurd detour
            expect(result.steps).toBeLessThan(400);
        });
    });

    it('does not oscillate between two fine rows when the direct line is blocked', () => {
        // The T4 oscillation signature was a two-row ping-pong: fine (10,-8) ↔
        // (10,8) between (-7,1) and (-7,0). Sample the coarse tile sequence
        // over the first stretch and require monotone westward progress.
        const handle = createIslandWorld({ seed: 7, plugins: { farming: false, sleep: false } });
        const moverId = [...handle.world.actors.values()][0].id;
        const { world } = handle;
        world.relocate(moverId, { x: -7, y: 0, z: 0 });
        const sub = world.subOf(moverId);
        world.relocateFine(moverId, 0 - (sub?.x ?? 0), 0 - (sub?.y ?? 0));
        const mover = world.actors.get(moverId)!;
        const tiles: string[] = [];
        for (let index = 0; index < 120; index++) {
            const move = greedyFineStep(world, mover, 0, 0);
            if (!move || !fineStep(world, mover, move[0], move[1])) {
                break;
            }
            world.relocateFine(moverId, move[0], move[1]);
            const key = `${mover.position.x},${mover.position.y}`;
            if (tiles[tiles.length - 1] !== key) {
                tiles.push(key);
            }
        }
        // No tile is visited twice: a ping-pong would repeat the same pair
        expect(new Set(tiles).size).toBe(tiles.length);
        // …and the walk actually advanced east
        expect(mover.position.x).toBeGreaterThan(-7);
    });

    it('leaves a river tile’s dry bank pocket instead of milling (the T10 case)', () => {
        // T10 measured this EXACT seeded spot never leaving: tile (0,-4) is a
        // river tile whose fine interior holds 309 wet cells of 425, and the
        // body's derived bank spot (-12,-8) sits in a pocket whose only dry
        // ground is 3 steps away across a tile boundary. The coarse hop
        // pointed at (0,-3), which the dry walk needs >32768 nodes to reach,
        // so the ladder milled (-8,-4) ↔ (-7,-4) for the full 6000 minutes.
        //
        // The fix (fineRouteOut) routes to ANY dry cell of walkable ground, so
        // the body must leave within a handful of minutes. Each spot below is
        // a real seeded bank cell, not a synthetic grid.
        const spots: Array<{ tile: { x: number; y: number }; fine: { x: number; y: number } }> = [
            { tile: { x: 0, y: -4 }, fine: { x: -12, y: -8 } },
            { tile: { x: 0, y: -4 }, fine: { x: -11, y: -8 } },
        ];
        spots.forEach((spot) => {
            const handle = createIslandWorld({ seed: 7 });
            const { world } = handle;
            const mover = [...world.actors.values()][0];
            world.relocate(mover.id, { x: spot.tile.x, y: spot.tile.y, z: 0 });
            const sub = world.subOf(mover.id)!;
            world.relocateFine(mover.id, spot.fine.x - sub.x, spot.fine.y - sub.y);
            // The bank spot itself is dry — the pocket is legal ground
            expect(moverStandsOnDryGround(world, mover)).toBe(true);
            // Step until the body reaches COARSE-WALKABLE ground (real land,
            // not another river tile's bank) or the bound runs out. Every
            // intermediate landing must be dry — the exit is a dry walk.
            let arrivedAt = -1;
            let wetLandings = 0;
            for (let minute = 0; minute < 30 && arrivedAt < 0; minute++) {
                world.step();
                if (!moverStandsOnDryGround(world, mover)) {
                    wetLandings = wetLandings + 1;
                }
                if (isWalkableCell(world.cellAt(mover.position.x, mover.position.y))) {
                    arrivedAt = minute;
                }
            }
            // Measured: minute 3 (the pocket's dry path leaves the river tile
            // at minute 1 and reaches meadow at minute 3). The bound is small
            // and finite — it fails hard on the 6000-minute mill it replaces.
            expect(arrivedAt).toBeGreaterThanOrEqual(0);
            expect(arrivedAt).toBeLessThan(10);
            // The whole exit stayed on dry ground — no wet landing ever
            expect(wetLandings).toBe(0);
        });
    });
});

// ── structures ──────────────────────────────────────────────────────────────
describe('R2 — structure collision is preserved', () => {
    it('still refuses a walled fine cell and still allows the gate', () => {
        // The R2 water rule sits BESIDE the construction blocker, never in
        // place of it: a completed footprint walls its cells off exactly as
        // before (fineSpotTaken reads world.structures).
        const world = worldOf([{ x: 0, y: 0, biome: 'meadow', passable: true }]);
        world.structures = {
            blocksFineSpot: (tileX, tileY, sx, sy) =>
                tileX === 0 && tileY === 0 && sx === 1 && sy === 0,
        };
        const mover = placeMover(world, 'a', 0, 0, 0, 0);
        // The walled cell is refused…
        expect(fineStep(world, mover, 1, 0)).toBeUndefined();
        // …while the open gate cell beside it stays usable
        expect(fineStep(world, mover, 0, -1)).toEqual({ parent: { dx: 0, dy: 0 } });
    });
});
