// Needs display adapter — inverts survival pressure into wellbeing bars.
//
// The engine tracks hunger/thirst as PRESSURE: 100 = dying, 0 = fine
// (needsPlugin thresholds, behavior triggers and doom counting all read
// that direction). The god-view shows wellbeing bars where a FULL bar is
// good and an EMPTY bar is bad, so the values are inverted at display time:
//
//   hunger  (pressure) → fullness   = 100 − hunger   (100 = full belly)
//   thirst  (pressure) → hydration  = 100 − thirst   (100 = hydrated)
//   energy             → energy     = unchanged      (100 = rested)
//
// Terminology note: "hydrate" is the verb; "hydration" is the measurable
// state (standard physiological usage), so the thirst bar is labelled
// Hydration. The hunger bar is labelled Fullness.

export type NeedsState = {
    hunger: number;
    thirst: number;
    energy: number;
};

export type NeedsDisplay = {
    /** 100 = full belly, 0 = starving. */
    fullness: number;
    /** 100 = fully hydrated, 0 = dying of thirst. */
    hydration: number;
    /** 100 = rested, 0 = collapsing. Already wellbeing-oriented. */
    energy: number;
};

/** Converts engine need pressure into wellbeing display values. */
export const needsDisplay = (state: NeedsState): NeedsDisplay => ({
    fullness: 100 - state.hunger,
    hydration: 100 - state.thirst,
    energy: state.energy,
});
