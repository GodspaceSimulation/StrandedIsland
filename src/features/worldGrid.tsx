// The island canvas — the @godspace/canvas representation area, now TABBED.
//
// Three representations of the SAME world view, one per tab (all loaded as
// plugins from @godspace/canvas by the scenario, see scenario/island.ts):
//   Data    — the data canvas plugin: plain tables of every entity's
//             coordinates (id/kind/name/state/x/y/z), the terrain census
//             and the canvas overview
//   ASCII   — the ascii canvas plugin: one colored tile per ground cell
//             (surface palette), one glyph letter per entity
//   Unicode — the unicode canvas plugin: the emoji twin — terrain emoji on
//             empty tiles, semantic emoji per entity kind, same colors
//
// Every glyph carries its Z altitude as a superscript (K² = 2 voxels up —
// the shared glyphText helper). Hovering a tile shows the voxel column plus
// every entity standing in that column. Clicking ANY tile inspects that
// column (Tile Inspector below the canvas); when the tile holds a castaway,
// the god's actor inspector opens for them too (birds and other non-registry
// residents stay view-only). The data tab is read-only — it shows the exact
// coordinates the other two draw as glyphs.

import { useStateHook } from '@presource/react';
import {
    glyphText,
    ASCII_STATE_FALLBACK,
    type AsciiFrame,
    type UnicodeFrame,
} from '@godspace/canvas';
import type { Biome } from '../engine/types';
import type { IslandHandle } from '../scenario/island';
import { PALETTE } from '../styles/theme';
import { styled } from '../styles/styled';
import { Panel, PanelTitle } from '../components/panel';
import {
    useWorld,
    useRevision,
    useSelection,
    selectActor,
    useTile,
    selectTile,
} from './worldBridge';

/** The three representations tabs switch between. */
type CanvasTab = 'data' | 'ascii' | 'unicode';

/** Tab order + labels — the fixed ladder across the canvas area. */
const TABS: Array<{ id: CanvasTab; label: string }> = [
    { id: 'data', label: 'Data' },
    { id: 'ascii', label: 'ASCII' },
    { id: 'unicode', label: 'Unicode' },
];

