// The island canvas — the @godspace/canvas ASCII representation plugin.
//
// The scenario loads the ascii canvas plugin from the @godspace/canvas
// package and the engine binds it (plugins.add → setup captures the world).
// This feature renders the plugin's frame() as styled components: one
// colored tile per ground cell (surface palette), one glyph per entity —
// the marker letter colored by state, with flying entities (seabirds)
// carrying their Z altitude as a superscript (K² = 2 voxels up). Hovering
// shows the voxel column plus every entity standing in that column.
// Clicking a castaway's tile selects them for the inspector.

import { glyphText } from '@godspace/canvas';
import type { Biome } from '../engine/types';
import { PALETTE } from '../styles/theme';
import { styled } from '../styles/styled';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, useSelection, selectActor } from './worldBridge';

const Grid = styled<{ columns: number }>('div', {
    display: 'grid',
    gridTemplateColumns: ({ columns }) => `repeat(${columns}, 26px)`,
    gridAutoRows: '26px',
    gap: 2,
    alignContent: 'start',
});

// background/border are prop-driven ('custom' sentinel resolves rest[key])
const Cell = styled<{ background: string; border: string }>('div', {
    background: 'custom',
    border: 'custom',
    borderRadius: 3,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
});

const Marker = styled<{ color: string }>('span', {
    color: 'custom',
    textShadow: '0 1px 2px rgba(0,0,0,0.8)',
    lineHeight: 1,
});

const Legend = styled('div', {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
});

const LegendItem = styled<{ color: string }>('span', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    color: PALETTE.textDim,
});

const LegendSwatch = styled<{ color: string }>('span', {
    background: 'custom',
    width: '10px',
    height: '10px',
    borderRadius: 2,
    display: 'inline-block',
});

/** Legend order — the island's surface ladder. */
const BIOME_ORDER: Biome[] = ['ocean', 'shallows', 'beach', 'meadow', 'forest', 'highland'];

export const WorldGrid = () => {
    const island = useWorld();
    const revision = useRevision();
    const selected = useSelection();
    if (!island) {
        return null;
    }
    void revision; // subscription pulse — re-render on every world change

    const { world, ascii } = island;
    // The representation comes straight from the plugin (@godspace/canvas)
    const frame = ascii.frame();
    const palette = ascii.palette();

    return (
        <Panel>
            <PanelTitle>Island Canvas</PanelTitle>
            <Grid columns={frame.columns} data-testid="world-grid">
                {frame.tiles.map((tile) => {
                    // Top of the column's glyph stack draws on the tile
                    const glyph = tile.glyphs[0];
                    const isCastaway = glyph !== undefined && world.actors.has(glyph.id);
                    const isSelected = glyph !== undefined && glyph.id === selected;
                    return (
                        <Cell
                            key={`${tile.x},${tile.y}`}
                            background={tile.background}
                            border={
                                isSelected ? `2px solid ${PALETTE.accent}` : '1px solid rgba(0,0,0,0.3)'
                            }
                            title={tile.title}
                            onClick={() => selectActor(isCastaway ? glyph.id : null)}
                        >
                            {glyph ? (
                                <Marker color={glyph.color}>
                                    {glyphText(glyph.glyph, glyph.elevation)}
                                </Marker>
                            ) : null}
                        </Cell>
                    );
                })}
            </Grid>
            <Legend data-testid="grid-legend">
                {BIOME_ORDER.map((biome) => (
                    <LegendItem key={biome} color={palette.tiles[biome]}>
                        <LegendSwatch color={palette.tiles[biome]} />
                        {biome}
                    </LegendItem>
                ))}
            </Legend>
        </Panel>
    );
};
