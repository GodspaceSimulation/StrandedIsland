// Engine ↔ React bridge.
//
// The simulation is framework-free; the god-view subscribes through
// `signalState` handles from @presource/react:
//   worldSignal   — the mounted IslandHandle (set once per app mount)
//   revisionSignal— a counter bumped on every world event / tick; components
//                   read it in render so any world change re-renders them
//   selectionSignal — which actor the god is inspecting
//   tileSignal      — which canvas tile the god is inspecting (any tile,
//                     not just one that holds an actor)
//   scaleSignal     — the view scale the god zoomed to (mirrors the island's
//                     @godspace/core scale system — 0 the LOWEST level, the
//                     tile interior where the simulation runs; 1 the island,
//                     the default view; see features/tileDetails)
//
// Components call useWorld() / useRevision() during render to subscribe;
// the engine calls bumpRevision() from its own callbacks (never during
// render), which is exactly the writer/reader split signalState supports.

import { signalState } from '@presource/react';
import type { TilePath } from '@godspace/core';
import type { IslandHandle } from '../scenario/island';

/**
 * The runtime contract of a signalState accessor: calling it during render
 * subscribes and reads; calling `.value(updated)` from anywhere writes
 * without subscribing. The stock SignalState type types `.value` as a pure
 * reader, but the implementation (packages/presource/react/src/hooks/global/
 * signal-state.ts, valueFunction) accepts a new value — the cast makes that
 * honest for TypeScript.
 */
type SignalAccessor<T> = {
    (updated?: T | ((input: T) => void)): T;
    value: (updated?: T) => T;
};

const asAccessor = <T>(signal: ReturnType<typeof signalState<T>>): SignalAccessor<T> =>
    signal as unknown as SignalAccessor<T>;

/** The mounted island, or null before mounting. */
const worldSignal = asAccessor<IslandHandle | null>(signalState<IslandHandle | null>(null));

/** Bumped on every world event and tick — the re-render pulse. */
const revisionSignal = asAccessor<number>(signalState<number>(0));

/** Currently inspected actor id, or null. */
const selectionSignal = asAccessor<string | null>(signalState<string | null>(null));

/**
 * The inspected tile's address down the recursive tile ladder
 * (@godspace/core src/subtile): path[0] the island tile, path[1] the
 * subtile within it — the full zoom lineage, so any depth is inspectable
 * exactly like the root. Null when no tile is under inspection.
 */
const tileSignal = asAccessor<TilePath | null>(signalState<TilePath | null>(null));

/**
 * The view scale the god zoomed the canvas to — the render mirror of the
 * mounted island's scale system (@godspace/core src/scale). Scale 0 is the
 * ladder's LOWEST level — the tile interior, where the simulation runs (the
 * entities move around here); scale 1 is the island, THE DEFAULT VIEW,
 * showing where the Scale-0 entities stand (features/tileDetails.ts
 * scaleView resolves the slice).
 */
const scaleSignal = asAccessor<number>(signalState<number>(1));

/** Mounts an island into the god-view (re-mounting swaps the world). */
export const mountWorld = (island: IslandHandle) => {
    worldSignal.value(island);
    selectionSignal.value(null);
    tileSignal.value(null);
    // A fresh world mounts at its default view — the ISLAND (scale 1, the
    // ladder's top; the scale system starts there via its `view` option)
    scaleSignal.value(island.scale.current());
    bumpRevision();
};

/** Read during render to subscribe to world swaps. */
export const useWorld = (): IslandHandle | null => worldSignal();

/** Read during render to subscribe to every world change. */
export const useRevision = (): number => revisionSignal();

/** Engine-side pulse: call after any world change. */
export const bumpRevision = () => {
    revisionSignal.value(revisionSignal.value() + 1);
};

/** Read during render to subscribe to selection changes. */
export const useSelection = (): string | null => selectionSignal();

/** God selects an actor to inspect (null clears). */
export const selectActor = (actorId: string | null) => {
    selectionSignal.value(actorId);
};

/** Read during render to subscribe to tile selection changes. */
export const useTile = (): TilePath | null => tileSignal();

/** God selects a tile to inspect by its full path (null clears). */
export const selectTile = (path: TilePath | null) => {
    // Copy on write — callers may keep mutating their path array
    tileSignal.value(path ? [...path] : null);
};

/** Read during render to subscribe to view-scale changes. */
export const useScale = (): number => scaleSignal();

/**
 * Runs a move on the mounted island's scale system and mirrors the result
 * into the signal — the system owns the clamping and the anchor, the signal
 * only carries what the view renders.
 */
const moveScale = (move: (island: IslandHandle) => number) => {
    const island = worldSignal.value();
    if (!island) {
        return;
    }
    scaleSignal.value(move(island));
};

/**
 * God zooms IN: the view descends one level into the inspected tile (its
 * sub-grid becomes the board — same dimensions, the recursive tiling rule)
 * and the god inspects that sub-grid's center tile. The scale number DROPS
 * (the ladder counts up from the lowest level — scale 1 the island → scale
 * 0 the tile interior). Needs an inspected tile — it is the zoom target —
 * and a reachable rung on the island's scale ladder.
 */
export const zoomIn = () => {
    const island = worldSignal.value();
    const path = tileSignal.value();
    if (!island || !path || !island.scale.canZoomIn()) {
        return;
    }
    // Center tile of an odd centered grid is exactly (0, 0)
    tileSignal.value([...path, { x: 0, y: 0 }]);
    scaleSignal.value(island.scale.zoomIn());
};

/**
 * God zooms OUT one level: the inspected subtile pops off the path — the
 * parent tile becomes the inspected tile of the wider view (the zoom
 * lineage stays intact, so zooming back in returns where the god was). The
 * scale number CLIMBS (0 the tile interior → 1 the island).
 */
export const zoomOut = () => {
    const island = worldSignal.value();
    const path = tileSignal.value();
    if (!island || !path || path.length <= 1 || !island.scale.canZoomOut()) {
        return;
    }
    tileSignal.value(path.slice(0, -1));
    scaleSignal.value(island.scale.zoomOut());
};

/**
 * God toggles the view ladder — THE ONE zoom control (this engine's ladder
 * only has two rungs: 1 the island, the default view, and 0 the tile
 * interior). At the island view the toggle zooms IN (needs an inspected
 * tile — it is the zoom target, same contract zoomIn has); anywhere below
 * it zooms OUT. The direction is read off the mounted island's own scale
 * system, so the signal never drifts from the engine's clamps.
 */
export const toggleZoom = () => {
    const island = worldSignal.value();
    if (!island) {
        return;
    }
    if (island.scale.canZoomOut()) {
        zoomOut();
    } else {
        zoomIn();
    }
};
