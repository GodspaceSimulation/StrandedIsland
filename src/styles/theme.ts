// God-view theme — palette + semantic color maps.
// Biome colors drive the world grid cells; condition/need colors drive the
// status bars. Kept as plain constants (no CSS-in-JS theme machinery needed).

import type { Biome } from '../engine/types';

/** Cell fill per biome — the voxel surface the god sees from above. */
export const BIOME_COLORS: Record<Biome, string> = {
    ocean: '#173a52',
    shallows: '#265d7d',
    beach: '#d3bd85',
    meadow: '#5f9450',
    forest: '#2e6b37',
    highland: '#8d939e',
};

/** Actor condition dot / badge colors. */
export const CONDITION_COLORS: Record<string, string> = {
    well: '#5cb85c',
    weak: '#e0a839',
    critical: '#d9534f',
    gone: '#6b7280',
};

/**
 * Wellbeing bar colors — keyed by the DISPLAY metric (features/needsDisplay):
 * fullness (inverted hunger), hydration (inverted thirst), energy, health.
 * Health wears the wound red — the reservoir between the entity and death.
 */
export const NEED_COLORS: Record<string, string> = {
    fullness: '#d97b3f',
    hydration: '#3d9be9',
    energy: '#8bc34a',
    health: '#d9534f',
};

/** UI palette. */
export const PALETTE = {
    background: '#12161b',
    panel: '#1b222b',
    panelBorder: '#2b3542',
    text: '#e6e9ee',
    textDim: '#8fa3b8',
    accent: '#63b995',
    accentDim: '#2f6b5e',
    /**
     * The TILE-pick highlight — deliberately a different hue than the
     * ENTITY-pick `accent` (teal): a tile inspected for the Tile Inspector
     * wears amber on the canvas, a castaway selected for the Entity
     * Inspector wears teal, so the two selections never read as one.
     */
    tileAccent: '#c98a2d',
    danger: '#d9534f',
} as const;
