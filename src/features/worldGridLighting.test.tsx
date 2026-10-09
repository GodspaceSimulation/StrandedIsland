// Tests for the R5 day/night lighting in the god-view canvas
// (features/worldGrid.tsx) — the render half of the shared clock contract
// (scenario/dayCycle.ts, whose pure shape scenario/dayCycle.test.ts pins).
//
// What is pinned here, all exact:
//   wiring   — the canvas paints from the LIVE world clock: real
//              world.step() ticks move the badge minute by minute (the
//              bridge's revision pulse re-renders the grid per tick)
//   full day — daylight paints no veil (alpha 0); night paints the exact
//              0.65 floor; dusk/dawn land the exact rounded ramp values
//   phase    — the PhaseBadge flips exactly at 18:00 and 06:00, reads the
//              same clock face the World Ticker's calendar does, and its
//              title carries the exact ambient percentage
//   scales   — the veil is identical at the island view (scale 1) and the
//              tile interior (scale 0) — the ladder never re-times the
//              clock — and every tile canvas (unicode/svg/ascii) wears it
//   periodic — a full DAY_MINUTES of world time returns the exact birth
//              lighting (badge 10:00, veil alpha 0)
//   nonblock — the veil is pointer-events:none decoration: clicks pass
//              straight through at full night
//
// Clock-driving strategy: each test mounts <Dashboard island={island} />
// over a handle it owns (the App.test.tsx pattern) and moves the CLOCK
// through island.world.ticker — one tickSize-jumped step carries the exact
// elapsed world minutes the dayCycle contract consumes (the dial is
// restored to the 1-minute pace immediately). The lighting is a pure read
// of elapsed minutes, so the lighting tests drive the clock read itself;
// the wiring test below steps the REAL world.step() path end to end.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Dashboard } from './dashboard';
import { createIslandWorld, type IslandHandle } from '../scenario/island';
import { bumpRevision } from './worldBridge';

// Emotion rule reader — every CSS block styling the element's classes,
// concatenated (the styled factory emits a base block plus the prop-driven
// block inside a @media (min-width: 0px) wrapper; the reader walks them
// all, splitting the element's class list in case more than one Emotion
// class rides it — the App.test.tsx pattern).
const ruleFor = (className: string): string => {
    const all = Array.from(document.querySelectorAll('style'))
        .map((tag) => tag.textContent ?? '')
        .join('');
    let out = '';
    for (const single of className.split(/\s+/)) {
        const matcher = new RegExp(`\\.${single}\\b[^{]*\\{([^}]*)\\}`, 'g');
        let block = matcher.exec(all);
        while (block) {
            out += block[1];
            block = matcher.exec(all);
        }
    }
    return out;
};

// Drives the world clock forward WITHOUT running the simulation: one tick
// carries the whole jump (the ticker's tickSize dial — set, step, restore
// to the 1-minute pace), then the bridge pulse re-renders every panel.
const advance = (island: IslandHandle, minutes: number) => {
    act(() => {
        island.world.ticker.tickSize(minutes);
        island.world.ticker.step();
        island.world.ticker.tickSize(1);
        bumpRevision();
    });
};

const seedIsland = (): IslandHandle => createIslandWorld({ seed: 7 });

const renderBoard = (island: IslandHandle) =>
    render(<Dashboard island={island} onReroll={() => undefined} />);

