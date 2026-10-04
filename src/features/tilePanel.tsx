// Tile Inspector — details of whichever canvas tile the god clicked.
//
// Clicking ANY tile (worldGrid.tsx) selects its column through the bridge;
// this panel shows all three layers of that column:
//   Terrain   — biome, height vs the water line, walkability, and the voxel
//               stack bottom → top (runs merged, e.g. "stone ×3, soil, grass")
//   Ground    — what lies on the terrain (the inventory plugin's cell stock;
//               sea tiles stock fish, beaches hide shells…)
//   Residents — EVERY living thing in the column: people, birds, any creature
//               a plugin coins — actors in the broad sense. All live in the
//               world's coordinate space (world.coordinates.column), grounded
//               first. Castaway rows are buttons that open the full actor
//               inspector (features/actorPanel.tsx) for that actor.
//
// Rendered in the GridSection right below the island canvas (dashboard.tsx).

import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, useTile, selectActor } from './worldBridge';
import { tileSummary, voxelSummary, occupantLine, type TileOccupant } from './tileDetails';
import { itemLabel } from '../plugins/inventory/items';

/** Two-column detail row — the label is dim, the value plain. */
const Row = styled('div', {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    fontSize: 13,
});

const RowName = styled('span', {
    width: '72px',
    flexShrink: 0,
    fontSize: 12,
    color: PALETTE.textDim,
});

const VoxelStack = styled('div', {
    fontSize: 12,
    color: PALETTE.text,
    lineHeight: 1.5,
});

const List = styled('ul', {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 13,
});

const EmptyNote = styled('span', {
    fontSize: 12,
    color: PALETTE.textDim,
});

/** Occupant row — state dot + readable line; castaways open the inspector. */
const ResidentButton = styled<{ linked: string }>('button', {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'transparent',
    border: 'none',
    padding: 0,
    margin: 0,
    fontFamily: 'inherit',
    fontSize: 13,
    color: PALETTE.text,
    textAlign: 'left',
    // Only castaway rows (linked = 'true') act like links
    cursor: ({ linked }) => (linked === 'true' ? 'pointer' : 'default'),
});

const ResidentDot = styled<{ color: string }>('span', {
    background: 'custom',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
});

const ResidentText = styled('span', {
    lineHeight: 1.4,
});

/**
 * Resident row: castaways link into the actor inspector, every other living
 * thing (birds, future creatures) stays view-only here.
 */
const ResidentRow = ({ occupant, dotColor }: { occupant: TileOccupant; dotColor: string }) => (
    <li>
        <ResidentButton
            linked={occupant.actorId ? 'true' : 'false'}
            title={occupant.actorId ? `Inspect ${occupant.name}` : undefined}
            onClick={() => {
                // Open the full actor card for castaways — no-op residents
                // stay inert
                if (occupant.actorId) {
                    selectActor(occupant.actorId);
                }
            }}
        >
            <ResidentDot color={dotColor} />
            <ResidentText>{occupantLine(occupant)}</ResidentText>
        </ResidentButton>
    </li>
);

export const TilePanel = () => {
    const island = useWorld();
    const revision = useRevision();
    const tile = useTile();
    if (!island) {
        return null;
    }
    void revision; // subscription pulse — re-render on every world change

    // Stale selection after a regenerated island resolves to null too
    const summary = tile ? tileSummary(island, tile.x, tile.y) : null;

    // Occupant state dots share the canvas glyph palette (condition +
    // flight state colors from @godspace/canvas)
    const stateColors = island.ascii.palette().states;

    return (
        <Panel>
            <PanelTitle>Tile Inspector</PanelTitle>
            {!summary ? (
                <EmptyNote data-testid="tile-empty">Click a tile to inspect it.</EmptyNote>
            ) : (
                <>
                    <Row>
                        <RowName>Position</RowName>
                        <span data-testid="tile-position">
                            ({summary.x}, {summary.y}) · {summary.biome}
                        </span>
                    </Row>
                    <Row>
                        <RowName>Terrain</RowName>
                        <span data-testid="tile-terrain-meta">
                            height {summary.height} · water line {summary.waterLevel} ·{' '}
                            {summary.passable ? 'walkable' : 'submerged'}
                        </span>
                    </Row>
                    <Row>
                        <RowName>Voxels</RowName>
                        <VoxelStack data-testid="tile-voxels">
                            {voxelSummary(summary.voxels) || '—'}
                        </VoxelStack>
                    </Row>
                    <div>
                        <PanelTitle>On the ground</PanelTitle>
                        <List data-testid="tile-ground">
                            {summary.ground.length === 0 ? (
                                <li>
                                    <EmptyNote>Nothing on the ground.</EmptyNote>
                                </li>
                            ) : (
                                summary.ground.map((entry) => (
                                    <li key={entry.item}>{itemLabel(entry.item, entry.count)}</li>
                                ))
                            )}
                        </List>
                    </div>
                    <div>
                        <PanelTitle>Residents</PanelTitle>
                        <List data-testid="tile-residents">
                            {summary.occupants.length === 0 ? (
                                <li>
                                    <EmptyNote>No one here.</EmptyNote>
                                </li>
                            ) : (
                                summary.occupants.map((occupant) => (
                                    <ResidentRow
                                        key={occupant.id}
                                        occupant={occupant}
                                        dotColor={stateColors[occupant.state] ?? PALETTE.textDim}
                                    />
                                ))
                            )}
                        </List>
                    </div>
                </>
            )}
        </Panel>
    );
};
