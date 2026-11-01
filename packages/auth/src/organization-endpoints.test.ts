import type { AuthOpenApiDocument } from "@careeros/testing/auth-org-inventory";
import { describe, expect, it } from "vite-plus/test";
import { AUTH_ORG_SKIP, checkAuthOrgInventory, readOrganizationEndpoints } from "@careeros/testing/auth-org-inventory";
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
