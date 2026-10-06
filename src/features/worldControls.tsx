// World size + reroll — the god's hand on the world itself, parked in the
// header right where the seed reads (dashboard.tsx). Minimal by design:
// two odd-size pickers (width × height) and one Reroll button.
//
// Rerolling swaps in a BRAND-NEW world (App.tsx reroll()): a fresh random
// seed EVERY click — the seed readout beside it updates in place — a fresh
// island shape, resources, cast and bird, generated at the picked size.
// The old in-place reshape relay (terrain.resize → inventory.resurvey →
// settleAfterResize, features/worldSize.ts) is gone with the panel: a
// regeneration spawns everything anew, so nothing needs settling.
//
// The world coordinate system is CENTERED ((0, 0) is the canvas center), so
// sizes are ODD only — the pickers list the odd ladder and the terrain
// plugin nudges even input up to the next odd size
// (plugins/terrain/islandTerrain.ts oddSize).

import { arrayCreate } from '@presource/core';
import { useStateHook } from '@presource/react';
import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import { ControlButton, ControlSelect } from '../components/panel';
import { useWorld, useRevision } from './worldBridge';
import type { IslandTerrainOptions } from '../plugins/terrain/islandTerrain';

/** Props — onReroll hands the picked size to App, which regenerates the world. */
export type WorldControlsProps = {
    onReroll: (terrain?: IslandTerrainOptions) => void;
};

/**
 * Odd size ladder — steps of 4 keep every value odd. Widths 13..85 (19
 * options), heights 9..53 (12 options); the default 25×17 sits mid-ladder.
 */
const oddLadder = (start: number, end: number): number[] =>
    // arrayCreate's callback factory generates until undefined — the last
    // element over the cap stops the generation
    arrayCreate(({ index }) => {
        const size = start + index * 4;
        return size <= end ? size : undefined;
    }) as number[];

const WIDTHS = oddLadder(13, 85);
const HEIGHTS = oddLadder(9, 53);

// The header control is one slim inline bar: [width] × [height] [Reroll]
const SizeBar = styled('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
});

const SizeCross = styled('span', {
    fontSize: 12,
    color: PALETTE.textDim,
});

export const WorldControls = ({ onReroll }: WorldControlsProps) => {
    const island = useWorld();
    const revision = useRevision();
    // Picked (unapplied) size — null shows the live terrain size in the
    // pickers. useStateHook is an accessor: picked() reads, picked(v) writes.
    const picked = useStateHook<{ width: number; height: number } | null>(null);
    if (!island) {
        return null;
    }
    void revision; // subscription pulse — re-render on every world change

    const current = island.terrain.size();
    const width = picked()?.width ?? current.width;
    const height = picked()?.height ?? current.height;

    return (
        <SizeBar data-testid="world-size">
            <ControlSelect
                data-testid="world-size-width"
                value={String(width)}
                onChange={(event) => {
                    const input = event.target as HTMLSelectElement;
                    picked({ width: Number(input.value), height });
                }}
            >
                {WIDTHS.map((option) => (
                    <option key={option} value={option}>
                        {option}
                    </option>
                ))}
            </ControlSelect>
            <SizeCross>×</SizeCross>
            <ControlSelect
                data-testid="world-size-height"
                value={String(height)}
                onChange={(event) => {
                    const input = event.target as HTMLSelectElement;
                    picked({ width, height: Number(input.value) });
                }}
            >
                {HEIGHTS.map((option) => (
                    <option key={option} value={option}>
                        {option}
                    </option>
                ))}
            </ControlSelect>
            <ControlButton
                data-testid="world-size-reroll"
                title="Regenerate the island — a fresh seed every roll"
                onClick={() => {
                    // App rebuilds the whole world: fresh random seed at
                    // the picked size. The picks then reset to null so the
                    // pickers track the new live size.
                    onReroll({ width, height });
                    picked(null);
                }}
            >
                Reroll
            </ControlButton>
        </SizeBar>
    );
};
