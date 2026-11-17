import { describe, expect, it, vi } from "vite-plus/test";
import { createBrandingCache } from "./branding-cache";

function setup(options: { maxEntries?: number } = {}) {
	let time = 1000;
	const cache = createBrandingCache<string>({ ttlMs: 60_000, now: () => time, ...options });
	return { cache, advance: (ms: number) => (time += ms) };
}

describe("createBrandingCache", () => {
	it("loads once per organization within the TTL and again after it", async () => {
		const { cache, advance } = setup();
		const load = vi.fn(async () => "a");
		await cache.read("org-1", load);
		await cache.read("org-1", load);
		expect(load).toHaveBeenCalledTimes(1);
		advance(59_999);
		await cache.read("org-1", load);
		expect(load).toHaveBeenCalledTimes(1);
		advance(2);
		await cache.read("org-1", load);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("keeps organizations apart", async () => {
		const { cache } = setup();
		expect(await cache.read("org-1", async () => "one")).toBe("one");
		expect(await cache.read("org-2", async () => "two")).toBe("two");
		expect(await cache.read("org-1", async () => "other")).toBe("one");
	});

	it("shares one running load between concurrent readers", async () => {
		const { cache } = setup();
		const load = vi.fn(async () => "a");
		await Promise.all([cache.read("org-1", load), cache.read("org-1", load)]);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("loads again after a bust", async () => {
		const { cache } = setup();
		await cache.read("org-1", async () => "old");
		cache.bust("org-1");
		expect(await cache.read("org-1", async () => "new")).toBe("new");
	});

	it("does not store a load that was running when the entry was busted", async () => {
		const { cache } = setup();
		let release: (value: string) => void = () => undefined;
		const slow = new Promise<string>((resolve) => (release = resolve));
		const first = cache.read("org-1", () => slow);
		cache.bust("org-1");
		release("stale");
		expect(await first).toBe("stale");
		await Promise.resolve();
		expect(await cache.read("org-1", async () => "fresh")).toBe("fresh");
	});

	it("does not cache a failed load", async () => {
		const { cache } = setup();
		await expect(cache.read("org-1", () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
		expect(await cache.read("org-1", async () => "ok")).toBe("ok");
	});

	it("evicts the oldest entry at the size limit", async () => {
		const { cache } = setup({ maxEntries: 2 });
		await cache.read("a", async () => "1");
		await cache.read("b", async () => "2");
		await cache.read("c", async () => "3");
		expect(cache.size()).toBe(2);
		const reload = vi.fn(async () => "again");
		await cache.read("a", reload);
		expect(reload).toHaveBeenCalledTimes(1);
	});
});

describe("email branding keys", () => {
	it("busting an organization drops its public and its email entry, and nobody else's", async () => {
		const { clearPublicBrandingCache, readEmailBrandingCache, readPublicBrandingCache, bustPublicBranding } =
			await import("./branding-cache");
		clearPublicBrandingCache();
		const load = vi.fn(async () => "v1");
		await readPublicBrandingCache("org-1", load);
		await readEmailBrandingCache("org-1", load);
		await readEmailBrandingCache("org-2", load);
		expect(load).toHaveBeenCalledTimes(3);
		bustPublicBranding("org-1");
		await readPublicBrandingCache("org-1", load);
		await readEmailBrandingCache("org-1", load);
		await readEmailBrandingCache("org-2", load);
		expect(load).toHaveBeenCalledTimes(5);
		clearPublicBrandingCache();
	});
});
