// App — creates the island world once per mount and shows the god-view.

import { useState } from 'react';
import { createIslandWorld, type IslandHandle } from './scenario';
import { Dashboard } from './features/dashboard';

/** Upper bound of a rolled seed (0..999999) — six digits, reads well in the header. */
const SEED_ROLL_RANGE = 1000000;

export function App({ seed }: { seed?: number } = {}) {
    // One world per App mount. EVERY reload rolls a completely random seed:
    // a fresh island (terrain, resources, agents, the bird) every time — the
    // rolled seed shows in the header subtitle. Pin `seed` to reproduce a
    // run exactly (tests and stories do: <App seed={7} /> renders the
    // deterministic seed-7 island the whole suite asserts against).
    const [island] = useState<IslandHandle>(() =>
        createIslandWorld({ seed: seed ?? Math.floor(Math.random() * SEED_ROLL_RANGE) }),
    );

    return <Dashboard island={island} />;
}
