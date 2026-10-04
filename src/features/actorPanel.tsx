// Actor inspector — needs, inventory and bonds for whichever castaway the
// god selects. Rendered in the LEFT rail (where the roster lives — see
// dashboard.tsx). The actor's history is hidden behind a toggle: the god
// clicks "History" to open it, keeping the panel compact otherwise.

import { useToggleHook } from '@presource/react';
import { styled } from '../styles/styled';
import { NEED_COLORS, PALETTE } from '../styles/theme';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, useSelection } from './worldBridge';
import { needsDisplay, type NeedsDisplay } from './needsDisplay';
import { inventoryEntries } from '../plugins/inventory/inventory';
import { itemLabel } from '../plugins/inventory/items';
import type { Actor } from '../engine/types';

const Row = styled('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
});

const NeedName = styled('span', {
    width: '52px',
    fontSize: 12,
    color: PALETTE.textDim,
});

const Track = styled('div', {
    height: '8px',
    flex: 1,
    background: '#2a333f',
    borderRadius: 4,
    overflow: 'hidden',
});

const Fill = styled<{ width: string; background: string }>('div', {
    height: '100%',
    width: 'custom',
    background: 'custom',
    borderRadius: 4,
});

const NeedValue = styled('span', {
    width: '34px',
    textAlign: 'right',
    fontSize: 12,
    fontVariantNumeric: 'tabular-nums',
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

const History = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    fontSize: 12,
    color: PALETTE.textDim,
    maxHeight: '140px',
    overflowY: 'auto',
});

/** Collapsible section header — acts as the toggle button. */
const HistoryToggle = styled<{ open: string }>('button', {
    background: 'transparent',
    border: 'none',
    padding: 0,
    margin: 0,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: 600,
    color: ({ open }) => (open === 'true' ? PALETTE.text : PALETTE.textDim),
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
});

/** Wellbeing rows — labels match the display metrics (needsDisplay). */
const NEED_ROWS: Array<{ key: keyof NeedsDisplay; label: string }> = [
    { key: 'fullness', label: 'Fullness' },
    { key: 'hydration', label: 'Hydration' },
    { key: 'energy', label: 'Energy' },
];

const ActorCard = ({ actor }: { actor: Actor }) => {
    const island = useWorld();
    // History stays collapsed until the god asks for it
    const historyOpen = useToggleHook(false);
    if (!island) {
        return null;
    }
    const { inventory, needs, relationship, world } = island;
    // Display values: full bar = good (hunger/thirst pressure inverted)
    const state = needsDisplay(needs.of(actor.id));
    const bag = inventory.of(actor.id);
    const stock = inventory.cellStock(actor.position.x, actor.position.y);

    // One bond row per fellow castaway — never the actor themselves. Walking
    // the roster (instead of relationship.pairs()) keeps the list at exactly
    // castSize − 1: pairs that don't involve this actor can no longer be
    // mislabelled as theirs, and unacquainted pairs read as neutral (0).
    const relations = Array.from(world.actors.values())
        .filter((other) => other.id !== actor.id)
        .map((other) => ({
            id: other.id,
            name: other.name,
            value: relationship.relation(actor.id, other.id),
            level: relationship.level(actor.id, other.id),
        }));

    // The actor's own last 8 log lines, newest first
    const history = world
        .events.logFor(actor.id)
        .slice(-8)
        .reverse();

    return (
        <>
            <Row>
                <span data-testid="actor-condition">
                    {actor.name} · {actor.condition}
                </span>
            </Row>
            <div>
                {NEED_ROWS.map((row) => (
                    <Row key={row.key}>
                        <NeedName>{row.label}</NeedName>
                        <Track>
                            <Fill width={`${Math.round(state[row.key])}%`} background={NEED_COLORS[row.key]} />
                        </Track>
                        <NeedValue>{Math.round(state[row.key])}</NeedValue>
                    </Row>
                ))}
            </div>
            <div>
                <PanelTitle>Inventory</PanelTitle>
                <List data-testid="actor-inventory">
                    {inventoryEntries(bag).length === 0 ? (
                        <li>
                            <EmptyNote>Empty hands.</EmptyNote>
                        </li>
                    ) : (
                        inventoryEntries(bag).map((entry) => (
                            <li key={entry.item}>{itemLabel(entry.item, entry.count)}</li>
                        ))
                    )}
                </List>
            </div>
            <div>
                <PanelTitle>Underfoot</PanelTitle>
                <List>
                    {inventoryEntries(stock).length === 0 ? (
                        <li>
                            <EmptyNote>Nothing left here.</EmptyNote>
                        </li>
                    ) : (
                        inventoryEntries(stock).map((entry) => (
                            <li key={entry.item}>{itemLabel(entry.item, entry.count)} (ground)</li>
                        ))
                    )}
                </List>
            </div>
            <div>
                <PanelTitle>Bonds</PanelTitle>
                <List data-testid="actor-relations">
                    {relations.length === 0 ? (
                        <li>
                            <EmptyNote>No bonds yet.</EmptyNote>
                        </li>
                    ) : (
                        relations.map((relation) => (
                            <li key={relation.id}>
                                {relation.name} — {relation.level} (
                                {Math.round(relation.value)})
                            </li>
                        ))
                    )}
                </List>
            </div>
            <div>
                <HistoryToggle
                    data-testid="history-toggle"
                    open={historyOpen() ? 'true' : 'false'}
                    onClick={() => historyOpen(!historyOpen())}
                >
                    History {historyOpen() ? '▾' : '▸'}
                </HistoryToggle>
                {historyOpen() ? (
                    <History data-testid="actor-history">
                        {history.length === 0 ? (
                            <EmptyNote>Nothing yet.</EmptyNote>
                        ) : (
                            history.map((event) => (
                                <span key={event.id}>
                                    t{event.tick} · {event.message}
                                </span>
                            ))
                        )}
                    </History>
                ) : null}
            </div>
        </>
    );
};

export const ActorPanel = () => {
    const island = useWorld();
    const revision = useRevision();
    const selected = useSelection();
    if (!island) {
        return null;
    }
    void revision;

    const actor = selected ? island.world.actors.get(selected) : undefined;

    return (
        <Panel>
            <PanelTitle>Inspector</PanelTitle>
            {actor ? (
                <ActorCard actor={actor} />
            ) : (
                <EmptyNote>Select a castaway to inspect.</EmptyNote>
            )}
        </Panel>
    );
};
