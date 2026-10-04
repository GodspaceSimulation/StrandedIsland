// Engine ↔ React bridge.
//
// The simulation is framework-free; the god-view subscribes through two
// `signalState` handles from @presource/react:
//   worldSignal   — the mounted IslandHandle (set once per app mount)
//   revisionSignal— a counter bumped on every world event / tick; components
//                   read it in render so any world change re-renders them
//   selectionSignal — which actor the god is inspecting
//
// Components call useWorld() / useRevision() during render to subscribe;
// the engine calls bumpRevision() from its own callbacks (never during
// render), which is exactly the writer/reader split signalState supports.

import { signalState } from '@presource/react';
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

/** Mounts an island into the god-view (re-mounting swaps the world). */
export const mountWorld = (island: IslandHandle) => {
    worldSignal.value(island);
    selectionSignal.value(null);
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
