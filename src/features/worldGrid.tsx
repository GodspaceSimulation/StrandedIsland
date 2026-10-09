// The island canvas — the @godspace/canvas representation area, TABBED and
// SCALE-AWARE.
//
// One UI serves EVERY zoom level of the recursive tile ladder (@godspace/core
// src/subtile): the tabs, the interactions, the legend and the board
// dimensions are identical at scale 0, scale 1 and beyond — a tile's
// sub-grid has the same width × height as the world grid, so zooming in
// re-renders the SAME components over the zoomed slice (features/tileDetails
// scaleView) instead of switching to a special board. The scale bar holds
// ONE toggle: this version's ladder is two rungs (scale 1 the island, the
// default view — scale 0 the tile interior), so the button flips between
// them — at the island view it zooms into the INSPECTED tile (its target;
// without a pick it stands off), at the interior it pops back up the
// lineage. The ladder counts UP from the lowest level: scale 0 is the tile
// interior — the simulation ground, where the entities move around — and
// scale 1 is the island, THE DEFAULT VIEW, which shows where those
// entities are.
//
// Four representations of the CURRENT view, one per tab (all loaded as
// plugins from @godspace/canvas by the scenario, see scenario/island.ts):
//   Data    — the data canvas plugin: plain tables of every entity's
//             coordinates (id/kind/type/name/state/x/y/z), the terrain
//             census and the canvas overview
//   ASCII   — the ascii canvas plugin: one colored tile per ground cell
//             (surface palette), one glyph letter per entity
//   Unicode — the unicode canvas plugin: the emoji twin — semantic emoji
//             per entity (resolved from the kind/type taxonomy), terrain
//             drawn as color only (no per-tile emoji flood) EXCEPT the
//             standing DECORATIONS the engine hangs on tiles: a treed tile
//             draws the 🌳 tree emoji when no entity stands on it (the
//             woods, visible at last — scenario/island.ts decorationOf),
//             same colors. THE DEFAULT VIEW
//   SVG     — the svg canvas plugin: the vector twin — the world as a
//             scalable SVG document (one rect per ground cell, one text
//             per entity, native <title> hovers, the vector TREE icon on
//             treed tiles); geometry on the SAME 26px tile grid, so every
//             tab occupies the same board footprint
//
// At the island view (scale 1 = the ladder's top) the canvases render their
// bound root view (frame()); deeper levels re-bind through frameFor with the
// zoomed slice — the zoom seam (@godspace/canvas AsciiFrameSource). Zoomed
// in, the tiles are SUBTILES: the parent tile's deposits stand distributed
// on them (a forest tile's tree ×2 scatters into two tree subtiles — the
// trees, visible at last), and its residents stand at their fine positions
// (world.subOf).
//
// TILE OCCUPATION PARITY — every tile canvas draws on the SAME 26px grid
// (ascii's tile) at every scale. The unicode tab once painted 30px emoji
// tiles, which blew this panel wide; all tile tabs now share the ascii size
// so switching representations never breaks the layout.
//
// NO Z-INDEX ON CHARACTERS — the altitude superscript is gone from the
// glyphs (K² → K): altitude is communicated by the FADE BANDS instead
// (birds color-fade with altitude, plugins/birds/birdsPlugin.ts
// BIRD_ALTITUDE_STATES) and by the hover titles, which still read the exact
// state + z. The elevation field stays in the frame data (inspectors read
// it); only the drawn glyph dropped it.
//
// Hovering a tile shows the voxel column plus every entity standing in
// that column AND selects the tile itself at the current scale (the hover
// sets the SAME full address a click would — the existing zoom target the
// wheel and the ScaleBar toggle descend into — but it never re-points the
// actor inspector and never zooms; the pick is sticky and survives leaving
// the board). Clicking ANY tile inspects that tile AT THE CURRENT SCALE
// (the selection extends the view path); when the tile holds a castaway,
// the god's actor inspector opens for them too (birds and other non-
// registry residents stay view-only). The data tab is read-only — it shows
// the exact coordinates the other three draw as glyphs.
//
// WHEEL ZOOM — scrolling the mouse over a tile board drives the same zoom
// ladder the ScaleBar toggle drives: scroll up = Zoom In (descends into the
// SELECTED tile — the same target contract the toggle has), scroll down =
// Zoom Out (pops back up the lineage). It is active only while a tile is
// selected; with no selection (or at a rung's end) the wheel stays with the
// page scroll. The Data tab is excluded — its tables scroll natively.
//
// R5 — THE DAY/NIGHT LIGHTING — the canvas wears the world clock. The tile
// boards (ascii/unicode/svg, at EVERY scale rung — the ladder is a pure
// view) sit under a translucent night veil whose alpha is the world clock's
// dark side: elapsed world minutes → scenario/dayCycle.ts daylightAt (the
// shared clock contract, the same pure functions the sleep plugin reads) →
// ambient light in [NIGHT_LIGHT_FLOOR 0.35, 1] → veil alpha = 1 − ambient.
// Full daylight 07:30–16:30 paints nothing; the 18:00–06:00 night paints
// the readable 0.65 floor (the R6 "nonblocking readable night floor" rule —
// every tile stays visible and clickable through the veil, which is
// pointer-events: none); dusk (16:30→18:00) and dawn (06:00→07:30) ride
// 90-minute smoothstep ramps so the light never jumps between minutes. The
// veil is presentation only — the scale bar, tabs, legends and the Data
// tables stay lit, and the ScaleBar gains a PhaseBadge ("Day · 10:00" /
// "Night · 18:00") stating the phase and clock face the lighting reads.
// The clock itself is NOT new state: it is read fresh from
// world.ticker.elapsed() each render, and the existing revision pulse
// (worldBridge — every tick and world event bumps it) re-renders the grid,
// so the lighting tracks the ticker exactly like every other panel.

