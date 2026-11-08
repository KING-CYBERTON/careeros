import { describe, expect, it, vi } from "vite-plus/test";
import { WebhookIgnored, WebhookPayloadError, WebhookSignatureError } from "../events";
import { priceFor, type PlanPrices } from "../pricing";
import {
	createFakeProvider,
	FAKE_SIGNATURE_HEADER,
	fakeDecisionEvent,
	readFakeSession,
	signFakeEvent,
	type FakeEventBody,
} from "./fake";
import { manualProvider } from "./manual";
import { ProviderUnsupportedError } from "./types";

// P3-T04: the fake provider's webhook verification, test page tokens and checkout, with no database.

const SECRET = "unit-test-fake-secret-0123456789";
const NOW = new Date("2026-11-02T12:00:00.000Z");

const starter: PlanPrices = {
	id: "starter",
	pricingModel: "flat",
	seatLimit: 50,
	active: true,
	priceMonthlyUsdCents: 4900,
	priceAnnualUsdCents: 49000,
	priceMonthlyKes: 6500,
	priceAnnualKes: 65000,
};
const pro: PlanPrices = {
	...starter,
	id: "pro",
	pricingModel: "per_seat",
	seatLimit: null,
	priceMonthlyUsdCents: 1200,
};

const body = (overrides: Partial<FakeEventBody> = {}): FakeEventBody => ({
	id: "fake_evt_1",
	type: "payment.succeeded",
	created: Math.floor(NOW.getTime() / 1000),
	metadata: { orgId: "org_a" },
	data: {
		planId: "starter",
		seats: 10,
		interval: "month",
		periodStart: NOW.toISOString(),
		amount: 4900,
		currency: "USD",
	},
	...overrides,
});

const provider = (extra: Partial<Parameters<typeof createFakeProvider>[0]> = {}) =>
	createFakeProvider({ secret: SECRET, appUrl: "https://app.example.test", now: () => NOW, ...extra });

describe("fake webhook verification", () => {
	it("returns the normalized event for a good signature", async () => {
		const signed = signFakeEvent(SECRET, body(), NOW);
		const event = await provider().verifyWebhook(signed.rawBody, signed.headers);
		expect(event).toMatchObject({
			type: "payment.succeeded",
			provider: "fake",
			providerEventId: "fake_evt_1",
			orgId: "org_a",
			planId: "starter",
			seats: 10,
			interval: "month",
			amount: 4900,
			currency: "USD",
		});
		expect(event.periodStart).toEqual(NOW);
	});

	it("rejects a missing header, a wrong secret, a tampered body and a malformed header", async () => {
		const good = signFakeEvent(SECRET, body(), NOW);
		const tampered = new TextEncoder().encode(new TextDecoder().decode(good.rawBody).replace("org_a", "org_b"));
		const other = signFakeEvent("another-secret-0123456789abc", body(), NOW);
		const cases: [Uint8Array, Headers][] = [
			[good.rawBody, new Headers()],
			[other.rawBody, other.headers],
			[tampered, good.headers],
			[good.rawBody, new Headers({ [FAKE_SIGNATURE_HEADER]: "t=1,v1=nothex" })],
			[
				good.rawBody,
				new Headers({ [FAKE_SIGNATURE_HEADER]: `t=${Math.floor(NOW.getTime() / 1000)},v1=${"0".repeat(64)}` }),
			],
		];
		for (const [raw, headers] of cases)
			await expect(provider().verifyWebhook(raw, headers)).rejects.toBeInstanceOf(WebhookSignatureError);
	});

	it("rejects a correctly signed request that is older than five minutes (replay)", async () => {
		const old = signFakeEvent(SECRET, body(), new Date(NOW.getTime() - 6 * 60 * 1000));
		await expect(provider().verifyWebhook(old.rawBody, old.headers)).rejects.toBeInstanceOf(WebhookSignatureError);
		const recent = signFakeEvent(SECRET, body(), new Date(NOW.getTime() - 4 * 60 * 1000));
		await expect(provider().verifyWebhook(recent.rawBody, recent.headers)).resolves.toMatchObject({ orgId: "org_a" });
	});

	it("takes the organization from metadata only, whatever other fields say", async () => {
		const crafted = {
			...body(),
			orgId: "org_evil",
			organizationId: "org_evil",
			organization_id: "org_evil",
			data: {
				...body().data,
				orgId: "org_evil",
				organizationId: "org_evil",
				customer: { metadata: { orgId: "org_evil" } },
			},
		};
		const signed = signFakeEvent(SECRET, crafted as FakeEventBody, NOW);
		await expect(provider().verifyWebhook(signed.rawBody, signed.headers)).resolves.toMatchObject({ orgId: "org_a" });
	});

	it("refuses a signed event that names no organization in its metadata", async () => {
		const { metadata: _metadata, ...withoutMetadata } = body();
		const signed = signFakeEvent(SECRET, { ...withoutMetadata, orgId: "org_evil" } as unknown as FakeEventBody, NOW);
		await expect(provider().verifyWebhook(signed.rawBody, signed.headers)).rejects.toBeInstanceOf(WebhookPayloadError);
	});

	it("says ignored for a signed event type it does not act on, and payload error for rubbish", async () => {
		const ignored = signFakeEvent(SECRET, body({ type: "invoice.created" }), NOW);
		await expect(provider().verifyWebhook(ignored.rawBody, ignored.headers)).rejects.toBeInstanceOf(WebhookIgnored);
		const rubbish = [
			body({ id: "bad id with spaces" }),
			body({ data: { seats: 0 } }),
			body({ data: { seats: 1.5 } }),
			body({ data: { interval: "week" as "month" } }),
			body({ data: { periodEnd: "yesterday" } }),
			body({ data: { currency: "usd" } }),
			body({ metadata: { orgId: "../etc" } }),
		];
		for (const candidate of rubbish) {
			const signed = signFakeEvent(SECRET, candidate, NOW);
			await expect(provider().verifyWebhook(signed.rawBody, signed.headers)).rejects.toBeInstanceOf(
				WebhookPayloadError,
			);
		}
		const notJson = signFakeEvent(SECRET, body(), NOW);
		const text = new TextEncoder().encode("not json");
		const headers = new Headers({
			[FAKE_SIGNATURE_HEADER]: notJson.headers.get(FAKE_SIGNATURE_HEADER) ?? "",
		});
		await expect(provider().verifyWebhook(text, headers)).rejects.toBeInstanceOf(WebhookSignatureError);
	});
});

