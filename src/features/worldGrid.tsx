// The island canvas — the @godspace/canvas representation area, now TABBED.
//
// Four representations of the SAME world view, one per tab (all loaded as
// plugins from @godspace/canvas by the scenario, see scenario/island.ts):
//   Data    — the data canvas plugin: plain tables of every entity's
//             coordinates (id/kind/type/name/state/x/y/z), the terrain
//             census and the canvas overview
//   ASCII   — the ascii canvas plugin: one colored tile per ground cell
//             (surface palette), one glyph letter per entity
//   Unicode — the unicode canvas plugin: the emoji twin — semantic emoji
//             per entity (resolved from the kind/type taxonomy), terrain
//             drawn as color only (no per-tile emoji flood), same colors
//   SVG     — the svg canvas plugin: the vector twin — the world as a
//             scalable SVG document (one rect per ground cell, one text per
//             entity, native <title> hovers); geometry on the SAME 26px
//             tile grid, so every tab occupies the same board footprint
//
// TILE OCCUPATION PARITY — every tile canvas draws on the SAME 26px grid
// (ascii's tile). The unicode tab once painted 30px emoji tiles, which blew
// this panel wide; all tile tabs now share the ascii size so switching
// representations never breaks the layout.
//
// Every glyph carries its Z altitude as a superscript (K² = 2 voxels up —
// the shared glyphText helper). Hovering a tile shows the voxel column plus
// every entity standing in that column. Clicking ANY tile inspects that
// column (Tile Inspector below the canvas); when the tile holds a castaway,
// the god's actor inspector opens for them too (birds and other non-registry
// residents stay view-only). The data tab is read-only — it shows the exact
// coordinates the other three draw as glyphs.

import { useStateHook } from '@presource/react';
import {
    glyphText,
    type AsciiFrame,
    type SvgFrame,
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

/** The four representations tabs switch between. */
type CanvasTab = 'data' | 'ascii' | 'unicode' | 'svg';

/** Tab order + labels — the fixed ladder across the canvas area. */
const TABS: Array<{ id: CanvasTab; label: string }> = [
    { id: 'data', label: 'Data' },
    { id: 'ascii', label: 'ASCII' },
    { id: 'unicode', label: 'Unicode' },
    { id: 'svg', label: 'SVG' },
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

    const { world, ascii, unicode, svg, data } = island;

    // A tile click wires the same two inspections regardless of which canvas
    // is showing (all four frames carry identical coordinates) —
    // shared so every tile renderer stays behaviorally identical
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
                    world={world}
                    frame={unicode.frame()}
                    palette={unicode.palette().tiles}
                    inspected={inspected}
                    selected={selected}
                    // SAME TILE OCCUPATION AS ASCII (26) — the emoji tab once
                    // painted 30px tiles and blew the panel wide; all tile
                    // tabs now share the ascii grid so switching never breaks
                    // the layout
                    size={26}
                    onTile={inspectTile}
                />
            ) : null}
            {tab() === 'svg' ? (
                <SvgView
                    world={world}
                    frame={svg.frame()}
                    palette={svg.palette().tiles}
                    inspected={inspected}
                    selected={selected}
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
    world,
    frame,
    palette,
    inspected,
    selected,
    size,
    onTile,
}: {
    world: IslandHandle['world'];
    frame: UnicodeFrame;
    palette: Record<string, string>;
    inspected: { x: number; y: number } | null;
    selected: string | null;
    size: number;
    onTile: (tile: { x: number; y: number }, castawayId: string | undefined) => void;
}) => (
    <>
        <Grid columns={frame.columns} size={size} data-testid="world-grid-unicode">
            {frame.tiles.map((tile) => {
                const glyph = tile.glyphs[0];
                // Same registry rule as the ascii view — any castaway in the
                // column opens the actor inspector, a bird gliding above
                // never hides the castaway walking below
                const castaway = tile.glyphs.find((entry) => world.actors.has(entry.id));
                const isSelected = glyph !== undefined && glyph.id === selected;
                const isInspected =
                    inspected !== null && inspected.x === tile.x && inspected.y === tile.y;
                // Entities draw their emoji in the state color; empty tiles
                // stay bare — terrain shows through its background color
                // alone (no per-tile emoji flood)
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
                        {glyph ? (
                            <Marker color={glyph.color}>
                                {glyphText(glyph.glyph, glyph.elevation)}
                            </Marker>
                        ) : null}
                    </Cell>
                );
            })}
        </Grid>
        {/* Terrain is color-only here — the legend matches the ascii view */}
        <Legend data-testid="grid-legend-unicode">
            {BIOME_ORDER.map((biome) => (
                <LegendItem key={biome} color={palette[biome]}>
                    <LegendSwatch color={palette[biome]} />
                    {biome}
                </LegendItem>
            ))}
        </Legend>
    </>
);