import { useEffect, type ForwardRefExoticComponent, type HTMLAttributes, type RefAttributes } from 'react';
import { useStateHook, useReferenceHook } from '@presource/react';
import {
    type AsciiFrame,
    type SvgFrame,
    type UnicodeFrame,
} from '@godspace/canvas';
import type { TilePath } from '@godspace/core';
import type { IslandHandle } from '../scenario/island';
import { PALETTE } from '../styles/theme';
import { styled } from '../styles/styled';
import { Panel, PanelTitle } from '../components/panel';
import {
    useWorld,
    useRevision,
    useSelection,
    useScale,
    selectActor,
    zoomIn,
    zoomOut,
    toggleZoom,
    useTile,
    selectTile,
} from './worldBridge';
import { scaleView, treeIconOpacity, tileProgress, type TileProgress } from './tileDetails';
// R5 — the shared day/night clock contract (scenario/dayCycle.ts): the SAME
// pure functions the sleep plugin reads, so the canvas lighting and the
// sleep window can never disagree. Pure reads — the caller supplies the
// elapsed world minutes (world.ticker.elapsed()).
import { daylightAt, isNight, minuteOfDay } from '../scenario/dayCycle';

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
    // The progress bars (R6) anchor to the tile's bottom edge
    position: 'relative',
});

// ── The tile progress bars (R6) ──────────────────────────────────────────────
// A standing job on a tile (the shared tile-work ledger + the live site
// build work, features/tileDetails tileProgress) wears a thin bar along the
// tile's bottom edge. Multiple jobs on one tile STACK upward (the `offset`
// prop, 5px per bar) so a tile under a chop AND a build reads both. The
// fill width is a percentage STRING (the function value bypasses
// styleStructure's rem conversion — a raw number would become '0.05rem').
// Accessible: each track is a role="progressbar" with the exact
// aria-valuenow/min/max of the work minutes.

const WorkBarTrack = styled<{ offset: number }>('div', {
    position: 'absolute',
    left: 2,
    right: 2,
    bottom: ({ offset }) => `${2 + offset * 5}px`,
    height: 3,
    background: 'rgba(0,0,0,0.45)',
    borderRadius: 2,
});

const WorkBarFill = styled<{ pct: number }>('div', {
    width: ({ pct }) => `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%`,
    height: '100%',
    background: PALETTE.accent,
    borderRadius: 2,
});

/** The DOM (ascii/unicode) progress bars of one tile — empty when idle. */
const WorkBars = ({ x, y, progress }: { x: number; y: number; progress: TileProgress[] }) => (
    <>
        {progress.map((job, index) => (
            <WorkBarTrack
                key={`${job.label}-${index}`}
                offset={index}
                role="progressbar"
                aria-valuenow={job.done}
                aria-valuemin={0}
                aria-valuemax={job.total}
                aria-label={`${job.label} ${job.done}/${job.total}`}
                // R1 — the bar carries its OWN hover detail (the exact work
                // minutes), the DOM twin of the SVG strip's <title>. Without
                // it the track only ever surfaced the CELL's column tooltip
                // and hovering the bar showed no job detail at all
                title={`${job.label} ${job.done}/${job.total}`}
                data-testid={`work-bar-${x}-${y}-${job.label}`}
            >
                <WorkBarFill pct={job.total > 0 ? job.done / job.total : 0} />
            </WorkBarTrack>
        ))}
    </>
);

