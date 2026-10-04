// Procedural voxel island generation (the canvas).
//
// The island is a width × height grid of voxel columns. Each column is built
// from a heightmap driven by two octaves of seeded value noise (lattice +
// bilinear + smoothstep) shaped by a radial falloff so the center rises above
// the water line and the edges fall into the sea — a small island.
//
// Everything is deterministic: the same seed produces the exact same island,
// which is what the tests assert. `@presource/core` has no seeded PRNG, so the
// stream comes from engine/random.ts (mulberry32).

import { randomCreate, type RandomSource } from '../../engine/random';
import type { Biome, Canvas, TerrainCell, VoxelKind } from '../../engine/types';
import type { PluginContext, WorldPlugin } from '../../engine/plugin';

export type IslandTerrainOptions = {
    /** Grid width in cells. Default 12. */
    width?: number;
    /** Grid height in cells. Default 10. */
    height?: number;
    /** PRNG seed. Defaults to the world seed (passed by the plugin setup). */
    seed?: number;
    /** Water line in voxel units — columns strictly below are underwater. Default 3. */
    seaLevel?: number;
    /** Tallest possible ground column in voxels. Default 8. */
    maxHeight?: number;
    /** 0..1 — how much the raw noise (vs the radial falloff) shapes height. Default 0.55. */
    roughness?: number;
};

export type IslandStats = {
    land: number;
    water: number;
    forest: number;
};

/**
 * Lattice value noise with bilinear interpolation and a smoothstep fade.
 * Returns a sampler function `(x, y) → [0, 1]` over the grid dimensions.
 */
const latticeNoise = (
    random: RandomSource,
    width: number,
    height: number,
    scale: number,
): ((x: number, y: number) => number) => {
    // Lattice resolution: one random value per `scale` cells, +1 for the edge
    const columns = Math.ceil(width / scale) + 1;
    const rows = Math.ceil(height / scale) + 1;
    const lattice: number[] = [];
    for (let index = 0; index < columns * rows; index++) {
        lattice.push(random());
    }

    return (x, y) => {
        // Continuous lattice position
        const gx = x / scale;
        const gy = y / scale;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        // Clamp so edge cells interpolate against the last lattice column
        const x1 = Math.min(x0 + 1, columns - 1);
        const y1 = Math.min(y0 + 1, rows - 1);
        // Smoothstep fade removes the bilinear "diamond" artifacts
        const tx = gx - x0;
        const ty = gy - y0;
        const fx = tx * tx * (3 - 2 * tx);
        const fy = ty * ty * (3 - 2 * ty);

        const topRow = y0 * columns;
        const bottomRow = y1 * columns;
        const top = lattice[topRow + x0] * (1 - fx) + lattice[topRow + x1] * fx;
        const bottom = lattice[bottomRow + x0] * (1 - fx) + lattice[bottomRow + x1] * fx;
        return top * (1 - fy) + bottom * fy;
    };
};

/**
 * Derives the biome from the surface situation of a column.
 * `depth` is how many water voxels sit above the seabed.
 */
const deriveBiome = (
    surface: VoxelKind,
    submerged: boolean,
    depth: number,
    forested: boolean,
): Biome => {
    if (submerged) {
        // Deep water (more than 1 voxel of water above the seabed) = ocean
        return depth > 1 ? 'ocean' : 'shallows';
    }
    if (forested) {
        return 'forest';
    }
    if (surface === 'stone') {
        return 'highland';
    }
    if (surface === 'sand') {
        return 'beach';
    }
    return 'meadow';
};

/**
 * Generates the island canvas. Pure: same options → same canvas.
 */
