// App — creates the island world once per mount and shows the god-view.

import { useState } from 'react';
import { createIslandWorld, type IslandHandle } from './scenario';
import type { IslandTerrainOptions } from './plugins/terrain/islandTerrain';
import { Dashboard } from './features/dashboard';

/** Upper bound of a rolled seed (0..999999) — six digits, reads well in the header. */
const SEED_ROLL_RANGE = 1000000;

export function App(
    { seed, terrain }: { seed?: number; terrain?: IslandTerrainOptions } = {},
) {
    // One world per App mount. EVERY reload rolls a completely random seed:
    // a fresh island (terrain, resources, agents, the bird) every time — the
    // rolled seed shows in the header subtitle. Pin `seed` to reproduce a
    // run exactly (tests and stories do: <App seed={7} /> renders the
    // deterministic seed-7 island the whole suite asserts against). Pin
    // `terrain` to pin the grid size too (the default is the 37×25 island;
    // the god can reshape it live through the World Size controls).
    const [island] = useState<IslandHandle>(() =>
        createIslandWorld({ seed: seed ?? Math.floor(Math.random() * SEED_ROLL_RANGE), terrain }),
    );

    return <Dashboard island={island} />;
}
