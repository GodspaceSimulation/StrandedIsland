// The relationship environment plugin — affinity between actors.
//
// A single signed value per actor pair (−100 feud … +100 bond), shared by
// both directions (the pair key is the sorted id pair). Relationships move
// through explicit `adjust` calls (trades, gifts, slights — the behavior
// plugin drives these) and slowly drift back toward neutral over time.

import { arrayEach } from '@presource/core';
import type { PluginContext, WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';

export type RelationshipPluginOptions = {
    /** Drift toward 0 per world-minute. Default 0.02 (0.2 per 10-min step). */
    driftPerMinute?: number;
};

export type RelationLevel = 'hostile' | 'strained' | 'neutral' | 'friendly' | 'bonded';

export type RelationshipPlugin = WorldPlugin<World> & {
    /** Affinity between two actors (−100..100). Unacquainted pairs are 0. */
    relation(a: string, b: string): number;
    /** Named level for the affinity value. */
    level(a: string, b: string): RelationLevel;
    /**
     * Moves the affinity by `delta`, clamped to ±100. `reason` is appended to
     * the log line. Emits a relationship event for notable moves.
     */
    adjust(a: string, b: string, delta: number, reason?: string): void;
    /** All tracked pairs with their values — for the god-view roster. */
    pairs(): Array<{ a: string; b: string; value: number }>;
};

/** Level ladder from the affinity value. */
const levelOf = (value: number): RelationLevel => {
    if (value <= -60) {
        return 'hostile';
    }
    if (value <= -25) {
        return 'strained';
    }
    if (value < 25) {
        return 'neutral';
    }
    if (value < 60) {
        return 'friendly';
    }
    return 'bonded';
};

/** Sorted pair key so relation(a,b) === relation(b,a). */
const pairKey = (a: string, b: string): string => (a <= b ? `${a}|${b}` : `${b}|${a}`);

export const relationshipPlugin = (options: RelationshipPluginOptions = {}): RelationshipPlugin => {
    // Per world-minute — each tick hook call covers exactly one minute
    // (engine/world.ts sub-steps), so the drift applies directly
    const driftPerMinute = options.driftPerMinute ?? 0.02;

    const relations = new Map<string, number>();

    // Actor name lookup for log lines — filled at setup
    let world: PluginContext<World>['world'] | null = null;
    const nameOf = (actorId: string): string => world?.actors.get(actorId)?.name ?? actorId;

    return {
        id: 'relationship',
        label: 'Relationships',

        relation: (a, b) => relations.get(pairKey(a, b)) ?? 0,

        level: (a, b) => levelOf(relations.get(pairKey(a, b)) ?? 0),

        adjust: (a, b, delta, reason) => {
            const key = pairKey(a, b);
            const current = relations.get(key) ?? 0;
            const next = Math.max(-100, Math.min(100, current + delta));
            relations.set(key, next);
            // Log notable moves (anything ≥ 5 magnitude) with the reason
            if (world && Math.abs(delta) >= 5) {
                const direction = delta > 0 ? 'grow closer' : 'fall out';
                world.events.emit({
                    kind: 'relationship',
                    message: `${nameOf(a)} and ${nameOf(b)} ${direction}${reason ? ` (${reason})` : ''}.`,
                });
            }
        },

        pairs: () => {
            const list: Array<{ a: string; b: string; value: number }> = [];
            relations.forEach((value, key) => {
                const [a, b] = key.split('|');
                list.push({ a, b, value });
            });
            return list;
        },

        setup: (context: PluginContext<World>) => {
            world = context.world;
        },

        dispose: () => {
            relations.clear();
            world = null;
        },

        tick: (context: PluginContext<World>) => {
            // Drift toward neutral — small affinities snap back exactly to 0
            relations.forEach((value, key) => {
                if (value === 0) {
                    return;
                }
                const drifted = value > 0 ? value - driftPerMinute : value + driftPerMinute;
                relations.set(key, Math.abs(drifted) < driftPerMinute ? 0 : drifted);
            });
            void context;
        },
    };
};