export const generateIsland = (
    options: IslandTerrainOptions = {},
): Canvas & { stats: IslandStats } => {
    const width = options.width ?? 12;
    const height = options.height ?? 10;
    const seaLevel = options.seaLevel ?? 3;
    const maxHeight = options.maxHeight ?? 8;
    const roughness = options.roughness ?? 0.55;
    const random = randomCreate(options.seed ?? 1);

    // Two noise octaves (coastline shape + local bumps) and a moisture map
    // that decides where forests grow on grass
    const coarse = latticeNoise(random, width, height, 4);
    const fine = latticeNoise(random, width, height, 2);
    const moisture = latticeNoise(random, width, height, 3);

    const cells: TerrainCell[] = [];
    const stats: IslandStats = { land: 0, water: 0, forest: 0 };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // Normalized position −1..1 from the island center
            const centerX = (width - 1) / 2 || 1;
            const centerY = (height - 1) / 2 || 1;
            const nx = (x - centerX) / centerX;
            const ny = (y - centerY) / centerY;
            // Elliptical distance, 0 at center → 1 at the rim (clamped);
            // corners overshoot and clamp, edge midpoints sit exactly at 1
            const distance = Math.min(1, Math.sqrt(nx * nx + ny * ny));
            // Radial falloff: 1 at the center → 0 at the rim, squared so the
            // beach ring is wide and the peak is concentrated
            const falloff = 1 - distance * distance;

            // Height: noise shaped by falloff, clamped to 0..1
            const noise = coarse(x, y) * 0.65 + fine(x, y) * 0.35;
            const blended = Math.max(0, Math.min(1, noise * roughness + falloff * (1 - roughness)));
            // Ground height in voxels: 0 (seafloor) … maxHeight (peak)
            const groundHeight = Math.round(blended * maxHeight);

            // Classify the surface. A column exactly at the water line is a
            // dry sandbar (walkable); only columns strictly below it are
            // submerged with water stacked up to the sea level.
            const submerged = groundHeight < seaLevel;
            // Surface ladder: seabed sand → sandbar/beach sand (sea level and
            // one above) → grass meadow → stone highland at the peaks
            const surface: VoxelKind = submerged
                ? 'sand'
                : groundHeight >= seaLevel + 4
                  ? 'stone'
                  : groundHeight <= seaLevel + 1
                    ? 'sand'
                    : 'grass';
            // Forests only grow on grass with enough moisture
            const forested = surface === 'grass' && moisture(x, y) > 0.6;

            // Build the voxel stack, bottom → top:
            //   stone × (ground-2), soil × 1, surface × 1,
            //   then water up to the sea level (submerged columns),
            //   then a forest voxel when wooded
            const stack: VoxelKind[] = [];
            if (groundHeight >= 3) {
                for (let index = 0; index < groundHeight - 2; index++) {
                    stack.push('stone');
                }
            }
            if (groundHeight >= 2) {
                stack.push('soil');
            }
            stack.push(surface);
            const depth = submerged ? seaLevel - groundHeight : 0;
            for (let index = 0; index < depth; index++) {
                stack.push('water');
            }
            if (forested) {
                stack.push('forest');
            }

            const biome = deriveBiome(surface, submerged, depth, forested);
            if (submerged) {
                stats.water = stats.water + 1;
            } else {
                stats.land = stats.land + 1;
                if (forested) {
                    stats.forest = stats.forest + 1;
                }
            }

            cells.push({
                x,
                y,
                voxels: stack,
                height: groundHeight,
                waterLevel: seaLevel,
                biome,
                // Water columns are impassable; everything dry is walkable
                passable: !submerged,
            });
        }
    }

    return { width, height, cells, stats };
};

/**
 * The terrain plugin — installs the island as the world's canvas in `setup`.
 * Re-running `setup` (by removing/re-adding the plugin) regenerates it.
 * `stats()` reports the last generated island's composition.
 */
export const islandTerrainPlugin = (options: IslandTerrainOptions = {}): WorldPlugin & { stats(): IslandStats | undefined } => {
    // Last generation stats, exposed for the god-view roster
    let lastStats: IslandStats | undefined;

    return {
        id: 'island-terrain',
        label: 'Island Terrain',
        setup: (context: PluginContext) => {
            // Default seed: the world seed, so one global seed drives everything
            const generated = generateIsland({
                seed: options.seed ?? context.world.seed,
                width: options.width,
                height: options.height,
                seaLevel: options.seaLevel,
                maxHeight: options.maxHeight,
                roughness: options.roughness,
            });
            context.world.canvas = {
                width: generated.width,
                height: generated.height,
                cells: generated.cells,
            };
            lastStats = generated.stats;
        },
        stats: () => lastStats,
    };
};
