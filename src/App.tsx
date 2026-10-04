// App — creates the island world once per mount and shows the god-view.

import { useState } from 'react';
import { createIslandWorld, type IslandHandle } from './scenario';
import { Dashboard } from './features/dashboard';

export function App() {
    // One world per App mount. The seed makes the whole run — terrain,
    // resources, agent choices — reproducible.
    const [island] = useState<IslandHandle>(() => createIslandWorld({ seed: 7 }));

    return <Dashboard island={island} />;
}