describe("fake checkout", () => {
	const input = {
		orgId: "org_a",
		planId: "starter",
		interval: "month" as const,
		seats: 10,
		customerEmail: "owner@example.test",
		returnUrl: "https://app.example.test/dashboard",
	};

	it("redirects to the test page on the platform with a signed session that carries the price", async () => {
		const result = await provider({ loadPlan: () => Promise.resolve(starter) }).createCheckout(input);
		if (!("redirectUrl" in result)) throw new Error("expected a redirect");
		const url = new URL(result.redirectUrl);
		expect(url.origin + url.pathname).toBe("https://app.example.test/api/billing/fake/checkout");
		const session = readFakeSession(SECRET, url.searchParams.get("session") ?? "", NOW);
		expect(session).toMatchObject({ orgId: "org_a", planId: "starter", seats: 10, amount: 4900, currency: "USD" });
	});

	it("prices a per-seat plan by the seats", async () => {
		const result = await provider({ loadPlan: () => Promise.resolve(pro) }).createCheckout({ ...input, planId: "pro" });
		if (!("redirectUrl" in result)) throw new Error("expected a redirect");
		const token = new URL(result.redirectUrl).searchParams.get("session") ?? "";
		expect(readFakeSession(SECRET, token, NOW)?.amount).toBe(12_000);
	});

	it("refuses a plan it cannot price", async () => {
		await expect(provider({ loadPlan: () => Promise.resolve(null) }).createCheckout(input)).rejects.toThrow(
			"cannot price",
		);
	});

	it("session tokens are forged-proof and expire", async () => {
		const result = await provider({ loadPlan: () => Promise.resolve(starter) }).createCheckout(input);
		if (!("redirectUrl" in result)) throw new Error("expected a redirect");
		const token = new URL(result.redirectUrl).searchParams.get("session") ?? "";
		const [payload = "", signature = ""] = token.split(".");
		const forged = Buffer.from(
			JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), orgId: "org_evil" }),
		).toString("base64url");
		expect(readFakeSession(SECRET, `${forged}.${signature}`, NOW)).toBeNull();
		expect(readFakeSession("another-secret-0123456789abc", token, NOW)).toBeNull();
		expect(readFakeSession(SECRET, token, new Date(NOW.getTime() + 31 * 60 * 1000))).toBeNull();
		expect(readFakeSession(SECRET, "garbage", NOW)).toBeNull();
		expect(readFakeSession(SECRET, "", NOW)).toBeNull();
	});

	it("the approve and decline events verify as checkout.completed and payment.failed", async () => {
		const session = {
			orgId: "org_a",
			planId: "starter",
			interval: "year" as const,
			seats: 10,
			email: "owner@example.test",
			returnUrl: "https://app.example.test/dashboard",
			amount: 49_000,
			currency: "USD" as const,
			expires: NOW.getTime() + 1000,
		};
		const approve = fakeDecisionEvent(SECRET, session, "approve", NOW);
		const approved = await provider().verifyWebhook(approve.rawBody, approve.headers);
		expect(approved).toMatchObject({ type: "checkout.completed", orgId: "org_a", seats: 10, interval: "year" });
		expect(approved.periodEnd?.toISOString()).toBe("2027-11-02T12:00:00.000Z");
		const decline = fakeDecisionEvent(SECRET, session, "decline", NOW);
		await expect(provider().verifyWebhook(decline.rawBody, decline.headers)).resolves.toMatchObject({
			type: "payment.failed",
			orgId: "org_a",
		});
	});
});

