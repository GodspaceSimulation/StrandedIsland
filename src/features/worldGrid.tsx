// The island canvas — top-down voxel grid view.
//
// Each cell renders its surface biome color; hovering shows the full voxel
// column (bedrock → surface → water → forest) via the title attribute. The
// actor standing on a cell is drawn as their marker letter, colored by
// condition. Clicking a cell selects/deselects the actor on it.

import type { Biome } from '../engine/types';
import { BIOME_COLORS, CONDITION_COLORS, PALETTE } from '../styles/theme';
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

const BIOME_ORDER: Biome[] = ['ocean', 'shallows', 'beach', 'meadow', 'forest', 'highland'];

export const WorldGrid = () => {
    const island = useWorld();
    const revision = useRevision();
    const selected = useSelection();
    if (!island) {
        return null;
    }
    void revision; // subscription pulse — re-render on every world change

    const { world } = island;
    const { canvas } = world;

    return (
        <Panel>
            <PanelTitle>Island Canvas</PanelTitle>
            <Grid columns={canvas.width} data-testid="world-grid">
                {canvas.cells.map((cell) => {
                    const actor = world.actorAt(cell.x, cell.y);
                    const isSelected = actor !== undefined && actor.id === selected;
                    return (
                        <Cell
                            key={`${cell.x},${cell.y}`}
                            background={BIOME_COLORS[cell.biome]}
                            border={
                                isSelected ? `2px solid ${PALETTE.accent}` : '1px solid rgba(0,0,0,0.3)'
                            }
                            title={`${cell.biome} · height ${cell.height} · ${cell.voxels.join(' / ')}${
                                actor ? ` · ${actor.name}` : ''
                            }`}
                            onClick={() => selectActor(actor ? actor.id : null)}
                        >
                            {actor ? (
                                <Marker color={CONDITION_COLORS[actor.condition]}>{actor.marker}</Marker>
                            ) : null}
                        </Cell>
                    );
                })}
            </Grid>
            <Legend data-testid="grid-legend">
                {BIOME_ORDER.map((biome) => (
                    <LegendItem key={biome} color={BIOME_COLORS[biome]}>
                        <LegendSwatch color={BIOME_COLORS[biome]} />
                        {biome}
                    </LegendItem>
                ))}
            </Legend>
        </Panel>
    );
};
