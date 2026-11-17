import { AsyncLocalStorage } from "node:async_hooks";

// CAREEROS (P3-T01): entitlements are cached for the length of one request and never longer. A plan, status or flag
// change must be visible to the next request, and the cache must never be shared between organizations or requests.
// Outside `runWithEntitlementsCache` nothing is cached at all.

const store = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Opens a request-scoped cache around `fn`. Call it once per request, around the work that reads entitlements. */
export function runWithEntitlementsCache<T>(fn: () => T): T {
	return store.run(new Map(), fn);
}

/** Whether a request-scoped cache is open. */
export function hasEntitlementsCache(): boolean {
	return store.getStore() !== undefined;
}

/**
 * Runs `load` once per `key` inside an open request cache and shares the result with concurrent and later callers of
 * the same request. Failures are not kept. Outside a request cache it simply runs `load`.
 */
export function memoizeInRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
	const cache = store.getStore();
	if (!cache) return load();
	const existing = cache.get(key);
	if (existing) return existing as Promise<T>;
	const pending = load().catch((error: unknown) => {
		cache.delete(key);
		throw error;
	});
	cache.set(key, pending);
	return pending;
}
