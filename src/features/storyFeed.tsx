// Story — the tab that opens the story happening so far.
//
// The island's log IS the story: every entry left in the event bus is a
// narrative beat (a castaway washing ashore, a trade, a storm, a scenario
// encounter). Position plumbing never lands there, so the feed reads like
// a chronicle rather than a telemetry stream.
//
// The tab lives top right in the header; opening it drops an overlay panel
// (newest first) over the god view. Scenario encounters arrive as
// STRUCTURED story blocks (@godspace/core src/engine events `detail`):
// title, cast and the narrative lines render as one coherent entry;
// everything else renders as a single line. Timestamps come from the
// island's temporal configuration (scenario/temporal.ts) — the same
// calendar the World Ticker renders.

import { useToggleHook } from '@presource/react';
import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import { useWorld, useRevision } from './worldBridge';
import { islandCalendar } from '../scenario/temporal';
import type { WorldEvent } from '@godspace/core';

/** The tab button in the header's top right — the story's door. */
const StoryTabButton = styled<{ open: string }>('button', {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: ({ open }) => (open === 'true' ? PALETTE.accentDim : '#232c37'),
    color: ({ open }) => (open === 'true' ? '#eafff5' : PALETTE.text),
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 6,
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'inherit',
    letterSpacing: 1,
});

/** The overlay panel — pinned top right beneath the header, scrollable. */
const StoryPanel = styled('div', {
    position: 'fixed',
    top: 62,
    right: 16,
    width: 380,
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: '70vh',
    overflowY: 'auto',
    background: PALETTE.panel,
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 8,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    zIndex: 30,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
});

const PanelHeader = styled('div', {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
});

const PanelHeading = styled('span', {
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: 600,
    color: PALETTE.textDim,
});

const BeatCount = styled('span', {
    fontSize: 11,
    color: PALETTE.textDim,
    fontVariantNumeric: 'tabular-nums',
});

const EntryList = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
});

const Entry = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    paddingBottom: 8,
    borderBottom: `1px solid ${PALETTE.panelBorder}`,
});

/** A scenario encounter's story block — title, cast, then the lines. */
const StoryTitle = styled('div', {
    fontSize: 13,
    fontWeight: 700,
    color: PALETTE.accent,
});

const StoryCast = styled('div', {
    fontSize: 11,
    color: PALETTE.textDim,
    letterSpacing: 1,
});

const StoryLine = styled('div', {
    fontSize: 13,
    lineHeight: 1.45,
    color: PALETTE.text,
});

/** A plain narrative beat — one line, one row. */
const PlainLine = styled('div', {
    fontSize: 13,
    lineHeight: 1.45,
});

const Stamp = styled('div', {
    fontSize: 11,
    color: PALETTE.textDim,
    fontVariantNumeric: 'tabular-nums',
});

const EmptyNote = styled('div', {
    fontSize: 12,
    color: PALETTE.textDim,
});

const Padded = (value: number): string => String(value).padStart(2, '0');

/** Calendar stamp for a log time — "Jan 1 · 10:10". */
const stampOf = (time: number): string => {
    const stamp = islandCalendar(time);
    return `${stamp.monthName.slice(0, 3)} ${stamp.dayOfMonth} · ${Padded(stamp.hour)}:${Padded(stamp.minute)}`;
};

/** One story entry — a scenario block, or a plain narrative beat. */
const StoryEntry = ({ event }: { event: WorldEvent }) => {
    const detail = event.detail as
        | { title?: string; cast?: string[]; lines?: string[] }
        | undefined;
    if (detail?.lines && detail.lines.length > 0) {
        return (
            <Entry data-testid="story-entry">
                <Stamp>{stampOf(event.time)}</Stamp>
                <StoryTitle>{detail.title ?? 'A story'}</StoryTitle>
                {detail.cast && detail.cast.length > 0 ? (
                    <StoryCast>{detail.cast.join(' · ')}</StoryCast>
                ) : null}
                {detail.lines.map((line, index) => (
                    <StoryLine key={index}>{line}</StoryLine>
                ))}
            </Entry>
        );
    }
    return (
        <Entry data-testid="story-entry">
            <Stamp>{stampOf(event.time)}</Stamp>
            <PlainLine>{event.message}</PlainLine>
        </Entry>
    );
};

/** The Story tab + its overlay panel. */
export const StoryTab = () => {
    const island = useWorld();
    const revision = useRevision();
    const open = useToggleHook(false);
    if (!island) {
        return null;
    }
    void revision;

    // The whole log IS the story now — newest first
    const entries = island.world.events.log().slice().reverse();

    return (
        <>
            <StoryTabButton
                open={open() ? 'true' : 'false'}
                data-testid="story-tab"
                onClick={() => open(!open())}
            >
                Story {open() ? '▾' : '▸'}
            </StoryTabButton>
            {open() ? (
                <StoryPanel data-testid="story-panel">
                    <PanelHeader>
                        <PanelHeading>The story so far</PanelHeading>
                        <BeatCount>{entries.length} beats</BeatCount>
                    </PanelHeader>
                    <EntryList data-testid="story-feed">
                        {entries.length === 0 ? (
                            <EmptyNote>The island is silent.</EmptyNote>
                        ) : (
                            entries.map((event) => <StoryEntry key={event.id} event={event} />)
                        )}
                    </EntryList>
                </StoryPanel>
            ) : null}
        </>
    );
};
