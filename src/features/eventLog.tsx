// World log — hidden until opened.
//
// Collapsed by default: the header row shows the event count and acts as
// the toggle. Clicking it expands the stream (newest first).
//
// Timestamps come from the island's temporal configuration (scenario/
// temporal.ts — Year · Month day · clock face) — the same calendar the
// World Ticker renders, so log lines and the big clock always agree
// on "when".

import { useToggleHook } from '@presource/react';
import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision } from './worldBridge';
import { islandCalendar } from '../scenario/temporal';

/** Clickable header row for the collapsible panel. */
const HeaderRow = styled<{ open: string }>('button', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
    background: 'transparent',
    border: 'none',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
});

const CountTag = styled<{ open: string }>('span', {
    fontSize: 11,
    color: ({ open }) => (open === 'true' ? PALETTE.text : PALETTE.textDim),
    fontVariantNumeric: 'tabular-nums',
});

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

const Padded = (value: number): string => String(value).padStart(2, '0');

/** How many recent events to show once expanded. */
const VISIBLE = 30;

export const EventLog = () => {
    const island = useWorld();
    const revision = useRevision();
    const open = useToggleHook(false);
    if (!island) {
        return null;
    }
    void revision;

    const all = island.world.events.log();
    // Newest first when expanded
    const events = all.slice(-VISIBLE).reverse();

    return (
        <Panel>
            <HeaderRow
                open={open() ? 'true' : 'false'}
                data-testid="log-toggle"
                onClick={() => open(!open())}
            >
                <PanelTitle>World Log</PanelTitle>
                <CountTag open={open() ? 'true' : 'false'}>
                    {all.length} events {open() ? '▾' : '▸'}
                </CountTag>
            </HeaderRow>
            {open() ? (
                <LogList data-testid="event-log">
                    {events.length === 0 ? (
                        <LogRow>
                            <span style={{ color: PALETTE.textDim }}>The island is silent.</span>
                        </LogRow>
                    ) : (
                        events.map((event) => {
                            // Temporal calendar stamp — "Year 1609 · Jan 1 · 10:10"
                            const stamp = islandCalendar(event.time);
                            return (
                                <LogRow key={event.id} data-testid="event-row">
                                    <LogTick>
                                        Year {stamp.year} · {stamp.monthName.slice(0, 3)}{' '}
                                        {stamp.dayOfMonth} · {Padded(stamp.hour)}:
                                        {Padded(stamp.minute)}
                                    </LogTick>
                                    <span>{event.message}</span>
                                </LogRow>
                            );
                        })
                    )}
                </LogList>
            ) : null}
        </Panel>
    );
};
