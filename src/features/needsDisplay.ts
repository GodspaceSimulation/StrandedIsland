// Needs display adapter — inverts survival pressure into wellbeing bars.
//
// The engine tracks hunger/thirst as PRESSURE: 100 = dying, 0 = fine
// (needsPlugin thresholds, behavior triggers and starvation damage all read
// that direction). The god-view shows wellbeing bars where a FULL bar is
// good and an EMPTY bar is bad, so the values are inverted at display time:
//
//   hunger  (pressure) → fullness   = 100 − hunger   (100 = full belly)
//   thirst  (pressure) → hydration  = 100 − thirst   (100 = hydrated)
//   energy             → energy     = unchanged      (100 = rested)
//   health             → health     = unchanged      (100 = healthy — the
//                       reservoir between the entity and death; at 0 the
//                       entity dies, plugins/needs)
//
// Terminology note: "hydrate" is the verb; "hydration" is the measurable
// state (standard physiological usage), so the thirst bar is labelled
// Hydration. The hunger bar is labelled Fullness.
//
// EVERY entity reads through this adapter: the needs plugin tracks the
// survival stats of all living things (plugins/needs/needsPlugin.ts), so
// the roster's birds, sharks and boars display the same four bars as the
// castaways.

export type NeedsState = {
    hunger: number;
    thirst: number;
    energy: number;
    /** Wellbeing reservoir — 100 = healthy, 0 = dead. */
    health: number;
};

export type NeedsDisplay = {
    /** 100 = full belly, 0 = starving. */
    fullness: number;
    /** 100 = fully hydrated, 0 = dying of thirst. */
    hydration: number;
    /** 100 = rested, 0 = collapsing. Already wellbeing-oriented. */
    energy: number;
    /** 100 = healthy, 0 = dying of wounds. Already wellbeing-oriented. */
    health: number;
};

/** Converts engine need pressure into wellbeing display values. */
export const needsDisplay = (state: NeedsState): NeedsDisplay => ({
    fullness: 100 - state.hunger,
    hydration: 100 - state.thirst,
    energy: state.energy,
    health: state.health,
});

/**
 * The condition ladder read off the WELLBEING values — the same thresholds
 * the needs plugin's conditionOf applies to the pressure, inverted:
 * fullness/hydration ≤ 10 (pressure ≥ 90) or energy/health ≤ 10/25 →
 * critical; ≤ 30 (pressure ≥ 70) or energy/health ≤ 25/50 → weak;
 * otherwise well. Creatures carry no condition on their record (their
 * facet state is plugin-owned, e.g. a bird's altitude band), so the roster
 * derives the dot here.
 */
export const displayConditionOf = (
    state: NeedsDisplay,
): 'well' | 'weak' | 'critical' => {
    if (state.fullness <= 10 || state.hydration <= 10 || state.energy <= 10 || state.health <= 25) {
        return 'critical';
    }
    if (state.fullness <= 30 || state.hydration <= 30 || state.energy <= 25 || state.health <= 50) {
        return 'weak';
    }
    return 'well';
};
