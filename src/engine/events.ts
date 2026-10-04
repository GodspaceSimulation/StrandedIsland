// World event bus / log.
//
// Every notable happening in the simulation (spawn, move, gather, exchange,
// needs change, …) is emitted here. The god-view log streams from this bus.
// The bus is also the re-render bridge for React: features subscribe to it.

import { arrayEach } from '@presource/core';
import type { WorldEvent } from './types';

/** Most recent events kept in the ring buffer. */
const LOG_CAPACITY = 200;

/** Payload accepted by emit — ids and time stamps are filled in by the bus. */
export type EventInput = {
    kind: string;
    message: string;
    actorId?: string;
};

/** Callback fired for every emitted event. */
export type EventListener = (event: WorldEvent) => void;

export type EventBus = {
    /**
     * Logs and broadcasts an event. `tick`/`time` are stamped from the bound
     * ticker; `id` comes from a monotonic counter.
     */
    emit(input: EventInput): WorldEvent;
    /** Full log, oldest → newest (capped at LOG_CAPACITY). */
    log(): WorldEvent[];
    /** Only events about one actor. */
    logFor(actorId: string): WorldEvent[];
    /** Subscribes to every event; returns the unsubscribe function. */
    subscribe(listener: EventListener): () => void;
    /** Binds the ticker so emitted events are stamped with tick + time. */
    bind(read: () => { tick: number; time: number }): void;
};

export const createEventBus = (): EventBus => {
    let sequence = 0;
    const log: WorldEvent[] = [];
    const listeners = new Set<EventListener>();

    // Clock reader — bound to the world's ticker by world.ts at creation
    let readClock: () => { tick: number; time: number } = () => ({ tick: 0, time: 0 });

    return {
        emit: (input) => {
            const clock = readClock();
            sequence = sequence + 1;
            const event: WorldEvent = {
                id: sequence,
                tick: clock.tick,
                time: clock.time,
                kind: input.kind,
                message: input.message,
                // Only include actorId when provided, keeping the exact shape
                ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
            };
            log.push(event);
            // Ring buffer — drop the oldest when over capacity
            if (log.length > LOG_CAPACITY) {
                log.splice(0, log.length - LOG_CAPACITY);
            }
            // Block body so a listener's return value can never short-circuit
            // the loop (arrayEach breaks on non-undefined returns). Array.from
            // because arrayEach needs index access — a Set has neither.
            arrayEach(Array.from(listeners), ({ value: listener }) => {
                listener(event);
            });
            return event;
        },
        log: () => log.slice(),
        logFor: (actorId) => log.filter((event) => event.actorId === actorId),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        bind: (read) => {
            readClock = read;
        },
    };
};