// ── SVG view — the vector twin ───────────────────────────────────────────────

// The SVG board: a block-level vector canvas that scales DOWN to the panel
// width (the whole point of the SVG style — the vector document shrinks to
// fit where the px-bound DOM grids can only overflow). All geometry lives
// in the viewBox coordinates computed from the frame's tile edge.
const SvgBoard = styled('svg', {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
});

// One tile rect — per-tile geometry and colors arrive as SVG presentation
// attributes (x/y/width/height/fill/stroke); the styled class carries the
// shared paint (rounded corners, hairline width, pointer cursor)
const SvgTile = styled('rect', {
    rx: 3,
    strokeWidth: 1,
    cursor: 'pointer',
});

// One entity glyph — the styled class carries the static text paint
// (centered anchor, midline baseline, the shared 13px glyph budget);
// position and state color arrive as x/y/fill attributes
const SvgGlyph = styled('text', {
    textAnchor: 'middle',
    dominantBaseline: 'central',
    fontSize: 13,
    fontWeight: 700,
});

const SvgView = ({
    world,
    frame,
    palette,
    inspected,
    selected,
    onTile,
}: {
    world: IslandHandle['world'];
    frame: SvgFrame;
    palette: Record<string, string>;
    inspected: { x: number; y: number } | null;
    selected: string | null;
    onTile: (tile: { x: number; y: number }, castawayId: string | undefined) => void;
}) => (
    <>
        {/* The viewBox spans columns·size × rows·size user units — the SAME
            26px tile grid the ascii/unicode boards draw, so the board
            occupies the same footprint in tile units and merely SCALES to
            the panel (never overflows it) */}
        <SvgBoard
            data-testid="world-grid-svg"
            viewBox={`0 0 ${frame.columns * frame.size} ${frame.rows * frame.size}`}
            width={frame.columns * frame.size}
            height={frame.rows * frame.size}
        >
            {frame.tiles.map((tile, index) => {
                // SVG geometry follows the row-major tile ORDER (array index
                // → column/row) — the exact layout the DOM grids draw. The
                // engine's own coordinates may be centered (negative), which
                // would map off-canvas
                const column = index % frame.columns;
                const row = Math.floor(index / frame.columns);
                // Top of the column's glyph stack draws on the tile
                const glyph = tile.glyphs[0];
                // Same registry rule as the DOM views — any castaway in the
                // column opens the actor inspector, a bird gliding above
                // never hides the castaway walking below
                const castaway = tile.glyphs.find((entry) => world.actors.has(entry.id));
                const isSelected = glyph !== undefined && glyph.id === selected;
                const isInspected =
                    inspected !== null && inspected.x === tile.x && inspected.y === tile.y;
                return (
                    <g
                        key={`${tile.x},${tile.y}`}
                        data-testid={`svg-tile-${tile.x}-${tile.y}`}
                        onClick={() => onTile(tile, castaway?.id)}
                    >
                        {/* SVG-native hover: <title> is the vector twin of
                            the DOM title attribute the other canvases use */}
                        <title>{tile.title}</title>
                        {/* Terrain IS the rect fill — the 1-unit inset
                            reproduces the DOM grids' 2px tile seam; empty
                            tiles draw no text (the flood fix) */}
                        <SvgTile
                            x={column * frame.size + 1}
                            y={row * frame.size + 1}
                            width={frame.size - 2}
                            height={frame.size - 2}
                            fill={tile.background}
                            stroke={
                                isSelected || isInspected
                                    ? PALETTE.accent
                                    : 'rgba(0,0,0,0.3)'
                            }
                        />
                        {/* Entities draw their glyph in the state color at
                            the dead-center of the tile — the same visual
                            position the flex-centered DOM cells produce */}
                        {glyph ? (
                            <SvgGlyph
                                x={column * frame.size + frame.size / 2}
                                y={row * frame.size + frame.size / 2}
                                fill={glyph.color}
                            >
                                {glyphText(glyph.glyph, glyph.elevation)}
                            </SvgGlyph>
                        ) : null}
                    </g>
                );
            })}
        </SvgBoard>
        {/* Terrain is color-only here — the legend matches the ascii view */}
        <Legend data-testid="grid-legend-svg">
            {BIOME_ORDER.map((biome) => (
                <LegendItem key={biome} color={palette[biome]}>
                    <LegendSwatch color={palette[biome]} />
                    {biome}
                </LegendItem>
            ))}
        </Legend>
    </>
);
