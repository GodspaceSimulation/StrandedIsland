// Seeded deterministic randomness for the simulation.
//
// @presource/core has arrayShuffle / objectShuffle but no seeded PRNG stream.
// Procedural generation and agent decisions must be reproducible from a seed
// (tests assert exact generated layouts), so a tiny mulberry32 PRNG lives here.

/** A PRNG stream: each call returns a deterministic float in [0, 1). */
export type RandomSource = () => number;

/** 4294967296 — 2^32, used to normalize the PRNG's uint32 output into [0,1). */
const UINT32_MAX_PLUS_ONE = 4294967296;

/**
 * Creates a deterministic PRNG stream (mulberry32) from an integer seed.
 * Two streams created from the same seed produce the exact same sequence.
 */
export const randomCreate = (seed: number): RandomSource => {
    // Force the seed into unsigned 32-bit space — mulberry32 operates on uint32
    let state = seed >>> 0;

    return () => {
        // Standard mulberry32 round: add a large odd constant, then two rounds
        // of imul-based scrambling to avalanche the bits.
        state = (state + 0x6d2b79f5) | 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / UINT32_MAX_PLUS_ONE;
    };
};

/**
 * Derives an independent PRNG stream from a seed plus a string key.
 * Used to give each plugin its own deterministic stream so plugin order can
 * change without shifting another plugin's randomness (djb2 string hash).
 */
export const randomKeyed = (seed: number, key: string): RandomSource => {
    // djb2 hash of the key, XOR-folded with the base seed
    let hash = 5381;
    for (let index = 0; index < key.length; index++) {
        hash = (Math.imul(hash, 33) ^ key.charCodeAt(index)) >>> 0;
    }
    return randomCreate((seed ^ hash) >>> 0);
};

/** Uniform float in [min, max). */
export const randomRange = (source: RandomSource, min: number, max: number): number =>
    min + source() * (max - min);

/** Uniform integer in [min, max], both ends inclusive. */
export const randomInteger = (source: RandomSource, min: number, max: number): number =>
    Math.floor(min + source() * (max - min + 1));

/** Uniform pick from a non-empty list. */
export const randomPick = <T>(source: RandomSource, list: T[]): T =>
    list[Math.floor(source() * list.length)];

/** True with the given probability (0..1). */
export const randomChance = (source: RandomSource, probability: number): boolean =>
    source() < probability;
