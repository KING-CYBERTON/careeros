// CAREEROS (P2-T02): a small in-process cache for one organization's public branding. The app shell reads branding on
// every page load, so it is cached for 60 seconds per organization. The key is the organization id that the request's
// host resolved to (never a client value). `bustPublicBranding` drops an entry after a change in this process; other
// processes see the change within the TTL. P2-T04 (emails) reads its own branding through the same cache, under the
// key `email:<organization id>`, and moved the module here from `packages/api` because `packages/auth` (the Better Auth
// email callbacks) sits below `packages/api` in the import graph. `packages/api/src/features/branding/cache.ts`
// re-exports it.

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

type Entry<T> = { value: Promise<T>; expires: number };

export type BrandingCache<T> = {
	/** The cached value for `organizationId`, loading it with `load` on a miss. A failed load is not cached. */
	read: (organizationId: string, load: () => Promise<T>) => Promise<T>;
	/** Drops the entry, so the next read loads again. A load already running will not be stored. */
	bust: (organizationId: string) => void;
	clear: () => void;
	size: () => number;
};

export type BrandingCacheOptions = {
	ttlMs?: number | undefined;
	maxEntries?: number | undefined;
	now?: (() => number) | undefined;
};

export function createBrandingCache<T>(options: BrandingCacheOptions = {}): BrandingCache<T> {
	const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const now = options.now ?? Date.now;
	const entries = new Map<string, Entry<T>>();
	// Bumped by every bust of a key, so a load that started before it does not store a stale answer.
	const generations = new Map<string, number>();

	return {
		read(organizationId, load) {
			const hit = entries.get(organizationId);
			if (hit && hit.expires > now()) return hit.value;
			entries.delete(organizationId);

			const generation = generations.get(organizationId) ?? 0;
			const value = load();
			const entry: Entry<T> = { value, expires: now() + ttl };
			// The oldest entry (first inserted) makes room, so one busy host cannot flush the others.
			if (entries.size >= maxEntries) {
				const oldest = entries.keys().next();
				if (!oldest.done) entries.delete(oldest.value);
			}
			entries.set(organizationId, entry);
			value.catch(() => {
				if (entries.get(organizationId) === entry) entries.delete(organizationId);
			});
			// A bust while this load ran removed the entry; the caller still gets its answer, nobody else does.
			void value.then(
				() => {
					if ((generations.get(organizationId) ?? 0) !== generation && entries.get(organizationId) === entry)
						entries.delete(organizationId);
				},
				() => undefined,
			);
			return value;
		},
		bust(organizationId) {
			entries.delete(organizationId);
			generations.set(organizationId, (generations.get(organizationId) ?? 0) + 1);
			// Keep the map small: only keys that were busted recently matter, and 10x entries is far more than that.
			if (generations.size > maxEntries * 10) generations.clear();
		},
		clear() {
			entries.clear();
			generations.clear();
		},
		size: () => entries.size,
	};
}

const shared = createBrandingCache<unknown>();

/** The process-wide cache behind `getCachedPublicBranding` (service.ts). Typed by the caller. */
export function readPublicBrandingCache<T>(organizationId: string, load: () => Promise<T>): Promise<T> {
	return shared.read(organizationId, load) as Promise<T>;
}

const emailKey = (organizationId: string) => `email:${organizationId}`;

/** The cached email branding of an organization (P2-T04): the public fields plus the sender name and reply-to. */
export function readEmailBrandingCache<T>(organizationId: string, load: () => Promise<T>): Promise<T> {
	return shared.read(emailKey(organizationId), load) as Promise<T>;
}

/** Drops an organization's cached branding, public and email. Call it after any change to the row or its assets. */
export function bustPublicBranding(organizationId: string): void {
	shared.bust(organizationId);
	shared.bust(emailKey(organizationId));
}

/** Empties the cache. Tests only. */
export function clearPublicBrandingCache(): void {
	shared.clear();
}
