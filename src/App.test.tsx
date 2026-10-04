// Tests for the god-view App (src/App.tsx).
// Renders the full dashboard against the deterministic seed-7 island.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { App } from './App';

describe('App', () => {
    it('renders the god view with title, clock and the full island grid', () => {
        render(<App />);
        expect(screen.getByRole('heading', { name: /stranded island/i })).toBeDefined();
        // Seed 7, tickSize 10 — the clock starts at day 1, 00:00
        expect(screen.getByTestId('world-clock').textContent).toBe('Day 1 · 00:00');
        // Default island is 12×10 = 120 voxel cells
        expect(screen.getByTestId('world-grid').children.length).toBe(120);
        // All four castaways are on the board
        expect(screen.getByTestId('actor-chip-Ael').textContent).toContain('Ael');
        expect(screen.getByTestId('actor-chip-Bram').textContent).toContain('Bram');
        expect(screen.getByTestId('actor-chip-Cove').textContent).toContain('Cove');
        expect(screen.getByTestId('actor-chip-Dune').textContent).toContain('Dune');
        // The plugin roster shows the mounted environment modules — the
        // seabirds plugin plus the @godspace/canvas ASCII representation
        expect(screen.getByTestId('plugin-roster').textContent).toBe(
            'Island Terrain · Inventories & Exchange · Survival Needs · Relationships · Agent Behavior · Seabirds · ASCII Canvas',
        );
        // Kiki the gull wheels above the island center (6,5) at z 2 — the
        // ASCII canvas renders her altitude as a superscript glyph
        const grid = screen.getByTestId('world-grid');
        expect((grid.children[66] as HTMLElement).textContent).toBe('K²');
        expect((grid.children[66] as HTMLElement).title).toContain('Kiki · flying · z 2');
        // Ael stands grounded on (6,0) — plain glyph, no altitude
        expect((grid.children[6] as HTMLElement).textContent).toBe('A');
        expect((grid.children[6] as HTMLElement).title).toContain('Ael · well');
    });

    it('every castaway row carries the compact 3-bar wellbeing overview', () => {
        render(<App />);
        // Starting needs: hunger 20, thirst 20, energy 100 → wellbeing bars
        // invert the pressure: fullness 80, hydration 80, energy 100
        const stats = screen.getByTestId('actor-stats-Ael');
        expect(stats.children.length).toBe(3);
        // Hover titles name the metric (fullness/hydration are the inverted reads)
        expect((stats.children[0] as HTMLElement).title).toBe('Fullness 80%');
        expect((stats.children[1] as HTMLElement).title).toBe('Hydration 80%');
        expect((stats.children[2] as HTMLElement).title).toBe('Energy 100%');
        // The factory emits prop-driven styles as Emotion classes (inside a
        // @media (min-width: 0px) block) — assert the exact CSS rule output
        const cssText = Array.from(document.querySelectorAll('style'))
            .map((tag) => tag.textContent ?? '')
            .join('');
        const hungerFill = stats.children[0].children[0] as HTMLElement;
        expect(cssText).toContain(`.${hungerFill.className}{width:80%;background:#d97b3f;}`);
        const thirstFill = stats.children[1].children[0] as HTMLElement;
        expect(cssText).toContain(`.${thirstFill.className}{width:80%;background:#3d9be9;}`);
        const energyFill = stats.children[2].children[0] as HTMLElement;
        expect(cssText).toContain(`.${energyFill.className}{width:100%;background:#8bc34a;}`);
    });

    it('the world log stays collapsed until opened', () => {
        render(<App />);
        // Four spawn events + Kiki's arrival, hidden behind the toggle
        expect(screen.queryByTestId('event-log')).toBeNull();
        fireEvent.click(screen.getByTestId('log-toggle'));
        expect(screen.getAllByTestId('event-row').length).toBe(5);
        // Collapsing again hides them
        fireEvent.click(screen.getByTestId('log-toggle'));
        expect(screen.queryByTestId('event-log')).toBeNull();
    });

    it('stepping one tick advances the clock; the opened log shows the moves', () => {
        render(<App />);
        fireEvent.click(screen.getByTestId('log-toggle'));
        fireEvent.click(screen.getByTestId('step-button'));
        // tickSize 10 → the clock moved 10 world minutes
        expect(screen.getByTestId('world-clock').textContent).toBe('Day 1 · 00:10');
        // Five arrivals + four castaway wanders + Kiki's first glide
        expect(screen.getAllByTestId('event-row').length).toBe(10);
        // Newest first: the seabird glided last (birds tick after behavior)
        expect(screen.getAllByTestId('event-row')[0].textContent).toContain('Kiki glides northwest.');
    });

    it('the inspector opens in the left rail when a castaway is selected', () => {
        render(<App />);
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        // Inspector shows Ael's condition and starting kit
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('2 Berries');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('1 Flint');
        // History is hidden until its toggle is clicked
        expect(screen.queryByTestId('actor-history')).toBeNull();
        fireEvent.click(screen.getByTestId('history-toggle'));
        expect(screen.getByTestId('actor-history').textContent).toContain('Ael washes ashore.');
        // Deselect clears the inspector entirely
        fireEvent.click(screen.getByTestId('history-toggle'));
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
        expect(screen.queryByTestId('actor-history')).toBeNull();
    });

    it('the bonds list holds exactly one row per fellow castaway — never self, never foreign pairs', () => {
        render(<App />);
        // Fresh world (tick 0): every pair is unacquainted → neutral (0)
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        const fresh = screen.getByTestId('actor-relations');
        expect(
            Array.from(fresh.children).map((child) => child.textContent),
        ).toEqual(['Bram — neutral (0)', 'Cove — neutral (0)', 'Dune — neutral (0)']);

        // 60 seeded ticks (seed 7) — drift and socials move the values
        for (let tick = 0; tick < 60; tick++) {
            fireEvent.click(screen.getByTestId('step-button'));
        }
        // Exactly castSize − 1 rows, roster order, Ael's own name absent.
        // Values captured from the deterministic run (see relationshipPlugin
        // drift 0.2/tick + behavior socials): 24.2→24, 1.8→2, 14.8→15.
        const stepped = screen.getByTestId('actor-relations');
        expect(
            Array.from(stepped.children).map((child) => child.textContent),
        ).toEqual(['Bram — neutral (24)', 'Cove — neutral (0)', 'Dune — neutral (24)']);

        // A different selection never shows its own name either — the list is
        // always the OTHER castaways, so pairs between third parties cannot
        // be mislabelled as the inspected actor's bonds.
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        fireEvent.click(screen.getByTestId('actor-chip-Bram'));
        const bram = screen.getByTestId('actor-relations');
        const bramRows = Array.from(bram.children).map((child) => child.textContent);
        expect(bramRows).toEqual(['Ael — neutral (24)', 'Cove — neutral (2)', 'Dune — neutral (15)']);
        expect(bramRows.join('|')).not.toContain('Bram');
    });

    it('the tick size dial redefines what one tick means', () => {
        render(<App />);
        fireEvent.click(screen.getByTestId('step-button'));
        expect(screen.getByTestId('world-clock').textContent).toBe('Day 1 · 00:10');
        // Switch to hour-long ticks
        fireEvent.change(screen.getByTestId('tick-size'), { target: { value: '60' } });
        fireEvent.click(screen.getByTestId('step-button'));
        // 10 + 60 world minutes
        expect(screen.getByTestId('world-clock').textContent).toBe('Day 1 · 01:10');
    });
});
