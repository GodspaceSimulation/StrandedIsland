// Plugin system — the swappable heart of the environment.
//
// A plugin is any object with an `id` plus optional lifecycle hooks that
// receive a `PluginContext` (the world + a deterministic random stream).
// Environments are configured by choosing which plugins to install:
//   - terrain plugin builds the canvas (procedural island)
//   - inventory plugin gives actors inventories + gathering + exchange
//   - needs plugin decays hunger/thirst/energy each tick
//   - relationship plugin tracks affinity between actors
//   - behavior plugin runs the agent decision loop
//   - birds plugin releases seabirds that travel the Z axis
//
// Removing a plugin from a world removes that entire behaviour; nothing else
// imports it, so plugins can be swapped in and out freely at setup time
// (see scenario/island.ts and world.plugins).

import { arrayEach } from '@presource/core';
import { randomKeyed, type RandomSource } from './random';
import type { World } from './world';

/** Everything a plugin hook receives. */
export type PluginContext = {
    /** The world this plugin is installed into. */
    world: World;
    /**
     * Deterministic random stream private to this plugin. Seeded from the
     * world seed + plugin id, so the stream is stable regardless of which
     * other plugins are installed or in which order.
     */
    random: RandomSource;
};

/** A swappable chunk of environment behaviour. */
export type WorldPlugin = {
    /** Unique identifier within a world (used for lookup + RNG keying). */
    id: string;
    /** Human readable name for the god-view plugin roster. */
    label?: string;
    /** Runs once when the plugin is installed (builds the canvas, seeds state). */
    setup?(context: PluginContext): void;
    /** Runs every world tick, in registration order. */
    tick?(context: PluginContext): void;
    /** Runs once when the plugin is removed (cleanup). */
    dispose?(context: PluginContext): void;
};

export type PluginRegistry = {
    /** Installs a plugin and immediately runs its `setup` hook. */
    add(plugin: WorldPlugin): void;
    /** Removes a plugin, running its `dispose` hook first. No-op when absent. */
    remove(id: string): void;
    /** Whether a plugin with this id is installed. */
    has(id: string): boolean;
    /** The installed plugin with this id, when any. */
    get(id: string): WorldPlugin | undefined;
    /** All installed plugins in registration (tick) order. */
    list(): WorldPlugin[];
    /**
     * The plugin's PluginContext. The random stream is cached per plugin id,
     * so a plugin's stream keeps advancing across ticks instead of being
     * re-seeded (which would replay the same values every tick).
     */
    context(plugin: WorldPlugin): PluginContext;
    /** Removes every plugin (dispose hooks run, newest → oldest). */
    clear(): void;
};

/** Builds a registry. `world` is needed to hand plugin hooks their context. */
export const createPluginRegistry = (world: World): PluginRegistry => {
    // Registration order === tick order; duplicates by id are rejected
    const installed: WorldPlugin[] = [];
    // Cached contexts — one per plugin, so random streams persist across ticks
    const contexts = new Map<string, PluginContext>();

    // Internal: context factory — random stream keyed by plugin id
    const contextFor = (plugin: WorldPlugin): PluginContext => {
        const cached = contexts.get(plugin.id);
        if (cached) {
            return cached;
        }
        const context: PluginContext = {
            world,
            random: randomKeyed(world.seed, plugin.id),
        };
        contexts.set(plugin.id, context);
        return context;
    };

    return {
        add: (plugin) => {
            // Guard: same plugin (or same id) installed twice would double-tick
            if (installed.some((entry) => entry.id === plugin.id)) {
                return;
            }
            installed.push(plugin);
            plugin.setup?.(contextFor(plugin));
        },
        remove: (id) => {
            const index = installed.findIndex((entry) => entry.id === id);
            if (index === -1) {
                return;
            }
            const [plugin] = installed.splice(index, 1);
            // Dispose before dropping the cached context
            plugin.dispose?.(contextFor(plugin));
            contexts.delete(id);
        },
        has: (id) => installed.some((entry) => entry.id === id),
        get: (id) => installed.find((entry) => entry.id === id),
        list: () => installed.slice(),
        context: contextFor,
        clear: () => {
            // Dispose newest → oldest, mirroring teardown conventions
            arrayEach(installed.slice().reverse(), ({ value: plugin }) => {
                plugin.dispose?.(contextFor(plugin));
            });
            installed.length = 0;
            contexts.clear();
        },
    };
};
