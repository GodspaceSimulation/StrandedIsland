// Inventory primitives — pure functions over a simple `Record<item, count>`
// bag. Every operation either succeeds fully or leaves both sides untouched
// (atomicity matters for the exchange primitive: a trade is all-or-nothing).

/** An inventory: item id → count. Counts are always integers ≥ 0. */
export type Inventory = Record<string, number>;

/** How many of `item` are held (0 when absent). */
export const inventoryCount = (inventory: Inventory, item: string): number =>
    inventory[item] ?? 0;

/** Adds `count` of `item` (mutates + returns the inventory for chaining). */
export const inventoryAdd = (inventory: Inventory, item: string, count: number): Inventory => {
    inventory[item] = inventoryCount(inventory, item) + count;
    return inventory;
};

/**
 * Removes `count` of `item`. When the inventory cannot afford it, nothing
 * changes and `false` is returned — never a partial removal.
 */
export const inventoryRemove = (inventory: Inventory, item: string, count: number): boolean => {
    if (inventoryCount(inventory, item) < count) {
        return false;
    }
    const remaining = inventoryCount(inventory, item) - count;
    if (remaining === 0) {
        // Zero entries are dropped so logs/tests see a clean bag
        delete inventory[item];
    } else {
        inventory[item] = remaining;
    }
    return true;
};

/** Non-zero entries as a list of stacks. */
export const inventoryEntries = (inventory: Inventory): Array<{ item: string; count: number }> =>
    Object.entries(inventory)
        .filter(([, count]) => count > 0)
        .map(([item, count]) => ({ item, count }));

/** Whether the inventory holds at least `count` of `item`. */
export const inventoryHas = (inventory: Inventory, item: string, count = 1): boolean =>
    inventoryCount(inventory, item) >= count;

/**
 * Whether the inventory can afford every stack in a bundle.
 * Accounts for repeated item ids across the bundle (e.g. two entries of
 * 'wood' in the same offer must sum).
 */
export const inventoryAffords = (inventory: Inventory, bundle: Inventory): boolean => {
    const required: Record<string, number> = {};
    Object.entries(bundle).forEach(([item, count]) => {
        if (count > 0) {
            required[item] = (required[item] ?? 0) + count;
        }
    });
    return Object.entries(required).every(([item, count]) => inventoryHas(inventory, item, count));
};

/**
 * Moves `count` of `item` from one inventory to another.
 * Atomic: when the source cannot afford it, neither side changes.
 */
export const inventoryTransfer = (
    from: Inventory,
    to: Inventory,
    item: string,
    count: number,
): boolean => {
    if (!inventoryRemove(from, item, count)) {
        return false;
    }
    inventoryAdd(to, item, count);
    return true;
};

/**
 * The exchange primitive — the heart of "one inventory can exchange items
 * with another". `giver` hands over `offer` and receives `request` from
 * `receiver`. Fully atomic: if either side cannot afford its part, both
 * inventories stay exactly as they were and `false` is returned.
 */
export const inventoryExchange = (
    giver: Inventory,
    receiver: Inventory,
    offer: Inventory,
    request: Inventory,
): boolean => {
    // Pre-check both sides — no mutation may happen on a failed trade
    if (!inventoryAffords(giver, offer) || !inventoryAffords(receiver, request)) {
        return false;
    }
    // Perform the two-way transfer; affordability was proven above
    Object.entries(offer).forEach(([item, count]) => {
        if (count > 0) {
            inventoryTransfer(giver, receiver, item, count);
        }
    });
    Object.entries(request).forEach(([item, count]) => {
        if (count > 0) {
            inventoryTransfer(receiver, giver, item, count);
        }
    });
    return true;
};
