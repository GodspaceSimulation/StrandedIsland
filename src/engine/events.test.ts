// Tests for the world event bus (engine/events.ts).

import { describe, it, expect } from 'vitest';
import { createEventBus } from './events';

describe('createEventBus', () => {
    it('stamps events with a monotonic id and bound clock', () => {
        const bus = createEventBus();
        // Bind a fake clock reader (normally the world's ticker)
        let tick = 0;
        bus.bind(() => ({ tick, time: tick * 10 }));
        const first = bus.emit({ kind: 'spawn', message: 'A washes ashore.', actorId: 'a' });
        tick = 3;
        const second = bus.emit({ kind: 'move', message: 'A moves east.' });
        expect(first).toEqual({
            id: 1,
            tick: 0,
            time: 0,
            kind: 'spawn',
            message: 'A washes ashore.',
            actorId: 'a',
        });
        expect(second).toEqual({
            id: 2,
            tick: 3,
            time: 30,
            kind: 'move',
            message: 'A moves east.',
        });
    });

    it('omits actorId when not provided', () => {
        const bus = createEventBus();
        const event = bus.emit({ kind: 'world', message: 'Storm passes.' });
        expect(Object.keys(event)).toEqual(['id', 'tick', 'time', 'kind', 'message']);
    });

    it('log returns events oldest → newest', () => {
        const bus = createEventBus();
        bus.emit({ kind: 'a', message: 'one' });
        bus.emit({ kind: 'b', message: 'two' });
        const log = bus.log();
        expect(log.map((event) => event.message)).toEqual(['one', 'two']);
        // Returned array is a copy — mutating it does not affect the bus
        log.pop();
        expect(bus.log().length).toBe(2);
    });

    it('log caps at 200 entries, keeping the newest', () => {
        const bus = createEventBus();
        for (let index = 0; index < 205; index++) {
            bus.emit({ kind: 'tick', message: `event-${index}` });
        }
        const log = bus.log();
        expect(log.length).toBe(200);
        expect(log[0].message).toBe('event-5');
        expect(log[199].message).toBe('event-204');
    });

    it('logFor filters by actor', () => {
        const bus = createEventBus();
        bus.emit({ kind: 'spawn', message: 'A lands.', actorId: 'a' });
        bus.emit({ kind: 'spawn', message: 'B lands.', actorId: 'b' });
        bus.emit({ kind: 'move', message: 'A moves.', actorId: 'a' });
        expect(bus.logFor('a').map((event) => event.message)).toEqual(['A lands.', 'A moves.']);
        expect(bus.logFor('b').map((event) => event.message)).toEqual(['B lands.']);
    });

    it('subscribe/unsubscribe controls listeners', () => {
        const bus = createEventBus();
        const seen: string[] = [];
        const unsubscribe = bus.subscribe((event) => seen.push(event.message));
        bus.emit({ kind: 'a', message: 'one' });
        unsubscribe();
        bus.emit({ kind: 'a', message: 'two' });
        expect(seen).toEqual(['one']);
    });
});
