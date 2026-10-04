// Ticker controls — the god's hand on the world clock.
//
// Step advances exactly one tick; Play/Pause toggles the realtime loop;
// tick size redefines what one tick MEANS (minutes of world time); speed
// scales ticks per real second while playing.

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

/** World clock line, e.g. "Day 2 · 07:30". */
export const formatClock = (clock: { day: number; hour: number; minute: number }): string =>
    `Day ${clock.day} · ${Padded(clock.hour)}:${Padded(clock.minute)}`;

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

    return (
        <Panel>
            <PanelTitle>World Ticker</PanelTitle>
            <ClockValue data-testid="world-clock">{formatClock(ticker.clock())}</ClockValue>
            <TickLabel>
                {ticker.ticks()} ticks × {minutes} min · {ticker.elapsed()} world minutes
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
