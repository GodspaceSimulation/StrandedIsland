// Actor roster — chips for every living castaway.

import { styled } from '../styles/styled';
import { CONDITION_COLORS, PALETTE } from '../styles/theme';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, useSelection, selectActor } from './worldBridge';

const Chip = styled<{ selected: string }>('button', {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: ({ selected }) => (selected === 'true' ? PALETTE.accentDim : '#232c37'),
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 13,
    color: PALETTE.text,
    fontFamily: 'inherit',
});

const Dot = styled<{ color: string }>('span', {
    background: 'custom',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
});

const Empty = styled('span', {
    fontSize: 12,
    color: PALETTE.textDim,
});

export const ActorList = () => {
    const island = useWorld();
    const revision = useRevision();
    const selected = useSelection();
    if (!island) {
        return null;
    }
    void revision;

    const actors = Array.from(island.world.actors.values());

    return (
        <Panel>
            <PanelTitle>Castaways</PanelTitle>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {actors.length === 0 ? (
                    <Empty>No one survives.</Empty>
                ) : (
                    actors.map((actor) => (
                        <Chip
                            key={actor.id}
                            selected={selected === actor.id ? 'true' : 'false'}
                            data-testid={`actor-chip-${actor.name}`}
                            onClick={() => selectActor(selected === actor.id ? null : actor.id)}
                        >
                            <Dot color={CONDITION_COLORS[actor.condition]} />
                            {actor.marker} {actor.name}
                        </Chip>
                    ))
                )}
            </div>
        </Panel>
    );
};