describe("fake provider operations", () => {
	it("changeSeats and cancel emit signed events the webhook accepts", async () => {
		const emitted: { rawBody: Uint8Array; headers: Headers }[] = [];
		const p = provider({ emit: (event) => Promise.resolve(void emitted.push(event)) });
		await p.changeSeats({
			orgId: "org_a",
			planId: "starter",
			interval: "month",
			seats: 20,
			providerSubscriptionId: "fake_sub_1",
		});
		await p.cancel({
			orgId: "org_a",
			providerSubscriptionId: "fake_sub_1",
			periodEnd: new Date("2026-12-02T00:00:00.000Z"),
		});
		const events = await Promise.all(emitted.map((e) => p.verifyWebhook(e.rawBody, e.headers)));
		expect(events[0]).toMatchObject({ type: "subscription.updated", seats: 20, orgId: "org_a" });
		expect(events[1]).toMatchObject({ type: "subscription.canceled", orgId: "org_a" });
		expect(events[1]?.periodEnd?.toISOString()).toBe("2026-12-02T00:00:00.000Z");
	});

	it("without a delivery hook it cannot change seats or cancel, and has no portal", async () => {
		await expect(
			provider().changeSeats({
				orgId: "o",
				planId: "starter",
				interval: "month",
				seats: 2,
				providerSubscriptionId: null,
			}),
		).rejects.toBeInstanceOf(ProviderUnsupportedError);
		await expect(
			provider().customerPortalUrl({ orgId: "o", providerCustomerId: null, returnUrl: "https://x.test" }),
		).resolves.toBeNull();
	});
});

describe("manual provider", () => {
	it("has no checkout, seats, cancel or webhook", async () => {
		const spy = vi.fn();
		await expect(manualProvider.verifyWebhook(new Uint8Array(), new Headers())).rejects.toBeInstanceOf(
			ProviderUnsupportedError,
		);
		await expect(
			manualProvider.createCheckout({
				orgId: "o",
				planId: "starter",
				interval: "month",
				seats: 1,
				customerEmail: "a@b.c",
				returnUrl: "x",
			}),
		).rejects.toBeInstanceOf(ProviderUnsupportedError);
		await expect(
			manualProvider.cancel({ orgId: "o", providerSubscriptionId: null, periodEnd: null }),
		).rejects.toBeInstanceOf(ProviderUnsupportedError);
		expect(manualProvider.id).toBe("manual");
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("priceFor", () => {
	it("flat plans cost one price whatever the seats", () => {
		expect(priceFor(starter, "month", 10, "USD")).toBe(4900);
		expect(priceFor(starter, "year", 50, "USD")).toBe(49_000);
	});
	it("per-seat plans multiply by the seats", () => {
		expect(priceFor(pro, "month", 7, "USD")).toBe(8400);
	});
	it("KES is whole shillings in the table and cents in the result", () => {
		expect(priceFor(starter, "month", 1, "KES")).toBe(650_000);
	});
	it("no price means contact us", () => {
		expect(priceFor({ ...starter, priceMonthlyUsdCents: null }, "month", 1, "USD")).toBeNull();
	});
});