describe('the canvas day/night lighting (R5)', () => {
    it('full daylight at the 10:00 birth — no veil, a Day badge, ambient 100 %', () => {
        const island = seedIsland();
        renderBoard(island);
        // Birth: elapsed 0 → minuteOfDay 600 (10:00) → the daylight plateau
        // → ambient 1 → veil alpha 0 (the wash paints nothing)
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Day · 10:00');
        expect(screen.getByTestId('daycycle-badge').getAttribute('title')).toBe(
            'Ambient light 100%',
        );
        const veil = screen.getByTestId('night-veil');
        expect(ruleFor(veil.className)).toContain('background:rgba(8,12,30,0)');
        // The veil is decorative: hidden from assistive tech, and its rule
        // carries pointer-events:none (never a pointer target)
        expect(veil.getAttribute('aria-hidden')).toBe('true');
        expect(ruleFor(veil.className)).toContain('pointer-events:none');
    });

    it('real world steps drive the lighting minute by minute (the revision-pulse wiring)', () => {
        const island = seedIsland();
        renderBoard(island);
        // Two REAL world.step() calls (ticker + every plugin tick, the same
        // path the Step button drives): each carries one world minute, and
        // the ticker subscription's bumpRevision re-renders the canvas
        act(() => {
            island.world.step();
            island.world.step();
            bumpRevision();
        });
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Day · 10:02');
        // Still the daylight plateau — the veil stays at alpha 0
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0)',
        );
    });

    it('the dusk ramp dims the board smoothly and 18:00 lands the exact night floor', () => {
        const island = seedIsland();
        renderBoard(island);
        // 17:15 — the dusk midpoint (minuteOfDay 1035, smoothstep t 0.5):
        // ambient 0.675 → veil alpha 0.325, the phase still reads Day
        advance(island, 435);
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Day · 17:15');
        expect(screen.getByTestId('daycycle-badge').getAttribute('title')).toBe(
            'Ambient light 68%',
        );
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0.325)',
        );
        // 18:00 — the night boundary: ambient === NIGHT_LIGHT_FLOOR (0.35)
        // → veil alpha 0.65, and the badge flips to Night
        advance(island, 45);
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Night · 18:00');
        expect(screen.getByTestId('daycycle-badge').getAttribute('title')).toBe(
            'Ambient light 35%',
        );
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0.65)',
        );
    });

    it('the night floor holds through the night; dawn reverses the ramp minute by minute', () => {
        const island = seedIsland();
        renderBoard(island);
        advance(island, 1199); // 05:59 — the night's last minute
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Night · 05:59');
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0.65)',
        );
        // 06:00 — the badge flips to Day while the veil still sits at the
        // floor (the dawn ramp's first minute has not moved yet)
        advance(island, 1);
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Day · 06:00');
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0.65)',
        );
        // 06:45 — the dawn midpoint (t 0.5): ambient 0.675 → alpha 0.325
        advance(island, 45);
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Day · 06:45');
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0.325)',
        );
        // 07:30 — full daylight again, the veil gone
        advance(island, 45);
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Day · 07:30');
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0)',
        );
    });

    it('the lighting is exactly periodic — a full day later the veil is gone again', () => {
        const island = seedIsland();
        renderBoard(island);
        // A whole day of world minutes lands back on the 10:00 face — the
        // night veil folds away exactly as at the birth minute
        advance(island, 1440);
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Day · 10:00');
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0)',
        );
    });

    it('the veil is identical at the island view and the tile interior — the ladder never re-times the clock', () => {
        const island = seedIsland();
        renderBoard(island);
        advance(island, 480); // 18:00 — full night floor
        // Zoom into Ael's shore tile: scale 0, the tile interior
        fireEvent.click(screen.getByTestId('unicode-tile--11-0'));
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 0');
        // The interior veil paints the SAME alpha from the SAME clock read
        expect(screen.getByTestId('daycycle-badge').textContent).toBe('Night · 18:00');
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0.65)',
        );
        // Back out to the island — unchanged
        fireEvent.click(screen.getByTestId('zoom-toggle'));
        expect(screen.getByTestId('scale-badge').textContent).toBe('Scale 1');
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0.65)',
        );
    });

    it('every tile canvas wears the veil — the SVG twin paints the same rgba, the ascii twin the same class rule', () => {
        const island = seedIsland();
        renderBoard(island);
        advance(island, 480); // 18:00 — full night floor
        // The SVG board: one full-viewBox rect carrying the identical fill
        // string the DOM veil computes, decorative and nonblocking
        fireEvent.click(screen.getByTestId('canvas-tab-svg'));
        const svgVeil = screen.getByTestId('night-veil-svg');
        expect(svgVeil.getAttribute('fill')).toBe('rgba(8,12,30,0.65)');
        expect(svgVeil.getAttribute('aria-hidden')).toBe('true');
        // T5 fix — an SVG element's `className` property is an
        // SVGAnimatedString object (never a string), so the class-list read
        // goes through the `class` ATTRIBUTE (the same string the styled
        // factory emitted). The assertion's intent is unchanged.
        expect(ruleFor(svgVeil.getAttribute('class') ?? '')).toContain('pointer-events:none');
        // The ASCII board: the same DOM wash with the same class rule
        fireEvent.click(screen.getByTestId('canvas-tab-ascii'));
        expect(ruleFor(screen.getByTestId('night-veil').className)).toContain(
            'background:rgba(8,12,30,0.65)',
        );
        // Back to daylight on the SVG board — the fill drains to alpha 0
        // (the tab is remounted first: the veil element above was detached
        // when the ascii tab replaced it)
        advance(island, 960); // 480 + 960 = 1440 — the next 10:00
        fireEvent.click(screen.getByTestId('canvas-tab-svg'));
        expect(screen.getByTestId('night-veil-svg').getAttribute('fill')).toBe('rgba(8,12,30,0)');
    });

    it('the veil never blocks the board — a click under full night still opens the Entity Inspector', () => {
        const island = seedIsland();
        renderBoard(island);
        advance(island, 480); // 18:00 — full night floor (the darkest the veil paints)
        // The veil IS rendered over the board — yet the click lands
        // straight through it (pointer-events:none): Ael's tile still
        // opens the Entity Inspector
        expect(screen.getByTestId('night-veil')).toBeDefined();
        fireEvent.click(screen.getByTestId('unicode-tile--11-0'));
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
    });
});
