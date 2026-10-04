// Tests for the needs display adapter (features/needsDisplay.ts).

import { describe, it, expect } from 'vitest';
import { needsDisplay } from './needsDisplay';

describe('needsDisplay', () => {
    it('inverts hunger/thirst pressure into wellbeing; energy passes through', () => {
        // Starting state: a little hungry (20 pressure) → 80 fullness
        expect(needsDisplay({ hunger: 20, thirst: 20, energy: 100 })).toEqual({
            fullness: 80,
            hydration: 80,
            energy: 100,
        });
    });

    it('a starving, dehydrated, exhausted actor shows empty bars', () => {
        expect(needsDisplay({ hunger: 100, thirst: 100, energy: 0 })).toEqual({
            fullness: 0,
            hydration: 0,
            energy: 0,
        });
    });

    it('a perfectly fed actor shows full bars', () => {
        expect(needsDisplay({ hunger: 0, thirst: 0, energy: 100 })).toEqual({
            fullness: 100,
            hydration: 100,
            energy: 100,
        });
    });

    it('fractional pressure inverts exactly', () => {
        // After three 10-min default ticks: hunger 23, thirst 24.5, energy 98.2
        expect(needsDisplay({ hunger: 23, thirst: 24.5, energy: 98.20000000000002 })).toEqual({
            fullness: 77,
            hydration: 75.5,
            energy: 98.20000000000002,
        });
    });
});
