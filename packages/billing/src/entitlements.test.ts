import { describe, expect, it, vi } from "vite-plus/test";
import { aiCreditsTotal, buildEntitlements, type EntitlementInputs } from "./entitlements";
import { hasEntitlementsCache, memoizeInRequest, runWithEntitlementsCache } from "./request-cache";

vi.mock("@reactive-resume/db/client", () => ({ db: {} }));

const base: EntitlementInputs = {
	status: "active",
	planId: "pro",
	seatLimit: null,
	aiCreditsPerSeat: 300,
	planFeatures: { custom_domain: true },
	seatsPaid: 10,
	overageAllowed: false,
	memberCount: 4,
	pendingInvitationCount: 2,
	orgFlags: new Map(),
	globalFlags: new Map(),
};

describe("entitlement maths", () => {
	it("pools credits as credits per seat times max(seats paid, members)", () => {
		expect(aiCreditsTotal(300, 10, 4)).toBe(3000);
		expect(aiCreditsTotal(300, 3, 8)).toBe(2400);
		expect(aiCreditsTotal(0, 10, 4)).toBe(0);
		expect(aiCreditsTotal(50, 1, 1)).toBe(50);
	});

	it("counts members plus pending invitations as seats used", () => {
		const entitlements = buildEntitlements(base);
		expect(entitlements.seatsUsed).toBe(6);
		expect(entitlements.aiCreditsTotal).toBe(3000);
		expect(entitlements.seatLimit).toBeNull();
		expect(entitlements.planId).toBe("pro");
	});

	it("takes the member count, not the invitations, for the credit pool", () => {
		const entitlements = buildEntitlements({ ...base, seatsPaid: 1, memberCount: 4, pendingInvitationCount: 50 });
		expect(entitlements.aiCreditsTotal).toBe(1200);
	});

	it("is read-only exactly when suspended", () => {
		expect(buildEntitlements({ ...base, status: "suspended" }).readOnly).toBe(true);
		for (const status of ["trial", "active", "past_due"])
			expect(buildEntitlements({ ...base, status }).readOnly).toBe(false);
	});

	it("passes the overage switch and applies the flag order to features", () => {
		const entitlements = buildEntitlements({
			...base,
			overageAllowed: true,
			orgFlags: new Map([["custom_domain", false]]),
			globalFlags: new Map([["sso", true]]),
		});
		expect(entitlements.overageAllowed).toBe(true);
		expect(entitlements.features.custom_domain).toBe(false);
		expect(entitlements.features.sso).toBe(true);
		expect(entitlements.features.job_discovery).toBe(false);
	});
});

describe("request cache", () => {
	it("does not cache outside a request", async () => {
		const load = vi.fn(async () => 1);
		expect(hasEntitlementsCache()).toBe(false);
		await memoizeInRequest("org", load);
		await memoizeInRequest("org", load);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("loads once per key inside a request, also for concurrent callers", async () => {
		const load = vi.fn(async () => ({ n: 1 }));
		await runWithEntitlementsCache(async () => {
			expect(hasEntitlementsCache()).toBe(true);
			const [a, b] = await Promise.all([memoizeInRequest("org-a", load), memoizeInRequest("org-a", load)]);
			expect(a).toBe(b);
			await memoizeInRequest("org-a", load);
			await memoizeInRequest("org-b", load);
		});
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("never shares a cache between requests", async () => {
		const load = vi.fn(async () => 1);
		await runWithEntitlementsCache(() => memoizeInRequest("org", load));
		await runWithEntitlementsCache(() => memoizeInRequest("org", load));
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("does not keep a failure", async () => {
		const load = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(5);
		await runWithEntitlementsCache(async () => {
			await expect(memoizeInRequest("org", load)).rejects.toThrow("boom");
			await expect(memoizeInRequest("org", load)).resolves.toBe(5);
		});
	});
});
