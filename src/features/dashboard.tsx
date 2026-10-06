// The god-view dashboard — full layout assembling every feature panel.
//
// Owns the world subscription: every world event and tick bumps the shared
// revision signal, which re-renders all panels through the bridge. The log
// is not a panel anymore — the STORY tab (storyFeed.tsx) lives top right
// and opens the story happening so far.

import { useEffect } from 'react';
import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import type { IslandHandle } from '../scenario/island';
import type { IslandTerrainOptions } from '../plugins/terrain/islandTerrain';
import { mountWorld, useWorld, bumpRevision } from './worldBridge';
import { WorldGrid } from './worldGrid';
import { TilePanel } from './tilePanel';
import { TickerControls } from './tickerControls';
import { WorldControls } from './worldControls';
import { ActorList } from './actorList';
import { ActorPanel } from './actorPanel';
import { StoryTab } from './storyFeed';

const Shell = styled('div', {
    minHeight: '100vh',
    background: PALETTE.background,
    color: PALETTE.text,
    fontFamily: 'system-ui, sans-serif',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
});

const Header = styled('header', {
    display: 'flex',
    alignItems: 'baseline',
    gap: 14,
    flexWrap: 'wrap',
});

const Title = styled('h1', {
    margin: 0,
    fontSize: 20,
    letterSpacing: 1,
});

const Subtitle = styled('span', {
    fontSize: 12,
    color: PALETTE.textDim,
});

const MainRow = styled('div', {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
    flexWrap: 'wrap',
});

// Left rail — the castaway roster with compact stat rows, and the Entity
// Inspector directly beneath it (selection opens the inspector in place)
const CastSection = styled('div', {
    flex: '0 1 250px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minWidth: 0,
});

// Middle — the island canvas alone (the Tile Inspector lives in the right
// rail now); clicking any tile on the canvas selects it for the inspector
const GridSection = styled('div', {
    flex: '1 1 460px',
    minWidth: 0,
});

// Right rail — the world clock and the Tile Inspector beneath it (clicking
// a canvas tile shows the terrain, ground stock and residents there)
const SideSection = styled('div', {
    flex: '0 1 320px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
});

export const Dashboard = ({
    island: mounted,
    onReroll,
}: {
    island: IslandHandle;
    /** Reroll — App regenerates the whole world (fresh seed) at the picked size. */
    onReroll: (terrain?: IslandTerrainOptions) => void;
}) => {
    // Subscribe to the bridge so a (re)mount re-renders this shell too
    const island = useWorld();

    // Mount the world into the bridge once, then pulse the revision signal
    // on every world event and tick so all panels re-render
    useEffect(() => {
        mountWorld(mounted);
        const unsubEvents = mounted.world.events.subscribe(() => bumpRevision());
        const unsubTicks = mounted.world.ticker.subscribe(() => bumpRevision());
        return () => {
            unsubEvents();
            unsubTicks();
        };
    }, [mounted]);

    if (!island) {
        return null;
    }

    const { world } = island;

    return (
        <Shell>
            <Header>
                <Title>Stranded Island</Title>
                {/* The rolled world seed — random every reload and every
                    reroll (App.tsx) */}
                <Subtitle>
                    god view · seed <span data-testid="world-seed">{world.seed}</span>
                </Subtitle>
                {/* The World Size control — minimal, right where the seed
                    reads: width × height pickers + Reroll (a fresh world
                    every roll) */}
                <WorldControls onReroll={onReroll} />
                {/* The Story tab — top right, opens the story happening so far */}
                <StoryTab />
            </Header>
            <MainRow>
                <CastSection>
                    <ActorList />
                    <ActorPanel />
                </CastSection>
                <GridSection>
                    <WorldGrid />
                </GridSection>
                <SideSection>
                    <TickerControls />
                    <TilePanel />
                </SideSection>
            </MainRow>
        </Shell>
    );
};
