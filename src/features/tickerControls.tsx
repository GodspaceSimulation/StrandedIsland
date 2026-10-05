// Ticker controls — the god's hand on the world clock.
//
// Step advances exactly one tick; Auto (play/pause) runs the simulation AS
// FAST AS POSSIBLE — no ticks-per-second cap, the browser's animation frames
// batch as many steps as their CPU budget allows. The tick's SIZE is not a
// free dial: the VIEW SCALE defines it (one zoom rung is one factor of 10 of
// step time — scale 0 steps 10 minutes, scale +1 steps 1 minute, scale −1
// would step 100 minutes; see scenario/island.ts minutesPerScaleStep).
//
// The calendar readout comes from the island's temporal configuration
// (scenario/temporal.ts): elapsed world minutes → the year/season/month/day
// calendar — a TRUE Earth calendar born at 10:00 on January 1, 1609, with
// Gregorian month lengths and leap years.

import type { TemporalCalendarPoint } from '@godspace/core';
import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import { ControlButton, ControlRow, Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, useScale, bumpRevision } from './worldBridge';
import { islandCalendar } from '../scenario/temporal';

const ClockValue = styled('div', {
    fontSize: 22,
    fontWeight: 700,
    color: PALETTE.accent,
    fontVariantNumeric: 'tabular-nums',
});

const TickLabel = styled('span', {
    fontSize: 11,
    color: PALETTE.textDim,
});

const Padded = (value: number): string => String(value).padStart(2, '0');

/**
 * World clock line from the temporal calendar point, e.g.
 * "Year 1609 · Winter · Jan 1 · 10:00" — year, season, month-day, clock face.
 */
export const formatClock = (calendar: TemporalCalendarPoint): string =>
    `Year ${calendar.year} · ${calendar.seasonName} · ${calendar.monthName.slice(0, 3)} ${calendar.dayOfMonth} · ${Padded(calendar.hour)}:${Padded(calendar.minute)}`;

export const TickerControls = () => {
    const island = useWorld();
    const revision = useRevision();
    // The step time is the VIEW SCALE's — subscribing to the scale keeps
    // this panel live when the god zooms (a zoom re-times the tick)
    const scale = useScale();
    if (!island) {
        return null;
    }
    void revision;

    const { world } = island;
    const ticker = world.ticker;
    const running = ticker.running();
    const minutes = ticker.tickSize();
    // The world calendar — derived from the ticker's elapsed minutes through
    // the island's temporal configuration (scenario/temporal.ts)
    const calendar = islandCalendar(ticker.elapsed());

    return (
        <Panel>
            <PanelTitle>World Ticker</PanelTitle>
            <ClockValue data-testid="world-clock">{formatClock(calendar)}</ClockValue>
            <TickLabel data-testid="tick-label">
                Scale {scale} · {ticker.ticks()} ticks × {minutes} min · {calendar.dayOfYear} /{' '}
                {calendar.daysInYear} · {ticker.elapsed()} world minutes
            </TickLabel>
            <ControlRow>
                {/* AUTO mode — the simulation runs as fast as the browser
                    allows, no per-second cap. Play/Pause toggles the loop. */}
                <ControlButton
                    active={running}
                    data-testid="play-button"
                    onClick={() => {
                        if (running) {
                            ticker.pause();
                        } else {
                            ticker.play();
                        }
                        bumpRevision();
                    }}
                >
                    {running ? '❚❚ Pause' : '▶ Auto'}
                </ControlButton>
                <ControlButton
                    data-testid="step-button"
                    onClick={() => {
                        // The full world step: ticker + every plugin tick
                        // (once per world-minute of the step)
                        world.step();
                        bumpRevision();
                    }}
                >
                    Step ▸
                </ControlButton>
            </ControlRow>
        </Panel>
    );
};
