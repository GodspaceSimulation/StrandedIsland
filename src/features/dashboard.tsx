// The god-view dashboard — full layout assembling every feature panel.
//
// Owns the world subscription: every world event and tick bumps the shared
// revision signal, which re-renders all panels through the bridge.

import { useEffect } from 'react';
import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';
import type { IslandHandle } from '../scenario/island';
import { mountWorld, useWorld, bumpRevision } from './worldBridge';
import { WorldGrid } from './worldGrid';
import { TilePanel } from './tilePanel';
import { TickerControls } from './tickerControls';
import { WorldControls } from './worldControls';
import { ActorList } from './actorList';
import { ActorPanel } from './actorPanel';
import { EventLog } from './eventLog';

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

const PluginRoster = styled('span', {
    fontSize: 11,
    color: PALETTE.accent,
});

const MainRow = styled('div', {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
    flexWrap: 'wrap',
});

// Left rail — the castaway roster with compact stat rows, and the inspector
// directly beneath it (selection opens the inspector in place)
const CastSection = styled('div', {
    flex: '0 1 250px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minWidth: 0,
});

// Middle — the island canvas with the Tile Inspector beneath it: clicking
// any tile on the canvas shows the terrain, ground stock and residents there
const GridSection = styled('div', {
    flex: '1 1 460px',
    minWidth: 0,
});

// Right rail — the world clock and the World Size controls (the god can
// reshape the island: odd-only canvas, centered (0,0), open-sea edge)
const SideSection = styled('div', {
    flex: '0 1 320px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
});

export const Dashboard = ({ island: mounted }: { island: IslandHandle }) => {
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

    const roster = world.plugins
        .list()
        .map((plugin) => plugin.label ?? plugin.id)
        .join(' · ');

    return (
        <Shell>
            <Header>
                <Title>Stranded Island</Title>
                {/* The rolled world seed — random every reload (App.tsx) */}
                <Subtitle>
                    god view · seed <span data-testid="world-seed">{world.seed}</span>
                </Subtitle>
                <PluginRoster data-testid="plugin-roster">{roster}</PluginRoster>
            </Header>
            <MainRow>
                <CastSection>
                    <ActorList />
                    <ActorPanel />
                </CastSection>
                <GridSection>
                    <WorldGrid />
                    <TilePanel />
                </GridSection>
                <SideSection>
                    <TickerControls />
                    <WorldControls />
                </SideSection>
            </MainRow>
            <EventLog />
        </Shell>
    );
};