const Grid = styled<{ columns: number; size: number }>('div', {
    display: 'grid',
    gridTemplateColumns: ({ columns, size }) => `repeat(${columns}, ${size}px)`,
    gridAutoRows: ({ size }) => `${size}px`,
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

const TabRow = styled('div', {
    display: 'flex',
    gap: 6,
});

const TabButton = styled<{ active: string }>('button', {
    background: ({ active }) => (active === 'true' ? PALETTE.accentDim : '#232c37'),
    color: ({ active }) => (active === 'true' ? '#eafff5' : PALETTE.textDim),
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 6,
    padding: '4px 12px',
    cursor: 'pointer',
    fontSize: 11,
    letterSpacing: 1,
    fontFamily: 'inherit',
    textTransform: 'uppercase',
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

// ── Data tab pieces ──────────────────────────────────────────────────────────

const TableWrap = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    maxHeight: 320,
    overflowY: 'auto',
});

const Table = styled('table', {
    borderCollapse: 'collapse',
    fontSize: 11,
    fontFamily: 'monospace',
    color: PALETTE.text,
    width: '100%',
});

const TableHead = styled('th', {
    textAlign: 'left',
    color: PALETTE.textDim,
    fontWeight: 600,
    padding: '2px 8px',
    borderBottom: `1px solid ${PALETTE.panelBorder}`,
});

const TableData = styled('td', {
    padding: '2px 8px',
    fontVariantNumeric: 'tabular-nums',
});

/** Legend order — the island's surface ladder. */
const BIOME_ORDER: Biome[] = ['ocean', 'shallows', 'beach', 'meadow', 'forest', 'highland'];

export const WorldGrid = () => {
    const island = useWorld();
    const revision = useRevision();
    const selected = useSelection();
    const inspected = useTile();
    // Active representation tab — ASCII stays the default view
    const tab = useStateHook<CanvasTab>('ascii');
    if (!island) {
        return null;
    }
    void revision; // subscription pulse — re-render on every world change

    const { world, ascii, unicode, data } = island;

    // A tile click wires the same two inspections regardless of which canvas
    // is showing (ascii and unicode frames carry identical coordinates) —
    // shared so both tile renderers stay behaviorally identical
    const inspectTile = (tile: { x: number; y: number }, castawayId: string | undefined) => {
        // Every click inspects the tile — sea or land, empty or crowded
        selectTile({ x: tile.x, y: tile.y });
        // A castaway on the tile ALSO re-points the actor inspector at them;
        // clicking an empty or bird-only tile leaves the actor pick
        // untouched — tile picks and actor picks are independent inspections
        if (castawayId) {
            selectActor(castawayId);
        }
    };

    return (
        <Panel>
            <PanelTitle>Island Canvas</PanelTitle>
            <TabRow>
                {TABS.map((entry) => (
                    <TabButton
                        key={entry.id}
                        active={tab() === entry.id ? 'true' : 'false'}
                        data-testid={`canvas-tab-${entry.id}`}
                        onClick={() => tab(entry.id)}
                    >
                        {entry.label}
                    </TabButton>
                ))}
            </TabRow>
            {tab() === 'data' ? (
                <TableWrap data-testid="data-tables">
                    {data.frame().tables.map((table) => (
                        <div key={table.title} data-testid={`data-table-${table.title.toLowerCase()}`}>
                            <PanelTitle>{table.title}</PanelTitle>
                            <Table>
                                <thead>
                                    <tr>
                                        {table.headers.map((header) => (
                                            <TableHead key={header}>{header}</TableHead>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {table.rows.map((row, rowIndex) => (
                                        <tr key={rowIndex}>
                                            {row.map((cell, cellIndex) => (
                                                <TableData key={cellIndex}>{String(cell)}</TableData>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </Table>
                        </div>
                    ))}
                </TableWrap>
            ) : null}
            {tab() === 'ascii' ? (
                <AsciiView
                    world={world}
                    frame={ascii.frame()}
                    palette={ascii.palette().tiles}
                    inspected={inspected}
                    selected={selected}
                    size={26}
                    onTile={inspectTile}
                />
            ) : null}
            {tab() === 'unicode' ? (
                <UnicodeView
                    frame={unicode.frame()}
                    palette={unicode.palette()}
                    inspected={inspected}
                    selected={selected}
                    size={30}
                    onTile={inspectTile}
                />
            ) : null}
        </Panel>
    );
};

// ── ASCII view — the original colored-tile render ────────────────────────────

const AsciiView = ({
    world,
    frame,
    palette,
    inspected,
    selected,
    size,
    onTile,
}: {
    world: IslandHandle['world'];
    frame: AsciiFrame;
    palette: Record<string, string>;
    inspected: { x: number; y: number } | null;
    selected: string | null;
    size: number;
    onTile: (tile: { x: number; y: number }, castawayId: string | undefined) => void;
}) => (
    <>
        <Grid columns={frame.columns} size={size} data-testid="world-grid">
            {frame.tiles.map((tile) => {
                // Top of the column's glyph stack draws on the tile
                const glyph = tile.glyphs[0];
                // Any castaway in the column opens the actor inspector —
                // searching the whole stack (not just the top) so a bird
                // gliding above never hides the castaway walking below
                const castaway = tile.glyphs.find((entry) => world.actors.has(entry.id));
                const isSelected = glyph !== undefined && glyph.id === selected;
                // The inspected tile (any column — sea, sand, forest) wears
                // the accent border so the god sees what the Tile
                // Inspector below is reading
                const isInspected =
                    inspected !== null && inspected.x === tile.x && inspected.y === tile.y;
                return (
                    <Cell
                        key={`${tile.x},${tile.y}`}
                        background={tile.background}
                        border={
                            isSelected || isInspected
                                ? `2px solid ${PALETTE.accent}`
                                : '1px solid rgba(0,0,0,0.3)'
                        }
                        title={tile.title}
                        data-testid={`grid-tile-${tile.x}-${tile.y}`}
                        onClick={() => onTile(tile, castaway?.id)}
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
                <LegendItem key={biome} color={palette[biome]}>
                    <LegendSwatch color={palette[biome]} />
                    {biome}
                </LegendItem>
            ))}
        </Legend>
    </>
);

// ── Unicode view — the emoji twin ────────────────────────────────────────────

const UnicodeView = ({
    frame,
    palette,
    inspected,
    selected,
    size,
    onTile,
}: {
    frame: UnicodeFrame;
    palette: { tiles: Record<string, string>; symbols: Record<string, string> };
    inspected: { x: number; y: number } | null;
    selected: string | null;
    size: number;
    onTile: (tile: { x: number; y: number }, castawayId: string | undefined) => void;
}) => (
    <>
        <Grid columns={frame.columns} size={size} data-testid="world-grid-unicode">
            {frame.tiles.map((tile) => {
                const glyph = tile.glyphs[0];
                const castaway = tile.glyphs.find((entry) => entry.kind === 'castaway');
                const isSelected = glyph !== undefined && glyph.id === selected;
                const isInspected =
                    inspected !== null && inspected.x === tile.x && inspected.y === tile.y;
                // Empty tiles draw the terrain emoji in the off-white
                // terrain color; occupied tiles draw the entity glyph in
                // its state color (same rule the unicode painter uses)
                const color = glyph ? glyph.color : ASCII_STATE_FALLBACK;
                const text = glyph ? glyphText(glyph.glyph, glyph.elevation) : tile.symbol;
                return (
                    <Cell
                        key={`${tile.x},${tile.y}`}
                        background={tile.background}
                        border={
                            isSelected || isInspected
                                ? `2px solid ${PALETTE.accent}`
                                : '1px solid rgba(0,0,0,0.3)'
                        }
                        title={tile.title}
                        data-testid={`unicode-tile-${tile.x}-${tile.y}`}
                        onClick={() => onTile(tile, castaway?.id)}
                    >
                        {text ? <Marker color={color}>{text}</Marker> : null}
                    </Cell>
                );
            })}
        </Grid>
        <Legend data-testid="grid-legend-unicode">
            {BIOME_ORDER.map((biome) => (
                <LegendItem key={biome} color={palette.tiles[biome]}>
                    <LegendSwatch color={palette.tiles[biome]} />
                    {palette.symbols[biome]} {biome}
                </LegendItem>
            ))}
        </Legend>
    </>
);