// `opacity` is prop-driven: the standing DECORATIONS (the tree icon) fade by
// the tile's true scale-0 tree coverage in the island view (features/
// tileDetails treeIconOpacity) while entity glyphs always stand at full
// opacity (they pass no opacity — the resolver returns undefined and the
// styled class drops the property). NOTE the function (not the 'custom'
// sentinel): 'custom' runs numbers through styleStructure's rem conversion
// (0.1 → '0.05rem' — INVALID for the unitless opacity, the fade would
// silently no-op); returning a STRING bypasses the conversion untouched.
const Marker = styled<{ color: string; opacity?: number }>('span', {
    color: 'custom',
    opacity: ({ opacity }) => (opacity === undefined ? undefined : String(opacity)),
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

// ── Scale bar — the ONE zoom toggle (identical at every scale) ───────────────

const ScaleBar = styled('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
});

// The single zoom control. This version's ladder holds only two rungs —
// scale 1 (the island, the default) and scale 0 (the tile interior) — so
// one button toggles between them: at the island view it reads Zoom In
// (descends into the inspected tile), at the interior it reads Zoom Out
// (pops back up). The `off` style prop is a STRING ('true'/'false' — the
// styled factory reads it for the paint); the HTML `disabled` attribute is
// passed separately as a real boolean so the DOM gets true button
// semantics. Zooming IN needs an inspected tile (its target), so at the
// top of the ladder with nothing picked the button stands off.
const ZoomButton = styled<{ off: string }>('button', {
    background: '#232c37',
    color: ({ off }) => (off === 'true' ? PALETTE.textDim : PALETTE.text),
    opacity: ({ off }) => (off === 'true' ? 0.45 : 1),
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 6,
    padding: '4px 12px',
    cursor: ({ off }) => (off === 'true' ? 'default' : 'pointer'),
    fontSize: 11,
    letterSpacing: 1,
    fontFamily: 'inherit',
    textTransform: 'uppercase',
});

// The current rung of the ladder, beside the toggle
const ScaleBadge = styled('span', {
    fontSize: 11,
    letterSpacing: 1,
    color: PALETTE.textDim,
    padding: '4px 10px',
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 6,
    background: '#232c37',
});

// The note when a zoomed view cannot resolve its slice (a stale lineage
// after a world redraw) — the toggle's Zoom Out side stays the way back
const ZoomEmpty = styled('span', {
    fontSize: 12,
    color: PALETTE.textDim,
});

// ── R5 — the day/night cycle: phase badge + night veil ───────────────────────

/** hh:mm clock face from a minute-of-day value — the PhaseBadge's read. */
const phaseClock = (minute: number): string =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

// The PhaseBadge — the day/night/time indicator in the scale bar (R5). It
// names the phase and the clock face the lighting is painted from ("Day ·
// 10:00" / "Night · 18:00") so the veil's dimming is never a mystery: the
// same minuteOfDay the veil derives its alpha from reads the badge. The
// `night` style prop is a STRING ('true'/'false' — the styled factory reads
// it for the paint, the ZoomButton pattern): night wears the cool moonlit
// blue, day the accent green.
const PhaseBadge = styled<{ night: string }>('span', {
    fontSize: 11,
    letterSpacing: 1,
    color: ({ night }) => (night === 'true' ? '#9db9e8' : PALETTE.accent),
    padding: '4px 10px',
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 6,
    background: '#232c37',
    fontVariantNumeric: 'tabular-nums',
});

// The BoardShell — the positioning context that lets the night veil overlay
// EXACTLY a tile board: it wraps each view's Grid/SvgBoard (never the legend
// and never the tab controls — the lighting is presentation, the chrome
// stays lit). The board itself stays untouched inside, so every structural
// contract on the grid element (children = one tile per cell) holds.
const BoardShell = styled('div', {
    position: 'relative',
});

// The NIGHT VEIL (R5) — the god-view's dynamic lighting overlay over a DOM
// tile board. One translucent wash whose alpha is the clock's dark side
// (1 − ambient, scenario/dayCycle.ts daylightAt): 0 through the daylight
// plateau, 0.65 at the night floor (NIGHT_LIGHT_FLOOR 0.35 — the R6
// "nonblocking readable night floor": every tile keeps 35 % of its color and
// stays readable), a smoothstep value in between across dusk/dawn. The wash
// is night BLUE (not black) so the moonlit board keeps its hue contrast.
// Rounded to 3 decimals — the smoothstep ramp's float noise stays out of the
// CSS string, the paint and the tests read the exact rounded value.
// `pointerEvents: none` + aria-hidden — the veil is pure decoration: it can
// never eat a click, a hover or the wheel zoom (every board interaction
// passes straight through), and it says so to assistive tech.
const NightVeil = styled<{ alpha: number }>('div', {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    background: ({ alpha }) => `rgba(8,12,30,${Math.round(alpha * 1000) / 1000})`,
});

// The SVG twin of the NightVeil — one full-viewBox rect with the same rgba
// fill string the DOM veils compute (veilAlpha arrives already rounded from
// WorldGrid, so the attribute is byte-identical to their CSS value). The
// fill arrives as a real SVG presentation ATTRIBUTE (the SvgTile convention
// — per-rect colors are attributes, the styled class carries the shared
// paint); `pointer-events: none` in the class keeps the veil nonblocking
// like its DOM siblings.
const SvgNightVeil = styled('rect', {
    pointerEvents: 'none',
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

/**
 * Legend order — the island's surface ladder. Resource surfaces first-class
 * (the tiles appear as the deposits they carry — trees, stone, iron, and the
 * voxel-derived unlimited ground supply grass/sand/dirt), then the plain
 * biome fallbacks that surface when a tile's finite deposits are gathered
 * away (or on sea columns). The SAME ladder serves every zoom level —
 * subtile surfaces come from the same deposit/voxel derivation.
 */
const SURFACE_ORDER: string[] = [
    'ocean',
    'shallows',
    'tree',
    'stone',
    'iron',
    'sand',
    'dirt',
    'grass',
    'beach',
    'meadow',
    'forest',
    'highland',
    // R4 — the interior fresh-water basins surface as their own water keys
    // (the palette joins them in scenario/island.ts GRASS_TILE_PALETTE)
    'lake',
    'pond',
];

// Board layer — the wheel-zoom wrapper around each mounted tile board
// (ascii / unicode / svg). Column layout with the Panel's 10px gap
// reproduced inside so the Grid + Legend spacing is unchanged. Ref-
// forwarded because the wheel listener attaches through the ref (Emotion
// forwards refs at runtime; the cast only surfaces the ref in TypeScript).
const BoardLayer = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
}) as unknown as ForwardRefExoticComponent<
    RefAttributes<HTMLDivElement> & HTMLAttributes<HTMLDivElement>
>;

// The tile BORDER — the selection highlights. Two DIFFERENT colors so the
// two selections never read as one on the canvas:
//   ENTITY pick — a castaway selected for the Entity Inspector wears the
//                 teal `accent` (the roster chip highlight's family)
//   TILE pick   — the tile under the Tile Inspector's lens wears the amber
//                 `tileAccent`
// One tile can be both (clicking a castaway inspects their tile AND
// selects the actor): the entity pick wins the paint — it is the stronger
// subject. Every canvas view (ascii/unicode/svg) shares the rule.
const tileBorder = (isSelected: boolean, isInspected: boolean): string =>
    isSelected
        ? `2px solid ${PALETTE.accent}`
        : isInspected
          ? `2px solid ${PALETTE.tileAccent}`
          : '1px solid rgba(0,0,0,0.3)';

// The SVG twin of tileBorder — a stroke COLOR (geometry attributes carry no
// width shorthand)
const tileStroke = (isSelected: boolean, isInspected: boolean): string =>
    isSelected ? PALETTE.accent : isInspected ? PALETTE.tileAccent : 'rgba(0,0,0,0.3)';

export const WorldGrid = () => {
    const island = useWorld();
    const revision = useRevision();
    const selected = useSelection();
    // The inspected tile's FULL path down the recursive ladder (null when
    // nothing is picked) and the view scale — 0 the tile interior (the
    // simulation ground), 1 the island (the default view)
    const inspected = useTile();
    const scale = useScale();
    // Active representation tab — the emoji (unicode) view is the default
    const tab = useStateHook<CanvasTab>('unicode');
    // The live board wrapper — the mount point of the wheel-zoom listener
    const boardLayer = useReferenceHook<HTMLDivElement | null>(null);

    // Wheel zoom — scrolling over a tile board rides the SAME view ladder
    // the ScaleBar toggle drives: scroll up descends into the SELECTED
    // tile's sub-grid (the same target contract the toggle has at the
    // island view — a selection is the zoom target), scroll down pops back
    // up the lineage. The listener is native and NON-passive so a zooming
    // scroll can preventDefault (React's synthetic onWheel registers
    // passive and cannot) — whenever the ladder cannot move (no tile
    // selected, or the view already sits at a rung's end) the wheel is left
    // to the page. Re-attached on every render (no deps) so the closure
    // always reads fresh ladder state; it is only live while a board is
    // mounted (the Data tab wraps its scrollable tables in nothing).
    useEffect(() => {
        const node = boardLayer();
        if (!node || !island) {
            return undefined;
        }
        const handleWheel = (event: WheelEvent) => {
            // Only vertical wheel motion zooms; horizontal trackpad
            // scrolls pass through untouched
            if (event.deltaY < 0 && island.scale.canZoomIn() && inspected !== null) {
                event.preventDefault();
                zoomIn();
            } else if (event.deltaY > 0 && island.scale.canZoomOut()) {
                event.preventDefault();
                zoomOut();
            }
        };
        node.addEventListener('wheel', handleWheel, { passive: false });
        return () => {
            node.removeEventListener('wheel', handleWheel);
        };
    });

    if (!island) {
        return null;
    }
    void revision; // subscription pulse — re-render on every world change

    const { world, ascii, unicode, svg, data } = island;

    // R5 — the canvas wears the world clock. The elapsed world minutes read
    // FRESH each render (the revision pulse — every tick and world event
    // bumps it, worldBridge — re-renders this component, so the lighting
    // tracks the ticker exactly like every other panel) and map through the
    // shared clock contract (scenario/dayCycle.ts):
    //   daylightAt — the smooth ambient in [NIGHT_LIGHT_FLOOR 0.35, 1]:
    //                full daylight 07:30–16:30, the floor through the
    //                18:00–06:00 night, 90-minute smoothstep ramps between
    //   isNight    — the phase flag (the night floor's window, save the
    //                single 06:00 ramp minute — see dayCycle.ts)
    //   minuteOfDay— the epoch-anchored clock face (elapsed 0 → 10:00),
    //                the PhaseBadge's read
    // The veil alpha is the clock's dark side, 1 − ambient, rounded to 3
    // decimals once here so the DOM veil's CSS value and the SVG veil's fill
    // attribute are byte-identical and the tests pin the exact string.
    const elapsed = world.ticker.elapsed();
    const ambient = daylightAt(elapsed);
    const veilAlpha = Math.round((1 - ambient) * 1000) / 1000;
    const night = isNight(elapsed);
    const clockMinute = minuteOfDay(elapsed);
    // The scale ladder lives on the island handle (@godspace/core src/scale)
    // — the signal carries the current rung, the system owns the clamps
    const zoom = island.scale;
    // The ladder's TOP — the island view's scale (the terrain's subtile
    // depth: one level below the island by default)
    const depth = zoom.range().max;

    // The CURRENT VIEW's address: the inspected path truncated to the view
    // depth — empty at the island view (scale 1 = the root island), length 1
    // at scale 0 (the inspected parent tile's sub-grid), and so on. The zoom
    // lineage keeps the inspected tile addressable inside its view.
    const viewPath: TilePath = inspected ? inspected.slice(0, depth - scale) : [];

    // The zoomed slice (null at the island view — the canvases render their
    // bound root view there). The SAME components render every level: the
    // sub-grid has the world grid's dimensions, so the board never changes
    // shape.
    const slice = scale === depth ? null : scaleView(island, viewPath);
    // A zoomed view that cannot resolve its slice — a stale lineage after a
    // world redraw (the root regenerated under the god's feet)
    const zoomFailed = scale < depth && !slice;
    // The inspected tile's TAIL coordinates — what the tile renderers
    // highlight (the amber tile-selection border) and what the tile tests
    // click by
    const inspectedTail = inspected
        ? { x: inspected[inspected.length - 1].x, y: inspected[inspected.length - 1].y }
        : null;

    // A tile click wires the same two inspections regardless of which canvas
    // is showing (all four frames carry identical coordinates) —
    // shared so every tile renderer stays behaviorally identical
    const inspectTile = (tile: { x: number; y: number }, castawayId: string | undefined) => {
        // Every click inspects the tile INSIDE the current view — the
        // selection extends the view path with the clicked subtile
        selectTile([...viewPath, { x: tile.x, y: tile.y }]);
        // A castaway on the tile ALSO re-points the actor inspector at them;
        // clicking an empty or bird-only tile leaves the actor pick
        // untouched — tile picks and actor picks are independent inspections
        if (castawayId) {
            selectActor(castawayId);
        }
    };

    // A tile HOVER selects it at the current scale without a click (R1 of the
    // hover feature) — the SAME formula inspectTile uses on click: the view
    // path (inspected.slice(0, depth - scale)) extended by the hovered
    // subtile — so hover and click always agree on the tile's full address,
    // and the hovered tile becomes the EXISTING zoom target the wheel scroll
    // and the ScaleBar toggle descend into. Hover must NOT do what a click
    // does on its own (R2): no zoomIn/zoomOut (the explicit wheel scroll and
    // the ScaleBar button stay the only zoom triggers, so hover alone never
    // moves the view — the wheel effect above then finds a fresh `inspected`
    // to zoom into) and no selectActor (the gold actor pick still opens only
    // on click/touch of a castaway). Nothing fires on mouse leave: the last
    // hovered tile STAYS selected (sticky), which also keeps the wheel-zoom
    // target valid between hovers.
    const hoverTile = (tile: { x: number; y: number }) => {
        selectTile([...viewPath, { x: tile.x, y: tile.y }]);
    };

    // R6 — the standing jobs of a tile (the shared tile-work ledger plus
    // the live site build work): the progress bars every board draws so
    // the god sees what work the world remembers at each tile.
    // R1 — THE BARS RIDE THE ADDRESS THAT OWNS THE WORK. The frame's tiles
    // carry VIEW-LOCAL coordinates: at the island view they ARE the root
    // (island) coordinates the ledger is keyed by (tileWorkKey composes
    // actor.position — the root space); at the zoomed interior they are the
    // parent tile's FINE cells, which are NOT ledger keys. So the read is
    // composed as a path: the island view reads `[{x, y}]` (ledger + any
    // footprint on the tile), the interior reads `[viewRoot, {x, y}]` —
    // the inspector's own address shape (tileSummary), where the ledger
    // half rides viewRoot = path[0] and the site half resolves the exact
    // fine cell the footprint covers. The interior board passes
    // tileJobs:false — a ledger job belongs to the WHOLE tile (the ledger
    // holds no fine-cell state), so it is never stamped onto individual
    // interior cells; the Tile Inspector still reads it at every zoom.
    const progressFor = (x: number, y: number): TileProgress[] =>
        tileProgress(
            island,
            viewPath.length > 0 ? [viewPath[0], { x, y }] : [{ x, y }],
            { tileJobs: viewPath.length === 0 },
        );

    // The zoom toggle at the ISLAND view needs an inspected tile — without
    // one there is nothing to zoom into (the button states that in its
    // hover title); at the interior view the toggle always can zoom out
    const canToggle = scale < depth ? true : zoom.canZoomIn() && inspected !== null;

    return (
        <Panel>
            <PanelTitle>Island Canvas</PanelTitle>
            {/* The ONE zoom control: badge (the current rung) + the toggle.
                This version's ladder is two rungs — scale 1 the island,
                scale 0 the tile interior — so one button flips between
                them: it reads Zoom In at the island view (descends into the
                inspected tile) and Zoom Out at the interior (pops back up) */}
            <ScaleBar data-testid="scale-controls">
                <ScaleBadge data-testid="scale-badge">Scale {scale}</ScaleBadge>
                {/* R5 — the day/night phase + clock face the lighting is
                    painted from. Same epoch the World Ticker's calendar
                    reads (scenario/temporal.ts startMinuteOfDay 600 =
                    10:00), so the badge, the veil and the clock always
                    agree. The title carries the exact ambient percentage
                    the veil derives its alpha from. */}
                <PhaseBadge
                    night={night ? 'true' : 'false'}
                    data-testid="daycycle-badge"
                    title={`Ambient light ${Math.round(ambient * 100)}%`}
                >
                    {night ? 'Night' : 'Day'} · {phaseClock(clockMinute)}
                </PhaseBadge>
                <ZoomButton
                    off={canToggle ? 'false' : 'true'}
                    disabled={!canToggle}
                    data-testid="zoom-toggle"
                    title={
                        scale < depth
                            ? 'Zoom out one scale'
                            : inspected
                              ? 'Zoom into the inspected tile'
                              : 'Hover over or select a tile to zoom into'
                    }
                    onClick={() => toggleZoom()}
                >
                    {scale < depth ? 'Zoom Out' : 'Zoom In'}
                </ZoomButton>
            </ScaleBar>
            {zoomFailed ? (
                <ZoomEmpty data-testid="zoom-empty">
                    The zoomed tile is no longer on the canvas — zoom out and pick again.
                </ZoomEmpty>
            ) : (
                <>
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
                            {(slice ? data.frameFor(slice) : data.frame()).tables.map((table) => (
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
                        <BoardLayer ref={boardLayer}>
                            <AsciiView
                                world={world}
                                frame={slice ? ascii.frameFor(slice) : ascii.frame()}
                                palette={ascii.palette().tiles}
                                inspected={inspectedTail}
                                selected={selected}
                                size={26}
                                // R5 — the night veil's alpha (1 − ambient,
                                // computed once in WorldGrid)
                                veilAlpha={veilAlpha}
                                progressFor={progressFor}
                                onTile={inspectTile}
                                onHover={hoverTile}
                            />
                        </BoardLayer>
                    ) : null}
                    {tab() === 'unicode' ? (
                        <BoardLayer ref={boardLayer}>
                            <UnicodeView
                                world={world}
                                frame={slice ? unicode.frameFor(slice) : unicode.frame()}
                                palette={unicode.palette().tiles}
                                inspected={inspectedTail}
                                selected={selected}
                                // SAME TILE OCCUPATION AS ASCII (26) — the emoji tab once
                                // painted 30px tiles and blew the panel wide; all tile
                                // tabs now share the ascii grid so switching never breaks
                                // the layout
                                size={26}
                                // The island view (the ladder's top — no zoomed slice)
                                // fades the tree decorations by the tile's TRUE scale-0
                                // coverage; the interior view stands at full opacity
                                islandView={slice === null}
                                // R5 — the night veil's alpha (1 − ambient,
                                // computed once in WorldGrid)
                                veilAlpha={veilAlpha}
                                progressFor={progressFor}
                                onTile={inspectTile}
                                onHover={hoverTile}
                            />
                        </BoardLayer>
                    ) : null}
                    {tab() === 'svg' ? (
                        <BoardLayer ref={boardLayer}>
                            <SvgView
                                world={world}
                                frame={slice ? svg.frameFor(slice) : svg.frame()}
                                palette={svg.palette().tiles}
                                inspected={inspectedTail}
                                selected={selected}
                                // Same island-view flag as the unicode view above — the
                                // coverage fade applies to the island view only (the
                                // interior view's drawn cells are trees by construction)
                                islandView={slice === null}
                                // R5 — the night veil's alpha (1 − ambient,
                                // computed once in WorldGrid)
                                veilAlpha={veilAlpha}
                                progressFor={progressFor}
                                onTile={inspectTile}
                                onHover={hoverTile}
                            />
                        </BoardLayer>
                    ) : null}
                </>
            )}
        </Panel>
    );
};

// ── ASCII view — the original colored-tile render ────────────────────────────

// The surface legend — shared by all three tile views (the same ladder at
// every scale)
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

const AsciiView = ({
    world,
    frame,
    palette,
    inspected,
    selected,
    size,
    veilAlpha,
    progressFor,
    onTile,
    onHover,
}: {
    world: IslandHandle['world'];
    frame: AsciiFrame;
    palette: Record<string, string>;
    inspected: { x: number; y: number } | null;
    selected: string | null;
    size: number;
    // R5 — the night veil's alpha (1 − ambient, scenario/dayCycle.ts
    // daylightAt; computed once in WorldGrid so every canvas reads the
    // same rounded value). 0 paints nothing, 0.65 the night floor.
    veilAlpha: number;
    // R6 — the standing jobs of a tile (the shared tile-work ledger + the
    // live site build work) — drawn as the bottom-edge progress bars
    progressFor: (x: number, y: number) => TileProgress[];
    onTile: (tile: { x: number; y: number }, castawayId: string | undefined) => void;
    // R1 hover — selects this tile ONLY (never the actor pick, never a
    // zoom); see hoverTile in WorldGrid for the full R1/R2 contract
    onHover: (tile: { x: number; y: number }) => void;
}) => (
    <>
        {/* The BoardShell gives the veil its positioning context — the grid
            itself keeps its exact structure (children = one tile per cell),
            and the veil overlays the BOARD only (the legend below and every
            control above stay lit) */}
        <BoardShell>
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
                    // the amber tile border so the god sees what the Tile
                    // Inspector below is reading
                    const isInspected =
                        inspected !== null && inspected.x === tile.x && inspected.y === tile.y;
                    return (
                        <Cell
                            key={`${tile.x},${tile.y}`}
                            background={tile.background}
                            border={tileBorder(isSelected, isInspected)}
                            title={tile.title}
                            data-testid={`grid-tile-${tile.x}-${tile.y}`}
                            onClick={() => onTile(tile, castaway?.id)}
                            // R1 hover: mouseenter selects this tile only (tile
                            // pick + zoom target, never the actor, never a zoom).
                            // Native mouse-enter semantics — fires once per cell
                            // entry and refires on re-entry; leave fires nothing
                            // (the pick stays sticky)
                            onMouseEnter={() => onHover(tile)}
                        >
                            {glyph ? (
                                <Marker color={glyph.color}>
                                    {glyph.glyph}
                                </Marker>
                            ) : null}
                            {/* R6 — the standing jobs' progress bars (the shared
                                tile work + the live site build work) */}
                            <WorkBars x={tile.x} y={tile.y} progress={progressFor(tile.x, tile.y)} />
                        </Cell>
                    );
                })}
            </Grid>
            {/* R5 — the night veil: one wash over the board, alpha =
                1 − ambient (the rounded veilAlpha from WorldGrid), the
                same value every canvas reads. pointer-events none — the
                veil is pure decoration and can never block a tile click,
                a hover or the wheel zoom. */}
            <NightVeil alpha={veilAlpha} data-testid="night-veil" aria-hidden="true" />
        </BoardShell>
        <Legend data-testid="grid-legend">
            {SURFACE_ORDER.map((surface) => (
                <LegendItem key={surface} color={palette[surface]}>
                    <LegendSwatch color={palette[surface]} />
                    {surface}
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
    islandView,
    veilAlpha,
    progressFor,
    onTile,
    onHover,
}: {
    world: IslandHandle['world'];
    frame: UnicodeFrame;
    palette: Record<string, string>;
    inspected: { x: number; y: number } | null;
    selected: string | null;
    size: number;
    // True at the island view (the ladder's top — the frame is the bound
    // root view, no zoomed slice): the tree decorations fade by the tile's
    // TRUE scale-0 tree coverage (features/tileDetails treeIconOpacity).
    // The interior view (the zoomed slice) stands at full opacity — every
    // drawn sub-grid cell there is a tree by construction (the mirror
    // scatters exactly the deposited units, one per cell), so its true
    // on-screen coverage is 100 %
    islandView: boolean;
    // R5 — the night veil's alpha (1 − ambient, scenario/dayCycle.ts
    // daylightAt; computed once in WorldGrid so every canvas reads the
    // same rounded value). 0 paints nothing, 0.65 the night floor.
    veilAlpha: number;
    // R6 — the standing jobs of a tile (the shared tile-work ledger + the
    // live site build work) — drawn as the bottom-edge progress bars
    progressFor: (x: number, y: number) => TileProgress[];
    onTile: (tile: { x: number; y: number }, castawayId: string | undefined) => void;
    // R1 hover — selects this tile ONLY (never the actor pick, never a
    // zoom); see hoverTile in WorldGrid for the full R1/R2 contract
    onHover: (tile: { x: number; y: number }) => void;
}) => (
    <>
        {/* The BoardShell gives the veil its positioning context — the grid
            itself keeps its exact structure (children = one tile per cell),
            and the veil overlays the BOARD only (the legend below and every
            control above stay lit) */}
        <BoardShell>
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
                    // Entities draw their emoji in the state color; EMPTY
                    // decorated tiles draw their standing icon — the 🌳 tree
                    // emoji on treed tiles (the woods, visible at last) and the
                    // 🪨 rock icon on stone-bearing tiles (the localized rock
                    // sites — the finite stone stock's marker, stock-driven:
                    // the frame's decorationOfCell resolver drops 'rock' the
                    // moment the tile's stock empties, so the icon disappears
                    // when the local stone is gone, at every scale). An entity
                    // always wins the tile over the decoration. Everything else
                    // stays bare — terrain shows through its background color
                    // alone (no per-tile emoji flood)
                    const decorationGlyph =
                        glyph === undefined
                            ? tile.decoration === 'rock'
                                ? '🪨'
                                : tile.decoration === 'tree'
                                  ? '🌳'
                                  : null
                            : null;
                    // THE SCALE-1 TREE OPACITY — at the island view the tree
                    // icon fades by the tile's TRUE scale-0 tree coverage: its
                    // standing tree UNITS (the live `resources.tree` deposit —
                    // the fine cells a sub-grid would scatter them onto) against
                    // the tile's sub-grid CELL COUNT (the board's width ×
                    // height — the sub-grid copies the world grid's dims). Zero
                    // trees → no icon (treeIconOpacity returns undefined — and
                    // the 'tree' decoration itself is stock-driven, so a bare
                    // tile never reaches the draw). The interior view (the
                    // zoomed slice) keeps FULL opacity: its drawn cells are
                    // trees by construction, so their true coverage is 100 %.
                    // The rock icon is BINARY (stock present → full opacity):
                    // the stock-driven drop is its honesty mechanism
                    const treeOpacity =
                        decorationGlyph === '🌳' && islandView
                            ? treeIconOpacity(
                                  world.cellAt(tile.x, tile.y)?.resources.tree ?? 0,
                                  world.canvas.width * world.canvas.height,
                              )
                            : undefined;
                    return (
                        <Cell
                            key={`${tile.x},${tile.y}`}
                            background={tile.background}
                            border={tileBorder(isSelected, isInspected)}
                            title={tile.title}
                            data-testid={`unicode-tile-${tile.x}-${tile.y}`}
                            onClick={() => onTile(tile, castaway?.id)}
                            // R1 hover — same contract as the ascii Cell above
                            // (tile pick + zoom target only; sticky on leave)
                            onMouseEnter={() => onHover(tile)}
                        >
                            {glyph ? (
                                <Marker color={glyph.color}>
                                    {glyph.glyph}
                                </Marker>
                            ) : decorationGlyph ? (
                                <Marker
                                    // The decoration's identity color — tree
                                    // green from the palette, the rock's mid
                                    // gray beside it (the emoji itself is
                                    // full-color; the color only styles the
                                    // surrounding span fallback)
                                    color={
                                        decorationGlyph === '🪨'
                                            ? (palette.stone ?? '#8d939e')
                                            : (palette.tree ?? '#4caf50')
                                    }
                                    // The coverage fade (tree, island view
                                    // only) — undefined omits the attribute
                                    opacity={treeOpacity}
                                    data-testid={
                                        decorationGlyph === '🪨'
                                            ? 'rock-icon-unicode'
                                            : 'tree-icon-unicode'
                                    }
                                >
                                    {decorationGlyph}
                                </Marker>
                            ) : null}
                            {/* R6 — the standing jobs' progress bars (the shared
                                tile work + the live site build work) */}
                            <WorkBars x={tile.x} y={tile.y} progress={progressFor(tile.x, tile.y)} />
                        </Cell>
                    );
                })}
            </Grid>
            {/* R5 — the night veil: the same wash the ascii view paints
                (alpha = 1 − ambient, the rounded veilAlpha from WorldGrid),
                pointer-events none so every tile interaction passes
                straight through */}
            <NightVeil alpha={veilAlpha} data-testid="night-veil" aria-hidden="true" />
        </BoardShell>
        {/* Terrain is color-only here except the tree decorations — the
            legend matches the ascii view */}
        <Legend data-testid="grid-legend-unicode">
            {SURFACE_ORDER.map((surface) => (
                <LegendItem key={surface} color={palette[surface]}>
                    <LegendSwatch color={palette[surface]} />
                    {surface}
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

// The vector TREE icon — the svg twin of the unicode view's 🌳 emoji. The
// canopy is a circle crowning the tile's center; the trunk is a slim rect
// rising to the tile's lower third (the silhouette that separates tree
// from bush). Colors mirror the @godspace/canvas svg plugin's own tree
// painter (packages/godspace/canvas src/svg drawTree) so the React view and
// the plugin's DOM mount draw the same icon. `opacity` carries the tile's
// SCALE-1 coverage fade (the island view only — see SvgView's treeOpacity;
// an undefined opacity renders the icon at full strength).
const TREE_TRUNK = '#7a5230';
const TREE_CANOPY = '#2e7d32';

// The vector ROCK icon — the svg twin of the unicode view's 🪨 emoji, and
// of the @godspace/canvas svg plugin's own rock painter (packages/godspace/
// canvas src/svg drawRock — the same two-circle geometry + hex pair, the
// main stone + the leaning pebble) so the React view and the plugin's DOM
// mount draw the same icon. It marks a STOCK-BEARING rock site (the finite
// stone's marker — scenario/island.ts decorationOfCell drops the 'rock'
// decoration when the tile's stone stock empties, so the icon disappears
// when the local stone is gone, at every scale) — BINARY: no fade.
const ROCK_MAIN = '#4b5563';
const ROCK_PEBBLE = '#d1d5db';

const SvgRock = ({ x, y, size }: { x: number; y: number; size: number }) => (
    <>
        {/* The main stone — a circle crowning the tile's center-right */}
        <circle
            cx={x + size * 0.05}
            cy={y - size * 0.02}
            r={size * 0.18}
            fill={ROCK_MAIN}
            data-testid="rock-icon-svg-main"
        />
        {/* The pebble — a smaller circle leaning on the main stone's
            lower-left flank (drawn second so the overlap reads as stacked
            stones) */}
        <circle
            cx={x - size * 0.13}
            cy={y + size * 0.12}
            r={size * 0.1}
            fill={ROCK_PEBBLE}
            data-testid="rock-icon-svg-pebble"
        />
    </>
);

const SvgTree = ({
    x,
    y,
    size,
    opacity,
}: {
    x: number;
    y: number;
    size: number;
    // The coverage fade — undefined (omitted) at full strength
    opacity?: number;
}) => (
    <>
        {/* The canopy — a circle crowning the center, sized a bit over half
            the tile edge so it stays inside the rounded rect */}
        <circle
            cx={x}
            cy={y - size * 0.12}
            r={size * 0.26}
            fill={TREE_CANOPY}
            opacity={opacity}
            data-testid="tree-icon-svg-canopy"
        />
        {/* The trunk — a slim rect rising from below the canopy */}
        <rect
            x={x - size * 0.06}
            y={y - size * 0.02}
            width={size * 0.12}
            height={size * 0.3}
            rx={1}
            fill={TREE_TRUNK}
            opacity={opacity}
            data-testid="tree-icon-svg-trunk"
        />
    </>
);

const SvgView = ({
    world,
    frame,
    palette,
    inspected,
    selected,
    islandView,
    veilAlpha,
    progressFor,
    onTile,
    onHover,
}: {
    world: IslandHandle['world'];
    frame: SvgFrame;
    palette: Record<string, string>;
    inspected: { x: number; y: number } | null;
    selected: string | null;
    // True at the island view (the ladder's top — the frame is the bound
    // root view, no zoomed slice): the tree icons fade by the tile's TRUE
    // scale-0 tree coverage (the same rule the unicode view applies —
    // features/tileDetails treeIconOpacity); the interior view stands at
    // full opacity (its drawn cells are trees by construction)
    islandView: boolean;
    // R5 — the night veil's alpha (1 − ambient, scenario/dayCycle.ts
    // daylightAt; computed once in WorldGrid so every canvas reads the
    // same rounded value). 0 paints nothing, 0.65 the night floor.
    veilAlpha: number;
    // R6 — the standing jobs of a tile (the shared tile-work ledger + the
    // live site build work) — drawn as the bottom-edge progress bars
    progressFor: (x: number, y: number) => TileProgress[];
    onTile: (tile: { x: number; y: number }, castawayId: string | undefined) => void;
    // R1 hover — selects this tile ONLY (never the actor pick, never a
    // zoom); see hoverTile in WorldGrid for the full R1/R2 contract
    onHover: (tile: { x: number; y: number }) => void;
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
                        // R1 hover — same contract as the DOM cells above;
                        // the SVG-native <title> tooltip below coexists with
                        // it (hover shows the column tooltip AND selects)
                        onMouseEnter={() => onHover(tile)}
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
                            stroke={tileStroke(isSelected, isInspected)}
                        />
                        {/* THE SCALE-1 TREE OPACITY — the island view fades
                            the vector tree icon by the tile's TRUE scale-0
                            tree coverage (the live `resources.tree` units
                            against the board's cell count — the sub-grid
                            copies the world grid's dims); the interior view
                            stands at full opacity (its drawn cells are
                            trees by construction — 100 % true coverage).
                            The rock icon is BINARY (no fade) — the stock-
                            driven drop is its honesty mechanism. An entity
                            always wins the tile over the decoration */}
                        {glyph ? (
                            <SvgGlyph
                                x={column * frame.size + frame.size / 2}
                                y={row * frame.size + frame.size / 2}
                                fill={glyph.color}
                            >
                                {glyph.glyph}
                            </SvgGlyph>
                        ) : tile.decoration === 'tree' ? (
                            <SvgTree
                                x={column * frame.size + frame.size / 2}
                                y={row * frame.size + frame.size / 2}
                                size={frame.size}
                                opacity={
                                    islandView
                                        ? treeIconOpacity(
                                              world.cellAt(tile.x, tile.y)?.resources.tree ?? 0,
                                              world.canvas.width * world.canvas.height,
                                          )
                                        : undefined
                                }
                            />
                        ) : tile.decoration === 'rock' ? (
                            // The vector rock — the stone-bearing tile's
                            // standing icon (full strength — binary)
                            <SvgRock
                                x={column * frame.size + frame.size / 2}
                                y={row * frame.size + frame.size / 2}
                                size={frame.size}
                            />
                        ) : null}
                        {/* R6 — the standing jobs' progress bars (the shared
                            tile work + the live site build work): a 2-unit
                            strip along the tile's bottom edge, stacked 5
                            units per job (the DOM views' twin). The <title>
            carries the accessible read (aria-* is not SVG-native here) */}
                        {progressFor(tile.x, tile.y).map((job, index) => (
                            <rect
                                key={`${job.label}-${index}`}
                                x={column * frame.size + 2}
                                y={row * frame.size + frame.size - 4 - index * 5}
                                width={Math.max(
                                    0,
                                    Math.min(1, job.total > 0 ? job.done / job.total : 0) *
                                        (frame.size - 4),
                                )}
                                height={2}
                                rx={1}
                                fill={PALETTE.accent}
                                data-testid={`work-bar-svg-${tile.x}-${tile.y}-${job.label}`}
                            >
                                <title>{`${job.label} ${job.done}/${job.total}`}</title>
                            </rect>
                        ))}
                    </g>
                );
            })}
            {/* R5 — the vector twin of the night veil: one full-viewBox rect
                painted LAST (SVG renders in document order — the wash sits
                over every tile group) with the same rgba fill the DOM
                veils compute from veilAlpha. Inside the svg root (not a
                wrapper) on purpose: the veil is a child of the vector
                document, so the board's `<g>` structure — every tile
                group the tests and interactions address — is untouched.
                pointer-events none keeps it nonblocking like the DOM
                veils; aria-hidden marks it decorative. */}
            <SvgNightVeil
                x={0}
                y={0}
                width={frame.columns * frame.size}
                height={frame.rows * frame.size}
                fill={`rgba(8,12,30,${veilAlpha})`}
                data-testid="night-veil-svg"
                aria-hidden="true"
            />
        </SvgBoard>
        {/* Terrain is color-only here except the tree decorations — the
            legend matches the ascii view */}
        <Legend data-testid="grid-legend-svg">
            {SURFACE_ORDER.map((surface) => (
                <LegendItem key={surface} color={palette[surface]}>
                    <LegendSwatch color={palette[surface]} />
                    {surface}
                </LegendItem>
            ))}
        </Legend>
    </>
);
