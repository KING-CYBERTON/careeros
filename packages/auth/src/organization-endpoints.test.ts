import type { AuthOpenApiDocument } from "@careeros/testing/auth-org-inventory";
import { describe, expect, it } from "vite-plus/test";
import {
	AUTH_ORG_SKIP,
	checkAuthOrgInventory,
	checkHandoffAnswer,
	checkHandoffInventory,
	handoffAttacks,
	HANDOFF_SERVER_ONLY_GUESSES,
	readOrganizationEndpoints,
} from "@careeros/testing/auth-org-inventory";
import { env } from "@reactive-resume/env/server";
import { auth } from "./config";

// CAREEROS: P1-Q10. The e2e fuzz (tests/e2e/specs/cross-org-auth-fuzz.spec.ts) attacks every organization endpoint
// the running auth instance publishes. This test runs the same inventory check against the real auth configuration,
// so a plugin upgrade or option that adds an endpoint fails here, before the e2e job.
describe("organization endpoint inventory", () => {
	it("attacks or skips every endpoint the organization plugin publishes", async () => {
		const response = await auth.handler(new Request(`${env.APP_URL}/api/auth/open-api/generate-schema`));
		expect(response.status).toBe(200);
		const endpoints = readOrganizationEndpoints((await response.json()) as AuthOpenApiDocument);
		expect(endpoints.length).toBeGreaterThan(15);
		expect(checkAuthOrgInventory(endpoints)).toEqual([]);
		for (const key of Object.keys(AUTH_ORG_SKIP)) expect(endpoints.map((endpoint) => endpoint.key)).toContain(key);
	});
});

// CAREEROS: P2-T05. The sign-in handoff endpoints are outside the published organization schema, so the inventory
// lists them by hand: every one has an attack, and the Better Auth session endpoints the handoff uses are not routable.
describe("handoff endpoint inventory", () => {
	const seed = { orgId: "org-a", orgSlug: "acme", ownerUserId: "user-a", invitationId: "inv-a" };

	it("attacks every handoff endpoint", () => {
		expect(checkHandoffInventory(seed)).toEqual([]);
	});

	it("expects a fixed refusal from each attack", () => {
		for (const attack of handoffAttacks(seed)) {
			expect(checkHandoffAnswer(attack, { status: attack.expect.status, location: attack.expect.location })).toEqual(
				[],
			);
			expect(checkHandoffAnswer(attack, { status: 200 })).not.toEqual([]);
		}
	});

	it("does not route the server-only session endpoints over HTTP", async () => {
		for (const path of HANDOFF_SERVER_ONLY_GUESSES) {
			const response = await auth.handler(
				new Request(`${env.APP_URL}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: env.APP_URL },
					body: JSON.stringify({ userId: "u", organizationId: "o", token: "t" }),
				}),
			);
			expect(response.status, path).toBe(404);
		}
		const published = await auth.handler(new Request(`${env.APP_URL}/api/auth/open-api/generate-schema`));
		expect(JSON.stringify(await published.json())).not.toMatch(/handoff/i);
	});
});
