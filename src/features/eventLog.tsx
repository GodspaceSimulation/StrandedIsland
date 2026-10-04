// World log — the stream of everything that happens on the island.

import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision } from './worldBridge';

const LogList = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    fontSize: 13,
    maxHeight: '180px',
    overflowY: 'auto',
});

const LogRow = styled('div', {
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
});

const LogTick = styled('span', {
    color: PALETTE.textDim,
    fontSize: 11,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '52px',
});

/** How many recent events to show. */
const VISIBLE = 30;

export const EventLog = () => {
    const island = useWorld();
    const revision = useRevision();
    if (!island) {
        return null;
    }
    void revision;

    // Newest first
    const events = island.world.events.log().slice(-VISIBLE).reverse();

    return (
        <Panel>
            <PanelTitle>World Log</PanelTitle>
            <LogList data-testid="event-log">
                {events.length === 0 ? (
                    <LogRow>
                        <span style={{ color: PALETTE.textDim }}>The island is silent.</span>
                    </LogRow>
                ) : (
                    events.map((event) => (
                        <LogRow key={event.id} data-testid="event-row">
                            <LogTick>
                                Day {Math.floor(event.time / 1440) + 1} ·{' '}
                                {String(Math.floor((event.time % 1440) / 60)).padStart(2, '0')}:
                                {String(event.time % 60).padStart(2, '0')}
                            </LogTick>
                            <span>{event.message}</span>
                        </LogRow>
                    ))
                )}
            </LogList>
        </Panel>
    );
};
