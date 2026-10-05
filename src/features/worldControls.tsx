// World Size controls — the god's hand on the canvas dimensions.
//
// Right-rail panel below the World Ticker. The world coordinate system is
// CENTERED ((0, 0) is the dead center of the canvas), so the canvas can only
// ever be ODD — the selects list odd sizes only, and the terrain plugin
// nudges even input up to the next odd size (islandTerrain oddSize).
//
// Applying a size runs the full resize relay:
//   1. terrain.resize(w, h)   — regenerates the island (same seed → the
//                               same island shape, just bigger/smaller; the
//                               outermost ring stays open sea by design)
//   2. inventory.resurvey()   — wipes and re-seeds every cell stock from
//                               the new canvas
//   3. settleAfterResize()    — clamps residents into bounds and walks
//                               stranded castaways to the nearest dry cell

import { arrayCreate } from '@presource/core';
import { useStateHook } from '@presource/react';
import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import { ControlButton, ControlRow, ControlSelect, Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, bumpRevision } from './worldBridge';
import { settleAfterResize } from './worldSize';

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

const CurrentSize = styled('span', {
    fontSize: 18,
    fontWeight: 700,
    color: PALETTE.accent,
    fontVariantNumeric: 'tabular-nums',
});

const Hint = styled('span', {
    fontSize: 10,
    color: PALETTE.textDim,
    lineHeight: 1.4,
});

export const WorldControls = () => {
    const island = useWorld();
    const revision = useRevision();
    // Pending (unapplied) picker state — null shows the live terrain size.
    // useStateHook is an accessor: pending() reads, pending(value) writes.
    const pending = useStateHook<{ width: number; height: number } | null>(null);
    if (!island) {
        return null;
    }
    void revision; // subscription pulse — re-render on every world change

    const { terrain, inventory, world } = island;
    const current = terrain.size();
    // The pickers hold the pending choice while it differs from the live size
    const width = pending()?.width ?? current.width;
    const height = pending()?.height ?? current.height;
    const unchanged = width === current.width && height === current.height;

    return (
        <Panel>
            <PanelTitle>World Size</PanelTitle>
            <CurrentSize data-testid="world-size-current">
                {current.width} × {current.height}
            </CurrentSize>
            <ControlRow>
                <ControlSelect
                    data-testid="world-size-width"
                    value={String(width)}
                    onChange={(event) => {
                        const input = event.target as HTMLSelectElement;
                        pending({ width: Number(input.value), height });
                    }}
                >
                    {WIDTHS.map((option) => (
                        <option key={option} value={option}>
                            {option} wide
                        </option>
                    ))}
                </ControlSelect>
                <ControlSelect
                    data-testid="world-size-height"
                    value={String(height)}
                    onChange={(event) => {
                        const input = event.target as HTMLSelectElement;
                        pending({ width, height: Number(input.value) });
                    }}
                >
                    {HEIGHTS.map((option) => (
                        <option key={option} value={option}>
                            {option} tall
                        </option>
                    ))}
                </ControlSelect>
                <ControlButton
                    data-testid="world-size-apply"
                    disabled={unchanged}
                    onClick={() => {
                        // The resize relay: regenerate → resurvey → settle
                        terrain.resize(width, height);
                        inventory.resurvey();
                        settleAfterResize(world);
                        pending(null);
                        bumpRevision();
                    }}
                >
                    Reshape
                </ControlButton>
            </ControlRow>
            <Hint>(0, 0) is locked to the canvas center — odd sizes only. The
                edge stays open sea; reshaping keeps the seed, so the island
                shape only grows or shrinks.</Hint>
        </Panel>
    );
};
