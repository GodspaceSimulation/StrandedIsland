// Ticker controls — the god's hand on the world clock.
//
// Step advances exactly one tick; Play/Pause toggles the realtime loop;
// tick size redefines what one tick MEANS (minutes of world time); speed
// scales ticks per real second while playing.
//
// The calendar readout comes from the @godspace/core temporal system
// (packages/godspace/core/src/temporal): elapsed world minutes → the
// year/season/month/day calendar. Standard shape — 3 months per season,
// 365 days a year — is the temporal default, so the island just feeds it
// the ticker's elapsed minutes.

import { temporalCalendar, type TemporalCalendarPoint } from '@godspace/core';
import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import { ControlButton, ControlRow, ControlSelect, Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, bumpRevision } from './worldBridge';

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
 * "Year 1 · Spring · Jan 1 · 00:00" — year, season, month-day, clock face.
 */
export const formatClock = (calendar: TemporalCalendarPoint): string =>
    `Year ${calendar.year} · ${calendar.seasonName} · ${calendar.monthName.slice(0, 3)} ${calendar.dayOfMonth} · ${Padded(calendar.hour)}:${Padded(calendar.minute)}`;

export const TickerControls = () => {
    const island = useWorld();
    const revision = useRevision();
    if (!island) {
        return null;
    }
    void revision;

    const { world } = island;
    const ticker = world.ticker;
    const running = ticker.running();
    const minutes = ticker.tickSize();
    // The world calendar — derived from the ticker's elapsed minutes through
    // the @godspace/core temporal system (3 months/season, 365 days/year)
    const calendar = temporalCalendar(ticker.elapsed());

    return (
        <Panel>
            <PanelTitle>World Ticker</PanelTitle>
            <ClockValue data-testid="world-clock">{formatClock(calendar)}</ClockValue>
            <TickLabel>
                {ticker.ticks()} ticks × {minutes} min · {calendar.dayOfYear} / 365 ·{' '}
                {ticker.elapsed()} world minutes
            </TickLabel>
            <ControlRow>
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
                    {running ? '❚❚ Pause' : '▶ Play'}
                </ControlButton>
                <ControlButton
                    data-testid="step-button"
                    onClick={() => {
                        // The full world step: ticker + every plugin tick
                        world.step();
                        bumpRevision();
                    }}
                >
                    Step ▸
                </ControlButton>
            </ControlRow>
            <ControlRow>
                <ControlSelect
                    data-testid="tick-size"
                    value={String(minutes)}
                    onChange={(event) => {
                        // One tick can be a minute, ten minutes or an hour —
                        // the god decides what a tick means
                        const input = event.target as HTMLSelectElement;
                        ticker.tickSize(Number(input.value));
                        bumpRevision();
                    }}
                >
                    <option value="1">1 min / tick</option>
                    <option value="10">10 min / tick</option>
                    <option value="60">1 hour / tick</option>
                </ControlSelect>
                <ControlSelect
                    data-testid="speed"
                    value={String(ticker.speed())}
                    onChange={(event) => {
                        const input = event.target as HTMLSelectElement;
                        ticker.speed(Number(input.value));
                        bumpRevision();
                    }}
                >
                    <option value="1">1× speed</option>
                    <option value="2">2× speed</option>
                    <option value="5">5× speed</option>
                    <option value="10">10× speed</option>
                </ControlSelect>
            </ControlRow>
        </Panel>
    );
};
