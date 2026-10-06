// App — creates the island world and shows the god-view. The world is
// REPLACEABLE at runtime: the header's Reroll button (features/
// worldControls.tsx) swaps in a brand-new island with a fresh random seed.

import { useState } from 'react';
import { createIslandWorld, type IslandHandle } from './scenario';
import type { IslandTerrainOptions } from './plugins/terrain/islandTerrain';
import { Dashboard } from './features/dashboard';

/** Upper bound of a rolled seed (0..999999) — six digits, reads well in the header. */
const SEED_ROLL_RANGE = 1000000;

export function App(
    { seed, terrain }: { seed?: number; terrain?: IslandTerrainOptions } = {},
) {
    // One world per App mount, built ONCE (the useState initializer never
    // re-runs). The INITIAL mount rolls a completely random seed — a fresh
    // island (terrain, resources, agents, the bird) every time; the rolled
    // seed shows in the header subtitle. Pin `seed` to reproduce a run
    // exactly (tests and stories do: <App seed={7} /> renders the
    // deterministic seed-7 island the whole suite asserts against). Pin
    // `terrain` to pin the initial grid size too (the default is the 25×17
    // island; the god can roll a new one through the header's World Size
    // control — see reroll below).
    const [island, setIsland] = useState<IslandHandle>(() =>
        createIslandWorld({ seed: seed ?? Math.floor(Math.random() * SEED_ROLL_RANGE), terrain }),
    );

    // Reroll — swap in a BRAND-NEW island: a fresh random seed EVERY click
    // (the pinned `seed` prop only pins the initial mount), generated at
    // the picked size merged over any pinned terrain options. The outgoing
    // world's AUTO loop is stopped first — pause() cancels its pending
    // animation frame (packages/godspace/core src/engine/ticker.ts) so no
    // ghost loop keeps stepping a world nobody renders anymore.
    const reroll = (size?: IslandTerrainOptions) => {
        island.world.ticker.pause();
        setIsland(createIslandWorld({
            seed: Math.floor(Math.random() * SEED_ROLL_RANGE),
            terrain: { ...terrain, ...size },
        }));
    };

    return <Dashboard island={island} onReroll={reroll} />;
}
