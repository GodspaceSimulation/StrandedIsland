// Tile Inspector — details of whichever canvas tile the god clicked.
//
// Clicking ANY tile (worldGrid.tsx) selects its column through the bridge;
// this panel shows the layers of that column:
//   Position   — coordinates + the surface key the canvas paints the tile
//                with (derived from the tile's resource deposits)
//   Terrain    — height vs the water line, walkability, and the voxel stack
//                bottom → top (runs merged, e.g. "stone ×3, dirt, grass")
//   Resources  — the tile's resource deposits: the voxel-derived INFINITE
//                ground supply (grass/dirt/sand/stone, never exhaustible)
//                and the finite biological tree stand / iron lodes — what
//                the tile appears as
//   Forest     — the tree WOOD stats (plugins/forest): the stand summary at
//                the island view; at scale 0 the tree card standing on the
//                inspected fine spot (wood pool, age, maturity)
//   Ground     — what lies on the terrain (the inventory plugin's cell stock;
//                sea tiles stock fish, beaches hide shells…)
//   Residents  — EVERY living thing in the column: people, birds, any creature
//                a plugin coins — actors in the broad sense. All live in the
//                world's coordinate space (world.coordinates.column), grounded
//                first. Castaway rows are buttons that open the full actor
//                inspector (features/actorPanel.tsx) for that actor.
//
// Rendered in the SideSection right rail (dashboard.tsx), beneath the
// world clock.

import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, useTile, selectActor } from './worldBridge';
import {
    tileSummary,
    voxelSummary,
    occupantLine,
    structureLine,
    forestStandLine,
    forestTreeLine,
    type TileOccupant,
    type TileStructure,
} from './tileDetails';
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
 * Resident row: EVERY living thing links into the entity inspector — the
 * castaways (world.actors) and the creatures a plugin coins (birds, sharks,
 * boars) alike, since the inspector reads any coordinate-space resident by
 * its coordinate id.
 */
const ResidentRow = ({ occupant, dotColor }: { occupant: TileOccupant; dotColor: string }) => (
    <li>
        <ResidentButton
            linked="true"
            title={`Inspect ${occupant.name}`}
            onClick={() => {
                // Open the full entity card — every resident of the column
                // is inspectable through its coordinate id
                selectActor(occupant.id);
            }}
        >
            <ResidentDot color={dotColor} />
            <ResidentText>{occupantLine(occupant)}</ResidentText>
        </ResidentButton>
    </li>
);

/**
 * Structure row — the construction sites at the inspected tile (NOT living
 * entities: never clickable into the entity inspector, never in the needs
 * sweep). The line carries the state, the gate flag, the staging ledger
 * and the work progress ("Shelter · building · wood 2/2 · work 3/10").
 */
const StructureRow = ({ structure }: { structure: TileStructure }) => (
    <li>
        <span data-testid={`tile-structure-${structure.siteId}`}>{structureLine(structure)}</span>
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
    const summary = tile ? tileSummary(island, tile) : null;

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
                            {/* The full zoom lineage — "(-11, 0) · sand" at
                                the island view, each deeper step appended
                                (the same line shape at every scale) */}
                            {summary.path.map((step) => `(${step.x}, ${step.y})`).join(' · ')} ·{' '}
                            {summary.surface}
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
                    <Row>
                        <RowName>Resources</RowName>
                        {/* The deposits the tile carries — what it appears as
                            on the canvas (tree ×383 · stone ×∞ · sand ×∞;
                            unlimited deposits can never be exhausted — the
                            voxel-derived ground supply) */}
                        <VoxelStack data-testid="tile-resources">
                            {summary.resources.length === 0
                                ? '—'
                                : summary.resources
                                      .map((stack) =>
                                          stack.unlimited
                                              ? `${stack.resource} ×∞`
                                              : `${stack.resource} ×${stack.count}`,
                                      )
                                      .join(' · ')}
                        </VoxelStack>
                    </Row>
                    {/* The FOREST layer — the tree wood stats (plugins/
                        forest), read through the tileDetails display lines:
                        the island view lists the stand summary ("383 trees
                        · 1234 wood standing"); at scale 0 the single tree
                        in view reads "1 tree · N wood standing" and its
                        card (tile-forest-tree) adds only the age in years
                        and the maturity — the card's wood pool IS the
                        standing count, so it is never repeated ("1 tree ·
                        3 wood standing · age 3.2 y · growing") */}
                    {summary.forest ? (
                        <Row>
                            <RowName>Forest</RowName>
                            <VoxelStack data-testid="tile-forest">
                                {forestStandLine(summary.forest)}
                                <span data-testid="tile-forest-tree">{forestTreeLine(summary.forest)}</span>
                            </VoxelStack>
                        </Row>
                    ) : null}
                    <div>
                        <PanelTitle>On the ground</PanelTitle>
                        <List data-testid="tile-ground">
                            {/* The granularity ladder: the island view (a
                                length-1 path, and anything wider) lists the
                                item CATEGORIES ("Foods ×2" — the
                                generalization), the interior views list the
                                items by name ("1 Berry"). The two entry
                                shapes distinguish by their label field. */}
                            {summary.ground.length === 0 ? (
                                <li>
                                    <EmptyNote>Nothing on the ground.</EmptyNote>
                                </li>
                            ) : (
                                summary.ground.map((entry) =>
                                    'label' in entry ? (
                                        <li key={entry.label}>
                                            {entry.label} ×{entry.count}
                                        </li>
                                    ) : (
                                        <li key={entry.item}>{itemLabel(entry.item, entry.count)}</li>
                                    ),
                                )
                            )}
                        </List>
                    </div>
                    <div>
                        <PanelTitle>Structures</PanelTitle>
                        <List data-testid="tile-structures">
                            {/* The construction sites at the inspected tile
                                (plugins/construction): what is being built
                                here, how far its staging and work run, and
                                whether the inspected address is its walkable
                                gate. Structures are not living entities —
                                they never enter the roster or the needs
                                sweep, they are the tile's built vocabulary. */}
                            {summary.structures.length === 0 ? (
                                <li>
                                    <EmptyNote>Nothing stands here.</EmptyNote>
                                </li>
                            ) : (
                                summary.structures.map((structure) => (
                                    <StructureRow key={structure.siteId} structure={structure} />
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
