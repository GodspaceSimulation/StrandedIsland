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
        // The plugin roster shows the mounted environment modules
        expect(screen.getByTestId('plugin-roster').textContent).toBe(
            'Island Terrain · Inventories & Exchange · Survival Needs · Relationships · Agent Behavior',
        );
    });

    it('stepping one tick advances the clock and fills the world log', () => {
        render(<App />);
        // The cast washed ashore during world creation — 4 spawn events
        expect(screen.getAllByTestId('event-row').length).toBe(4);
        fireEvent.click(screen.getByTestId('step-button'));
        // tickSize 10 → the clock moved 10 world minutes
        expect(screen.getByTestId('world-clock').textContent).toBe('Day 1 · 00:10');
        // Four spawns + four wander moves happened; newest first is a move
        expect(screen.getAllByTestId('event-row').length).toBe(8);
        expect(screen.getAllByTestId('event-row')[0].textContent).toContain('wanders');
    });

    it('the inspector opens when a castaway is selected', () => {
        render(<App />);
        expect(screen.getByTestId('event-log')).toBeDefined();
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        // Inspector shows Ael's condition and starting kit
        expect(screen.getByTestId('actor-condition').textContent).toBe('Ael · well');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('2 Berries');
        expect(screen.getByTestId('actor-inventory').textContent).toContain('1 Flint');
        expect(screen.getByTestId('actor-history').textContent).toContain('Ael washes ashore.');
        // Deselect clears the inspector
        fireEvent.click(screen.getByTestId('actor-chip-Ael'));
        expect(screen.queryByTestId('actor-inventory')).toBeNull();
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
